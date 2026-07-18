import { describe, expect, it, vi } from 'vitest';
import { CleanupCancelled } from '../src/cleanup/pipeline';
import { TranslationResult } from '../src/translation/pipeline';
import { TranslationCoordinator } from '../src/translation/coordinator';

const result = (outcome: TranslationResult['outcome']): TranslationResult => ({ text: outcome, outcome });

describe('TranslationCoordinator', () => {
  it.each(['timeout', 'error', 'empty', 'rejected'] as const)(
    'counts %s as a failure and opens after three consecutive failures',
    async (failure) => {
      const translate = vi.fn(async () => result(failure));
      const coordinator = new TranslationCoordinator(translate, (source) => source.trim());
      await coordinator.run(' one ', 'en', new AbortController().signal);
      await coordinator.run(' two ', 'en', new AbortController().signal);
      expect(coordinator.isOpen).toBe(false);
      await coordinator.run(' three ', 'en', new AbortController().signal);
      expect(coordinator.isOpen).toBe(true);
      await expect(coordinator.run(' four ', 'en', new AbortController().signal)).resolves.toEqual({
        text: 'four',
        outcome: 'circuit-open',
      });
      expect(translate).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['translated', 'identity'] as const)('%s resets the consecutive failure count', async (success) => {
    const outcomes: TranslationResult[] = [result('error'), result('timeout'), result(success), result('empty'), result('rejected'), result('error')];
    const coordinator = new TranslationCoordinator(async () => outcomes.shift()!, (source) => source);
    for (let i = 0; i < 5; i++) await coordinator.run(String(i), 'en', new AbortController().signal);
    expect(coordinator.isOpen).toBe(false);
    await coordinator.run('5', 'en', new AbortController().signal);
    expect(coordinator.isOpen).toBe(true);
  });

  it('opens immediately on a rate-limit failure and does not retry in the session', async () => {
    const translate = vi.fn(async (): Promise<TranslationResult> => ({
      text: 'hello',
      outcome: 'error',
      failure: { kind: 'rate-limit', retryAfterMs: 60_000 },
    }));
    const coordinator = new TranslationCoordinator(translate, (source) => source);
    await coordinator.run('hello', 'en', new AbortController().signal);
    expect(coordinator.isOpen).toBe(true);
    expect(await coordinator.run('again', 'en', new AbortController().signal)).toEqual({
      text: 'again',
      outcome: 'circuit-open',
    });
    expect(translate).toHaveBeenCalledOnce();
  });

  it('can be opened by backlog pressure before another provider call', async () => {
    const translate = vi.fn(async () => result('translated'));
    const coordinator = new TranslationCoordinator(translate, (source) => source);
    coordinator.openForBacklog(31_000);
    expect(await coordinator.run('source', 'en', new AbortController().signal)).toEqual({
      text: 'source',
      outcome: 'circuit-open',
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('does not count cancellation as a circuit failure', async () => {
    let calls = 0;
    const coordinator = new TranslationCoordinator(async () => {
      calls++;
      if (calls === 1) throw new CleanupCancelled();
      return result('error');
    }, (source) => source);
    await expect(coordinator.run('cancel', 'en', new AbortController().signal)).rejects.toBeInstanceOf(CleanupCancelled);
    await coordinator.run('one', 'en', new AbortController().signal);
    await coordinator.run('two', 'en', new AbortController().signal);
    expect(coordinator.isOpen).toBe(false);
    await coordinator.run('three', 'en', new AbortController().signal);
    expect(coordinator.isOpen).toBe(true);
  });

  it.each([
    ['empty rules', () => ''],
    ['throwing rules', () => { throw new Error('rules failed'); }],
  ])('circuit-open preserves non-empty source when %s fallback cannot produce text', async (_name, rules) => {
    const coordinator = new TranslationCoordinator(async () => result('translated'), rules);
    coordinator.openForBacklog(31_000);
    await expect(coordinator.run(' source text ', 'en', new AbortController().signal)).resolves.toEqual({
      text: 'source text',
      outcome: 'circuit-open',
    });
  });
});
