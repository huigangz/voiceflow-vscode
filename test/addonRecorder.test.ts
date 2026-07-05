/**
 * AddonRecorder 双层测试(P2a 步骤 5):
 * ① fake 注入纯单测 —— 错误映射按 code、节拍补读/欠账、drain-before-stop 顺序、
 *    dispose 后零事件(评审 v7-④)、watchdog 纯逻辑(不需 exe fixture);
 * ② 真设备集成 —— canRun 探测,SAC/无麦环境优雅跳过。
 *
 * fake 时钟说明:欠账补读按 Date.now() 记账 → 大多数用例连 Date 一起 fake
 * (advanceTimersByTime 同步推进系统时间);watchdog 用例反过来**只 fake 计时器**
 * (Date 走真实时钟,推进 1.5s 假定时器时真实 elapsed≈0 → owed=0 → tick 零帧,
 * 正好构造"tick 在跑但无帧交付"的水位场景)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AddonModule,
  AddonRecorder,
  AddonRecorderHandle,
  loadPvRecorderModule,
} from '../src/audio/addonRecorder';
import { PcmChunk, RecorderError } from '../src/audio/recorder';

const noop = (): void => {};

/** 可编程 fake:按调用产帧;可注入 read 异常与"阻塞读"(读时推进假时钟)。 */
class FakeHandle implements AddonRecorderHandle {
  readonly sampleRate = 16000;
  calls: string[] = [];
  reads = 0;
  /** 每次 readSync 抛错(模拟设备失效)。 */
  throwOnRead = false;
  /** 每次 readSync 推进假时钟 ms(模拟空缓冲阻塞读;仅 fake-Date 用例可用)。 */
  blockMsPerRead = 0;
  /** 产出帧的幅值(>~330 会被 0.01 RMS 阈值判为语音)。 */
  amplitude = 0;

  start(): void { this.calls.push('start'); }
  stop(): void { this.calls.push('stop'); }
  release(): void { this.calls.push('release'); }
  getSelectedDevice(): string { return 'FakeMic'; }
  readSync(): Int16Array {
    this.calls.push('read');
    if (this.throwOnRead) throw new Error('PvRecorder failed to read audio data frame.');
    if (this.blockMsPerRead > 0) vi.advanceTimersByTime(this.blockMsPerRead);
    this.reads++;
    return new Int16Array(512).fill(this.amplitude);
  }
}

function makeModule(handle: FakeHandle, devices: string[] = ['FakeMic']): AddonModule {
  return { getAvailableDevices: () => devices, create: () => handle };
}

interface Collected {
  chunks: PcmChunk[];
  errors: RecorderError[];
  speechStarts: number;
}

