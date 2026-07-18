import type { TranslationOutcome } from './pipeline';

const DEGRADED = new Set<TranslationOutcome>([
  'timeout', 'error', 'empty', 'rejected', 'circuit-open',
]);

export interface TranslationMetricsSnapshot {
  totalSegments: number;
  needsTranslationSegments: number;
  translatedSegments: number;
  identitySegments: number;
  degradationSegments: number;
  translationSuccessRate: number;
  identityBypassRate: number;
  overallUsableRate: number;
  degradationRate: number;
  outcomes: Readonly<Record<TranslationOutcome, number>>;
  translatedLatencyMs: readonly number[];
  identityLatencyMs: readonly number[];
  visibleLatencyMs: readonly number[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export class TranslationSessionMetrics {
  private readonly outcomes: Record<TranslationOutcome, number> = {
    translated: 0,
    identity: 0,
    'rules-only': 0,
    'circuit-open': 0,
    timeout: 0,
    error: 0,
    empty: 0,
    rejected: 0,
  };
  private readonly translatedLatencyMs: number[] = [];
  private readonly identityLatencyMs: number[] = [];
  private readonly visibleLatencyMs: number[] = [];

  observe(outcome: TranslationOutcome, latencyMs: number): void {
    this.outcomes[outcome]++;
    const latency = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0;
    this.visibleLatencyMs.push(latency);
    if (outcome === 'translated') this.translatedLatencyMs.push(latency);
    if (outcome === 'identity') this.identityLatencyMs.push(latency);
  }

  snapshot(): TranslationMetricsSnapshot {
    const totalSegments = Object.values(this.outcomes).reduce((sum, value) => sum + value, 0);
    const identitySegments = this.outcomes.identity;
    const translatedSegments = this.outcomes.translated;
    const needsTranslationSegments = totalSegments - identitySegments;
    const degradationSegments = [...DEGRADED]
      .reduce((sum, outcome) => sum + this.outcomes[outcome], 0);
    return {
      totalSegments,
      needsTranslationSegments,
      translatedSegments,
      identitySegments,
      degradationSegments,
      translationSuccessRate: ratio(translatedSegments, needsTranslationSegments),
      identityBypassRate: ratio(identitySegments, totalSegments),
      overallUsableRate: ratio(translatedSegments + identitySegments, totalSegments),
      degradationRate: ratio(degradationSegments, totalSegments),
      outcomes: { ...this.outcomes },
      translatedLatencyMs: [...this.translatedLatencyMs],
      identityLatencyMs: [...this.identityLatencyMs],
      visibleLatencyMs: [...this.visibleLatencyMs],
    };
  }

  summary(): TranslationMetricsSnapshot & {
    translatedLatency: { p50?: number; p95?: number };
    identityLatency: { p50?: number; p95?: number };
  } {
    return {
      ...this.snapshot(),
      translatedLatency: {
        p50: percentile(this.translatedLatencyMs, 0.5),
        p95: percentile(this.translatedLatencyMs, 0.95),
      },
      identityLatency: {
        p50: percentile(this.identityLatencyMs, 0.5),
        p95: percentile(this.identityLatencyMs, 0.95),
      },
    };
  }
}
