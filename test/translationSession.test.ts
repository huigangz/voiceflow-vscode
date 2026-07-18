import { describe, expect, it } from 'vitest';
import { Session } from '../src/session';
import {
  SessionPreflight,
  TranslationUnsupportedError,
  createTranslationSessionSnapshot,
  languageHintForSession,
  runCancellableStartup,
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
    const provider = { name: 'same-instance', cleanup: async (text: string) => text };
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
    await expect(preflight.run(async () => 'duplicate')).resolves.toEqual({ started: false, reason: 'busy' });
    release();
    await expect(first).resolves.toEqual({ started: true, value: 'ready' });
    expect(session.state).toBe('recording');
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
});
