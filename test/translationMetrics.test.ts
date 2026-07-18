import { describe, expect, it } from 'vitest';
import { TranslationSessionMetrics } from '../src/translation/metrics';

describe('target=zh session metrics', () => {
  it('excludes identity from translation success denominator and translated latency distribution', () => {
    const metrics = new TranslationSessionMetrics();
    metrics.observe('identity', 20);
    metrics.observe('translated', 100);
    metrics.observe('timeout', 8_000);
    metrics.observe('translated', 300);

    expect(metrics.snapshot()).toMatchObject({
      totalSegments: 4,
      needsTranslationSegments: 3,
      translatedSegments: 2,
      identitySegments: 1,
      degradationSegments: 1,
      translationSuccessRate: 2 / 3,
      identityBypassRate: 1 / 4,
      overallUsableRate: 3 / 4,
      degradationRate: 1 / 4,
      translatedLatencyMs: [100, 300],
      identityLatencyMs: [20],
      visibleLatencyMs: [20, 100, 8_000, 300],
    });
  });

  it('counts all failure outcomes and circuit-open as degradation', () => {
    const metrics = new TranslationSessionMetrics();
    for (const outcome of ['timeout', 'error', 'empty', 'rejected', 'circuit-open'] as const) {
      metrics.observe(outcome, 10);
    }
    expect(metrics.snapshot()).toMatchObject({
      totalSegments: 5,
      needsTranslationSegments: 5,
      translatedSegments: 0,
      identitySegments: 0,
      degradationSegments: 5,
      translationSuccessRate: 0,
      overallUsableRate: 0,
      degradationRate: 1,
    });
  });

  it('reports translated and identity percentile domains separately', () => {
    const metrics = new TranslationSessionMetrics();
    for (const latency of [10, 20, 30, 40, 50]) metrics.observe('translated', latency);
    metrics.observe('identity', 2);
    metrics.observe('identity', 4);
    expect(metrics.summary()).toMatchObject({
      translatedLatency: { p50: 30, p95: 50 },
      identityLatency: { p50: 2, p95: 4 },
    });
  });
});
