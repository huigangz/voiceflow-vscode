import { describe, expect, it, vi } from 'vitest';
import { CleanupCancelled } from '../src/cleanup/pipeline';
import { DEFAULT_RULES } from '../src/cleanup/rulesLayer';
import { runTranslate } from '../src/translation/pipeline';
import { settleSessionShutdown } from '../src/translation/sessionPreflight';
import {
  EMPTY_TRANSLATION_USAGE,
  TranslationSessionUsageAccounting,
  TranslationUsageStore,
  addUsage,
  formatSessionUsage,
  formatTranslationUsageReport,
  normalizeTranslationUsage,
  recordRequest,
} from '../src/translation/usage';

describe('translation usage accumulation', () => {
  it('attributes late usage to its finalized session while another session is active', () => {
    const store = new TranslationUsageStore({ get: () => undefined, update: async () => {} });
    const logA = vi.fn();
    const logB = vi.fn();
    const sessionA = new TranslationSessionUsageAccounting(store, logA);
    const sessionB = new TranslationSessionUsageAccounting(store, logB);

    sessionA.translationStarted();
    sessionA.finalize();
    sessionB.translationStarted();
    sessionA.translationUsage({ inputTokens: 7, outputTokens: 3, estimate: false });
    sessionA.translationSettled();

    expect(logA).toHaveBeenCalledWith(expect.stringContaining('in=7 out=3'));
    expect(logB).not.toHaveBeenCalled();
    sessionB.translationSettled();
  });

  it('settled waits for every started translation request', async () => {
    const store = new TranslationUsageStore({ get: () => undefined, update: async () => {} });
    const accounting = new TranslationSessionUsageAccounting(store, () => {});
    accounting.translationStarted();
    let completed = false;
    const waiting = accounting.settled().then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    accounting.translationSettled();
    await waiting;
    expect(completed).toBe(true);
  });

  it('shutdown aborts a pending provider and persists its late usage after cleanup', async () => {
    const writes: unknown[] = [];
    const events: string[] = [];
    const store = new TranslationUsageStore({
      get: () => undefined,
      update: async (_key, value) => { writes.push(value); },
    });
    const accounting = new TranslationSessionUsageAccounting(store, () => {});
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    let providerAborted = false;
    const outer = new AbortController();
    const translating = runTranslate('hello', 'en', {
      rules: DEFAULT_RULES,
      timeoutMs: 60_000,
      provider: {
        name: 'pending-provider',
        prepare: async () => ({ ok: true }),
        run: async (_instruction, _source, signal) => {
          providerStarted();
          return new Promise((resolve) => signal.addEventListener('abort', () => {
            providerAborted = true;
            resolve({
              ok: false,
              kind: 'aborted',
              usage: { inputTokens: 5, outputTokens: 2, estimate: false },
            });
          }, { once: true }));
        },
      },
      onRequestStart: () => accounting.translationStarted(),
      onUsage: (usage) => accounting.translationUsage(usage),
      onSettled: () => accounting.translationSettled(),
    }, outer.signal);
    await started;
    let releaseRunner!: () => void;
    const runnerCleanup = new Promise<void>((resolve) => { releaseRunner = resolve; });
    let completed = false;
    const shutdown = settleSessionShutdown({
      cleanup: [
        () => outer.abort(),
        () => { throw new Error('sync cleanup failure'); },
        async () => { throw new Error('async cleanup failure'); },
        () => accounting.finalize(),
        () => runnerCleanup,
      ],
      wait: [
        () => translating.catch((error) => {
          expect(error).toBeInstanceOf(CleanupCancelled);
        }),
        () => accounting.settled(),
      ],
      flush: async () => {
        await store.flushed();
        events.push('flushed');
      },
    }).then(() => { completed = true; });

    await Promise.resolve();
    expect(providerAborted).toBe(true);
    expect(completed).toBe(false);
    releaseRunner();
    await shutdown;
    expect(events).toEqual(['flushed']);
    expect(writes.at(-1)).toMatchObject({
      translationCalls: { calls: 1, inputTokens: 5, outputTokens: 2 },
    });
  });

  it('counts true translation requests separately from late exact usage', () => {
    const started = recordRequest(EMPTY_TRANSLATION_USAGE, 'translationCalls');
    const settled = addUsage(started, 'translationCalls', {
      inputTokens: 20,
      outputTokens: 5,
      estimate: false,
    });
    expect(settled.translationCalls).toEqual({
      calls: 1,
      inputTokens: 20,
      outputTokens: 5,
      estimatedCalls: 0,
    });
  });

  it('tracks authorization pings and estimated translation calls in separate buckets', () => {
    let totals = recordRequest(EMPTY_TRANSLATION_USAGE, 'authorizationCalls', {
      inputTokens: 3, outputTokens: 1, estimate: false,
    });
    totals = recordRequest(totals, 'translationCalls', {
      inputTokens: 40, outputTokens: 10, estimate: true,
    });
    expect(totals.authorizationCalls).toEqual({ calls: 1, inputTokens: 3, outputTokens: 1, estimatedCalls: 0 });
    expect(totals.translationCalls).toEqual({ calls: 1, inputTokens: 40, outputTokens: 10, estimatedCalls: 1 });
  });

  it('does not invent authorization calls for prepare without request usage', () => {
    expect(EMPTY_TRANSLATION_USAGE.authorizationCalls.calls).toBe(0);
  });

  it('robustly normalizes older or malformed stored values', () => {
    expect(normalizeTranslationUsage({
      translationCalls: { calls: 2.9, inputTokens: -4, outputTokens: 'bad', estimatedCalls: 99 },
      authorizationCalls: null,
    })).toEqual({
      translationCalls: { calls: 2, inputTokens: 0, outputTokens: 0, estimatedCalls: 2 },
      authorizationCalls: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCalls: 0 },
    });
  });

  it('serializes cumulative global-state persistence after each update', async () => {
    const writes: unknown[] = [];
    const stored = { translationCalls: { calls: 1, inputTokens: 2, outputTokens: 3 } };
    const state = {
      get: <T>() => stored as T,
      update: vi.fn(async (_key: string, value: unknown) => { writes.push(value); }),
    };
    const store = new TranslationUsageStore(state);
    store.recordRequest('translationCalls');
    store.addUsage('translationCalls', { inputTokens: 5, outputTokens: 1, estimate: true });
    await store.flushed();
    expect(store.snapshot().translationCalls).toEqual({ calls: 2, inputTokens: 7, outputTokens: 4, estimatedCalls: 1 });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(store.snapshot());
  });

  it('contains global-state write failures so accounting cannot reject a session', async () => {
    const store = new TranslationUsageStore({
      get: () => undefined,
      update: async () => { throw new Error('storage unavailable'); },
    });
    store.recordRequest('translationCalls');
    await expect(store.flushed()).resolves.toBeUndefined();
    expect(store.snapshot().translationCalls.calls).toBe(1);
  });
});

