# Translation Refusal Validation Design

## Context

T3-06 sent an English prompt-injection probe through the real `vscode.lm` provider. The provider safely refused with `抱歉，我无法协助处理该请求。`, but the translation pipeline accepted that text as a successful Chinese translation. Direct replay confirmed that both `TRANSLATION_META_REFUSAL_RE` and `isTranslationOutputRejected` return false for the captured output.

The existing Chinese predicate misses this exact wording for two concrete reasons: its request branch requires `无法处理` or `不能处理` to be adjacent, so the inserted `协助` prevents a match; its other branch requires an explicit `翻译` term. The failure therefore belongs in the existing observable refusal pattern, not in a new validation structure.

## Goal

Treat an observable request-directed provider refusal as a rejected translation, fall back to the original source text, and record outcome `rejected`. Preserve legitimate translation when the source transcript itself is a matching refusal sentence.

## Design

Extend the existing bilingual `TRANSLATION_META_REFUSAL_RE` in `src/translation/validation.ts` with narrow request-directed refusal forms:

- Chinese: an optional `抱歉/对不起` prefix, optional first-person subject, `无法/不能`, `协助/帮助`, `处理/完成`, and an explicit `这个/该/此/你的/您的请求` object. Keep the existing direct `无法/不能处理…请求` forms.
- English: an optional `sorry` prefix followed by first-person inability and `assist/help` with an explicit `this/that/the/your request` object.

The optional apology prefix is part of the matched span, rather than ignored outside it. For the guard source `Sorry, I cannot assist with this request.`, normalized matched length therefore covers the normalized source and satisfies the existing `dominance >= 0.9 AND residual <= 8` rule. Do not lower either dominance threshold.

Do not add a retry, a second provider call, a new outcome, or a prompt change. The existing pipeline already converts a rejected output into the rule-processed source fallback and records `rejected`.

## Data Flow

1. Provider returns candidate Chinese output.
2. `isTranslationOutputRejected(source, output)` tests the extended refusal predicate.
3. If only the output is a request-directed refusal, return the original source fallback with outcome `rejected`.
4. If the source is itself dominated by the corresponding refusal statement, accept its Chinese translation.

## Tests

Use TDD at the existing validation and pipeline seams:

- RED: the exact T3-06 source/output pair is rejected.
- RED: `runTranslate` falls back to the exact English source and reports `rejected` for that pair.
- Guard: a source such as `Sorry, I cannot assist with this request.` may translate to `抱歉，我无法协助处理该请求。` without rejection.
- Matrix: cover `协助/帮助 × 处理/完成 × 这个/该/此/你的/您的请求` and English `assist/help × this/that/the/your request`, while retaining the explicit request object requirement.
- Guard: ordinary inability content that is not a request-directed provider refusal remains accepted.
- GREEN: run focused translation validation/pipeline tests, then the relevant translation suite and repository regression checks required by the parent audio-translation plan.

## Acceptance Criteria

- The captured refusal can no longer produce outcome `translated`.
- T3-06 retry produces either a pure Chinese translation or source-English fallback with outcome `rejected`.
- A genuine refusal sentence in the transcript can still be translated.
- No provider retry or additional token usage is introduced.
- A rejected candidate inserts the original English injection-probe text in the editor, matching the parent plan's bounded source-fallback semantics.
