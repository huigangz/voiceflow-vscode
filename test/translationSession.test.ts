import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session';
import {
  MutableStartupResource,
  prepareTranslationSnapshot,
  SessionPreflight,
  TranslationUnsupportedError,
  createTranslationSessionSnapshot,
  languageHintForSession,
  runCancellableStartup,
  startCancellableFallback,
  transcribeOptionsForSession,
  validateTranslationSnapshot,
} from '../src/translation/sessionPreflight';

const rules = {
  convertToSimplified: true,
  spacingCJKLatin: true,
  normalizePunctuation: true,
  collapseSpaces: true,
  stripHallucinations: true,
};

function snapshot(target: 'off' | 'zh' | 'en' = 'en') {
  return createTranslationSessionSnapshot({
    target,
    sourceHint: 'auto',
    useLlm: false,
    provider: undefined,
    timeoutMs: 8000,
    rules,
  });
}

describe('完整翻译会话快照(t2a)', () => {
  it('采集前复制并冻结 target/sourceHint/useLlm/provider/timeout/rules,后续配置漂移不影响会话', () => {
    const provider = {
      name: 'same-instance',
      prepare: async () => ({ ok: true as const }),
      run: async (_instruction: string, text: string) => ({
        ok: true as const,
        text,
        usage: { estimate: true },
      }),
    };
    const input = {
      target: 'en' as const,
      sourceHint: 'zh' as const,
      useLlm: true,
      provider,
      timeoutMs: 1234,
      rules: { ...rules },
    };
    const frozen = createTranslationSessionSnapshot(input);
    input.target = 'off' as 'en';
    input.timeoutMs = 9999;
    input.rules.collapseSpaces = false;
    expect(frozen).toEqual({
      target: 'en', sourceHint: 'zh', useLlm: true, provider, timeoutMs: 1234, rules,
    });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.rules)).toBe(true);
  });
});

describe('会话转写路由(t2a)', () => {
  it('target=en 路由 Whisper translate;off 保持默认 transcribe', () => {
    expect(transcribeOptionsForSession(snapshot('en'))).toEqual({ task: 'translate', translationTarget: 'en' });
    expect(transcribeOptionsForSession(snapshot('off'))).toEqual({});
  });

  it('翻译会话旁路语言锁定;off 会话维持锁定行为', () => {
    expect(languageHintForSession(snapshot('en'), 'zh')).toBe('auto');
    expect(languageHintForSession(snapshot('zh'), 'en')).toBe('auto');
    expect(languageHintForSession(snapshot('off'), 'zh')).toBe('zh');
  });
});

