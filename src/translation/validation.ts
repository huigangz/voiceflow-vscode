/** Explicit translation-task refusals only; ordinary apologies or inability statements are valid content. */
export const TRANSLATION_META_REFUSAL_RE =
  /(?:作为(?:一名|一个)?\s*(?:AI|人工智能)|(?:无法|不能)(?:处理|翻译)(?:您|你)?(?:所)?提供的(?:内容|文本)|I\s+(?:cannot|can't|am unable to)\s+(?:translate|provide))/iu;

const TASK_META_PREFIX_RE =
  /^(?:以下是(?:本次|该)?翻译结果|翻译如下|here is the translation)\s*[:：\-—]?/iu;
const ORDINARY_PREFIX_RE = /^(?:以下是|here is)(?:\b|\s|[:：，,])?/iu;
const CODE_FENCE_RE = /```|~~~/u;
const CODE_INTENT_RE =
  /(?:```|~~~|`[^`]+`|https?:\/\/|\b(?:code(?:\s+block)?|const|let|var|function|class|interface|npm|JSON|Markdown)\b|[{}<>]=?|=>)/iu;
const CODE_SHAPE_RE =
  /(?:`[^`]+`|https?:\/\/|\b(?:const|let|var|function|class|interface|npm|JSON)\b|[{}<>]=?|=>)/iu;

function normalizedForEcho(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function editDistance(a: string, b: string): number {
  if (a.length > b.length) return editDistance(b, a);
  let previous = Array.from({ length: a.length + 1 }, (_, index) => index);
  for (let row = 1; row <= b.length; row++) {
    const current = [row];
    for (let column = 1; column <= a.length; column++) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (a[column - 1] === b[row - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[a.length]!;
}

function isEchoOrNearEcho(source: string, output: string): boolean {
  const a = normalizedForEcho(source);
  const b = normalizedForEcho(output);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  return longest >= 8 && editDistance(a, b) / longest <= 0.08;
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
  if (TRANSLATION_META_REFUSAL_RE.test(trimmed.slice(0, 160))) return true;
  if (TASK_META_PREFIX_RE.test(trimmed)) return true;
  if (isEchoOrNearEcho(source, trimmed)) return true;

  const ordinaryPrefix = ORDINARY_PREFIX_RE.test(trimmed);
  const unexpectedFence = CODE_FENCE_RE.test(trimmed) && !CODE_INTENT_RE.test(source);
  const contentWithoutFences = trimmed.replace(/```|~~~/gu, '');
  const residual = !CODE_SHAPE_RE.test(contentWithoutFences) && residualNonTargetRatio(trimmed) > 0.7;
  const weakSignals = Number(ordinaryPrefix) + Number(unexpectedFence) + Number(residual);
  const extremeExpansion =
    trimmed.length > source.length * 6 && trimmed.length > source.length + 200;
  return weakSignals >= 2 || (extremeExpansion && weakSignals >= 1);
}
