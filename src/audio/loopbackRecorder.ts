/**
 * P2c:系统音频(loopback)录音器 —— 实现 Recorder 接口,直接插入既有
 * SegmentedRecordingController/segmentPipeline(与 backend 无关,评审 v6-③ 的红利)。
 *
 * 链路:voiceflow-audio.node(注入)→ F32ToS16Converter(原生率/声道 → 16k mono s16)
 *      → GapFiller(补"无渲染流"间隙,时间线连续)→ FrameVad(Silero,D4)→ PcmChunk。
 *
 * 与 2a AddonRecorder 的差异:
 * - 数据水位 watchdog 不适用:GapFiller 使数据流恒续(静默期也出零帧)→ 设备失效检测
 *   改为轮询 addon status(deviceStopped = ma 停止通知;overflowFrames = 缓冲溢出丢数据)
 * - 无 helper 回退:load 失败 → module-unavailable 直接呈现(系统音频无备用采集路径)
 * - VAD 异步(Silero ~0.2ms/帧),tick 内 await;busy 门防重入
 */
import { PcmChunk, Recorder, RecorderError, RecorderEvents } from './recorder';
import { F32ToS16Converter } from './formatConvert';
import { GapFiller } from './gapFiller';
import { FrameVad } from './frameVad';
import { FRAME_SAMPLES } from './energyVad';

export interface LoopbackAddonModule {
  startLoopback(): { sampleRate: number; channels: number };
  read(): Float32Array;
  getStatus(): { running: boolean; deviceStopped: boolean; overflowFrames: number };
  stop(): void;
}

export type LoadLoopbackModule = () => LoopbackAddonModule;

/** 默认实现:require 自研 addon(bin/ 内,路径由 extension 提供)。 */
export function loadVoiceflowAudio(addonPath: string): LoadLoopbackModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return () => require(addonPath) as LoopbackAddonModule;
}

const TICK_MS = 100;
const FRAME_MS = 32;

/** 512 采样帧切片器(跨块拼帧)。 */
class FrameSlicer {
  private chunks: Int16Array[] = [];
  private buffered = 0;

  push(c: Int16Array): void {
    if (c.length === 0) return;
    this.chunks.push(c);
    this.buffered += c.length;
  }

  next(): Int16Array | undefined {
    if (this.buffered < FRAME_SAMPLES) return undefined;
    const frame = new Int16Array(FRAME_SAMPLES);
    let need = FRAME_SAMPLES;
    let off = 0;
    while (need > 0) {
      const head = this.chunks[0]!;
      const take = Math.min(need, head.length);
      frame.set(head.subarray(0, take), off);
      off += take;
      need -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.buffered -= FRAME_SAMPLES;
    return frame;
  }
}

export class LoopbackRecorder implements Recorder {
  public mode = 'loopback-silero';

  private module: LoopbackAddonModule | undefined;
  private vad: FrameVad | undefined;
  private converter: F32ToS16Converter | undefined;
  private readonly gapFiller = new GapFiller();
  private readonly slicer = new FrameSlicer();
  private tickTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private stopping = false;
  private errored = false;
  private busy = false;
  private emittedFrames = 0;
  private speechAnnounced = false;
  private events: RecorderEvents | undefined;

  constructor(
    private readonly log: (line: string) => void,
    private readonly loadModule: LoadLoopbackModule,
    private readonly vadFactory: () => Promise<FrameVad>,
    private readonly now: () => number = Date.now,
  ) {}

