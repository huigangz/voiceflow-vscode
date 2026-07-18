import type { TranslationResult } from './pipeline';

const FALLBACK_OUTCOMES = new Set<TranslationResult['outcome']>([
  'timeout', 'error', 'empty', 'rejected',
]);

export class TranslationSessionFeedback {
  private readonly notified = new Set<TranslationResult['outcome']>();

  notificationFor(result: TranslationResult): string | undefined {
    if (result.outcome === 'circuit-open') {
      if (this.notified.has(result.outcome)) return undefined;
      this.notified.add(result.outcome);
      return 'VoiceFlow: LLM translation is unavailable or responding slowly; subsequent segments will insert original text.';
    }
    if (!FALLBACK_OUTCOMES.has(result.outcome) || this.notified.has(result.outcome)) {
      return undefined;
    }
    this.notified.add(result.outcome);
    return `VoiceFlow: translation ${result.outcome} — inserted original text.`;
  }
}
