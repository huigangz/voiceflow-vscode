import { describe, expect, it, vi } from 'vitest';
import {
  TRANSLATION_PRIVACY_NOTICE_KEY,
  maybeShowTranslationPrivacyNotice,
} from '../src/translation/privacyNotice';

describe('translation privacy notice', () => {
  it('shows a nonmodal text-externalization notice once and stores only the seen flag', async () => {
    const values = new Map<string, unknown>();
    const state = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    };
    const show = vi.fn(async (_message: string) => undefined);
    expect(maybeShowTranslationPrivacyNotice(state, show)).toBe(true);
    await Promise.resolve();
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0]?.[0]).toMatch(/transcript text.*selected LLM provider.*external/i);
    expect(state.update).toHaveBeenCalledWith(TRANSLATION_PRIVACY_NOTICE_KEY, true);
    expect([...values.keys()]).toEqual([TRANSLATION_PRIVACY_NOTICE_KEY]);

    expect(maybeShowTranslationPrivacyNotice(state, show)).toBe(false);
    expect(show).toHaveBeenCalledOnce();
  });

  it('claims the in-process notice before persistence so concurrent calls show only once', () => {
    const state = {
      get: <T>(_key: string) => undefined as T | undefined,
      update: vi.fn(() => new Promise<void>(() => {})),
    };
    const show = vi.fn(async (_message: string) => undefined);
    expect(maybeShowTranslationPrivacyNotice(state, show)).toBe(true);
    expect(maybeShowTranslationPrivacyNotice(state, show)).toBe(false);
    expect(show).toHaveBeenCalledOnce();
    expect(state.update).toHaveBeenCalledOnce();
  });

  it('contains synchronous and asynchronous persistence failures without repeating the notice', async () => {
    const asyncFailure = {
      get: <T>(_key: string) => undefined as T | undefined,
      update: vi.fn(async () => { throw new Error('write rejected'); }),
    };
    const show = vi.fn(async (_message: string) => undefined);
    expect(maybeShowTranslationPrivacyNotice(asyncFailure, show)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(maybeShowTranslationPrivacyNotice(asyncFailure, show)).toBe(false);

    const syncFailure = {
      get: <T>(_key: string) => undefined as T | undefined,
      update: vi.fn((): Promise<void> => { throw new Error('write threw'); }),
    };
    expect(() => maybeShowTranslationPrivacyNotice(syncFailure, show)).not.toThrow();
    expect(maybeShowTranslationPrivacyNotice(syncFailure, show)).toBe(false);
    expect(show).toHaveBeenCalledTimes(2);
  });
});