  async start(events: RecorderEvents): Promise<void> {
    const gen = ++this.generation;
    this.stopping = false;
    this.errored = false;
    this.events = events;

    // ① 懒加载自研 addon(无回退路径:失败直接呈现,评审 v6-⑦ 语义下的 module-unavailable)
    try {
      this.module = this.loadModule();
    } catch (err) {
      throw new RecorderError(
        'module-unavailable',
        `系统音频采集模块加载失败:${String((err as Error)?.message ?? err)}`,
      );
    }
    // ② VAD(Silero:onnxruntime + 模型加载)
    try {
      this.vad = await this.vadFactory();
    } catch (err) {
      throw new RecorderError(
        'init-failed',
        `VAD 初始化失败(onnxruntime/模型):${String((err as Error)?.message ?? err)}`,
      );
    }
    // ③ 启动采集
    let fmt: { sampleRate: number; channels: number };
    try {
      fmt = this.module.startLoopback();
    } catch (err) {
      throw new RecorderError(
        'init-failed',
        `loopback 启动失败:${String((err as Error)?.message ?? err)}`,
      );
    }
    this.converter = new F32ToS16Converter({ sampleRate: fmt.sampleRate, channels: fmt.channels });
    this.log(`[recorder] loopback started: ${fmt.sampleRate}Hz x${fmt.channels}ch → 16k mono (silero VAD)`);

    this.tickTimer = setInterval(() => {
      void this.tick(gen);
    }, TICK_MS);
  }

  private async tick(gen: number): Promise<void> {
    if (gen !== this.generation || this.stopping || this.busy || !this.module) return;
    this.busy = true;
    try {
      const status = this.module.getStatus();
      if (status.deviceStopped) {
        this.fail('渲染设备已停止(默认输出设备切换/移除)');
        return;
      }
      if (status.overflowFrames > 0) {
        this.fail(`采集缓冲溢出,音频已丢失(${status.overflowFrames} 帧)`); // 绝不静默丢内容
        return;
      }
      await this.drainOnce(gen, this.now());
    } catch (err) {
      this.fail(String((err as Error)?.message ?? err));
    } finally {
      this.busy = false;
    }
  }

  /** 读一次 addon → 转换 → 补隙 → 切帧 → VAD → 发出。stop 冲刷与 tick 共用。 */
  private async drainOnce(gen: number, nowMs: number): Promise<void> {
    const f32 = this.module!.read();
    const converted = f32.length > 0 ? this.converter!.push(f32) : new Int16Array(0);
    for (const chunk of this.gapFiller.push(converted, nowMs)) this.slicer.push(chunk);
    for (;;) {
      const frame = this.slicer.next();
      if (!frame) break;
      const isSpeech = await this.vad!.process(frame);
      if (gen !== this.generation) return; // await 期间被 dispose:不再发事件(v7-④ 语义)
      const chunk: PcmChunk = { pcm: frame, isSpeech, timeMs: this.emittedFrames * FRAME_MS };
      this.emittedFrames++;
      if (isSpeech && !this.speechAnnounced) {
        this.speechAnnounced = true;
        this.events?.onSpeechStart();
      }
      this.events?.onChunk(chunk);
    }
  }

  /** 正常结束:清节拍 → 末次冲刷(残余数据;亚帧尾巴 ≤32ms 舍弃)→ 停采集。 */
  async stop(): Promise<void> {
    if (this.stopping || !this.module) return;
    this.stopping = true;
    this.clearTimer();
    const gen = this.generation;
    try {
      await this.drainOnce(gen, this.now());
    } catch { /* 设备恰在此刻失效:已得的帧已发出 */ }
    try { this.module.stop(); } catch { /* 已停 */ }
  }

  dispose(): void {
    this.generation++;
    this.stopping = true;
    this.clearTimer();
    try { this.module?.stop(); } catch { /* 已停 */ }
    this.module = undefined;
  }

  private fail(detail: string): void {
    if (this.errored || this.stopping) return;
    this.errored = true;
    this.stopping = true;
    this.clearTimer();
    try { this.module?.stop(); } catch { /* 已失效 */ }
    const err = new RecorderError('device-lost', `系统音频采集中断:${detail}`);
    this.log(`[recorder] ${err.message}`);
    this.events?.onError(err);
  }

  private clearTimer(): void {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }
}
