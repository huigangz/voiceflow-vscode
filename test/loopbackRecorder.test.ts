/** P2c-3:LoopbackRecorder 单测(fake addon + fake vad,fake 时钟)。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoopbackAddonModule, LoopbackRecorder } from '../src/audio/loopbackRecorder';
import { FrameVad } from '../src/audio/frameVad';
import { PcmChunk, RecorderError } from '../src/audio/recorder';

const noop = (): void => {};

class FakeModule implements LoopbackAddonModule {
  started = 0;
  stopped = 0;
  deviceStopped = false;
  overflowFrames = 0;
  queue: Float32Array[] = [];
  startLoopback(): { sampleRate: number; channels: number } {
    this.started++;
    return { sampleRate: 48000, channels: 2 };
  }
  read(): Float32Array {
    return this.queue.shift() ?? new Float32Array(0);
  }
  getStatus(): { running: boolean; deviceStopped: boolean; overflowFrames: number } {
    return { running: this.started > this.stopped, deviceStopped: this.deviceStopped, overflowFrames: this.overflowFrames };
  }
  stop(): void {
    this.stopped++;
  }
  /** 排入 n 毫秒 48k 立体声数据(幅值 amp)。 */
  feed(ms: number, amp = 0.5): void {
    const frames = Math.round((ms / 1000) * 48000);
    const f = new Float32Array(frames * 2).fill(amp);
    this.queue.push(f);
  }
}

/** 幅值 VAD fake:帧均值绝对值 > 500 判语音(补零帧恒 false)。 */
class AmplitudeVad implements FrameVad {
  process(frame: Int16Array): Promise<boolean> {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += Math.abs(frame[i]!);
    return Promise.resolve(s / frame.length > 500);
  }
  reset(): void {}
}

function collect(): { chunks: PcmChunk[]; errors: RecorderError[]; events: Parameters<LoopbackRecorder['start']>[0] } {
  const chunks: PcmChunk[] = [];
  const errors: RecorderError[] = [];
  return {
    chunks,
    errors,
    events: { onChunk: (c) => chunks.push(c), onSpeechStart: noop, onError: (e) => errors.push(e) },
  };
}

function makeRecorder(mod: FakeModule, vad: FrameVad = new AmplitudeVad()): LoopbackRecorder {
  return new LoopbackRecorder(noop, () => mod, () => Promise.resolve(vad), () => Date.now());
}

afterEach(() => vi.useRealTimers());

describe('LoopbackRecorder', () => {
  it('load 失败 → module-unavailable;startLoopback 抛错 → init-failed;vad 失败 → init-failed', async () => {
    const bad = new LoopbackRecorder(noop, () => { throw new Error('no addon'); }, () => Promise.resolve(new AmplitudeVad()));
    await expect(bad.start(collect().events)).rejects.toMatchObject({ code: 'module-unavailable' });

    const mod = new FakeModule();
    mod.startLoopback = () => { throw new Error('ma_device_init failed'); };
    await expect(makeRecorder(mod).start(collect().events)).rejects.toMatchObject({ code: 'init-failed' });

    const mod2 = new FakeModule();
    const noVad = new LoopbackRecorder(noop, () => mod2, () => Promise.reject(new Error('model missing')));
    await expect(noVad.start(collect().events)).rejects.toMatchObject({ code: 'init-failed' });
  });

  it('数据流:48k stereo → 16k mono 512 帧,timeMs 32ms 步进,VAD 标记生效', async () => {
    vi.useFakeTimers();
    const mod = new FakeModule();
    const rec = makeRecorder(mod);
    const c = collect();
    await rec.start(c.events);

    for (let i = 0; i < 5; i++) mod.feed(100); // 500ms 有声数据
    await vi.advanceTimersByTimeAsync(600);
    rec.dispose();

    expect(c.chunks.length).toBeGreaterThan(8); // ~15 帧(FIR 暖机损耗几帧)
    for (let i = 1; i < c.chunks.length; i++) {
      expect(c.chunks[i]!.timeMs - c.chunks[i - 1]!.timeMs).toBe(32);
    }
    expect(c.chunks.filter((x) => x.isSpeech).length).toBeGreaterThan(5);
    expect(c.errors).toHaveLength(0);
  });

  it('渲染流中断 → GapFiller 补静音帧(isSpeech=false),时间线不断', async () => {
    vi.useFakeTimers();
    const mod = new FakeModule();
    const rec = makeRecorder(mod);
    const c = collect();
    await rec.start(c.events);

    mod.feed(200); // 先有 200ms 声音
    await vi.advanceTimersByTimeAsync(300);
    const beforeGap = c.chunks.length;
    await vi.advanceTimersByTimeAsync(1500); // 无数据:纯靠补零推进
    rec.dispose();

    expect(c.chunks.length).toBeGreaterThan(beforeGap + 20); // 补出 ≥0.7s 静音帧
    const gapChunks = c.chunks.slice(beforeGap + 5);
    expect(gapChunks.every((x) => !x.isSpeech)).toBe(true); // 补零帧非语音 → 可切段
    expect(c.errors).toHaveLength(0);
  });

  it('deviceStopped → device-lost 恰一次,addon 收尾,后续零事件', async () => {
    vi.useFakeTimers();
    const mod = new FakeModule();
    const rec = makeRecorder(mod);
    const c = collect();
    await rec.start(c.events);

    await vi.advanceTimersByTimeAsync(200);
    mod.deviceStopped = true;
    await vi.advanceTimersByTimeAsync(300);

    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]!.code).toBe('device-lost');
    expect(mod.stopped).toBeGreaterThan(0);
    const frozen = c.chunks.length;
    mod.deviceStopped = false;
    mod.feed(500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.chunks.length).toBe(frozen);
    expect(c.errors).toHaveLength(1);
  });

  it('缓冲溢出 → device-lost(丢数据绝不静默)', async () => {
    vi.useFakeTimers();
    const mod = new FakeModule();
    const rec = makeRecorder(mod);
    const c = collect();
    await rec.start(c.events);
    mod.overflowFrames = 4800;
    await vi.advanceTimersByTimeAsync(200);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]!.message).toContain('溢出');
  });

  it('stop 做末次冲刷(残余数据仍交付),dispose 后零事件', async () => {
    vi.useFakeTimers();
    const mod = new FakeModule();
    const rec = makeRecorder(mod);
    const c = collect();
    await rec.start(c.events);

    mod.feed(300);
    await vi.advanceTimersByTimeAsync(100); // 只消化了一部分
    mod.feed(100); // stop 前又到一批
    await rec.stop();
    const afterStop = c.chunks.length;
    expect(afterStop).toBeGreaterThan(3); // 末次冲刷把队列里的都吐了
    expect(mod.stopped).toBeGreaterThan(0);

    rec.dispose();
    mod.feed(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(c.chunks.length).toBe(afterStop);
  });
});