function collector(): Collected & { events: Parameters<AddonRecorder['start']>[0] } {
  const c: Collected = { chunks: [], errors: [], speechStarts: 0 };
  return {
    ...c,
    events: {
      onChunk: (ch) => c.chunks.push(ch),
      onSpeechStart: () => c.speechStarts++,
      onError: (e) => c.errors.push(e),
    },
    get chunks() { return c.chunks; },
    get errors() { return c.errors; },
    get speechStarts() { return c.speechStarts; },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AddonRecorder(fake 注入)', () => {
  it('loadModule 抛错 → module-unavailable(可回退语义,评审 v7-②)', async () => {
    const rec = new AddonRecorder(noop, () => { throw new Error('Cannot find module'); });
    await expect(
      rec.start({ onChunk: noop, onSpeechStart: noop, onError: noop }),
    ).rejects.toMatchObject({ code: 'module-unavailable' });
  });

  it('设备列表为空 → no-device(不回退)', async () => {
    const rec = new AddonRecorder(noop, () => makeModule(new FakeHandle(), []));
    await expect(
      rec.start({ onChunk: noop, onSpeechStart: noop, onError: noop }),
    ).rejects.toMatchObject({ code: 'no-device' });
  });

  it('native start 抛错且不匹配权限特征串 → init-failed(不回退,评审 v3-④)', async () => {
    const handle = new FakeHandle();
    handle.start = () => { throw new Error('PvRecorderStatusBackendError something'); };
    const rec = new AddonRecorder(noop, () => makeModule(handle));
    await expect(
      rec.start({ onChunk: noop, onSpeechStart: noop, onError: noop }),
    ).rejects.toMatchObject({ code: 'init-failed' });
    // 创建过的 handle 必须被释放
    expect(handle.calls).toContain('release');
  });

  it('init 抛 PvRecorderStatusRuntimeError(隐私开关实测特征)→ permission-denied', async () => {
    // 2026-07-04 实测:隐私开关关闭 + 设备在场 → 构造抛该类;设备不在场路径被 no-device 前置拦截
    class PvRecorderStatusRuntimeError extends Error {}
    const handle = new FakeHandle();
    handle.start = () => { throw new PvRecorderStatusRuntimeError('PvRecorder failed to initialize.'); };
    const rec = new AddonRecorder(noop, () => makeModule(handle));
    await expect(
      rec.start({ onChunk: noop, onSpeechStart: noop, onError: noop }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('节拍补读:按墙钟欠账产帧,时间戳 32ms 单调递增,语音帧触发一次 onSpeechStart', async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    handle.amplitude = 5000; // 语音级幅值
    const rec = new AddonRecorder(noop, () => makeModule(handle));
    const c = collector();
    await rec.start(c.events);

    await vi.advanceTimersByTimeAsync(500); // 5 个 tick
    // 500ms/32ms ≈ 15 帧,留 1 帧余量 → 至少 12
    expect(c.chunks.length).toBeGreaterThanOrEqual(12);
    expect(c.chunks.length).toBeLessThanOrEqual(16);
    for (let i = 1; i < c.chunks.length; i++) {
      expect(c.chunks[i]!.timeMs - c.chunks[i - 1]!.timeMs).toBe(32);
    }
    expect(c.speechStarts).toBe(1);
    expect(c.errors).toHaveLength(0);
    rec.dispose();
  });

  it('stop = 先 drain 欠账帧再 native stop/release(顺序断言,S2 尾字不吞)', async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    const rec = new AddonRecorder(noop, () => makeModule(handle));
    const c = collector();
    await rec.start(c.events);

    await vi.advanceTimersByTimeAsync(300); // 正常采集若干帧
    const beforeStop = c.chunks.length;
    vi.advanceTimersByTime(90); // 不触发 tick(100ms 周期),制造 ~3 帧欠账
    await rec.stop();

    // 尾帧被 drain 交付
    expect(c.chunks.length).toBeGreaterThan(beforeStop);
    // 顺序:全部 read 都发生在 native stop 之前(spike 实测 stop 后缓冲不可读)
    const stopIdx = handle.calls.indexOf('stop');
    const lastReadIdx = handle.calls.lastIndexOf('read');
    expect(stopIdx).toBeGreaterThan(lastReadIdx);
    expect(handle.calls.indexOf('release')).toBeGreaterThan(stopIdx);
    rec.dispose();
  });

  it('dispose 后零事件(评审 v7-④ generation 防护 + 计时器清理)', async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    const rec = new AddonRecorder(noop, () => makeModule(handle));
    const c = collector();
    await rec.start(c.events);

    await vi.advanceTimersByTimeAsync(300);
    const frozen = c.chunks.length;
    rec.dispose();
    expect(handle.calls).toContain('release');

    await vi.advanceTimersByTimeAsync(2000); // 越过 watchdog 水位
    expect(c.chunks.length).toBe(frozen); // 无新 chunk
    expect(c.errors).toHaveLength(0);     // 无迟到 device-lost
  });

  it('录音中 read 抛错 → device-lost 一次,handle 收尾,后续零事件', async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    const rec = new AddonRecorder(noop, () => makeModule(handle));
    const c = collector();
    await rec.start(c.events);

    await vi.advanceTimersByTimeAsync(200);
    handle.throwOnRead = true;
    await vi.advanceTimersByTimeAsync(200);

    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]!.code).toBe('device-lost');
    expect(handle.calls).toContain('release');

    const frozenChunks = c.chunks.length;
    handle.throwOnRead = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.chunks.length).toBe(frozenChunks);
    expect(c.errors).toHaveLength(1); // 不重复报
  });

  it('阻塞读(>20ms)→ 进 suspect 模式:本 tick 立即收手', async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    handle.blockMsPerRead = 35; // 每次读都"阻塞"35ms
    const rec = new AddonRecorder(noop, () => makeModule(handle));
    const c = collector();
    await rec.start(c.events);

    await vi.advanceTimersByTimeAsync(100); // 首个 tick
    // 阻塞读下每 tick 只应读 1 帧就收手(而非按欠账连读)
    // 之后 owed 因阻塞推进时钟而增长,但每 tick 仍受 suspect 门控
    const reads1 = handle.reads;
    expect(reads1).toBeLessThanOrEqual(2);
    rec.dispose();
  });

  it('watchdog:tick 在跑但持续零帧交付 → 1.5s device-lost(纯逻辑,不需 exe fixture)', async () => {
    // 只 fake 计时器、不 fake Date:假时间推进 1.6s 时真实 elapsed≈0 → owed=0 → 每 tick 零帧
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const handle = new FakeHandle();
    const rec = new AddonRecorder(noop, () => makeModule(handle));
    const c = collector();
    await rec.start(c.events);

    await vi.advanceTimersByTimeAsync(1600);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]!.code).toBe('device-lost');
    expect(c.errors[0]!.message).toContain('watchdog');
    expect(handle.calls).toContain('release');
  });
});

// ---------- ② 真设备集成(canRun skip 模式)----------

function canRunReal(): boolean {
  try {
    const mod = loadPvRecorderModule();
    return mod.getAvailableDevices().length > 0;
  } catch {
    return false; // 模块加载失败(CI 无包/SAC)或无设备 → 跳过
  }
}

describe.skipIf(!canRunReal())('AddonRecorder(真设备)', () => {
  it('start → 真麦克风采集 ≥1s → drain-stop 干净收尾', async () => {
    const rec = new AddonRecorder(noop);
    const chunks: PcmChunk[] = [];
    let err: RecorderError | undefined;
    await rec.start({
      onChunk: (ch) => chunks.push(ch),
      onSpeechStart: noop,
      onError: (e) => { err = e; },
    });
    await new Promise((r) => setTimeout(r, 1200));
    await rec.stop();
    rec.dispose();

    expect(err).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(25); // ≥1.2s ≈ 37 帧,余量放宽
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.timeMs).toBeGreaterThan(chunks[i - 1]!.timeMs);
    }
  }, 15000);
});
