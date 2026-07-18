import type { TokenUsage } from '../cleanup/llmProvider';

export const TRANSLATION_USAGE_STATE_KEY = 'voiceflow.translationUsage.v1';

export type UsageBucketName = 'translationCalls' | 'authorizationCalls';

export interface UsageBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCalls: number;
}

export interface TranslationUsageTotals {
  translationCalls: UsageBucket;
  authorizationCalls: UsageBucket;
}

const emptyBucket = (): UsageBucket => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCalls: 0,
});

export const EMPTY_TRANSLATION_USAGE: TranslationUsageTotals = {
  translationCalls: emptyBucket(),
  authorizationCalls: emptyBucket(),
};

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeBucket(value: unknown): UsageBucket {
  const record = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
  const calls = nonnegativeInteger(record.calls);
  return {
    calls,
    inputTokens: nonnegativeInteger(record.inputTokens),
    outputTokens: nonnegativeInteger(record.outputTokens),
    estimatedCalls: Math.min(calls, nonnegativeInteger(record.estimatedCalls)),
  };
}

export function normalizeTranslationUsage(value: unknown): TranslationUsageTotals {
  const record = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
  return {
    translationCalls: normalizeBucket(record.translationCalls),
    authorizationCalls: normalizeBucket(record.authorizationCalls),
  };
}

function updateBucket(
  totals: TranslationUsageTotals,
  name: UsageBucketName,
  update: (bucket: UsageBucket) => UsageBucket,
): TranslationUsageTotals {
  return { ...totals, [name]: update(totals[name]) };
}

export function addUsage(
  totals: TranslationUsageTotals,
  name: UsageBucketName,
  usage: TokenUsage,
): TranslationUsageTotals {
  return updateBucket(totals, name, (bucket) => ({
    ...bucket,
    inputTokens: bucket.inputTokens + nonnegativeInteger(usage.inputTokens),
    outputTokens: bucket.outputTokens + nonnegativeInteger(usage.outputTokens),
    estimatedCalls: bucket.estimatedCalls + (usage.estimate ? 1 : 0),
  }));
}

export function recordRequest(
  totals: TranslationUsageTotals,
  name: UsageBucketName,
  usage?: TokenUsage,
): TranslationUsageTotals {
  const withCall = updateBucket(totals, name, (bucket) => ({ ...bucket, calls: bucket.calls + 1 }));
  return usage === undefined ? withCall : addUsage(withCall, name, usage);
}

export interface UsageMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class TranslationUsageStore {
  private totals: TranslationUsageTotals;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly state: UsageMemento) {
    this.totals = normalizeTranslationUsage(state.get(TRANSLATION_USAGE_STATE_KEY));
  }

  snapshot(): TranslationUsageTotals {
    return normalizeTranslationUsage(this.totals);
  }

  recordRequest(name: UsageBucketName, usage?: TokenUsage): void {
    this.totals = recordRequest(this.totals, name, usage);
    this.persist();
  }

  addUsage(name: UsageBucketName, usage: TokenUsage): void {
    this.totals = addUsage(this.totals, name, usage);
    this.persist();
  }

  flushed(): Promise<void> {
    return this.writes;
  }

  private persist(): void {
    const value = this.snapshot();
    const write = () => Promise.resolve(this.state.update(TRANSLATION_USAGE_STATE_KEY, value));
    this.writes = this.writes.then(write, write).catch(() => {});
  }
}

function tokenTotals(totals: TranslationUsageTotals): { input: number; output: number } {
  return {
    input: totals.translationCalls.inputTokens + totals.authorizationCalls.inputTokens,
    output: totals.translationCalls.outputTokens + totals.authorizationCalls.outputTokens,
  };
}

export function formatSessionUsage(totals: TranslationUsageTotals): string {
  const tokens = tokenTotals(totals);
  const calls = totals.translationCalls.calls + totals.authorizationCalls.calls;
  const approximate =
    totals.translationCalls.estimatedCalls + totals.authorizationCalls.estimatedCalls > 0;
  const mark = approximate ? '≈' : '=';
  return `[metrics] translate-llm: in${mark}${tokens.input} out${mark}${tokens.output} tok` +
    `(${calls} calls; translation=${totals.translationCalls.calls} ` +
    `authorization=${totals.authorizationCalls.calls})`;
}

function dollars(value: number): string {
  return `$${value > 0 && value < 0.01 ? value.toFixed(6) : value.toFixed(2)}`;
}

export function formatDirectApiCostRange(totals: TranslationUsageTotals): string {
  const tokens = tokenTotals(totals);
  const low = tokens.input / 1_000_000 + tokens.output * 5 / 1_000_000;
  const high = tokens.input * 2 / 1_000_000 + tokens.output * 10 / 1_000_000;
  return `${dollars(low)}–${dollars(high)}`;
}

function formatBucket(label: string, bucket: UsageBucket): string {
  const approximate = bucket.estimatedCalls > 0 ? ' (includes estimates)' : '';
  return `${label}: ${bucket.calls} calls, ${bucket.inputTokens.toLocaleString('en-US')} input tokens, ` +
    `${bucket.outputTokens.toLocaleString('en-US')} output tokens${approximate}`;
}

export function formatTranslationUsageReport(totals: TranslationUsageTotals): string {
  return [
    formatBucket('Translation requests', totals.translationCalls),
    formatBucket('Authorization requests', totals.authorizationCalls),
    '',
    'Subscription channels usually have marginal cost ≈ $0; these totals do not claim a subscription charge.',
    `Reference direct-API cost range: ${formatDirectApiCostRange(totals)}.`,
    'Pricing snapshot verified 2026-07-18: Haiku 4.5 ($1/MTok input, $5/MTok output) to ' +
      'Sonnet 5 introductory pricing through 2026-08-31 ($2/MTok input, $10/MTok output).',
    'Sources: https://www.anthropic.com/claude/haiku',
    'https://www.anthropic.com/news/claude-sonnet-5',
  ].join('\n');
}