describe('翻译 preflight 编排(t2a)', () => {
  it('preparing 单飞:重复开始 no-op;完成后才进入 recording', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = preflight.run(async () => { await gate; return 'ready'; });
    expect(session.state).toBe('preparing');
    expect(preflight.active).toBe(true);
    await expect(preflight.run(async () => 'duplicate')).resolves.toEqual({ started: false, reason: 'busy' });
    release();
    await expect(first).resolves.toEqual({ started: true, value: 'ready' });
    expect(session.state).toBe('recording');
    expect(preflight.active).toBe(false);
  });

  it('Esc 取消等待回 idle;共享启动继续,晚到结果不进入 recording', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let release!: () => void;
    let sharedCompleted = false;
    let seenSignal: AbortSignal | undefined;
    const sharedStartup = new Promise<void>((resolve) => { release = resolve; }).then(() => { sharedCompleted = true; });
    const waiting = preflight.run(async (signal) => { seenSignal = signal; await sharedStartup; return 'late'; });
    expect(preflight.cancel()).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    expect(session.state).toBe('idle');
    await expect(waiting).resolves.toEqual({ started: false, reason: 'cancelled' });
    release();
    await sharedStartup;
    expect(sharedCompleted).toBe(true);
    expect(session.state).toBe('idle');
  });

  it('off 会话一穿而过,不解析引擎能力', async () => {
    let calls = 0;
    await validateTranslationSnapshot(snapshot('off'), {
      resolveCapabilities: async () => { calls++; throw new Error('must not run'); },
    }, new AbortController().signal);
    expect(calls).toBe(0);
  });

  it('target=en turbo 能力在录音前明确拒绝', async () => {
    await expect(validateTranslationSnapshot(snapshot('en'), {
      resolveCapabilities: async () => ({ engine: 'server' as const, model: 'large-v3-turbo', canTranslateToEn: false }),
    }, new AbortController().signal)).rejects.toBeInstanceOf(TranslationUnsupportedError);
  });

  it('分段 admission 等待中 Esc:晚到完成不得启动采集或进入 recording', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let release!: () => void;
    const gate = new Promise<string>((resolve) => { release = () => resolve('admitted'); });
    let starts = 0;
    const startup = runCancellableStartup(
      preflight,
      async () => gate,
      async () => { starts++; return { dispose() {} }; },
      (resource) => resource.dispose(),
    );
    expect(session.state).toBe('preparing');
    expect(preflight.cancel()).toBe(true);
    release();
    await expect(startup).resolves.toEqual({ started: false, reason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(0);
    expect(session.state).toBe('idle');
  });

  it('采集 start 等待中 Esc:晚到 controller/lease 立即释放', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let disposed = 0;
    const startup = runCancellableStartup(
      preflight,
      async () => 'admitted',
      async () => { await gate; return { dispose: () => { disposed++; } }; },
      (resource) => resource.dispose(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(preflight.cancel()).toBe(true);
    await expect(startup).resolves.toEqual({ started: false, reason: 'cancelled' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(1);
    expect(session.state).toBe('idle');
  });

  it('off segmented commits recording before admission but Esc still prevents late capture', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let release!: () => void;
    const admission = new Promise<string>((resolve) => { release = () => resolve('admitted'); });
    let starts = 0;
    const startup = runCancellableStartup(
      preflight,
      async () => admission,
      async () => { starts++; return { dispose() {} }; },
      (resource) => resource.dispose(),
      { commitImmediately: true },
    );

    expect(session.state).toBe('recording');
    expect(preflight.cancel()).toBe(true);
    release();
    await expect(startup).resolves.toEqual({ started: false, reason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(0);
    expect(session.state).toBe('idle');
  });

  it('target=en segmented remains preparing until recorder startup safely completes', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const startup = runCancellableStartup(
      preflight,
      async () => 'admitted',
      async () => { await started; return { dispose() {} }; },
      (resource) => resource.dispose(),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.state).toBe('preparing');
    release();
    await expect(startup).resolves.toMatchObject({ started: true });
    expect(session.state).toBe('recording');
  });

  it('freezes batch insertion target synchronously before deferred admission settles', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let source = 'initial-focus';
    let captures = 0;
    const startup = runCancellableStartup(
      preflight,
      async () => { await admission; return 'admitted'; },
      async (_admitted, _signal, frozenTarget) => frozenTarget,
      () => {},
      {
        commitImmediately: true,
        captureBeforeAdmission: () => {
          captures++;
          return source;
        },
      },
    );

    expect(captures).toBe(1);
    expect(session.state).toBe('recording');
    source = 'later-focus';
    releaseAdmission();

    await expect(startup).resolves.toEqual({ started: true, value: 'initial-focus' });
    expect(captures).toBe(1);
  });
});

describe('target=zh language detection', () => {
  it('forces per-call auto detection even when the frozen source hint is explicit', () => {
    const explicit = createTranslationSessionSnapshot({ ...snapshot('zh'), sourceHint: 'en' });
    expect(languageHintForSession(explicit, undefined)).toBe('auto');
    expect(languageHintForSession(explicit, 'zh')).toBe('auto');
  });
});

describe('target=zh provider preflight', () => {
  it('rejects useLlm=false before engine or provider access', async () => {
    const selectProvider = vi.fn();
    const resolveCapabilities = vi.fn();
    await expect(prepareTranslationSnapshot(
      snapshot('zh'), resolveCapabilities, selectProvider, new AbortController().signal,
    )).rejects.toThrow(/voiceflow\.translate\.useLlm.*transcript text.*external/i);
    expect(selectProvider).not.toHaveBeenCalled();
    expect(resolveCapabilities).not.toHaveBeenCalled();
  });

  it('rejects rules-only or unavailable provider before capture', async () => {
    const base = createTranslationSessionSnapshot({ ...snapshot('zh'), useLlm: true });
    await expect(prepareTranslationSnapshot(
      base, vi.fn(), async () => undefined, new AbortController().signal,
    )).rejects.toThrow(/provider.*unavailable/i);
  });

  it('prepares one selected provider and freezes that instance into the session', async () => {
    const calls: string[] = [];
    const provider = {
      name: 'frozen-provider',
      prepare: vi.fn(async () => { calls.push('prepare'); return { ok: true as const }; }),
      run: vi.fn(),
    };
    const base = createTranslationSessionSnapshot({ ...snapshot('zh'), useLlm: true });
    const prepared = await prepareTranslationSnapshot(
      base,
      vi.fn(),
      async () => { calls.push('select'); return provider; },
      new AbortController().signal,
    );
    expect(calls).toEqual(['select', 'prepare']);
    expect(prepared.provider).toBe(provider);
    expect(Object.isFrozen(prepared)).toBe(true);
  });

  it('reports authorization usage only when prepare made a metered request', async () => {
    const authorizationUsage = vi.fn();
    const usage = { inputTokens: 2, outputTokens: 1, estimate: false } as const;
    const base = createTranslationSessionSnapshot({ ...snapshot('zh'), useLlm: true });
    const withPing = {
      name: 'ping', prepare: async () => ({ ok: true as const, usage }), run: vi.fn(),
    };
    await prepareTranslationSnapshot(
      base, vi.fn(), async () => withPing, new AbortController().signal, authorizationUsage,
    );
    expect(authorizationUsage).toHaveBeenCalledOnce();
    expect(authorizationUsage).toHaveBeenCalledWith(usage);

    await prepareTranslationSnapshot(
      base,
      vi.fn(),
      async () => ({ ...withPing, prepare: async () => ({ ok: true as const }) }),
      new AbortController().signal,
      authorizationUsage,
    );
    expect(authorizationUsage).toHaveBeenCalledOnce();
  });

  it('reports authorization ping usage even when prepare rejects the session', async () => {
    const authorizationUsage = vi.fn();
    const usage = { inputTokens: 2, outputTokens: 1, estimate: false } as const;
    const base = createTranslationSessionSnapshot({ ...snapshot('zh'), useLlm: true });
    await expect(prepareTranslationSnapshot(
      base,
      vi.fn(),
      async () => ({
        name: 'denied',
        prepare: async () => ({ ok: false as const, kind: 'unavailable' as const, usage }),
        run: vi.fn(),
      }),
      new AbortController().signal,
      authorizationUsage,
    )).rejects.toThrow(/denied/);
    expect(authorizationUsage).toHaveBeenCalledOnce();
    expect(authorizationUsage).toHaveBeenCalledWith(usage);
  });

  it('contains provider prepare throws and reports prepare failures clearly', async () => {
    const base = createTranslationSessionSnapshot({ ...snapshot('zh'), useLlm: true });
    const thrown = { name: 'broken', prepare: async () => { throw new Error('prepare bug'); }, run: vi.fn() };
    await expect(prepareTranslationSnapshot(
      base, vi.fn(), async () => thrown, new AbortController().signal,
    )).rejects.toThrow(/broken.*prepare bug/i);

    const failed = {
      name: 'offline',
      prepare: async () => ({ ok: false as const, kind: 'unavailable' as const, message: 'not signed in' }),
      run: vi.fn(),
    };
    await expect(prepareTranslationSnapshot(
      base, vi.fn(), async () => failed, new AbortController().signal,
    )).rejects.toThrow(/offline.*not signed in/i);
  });

  it('treats prepare aborted as cancellation only when the session signal is aborted', async () => {
    const base = createTranslationSessionSnapshot({ ...snapshot('zh'), useLlm: true });
    const controller = new AbortController();
    const provider = {
      name: 'cancelled',
      prepare: async () => {
        controller.abort();
        return { ok: false as const, kind: 'aborted' as const };
      },
      run: vi.fn(),
    };
    await expect(prepareTranslationSnapshot(
      base, vi.fn(), async () => provider, controller.signal,
    )).rejects.toMatchObject({ name: 'CleanupCancelled' });

    await expect(prepareTranslationSnapshot(
      base,
      vi.fn(),
      async () => ({ ...provider, prepare: async () => ({ ok: false as const, kind: 'aborted' as const }) }),
      new AbortController().signal,
    )).rejects.toThrow(/cancelled.*aborted/i);
  });

  it('accounts authorization usage exactly once when an aborted prepare made a real request', async () => {
    const base = createTranslationSessionSnapshot({ ...snapshot('zh'), useLlm: true });
    const controller = new AbortController();
    const authorizationUsage = vi.fn();
    const usage = { inputTokens: 4, outputTokens: 1, estimate: false } as const;
    await expect(prepareTranslationSnapshot(
      base,
      vi.fn(),
      async () => ({
        name: 'cancelled-after-request',
        prepare: async () => {
          controller.abort();
          return { ok: false as const, kind: 'aborted' as const, usage };
        },
        run: vi.fn(),
      }),
      controller.signal,
      authorizationUsage,
    )).rejects.toMatchObject({ name: 'CleanupCancelled' });
    expect(authorizationUsage).toHaveBeenCalledOnce();
    expect(authorizationUsage).toHaveBeenCalledWith(usage);
  });

  it.each(['off', 'en'] as const)('target=%s never selects or prepares an LLM provider', async (target) => {
    const selectProvider = vi.fn();
    const resolveCapabilities = vi.fn(async () => ({
      engine: 'server' as const,
      model: 'small',
      canTranslateToEn: true,
    }));
    const prepared = await prepareTranslationSnapshot(
      snapshot(target), resolveCapabilities, selectProvider, new AbortController().signal,
    );
    expect(selectProvider).not.toHaveBeenCalled();
    expect(prepared.provider).toBeUndefined();
    expect(resolveCapabilities).toHaveBeenCalledTimes(target === 'en' ? 1 : 0);
  });
});

describe('segmented mutable startup ownership', () => {
  it('does not create a fallback after early aggregate disposal', async () => {
    const abort = new AbortController();
    const disposed = { addon: 0, helper: 0 };
    const owner = new MutableStartupResource<{ start(): Promise<void>; dispose(): void }>(
      (resource) => resource.dispose(),
    );
    let rejectAddon!: (error: Error) => void;
    let helperCreates = 0;
    const addon = {
      start: () => new Promise<void>((_, reject) => { rejectAddon = reject; }),
      dispose: () => { disposed.addon++; },
    };
    const startup = startCancellableFallback({
      signal: abort.signal,
      owner,
      createPrimary: () => addon,
      createFallback: () => {
        helperCreates++;
        return { start: async () => {}, dispose: () => { disposed.helper++; } };
      },
      shouldFallback: () => true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    abort.abort();
    owner.dispose();
    rejectAddon(new Error('fallback eligible'));

    await expect(startup).rejects.toThrow();
    expect(helperCreates).toBe(0);
    expect(disposed).toEqual({ addon: 1, helper: 0 });
  });

  it('disposes a helper exactly once when cancellation lands during helper start', async () => {
    const abort = new AbortController();
    const disposed = { addon: 0, helper: 0 };
    const owner = new MutableStartupResource<{ start(): Promise<void>; dispose(): void }>(
      (resource) => resource.dispose(),
    );
    let releaseHelper!: () => void;
    let helperStarted!: () => void;
    const helperStarting = new Promise<void>((resolve) => { helperStarted = resolve; });
    const startup = startCancellableFallback({
      signal: abort.signal,
      owner,
      createPrimary: () => ({
        start: async () => { throw new Error('fallback eligible'); },
        dispose: () => { disposed.addon++; },
      }),
      createFallback: () => ({
        start: () => {
          helperStarted();
          return new Promise<void>((resolve) => { releaseHelper = resolve; });
        },
        dispose: () => { disposed.helper++; },
      }),
      shouldFallback: () => true,
    });
    await helperStarting;

    abort.abort();
    owner.dispose();
    releaseHelper();

    await expect(startup).rejects.toThrow();
    expect(disposed).toEqual({ addon: 1, helper: 1 });
  });

  it('immediately disposes a controller assigned after aggregate disposal', () => {
    let disposed = 0;
    const owner = new MutableStartupResource<{ dispose(): void }>((resource) => resource.dispose());
    owner.dispose();

    expect(owner.replace({ dispose: () => { disposed++; } })).toBe(false);
    expect(disposed).toBe(1);
  });
});

describe('batch and toggle startup cancellation', () => {
  it('batch Esc disposes an in-flight primary immediately and blocks late live assignment', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let releasePrimary!: () => void;
    let primaryStarted!: () => void;
    const primaryStarting = new Promise<void>((resolve) => { primaryStarted = resolve; });
    let disposed = 0;
    let assignedLive = false;
    const owner = new MutableStartupResource<{ start(): Promise<void>; dispose(): void }>(
      (resource) => resource.dispose(),
    );
    const startup = runCancellableStartup(
      preflight,
      async () => 'admitted',
      async (_admission, signal) => {
        const controller = await startCancellableFallback({
          signal,
          owner,
          createPrimary: () => ({
            start: () => {
              primaryStarted();
              return new Promise<void>((resolve) => { releasePrimary = resolve; });
            },
            dispose: () => { disposed++; },
          }),
          createFallback: () => ({ start: async () => {}, dispose: () => {} }),
          shouldFallback: () => false,
        });
        assignedLive = true;
        return controller;
      },
      () => owner.dispose(),
      { commitImmediately: true, onCancel: () => owner.dispose() },
    );
    await primaryStarting;

    expect(preflight.cancel()).toBe(true);
    expect(session.state).toBe('idle');
    expect(disposed).toBe(1);
    expect(assignedLive).toBe(false);
    await expect(startup).resolves.toEqual({ started: false, reason: 'cancelled' });

    releasePrimary();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(1);
    expect(assignedLive).toBe(false);
  });

  it('batch Esc during helper start disposes primary and helper exactly once without going live', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let releaseHelper!: () => void;
    let helperStarted!: () => void;
    const helperStarting = new Promise<void>((resolve) => { helperStarted = resolve; });
    const disposed = { addon: 0, helper: 0 };
    let assignedLive = false;
    const owner = new MutableStartupResource<{ start(): Promise<void>; dispose(): void }>(
      (resource) => resource.dispose(),
    );
    const startup = runCancellableStartup(
      preflight,
      async () => 'admitted',
      async (_admission, signal) => {
        const controller = await startCancellableFallback({
          signal,
          owner,
          createPrimary: () => ({
            start: async () => { throw new Error('fallback eligible'); },
            dispose: () => { disposed.addon++; },
          }),
          createFallback: () => ({
            start: () => {
              helperStarted();
              return new Promise<void>((resolve) => { releaseHelper = resolve; });
            },
            dispose: () => { disposed.helper++; },
          }),
          shouldFallback: () => true,
        });
        assignedLive = true;
        return controller;
      },
      () => owner.dispose(),
      { commitImmediately: true, onCancel: () => owner.dispose() },
    );
    await helperStarting;

    expect(preflight.cancel()).toBe(true);
    expect(disposed).toEqual({ addon: 1, helper: 1 });
    expect(assignedLive).toBe(false);
    await expect(startup).resolves.toEqual({ started: false, reason: 'cancelled' });

    releaseHelper();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toEqual({ addon: 1, helper: 1 });
    expect(assignedLive).toBe(false);
  });

  it('toggle during off segmented recorder start cancels instead of finishing an unready controller', async () => {
    const session = new Session();
    const preflight = new SessionPreflight(session);
    let releaseStart!: () => void;
    let controllerStarted!: () => void;
    const controllerStarting = new Promise<void>((resolve) => { controllerStarted = resolve; });
    let disposed = 0;
    let finishes = 0;
    const controller = {
      start: () => {
        controllerStarted();
        return new Promise<void>((resolve) => { releaseStart = resolve; });
      },
      finish: async () => { finishes++; },
      dispose: () => { disposed++; },
    };
    const owner = new MutableStartupResource<typeof controller>((resource) => resource.dispose());
    const startup = runCancellableStartup(
      preflight,
      async () => 'admitted',
      async (_admission, signal) => startCancellableFallback({
        signal,
        owner,
        createPrimary: () => controller,
        createFallback: () => controller,
        shouldFallback: () => false,
      }),
      () => owner.dispose(),
      { commitImmediately: true, onCancel: () => owner.dispose() },
    );
    await controllerStarting;
    expect(session.state).toBe('recording');

    // A second toggle must take the live-generation cancellation branch, never normal finish().
    expect(preflight.cancel()).toBe(true);
    expect(session.state).toBe('idle');
    expect(finishes).toBe(0);
    expect(disposed).toBe(1);
    await expect(startup).resolves.toEqual({ started: false, reason: 'cancelled' });

    releaseStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finishes).toBe(0);
    expect(disposed).toBe(1);
  });
});
