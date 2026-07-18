import { TranslationResult } from './pipeline';
import { applyRulesPreservingNonEmpty } from './safeRules';

type TranslateSegment = (
  source: string,
  detectedLanguage: string | undefined,
  signal: AbortSignal,
) => Promise<TranslationResult>;

const FAILURE_OUTCOMES = new Set<TranslationResult['outcome']>([
  'timeout',
  'error',
  'empty',
  'rejected',
]);

/** Pure session-level circuit. Cancellation never reaches observe because it is thrown by translate. */
export class TranslationCoordinator {
  private consecutiveFailures = 0;
  private open = false;

  constructor(
    private readonly translate: TranslateSegment,
    private readonly rulesFallback: (source: string) => string,
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  openForBacklog(_queuedMs: number): void {
    this.open = true;
  }

  async run(
    source: string,
    detectedLanguage: string | undefined,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    if (this.open) {
      return {
        text: applyRulesPreservingNonEmpty(source, this.rulesFallback),
        outcome: 'circuit-open',
      };
    }
    const result = await this.translate(source, detectedLanguage, signal);
    this.observe(result);
    return result;
  }

  private observe(result: TranslationResult): void {
    if (result.failure?.kind === 'rate-limit') {
      this.open = true;
      return;
    }
    if (result.outcome === 'translated' || result.outcome === 'identity') {
      this.consecutiveFailures = 0;
      return;
    }
    if (!FAILURE_OUTCOMES.has(result.outcome)) return;
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3) this.open = true;
  }
}
