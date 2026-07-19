# Translation Refusal Validation Design

## Context

T3-06 sent an English prompt-injection probe through the real `vscode.lm` provider. The provider safely refused with `抱歉，我无法协助处理该请求。`, but the translation pipeline accepted that text as a successful Chinese translation. Direct replay confirmed that both `TRANSLATION_META_REFUSAL_RE` and `isTranslationOutputRejected` return false for the captured output.

## Goal

Treat an observable request-directed provider refusal as a rejected translation, fall back to the original source text, and record outcome `rejected`. Preserve legitimate translation when the source transcript itself is a matching refusal sentence.

## Design

Extend the existing bilingual `TRANSLATION_META_REFUSAL_RE` in `src/translation/validation.ts` with narrow request-directed refusal forms:

- Chinese inability to assist with or handle `这个/该/此请求`, including the captured `无法协助处理该请求` form.
- The corresponding English inability to assist with or handle `this/the request`, so `sourceRefusalDominates` can continue to distinguish translated source content from an output-only provider refusal.

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
- Guard: ordinary inability content that is not a request-directed provider refusal remains accepted.
- GREEN: run focused translation validation/pipeline tests, then the relevant translation suite and repository regression checks required by the parent audio-translation plan.

## Acceptance Criteria

- The captured refusal can no longer produce outcome `translated`.
- T3-06 retry produces either a pure Chinese translation or source-English fallback with outcome `rejected`.
- A genuine refusal sentence in the transcript can still be translated.
- No provider retry or additional token usage is introduced.
