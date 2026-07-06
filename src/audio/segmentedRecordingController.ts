/**
 * P2b:分段录音控制器 —— Recorder(采集)+ RecordingPolicy(会话级自动结束,规则不变)
 * + SegmentAccumulator(切段纯逻辑)+ 段 WAV 落盘。
 *
 * 与 batch 的 RecordingController 并存(核心原则:现有闭环一字不动,分段是增强层)。
 *
 * 段 WAV 生命周期契约(评审 v8-① / v9-⑧):
 * - 命名 `seg-<tag>-<n>.wav` 平铺 tmp/ → 启动清扫 cleanTmpWavs 零改动覆盖残留
 * - onSegment 发出即**所有权移交下游**(pipeline 在 transcribeWithRetry 全部尝试结束后删,
 *   评审 v8-①);未发出的(cancel/dispose 竞态中在写的)由本控制器删除
 * - 落盘经 writeChain 串行 → onSegment 发出顺序 == 切段顺序(管线保序的前提)
 */
import * as vscode from 'vscode';
import { PcmChunk, Recorder, RecorderError, SAMPLE_RATE } from './recorder';
import { RecordingPolicy, RecordingPolicyConfig } from './recordingPolicy';
import { encodeWavPcm16 } from './wav';
import { SealedSegment, SegmentAccumulator, SegmentAccumulatorOptions } from '../segment/segmentation';

export interface SegmentFile {
  wavUri: vscode.Uri;
  /** 会话内段序号(0 起,含短段并入后的最终序)。 */
  index: number;
  startMs: number;
  endMs: number;
  speechMs: number;
  mergedShortSegments: number;
}

export class SegmentedRecordingController {
  private readonly policy: RecordingPolicy;
  private readonly acc: SegmentAccumulator;
  private lastTimeMs = 0;
  private stopped = false;
  private flushing = false;
  private cancelled = false;
  private segIndex = 0;
  /** 段 WAV 串行落盘链(保序;错误单段处理不断链)。 */
  private writeChain: Promise<void> = Promise.resolve();
  private readonly sessionTag = Date.now().toString(36);

  /** 段封口且 WAV 落盘完成(所有权移交,删除归下游)。 */
  onSegment: ((seg: SegmentFile) => void) | undefined;
  /** 段 WAV 落盘失败(段内容已丢失 → 下游应显式终止管线,绝不静默缺句,评审 ③)。 */
  onSegmentError: ((err: Error) => void) | undefined;
  onAutoStop: ((reason: 'silence' | 'max-duration') => void) | undefined;
  onError: ((err: RecorderError) => void) | undefined;
  onSpeechStart: (() => void) | undefined;

  constructor(
    private readonly recorder: Recorder,
    policyCfg: RecordingPolicyConfig,
    segmentPauseMs: number,
    private readonly storageUri: vscode.Uri,
    private readonly log: (line: string) => void,
    accOpts: SegmentAccumulatorOptions = {},
  ) {
    this.policy = new RecordingPolicy(policyCfg);
    this.acc = new SegmentAccumulator(segmentPauseMs, (seg) => this.enqueueWrite(seg), accOpts);
  }

  async start(): Promise<void> {
    await this.recorder.start({
      onChunk: (c) => this.handleChunk(c),
      onSpeechStart: () => this.onSpeechStart?.(),
      onError: (err) => {
        // S1 语义按段重申:在途段全弃,无半截脏数据
        this.acc.discard();
        this.stopped = true;
        this.onError?.(err);
      },
    });
  }

  private handleChunk(c: PcmChunk): void {
    if (this.stopped) return;
    this.acc.push(c); // 可能触发封口 → enqueueWrite
    this.lastTimeMs = c.timeMs;
    if (this.flushing) return; // 尾部冲刷:只收数据,不再自动结束判定
    const decision = this.policy.onChunk(c.timeMs, c.isSpeech);
    if (decision === 'stop-silence') {
      this.stopped = true;
      this.onAutoStop?.('silence');
    } else if (decision === 'stop-max-duration') {
      this.stopped = true;
      this.onAutoStop?.('max-duration');
    }
  }

  private enqueueWrite(seg: SealedSegment): void {
    const index = this.segIndex++;
    this.writeChain = this.writeChain.then(async () => {
      if (this.cancelled) return; // Esc 竞态:未写的直接不写(无文件即无残留)
      try {
        const wav = encodeWavPcm16(seg.frames, SAMPLE_RATE);
        const tmpDir = vscode.Uri.joinPath(this.storageUri, 'tmp');
        await vscode.workspace.fs.createDirectory(tmpDir);
        const wavUri = vscode.Uri.joinPath(tmpDir, `seg-${this.sessionTag}-${index}.wav`);
        await vscode.workspace.fs.writeFile(wavUri, wav);
        if (this.cancelled) {
          // 写盘期间被取消:文件未移交,由本控制器收回
          try { await vscode.workspace.fs.delete(wavUri); } catch { /* 已被清扫 */ }
          return;
        }
        this.log(
          `[segment] #${index} sealed: ${((seg.endMs - seg.startMs) / 1000).toFixed(1)}s ` +
            `(speech ${(seg.speechMs / 1000).toFixed(1)}s, merged ${seg.mergedShortSegments})`,
        );
        this.onSegment?.({
          wavUri,
          index,
          startMs: seg.startMs,
          endMs: seg.endMs,
          speechMs: seg.speechMs,
          mergedShortSegments: seg.mergedShortSegments,
        });
      } catch (err) {
        this.log(`[segment] #${index} write failed: ${String(err)}`);
        this.onSegmentError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * 正常结束(热键/自动停):冲刷尾帧 → 封口尾段(v8-②/v4-④ 规则在 accumulator 内)
   * → 等全部段 WAV 落盘。返回会话时长;段本身经 onSegment 陆续交付。
   */
  async finish(): Promise<{ durationMs: number }> {
    this.flushing = true;
    await this.recorder.stop(); // stop 期间到达的尾帧仍进 accumulator
    this.stopped = true;
    this.acc.finalize();
    await this.writeChain;
    return { durationMs: this.lastTimeMs };
  }

  /** 取消(Esc):未封口/未落盘内容丢弃;已移交下游的文件由 pipeline 删(统一 Esc 语义)。 */
  cancel(): void {
    this.cancelled = true;
    this.stopped = true;
    this.acc.discard();
  }

  dispose(): void {
    this.cancelled = true;
    this.stopped = true;
    this.acc.discard();
    this.recorder.dispose();
  }
}
