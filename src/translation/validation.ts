/** Explicit translation-task refusals only; ordinary apologies or inability statements are valid content. */
export const TRANSLATION_META_REFUSAL_RE =
  /(?:(?:无法|不能)(?:帮助|协助)?翻译(?:(?:您|你)?(?:所)?(?:提供的)?(?:内容|文本|请求)|此内容)|(?:无法|不能)处理(?:(?:您|你)?(?:所)?提供的(?:内容|文本)|(?:这个|该|此)(?:请求|内容))|I\s+(?:cannot|can't|am unable to)\s+(?:translate(?:\s+(?:the\s+)?provided\s+(?:content|text|request))?|provide\s+(?:(?:a|the)\s+translation|translated\s+(?:output|content|text))|process\s+(?:the\s+)?provided\s+(?:content|text|request)))/iu;

const TASK_META_PREFIX_RE =
  /^(?:以下是(?:本次|该)?翻译结果|翻译如下|here is the translation)\s*[:：\-—]?/iu;
const ORDINARY_PREFIX_RE = /^(?:以下是|here is)(?:\b|\s|[:：，,])?/iu;
const CODE_FENCE_RE = /```|~~~/u;
const CODE_INTENT_RE =
  /(?:```|~~~|`[^`]+`|https?:\/\/|\b(?:code(?:\s+block)?|const|let|var|function|class|interface|npm|JSON|Markdown)\b|[{}<>]=?|=>)/iu;
const CODE_SHAPE_RE =
  /(?:`[^`]+`|https?:\/\/|\b(?:const|let|var|function|class|interface|npm|JSON)\b|[{}<>]=?|=>)/iu;
const SOURCE_INJECTION_RE = /(?:<\/?transcript>|ignore (?:all )?(?:previous|prior) instructions)/iu;

function normalizedForEcho(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

const FUZZY_ECHO_PERCENT_LIMIT = 0.08;
const FUZZY_ECHO_MAX_EDIT_BUDGET = 32;
const SOURCE_REFUSAL_MIN_DOMINANCE = 0.9;
const SOURCE_REFUSAL_MAX_RESIDUAL_CHARS = 8;

export interface TranslationEchoComparison {
  isEcho: boolean;
  operations: number;
  maxEdits: number;
  skippedByLength: boolean;
}

function boundedEditDistanceWithin(
  a: string,
  b: string,
  maxEdits: number,
): { within: boolean; operations: number } {
  const outside = maxEdits + 1;
  let operations = 0;
  let previous = new Map<number, number>();
  for (let column = 0; column <= Math.min(b.length, maxEdits); column++) {
    previous.set(column, column);
  }

  for (let row = 1; row <= a.length; row++) {
    const current = new Map<number, number>();
    const start = Math.max(0, row - maxEdits);
    const end = Math.min(b.length, row + maxEdits);
    let rowMinimum = outside;
    for (let column = start; column <= end; column++) {
      operations++;
      const distance = column === 0
        ? row
        : Math.min(
            (current.get(column - 1) ?? outside) + 1,
            (previous.get(column) ?? outside) + 1,
            (previous.get(column - 1) ?? outside) +
              (a[row - 1] === b[column - 1] ? 0 : 1),
          );
      const bounded = Math.min(distance, outside);
      current.set(column, bounded);
      rowMinimum = Math.min(rowMinimum, bounded);
    }
    if (rowMinimum > maxEdits) return { within: false, operations };
    previous = current;
  }
  return { within: (previous.get(b.length) ?? outside) <= maxEdits, operations };
}

/**
 * Bounded fuzzy-echo heuristic. The fixed 32-edit budget intentionally narrows the nominal 8%
 * threshold on long transcripts to protect extension-host latency and avoid broad fuzzy rejection.
 */
export function compareTranslationEcho(
  source: string,
  output: string,
): TranslationEchoComparison {
  const a = normalizedForEcho(source);
  const b = normalizedForEcho(output);
  const longest = Math.max(a.length, b.length);
  const maxEdits = Math.min(
    FUZZY_ECHO_MAX_EDIT_BUDGET,
    Math.floor(longest * FUZZY_ECHO_PERCENT_LIMIT),
  );
  if (a.length === 0 || b.length === 0) {
    return { isEcho: false, operations: 0, maxEdits, skippedByLength: false };
  }
  if (a === b) {
    return { isEcho: true, operations: 0, maxEdits, skippedByLength: false };
  }
  if (longest < 8 || Math.abs(a.length - b.length) > maxEdits) {
    return { isEcho: false, operations: 0, maxEdits, skippedByLength: true };
  }
  const bounded = boundedEditDistanceWithin(a, b, maxEdits);
  return {
    isEcho: bounded.within,
    operations: bounded.operations,
    maxEdits,
    skippedByLength: false,
  };
}

/**
 * A source refusal suppresses the matching output signal only when its detected span accounts for
 * at least 90% of normalized source content and leaves at most eight normalized residual chars.
 * This admits punctuation/case variation while treating quoted or mixed material conservatively.
 */
function sourceRefusalDominates(source: string): boolean {
  const match = TRANSLATION_META_REFUSAL_RE.exec(source.slice(0, 160));
  if (!match) return false;
  const normalizedSource = normalizedForEcho(source);
  const normalizedSpan = normalizedForEcho(match[0]);
  if (normalizedSource.length === 0 || normalizedSpan.length === 0) return false;
  const residualChars = Math.max(0, normalizedSource.length - normalizedSpan.length);
  return (
    normalizedSpan.length / normalizedSource.length >= SOURCE_REFUSAL_MIN_DOMINANCE &&
    residualChars <= SOURCE_REFUSAL_MAX_RESIDUAL_CHARS
  );
}

function residualNonTargetRatio(output: string): number {
  const target = output.match(/\p{Script=Han}/gu)?.length ?? 0;
  const nonTarget = output.match(/[\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return nonTarget / Math.max(1, target + nonTarget);
}

/**
 * Reject only observable translation failures. A fluent unrelated Chinese sentence has no reliable
 * lexical signal and is intentionally accepted; prompt isolation and insertion-only handling bound it.
 *
 * Expansion is conservative: over 6x the source and at least 200 extra characters. It never rejects
 * alone, only in combination with an ordinary prefix, unexpected fence, or >70% residual language.
 */
export function isTranslationOutputRejected(source: string, output: string): boolean {
  const trimmed = output.trim();
  const outputIsMetaRefusal = TRANSLATION_META_REFUSAL_RE.test(trimmed.slice(0, 160));
  if (outputIsMetaRefusal && !sourceRefusalDominates(source)) return true;
  if (TASK_META_PREFIX_RE.test(trimmed)) return true;
  if (compareTranslationEcho(source, trimmed).isEcho) return true;

  const ordinaryPrefix = ORDINARY_PREFIX_RE.test(trimmed);
  const sourceHasCodeIntent = !SOURCE_INJECTION_RE.test(source) && CODE_INTENT_RE.test(source);
  const outputHasFence = CODE_FENCE_RE.test(trimmed);
  const unexpectedFence = outputHasFence && !sourceHasCodeIntent;
  const contentWithoutFences = trimmed.replace(/```|~~~/gu, '');
  const outputHasCodeShape = outputHasFence || CODE_SHAPE_RE.test(contentWithoutFences);
  const residualIsExpected = sourceHasCodeIntent && outputHasCodeShape;
  const residual = !residualIsExpected && residualNonTargetRatio(trimmed) > 0.7;
  const weakSignals = Number(ordinaryPrefix) + Number(unexpectedFence) + Number(residual);
  const extremeExpansion =
    trimmed.length > source.length * 6 && trimmed.length > source.length + 200;
  return weakSignals >= 2 || (extremeExpansion && weakSignals >= 1);
}
