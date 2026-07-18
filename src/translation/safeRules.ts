export type RulesTransform = (text: string) => string;

/** Rules are best-effort: a non-empty segment must never become empty or fatal. */
export function applyRulesPreservingNonEmpty(
  input: string,
  rules: RulesTransform,
  log?: (line: string) => void,
): string {
  const fallback = input.trim();
  if (fallback.length === 0) return '';
  try {
    const ruled = rules(input).trim();
    return ruled.length > 0 ? ruled : fallback;
  } catch (error) {
    try {
      log?.(`[translate] rules error: ${String(error).slice(0, 200)} -> unmodified text`);
    } catch {
      // Logging is best-effort too.
    }
    return fallback;
  }
}