describe('translation usage formatting', () => {
  it('marks approximate session tokens when any request was estimated', () => {
    const totals = {
      translationCalls: { calls: 2, inputTokens: 40, outputTokens: 10, estimatedCalls: 1 },
      authorizationCalls: { calls: 1, inputTokens: 3, outputTokens: 1, estimatedCalls: 0 },
    };
    expect(formatSessionUsage(totals)).toBe('[metrics] translate-llm: in≈43 out≈11 tok(3 calls; translation=2 authorization=1)');
  });

  it('keeps small direct-API reference ranges visible instead of rounding them to zero', () => {
    const report = formatTranslationUsageReport({
      translationCalls: { calls: 1, inputTokens: 10, outputTokens: 1, estimatedCalls: 0 },
      authorizationCalls: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCalls: 0 },
    });
    expect(report).toMatch(/\$0\.000015–\$0\.000030/);
  });

  it('formats cumulative buckets, subscription caveat, dated cost range, and source URLs', () => {
    const report = formatTranslationUsageReport({
      translationCalls: { calls: 2, inputTokens: 1_000_000, outputTokens: 100_000, estimatedCalls: 0 },
      authorizationCalls: { calls: 1, inputTokens: 0, outputTokens: 0, estimatedCalls: 0 },
    });
    expect(report).toMatch(/Translation requests: 2 .*1,000,000 input.*100,000 output/);
    expect(report).toMatch(/Authorization requests: 1/);
    expect(report).toMatch(/\$1\.50–\$3\.00/);
    expect(report).toMatch(/2026-07-18/);
    expect(report).toMatch(/anthropic\.com\/claude\/haiku/);
    expect(report).toMatch(/anthropic\.com\/news\/claude-sonnet-5/);
    expect(report).toMatch(/subscription channels.*marginal.*0/i);
  });
});
