/**
 * P2b:分段处理管线 —— segment FIFO 严格保序:转写 → 规则清理 → 插入,
 * 前段未插入完成后段等待。依赖全部注入(不 import vscode),纯逻辑可单测。
 *
 * 评审约束逐条落地:
 * - WAV 删除归本层(v8-①):`transcribeWithRetry` 的 finally 里删——**所有尝试结束后才删**,
 *   成功失败同待遇即时删(v5-①,不留盘)
 * - typed error 三分门控(v3-③/v6-⑤):cancelled 永不重试;transient 重试一次
 *   (runner 已在连接层错误时自行失效 server 代际,重试自然重新 prepare,v11-④);
 *   permanent 不重试;**每次尝试前显式检查取消位**(v9-③:Esc 落在两次尝试之间时
 *   in-flight 无物可 abort,不查取消位重试会拉起新请求)
 * - 失败显式终止(评审 ③):重试后仍失败 → closed + 删除队列内全部 WAV + onFatal,
 *   **绝不静默跳段输出缺句结果**;调用方负责停录、状态栏错误、flushFallback(v4-②)
 * - backlog(v11-③/v12-②):统计 queued audio 时长,超限 onBacklogLimit(调用方停止采集,
 *   **已入队段照常 drain**,不销毁队列不丢段)
 * - 会话级 AbortController 由本管线持有(v9-③/v12-①),Esc → cancel():abort 在途请求 +
 *   删除全部未提交段文件;已插入的段保留
 */
import { WhisperError } from '../stt/whisperRunner';
import { CleanupCancelled } from '../cleanup/pipeline';
import type { TranslationResult } from '../translation/pipeline';

export interface PipelineSegment {
  /** WAV 路径(所有权自 enqueue 移交本管线,删除归本层,v8-①)。 */
  wavPath: string;
  index: number;
  startMs: number;
  endMs: number;
  speechMs: number;
}

export interface SegmentTranscript {
  text: string;
  /** Whisper's normalized per-segment detection; the only valid identity evidence. */
  detectedLanguage?: 'zh' | 'en';
  /** Decode-only hint (locked/sourceHint). Never promoted to detectedLanguage. */
  decodeLanguageHint?: string;
}

export interface PipelineDeps {
  /** 转写一段(signal = 会话级;seg 供外层做语言锁定/埋点,2b-5)。 */
  transcribe(wavPath: string, signal: AbortSignal, seg: PipelineSegment): Promise<SegmentTranscript>;
  /** Async structured cleanup/translation. CleanupCancelled cancels without insertion or fatal. */
  cleanup(
    raw: string,
    detectedLanguage: string | undefined,
    signal: AbortSignal,
  ): Promise<TranslationResult>;
  /** 按序提交插入；累计路径保存 onVisible 并立即返回，最终输出成功后再调用。 */
  insert(text: string, seg: PipelineSegment, onVisible: () => void): Promise<void>;
  deleteWav(wavPath: string): Promise<void>;
  log(line: string): void;
  /** 段处理不可恢复失败(转写重试后仍败/插入抛错)→ 调用方停录 + 状态栏错误 + flush 兜底。 */
  onFatal(err: Error): void;
  /** Best-effort feedback hook immediately after structured cleanup. */
  onResult?(result: TranslationResult, segment: PipelineSegment, processingMs: number): void;
  /** Best-effort metric hook after successful final output (or an empty no-op). */
  onVisibleResult?(result: TranslationResult, segment: PipelineSegment, processingMs: number): void;
  /** Queued audio crossed half the limit; once per session, independent of the full-limit callback. */
  onBacklogPressure(queuedMs: number): void;
  /** backlog 超限 → 调用方立即停止采集(封口尾段;已入队的本管线继续 drain,v12-②)。 */
  onBacklogLimit(queuedMs: number): void;
}

/** 2b 默认 backlog 上限:排队音频总时长(2c loopback 只调阈值,v11-③)。 */
export const DEFAULT_BACKLOG_LIMIT_MS = 60_000;

interface QueuedSegment {
  segment: PipelineSegment;
  enqueuedAt: number;
}

export class SegmentPipeline {
  private readonly queue: QueuedSegment[] = [];
  private processing = false;
  private closed = false;
  private queuedAudioMs = 0;
  private backlogPressureFired = false;
  private backlogFired = false;
  private idleWaiters: Array<() => void> = [];
  /** 会话级取消(v9-③):Esc → cancel() → abort 在途 fetch/等待。 */
  private readonly abortController = new AbortController();

  constructor(
    private readonly deps: PipelineDeps,
    private readonly backlogLimitMs: number = DEFAULT_BACKLOG_LIMIT_MS,
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** 段入队(所有权移交)。closed 后入队的段直接删文件(fatal 已显式报过,不静默堆积)。 */
  enqueue(seg: PipelineSegment): void {
    if (this.closed) {
      void this.deps.deleteWav(seg.wavPath).catch(() => {});
      return;
    }
    this.queue.push({ segment: seg, enqueuedAt: Date.now() });
    this.queuedAudioMs += seg.endMs - seg.startMs;
    if (!this.backlogPressureFired && this.queuedAudioMs > this.backlogLimitMs / 2) {
      this.backlogPressureFired = true;
      this.deps.onBacklogPressure(this.queuedAudioMs);
    }
    if (!this.backlogFired && this.queuedAudioMs > this.backlogLimitMs) {
      this.backlogFired = true;
      this.deps.log(
        `[pipeline] backlog limit hit: ${(this.queuedAudioMs / 1000).toFixed(0)}s queued > ` +
          `${(this.backlogLimitMs / 1000).toFixed(0)}s — stopping capture, draining queued segments`,
      );
      this.deps.onBacklogLimit(this.queuedAudioMs); // 停采集不丢段(v12-②)
    }
    void this.pump();
  }

  /** 正常停止:等队列清空且在途段处理完(drain FIFO 全部段完成再回 idle)。 */
  async drained(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Esc / device-lost / Reload:abort 在途请求,删除全部未提交段文件,已插入的段保留。
   * 幂等;fatal 路径也复用(fatal 先报再 cancel)。
   */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    for (const { segment } of this.queue.splice(0)) {
      void this.deps.deleteWav(segment.wavPath).catch(() => {});
    }
    this.queuedAudioMs = 0;
    this.notifyIfIdle(true);
  }

  private isIdle(): boolean {
    return this.closed || (this.queue.length === 0 && !this.processing);
  }

  private notifyIfIdle(force = false): void {
    if (force || this.isIdle()) {
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private async pump(): Promise<void> {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const { segment: seg, enqueuedAt: processingStartedAt } = this.queue.shift()!;
        this.queuedAudioMs -= seg.endMs - seg.startMs;

        let transcript: SegmentTranscript;
        try {
          transcript = await this.transcribeWithRetry(seg);
        } catch (err) {
          if (err instanceof WhisperError && err.kind === 'cancelled') return; // 会话已取消,cancel() 负责清理
          this.failFatal(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        if (this.closed) return;
        let cleaned: TranslationResult;
        try {
          cleaned = await this.deps.cleanup(
            transcript.text,
            transcript.detectedLanguage,
            this.abortController.signal,
          );
        } catch (err) {
          if (err instanceof CleanupCancelled) {
            this.cancel();
            return;
          }
          this.failFatal(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (this.closed) return;
        try {
          this.deps.onResult?.(cleaned, seg, Date.now() - processingStartedAt);
        } catch {
          // Feedback must never make a segment fatal.
        }
        let visibleReported = false;
        const reportVisible = (): void => {
          if (visibleReported) return;
          visibleReported = true;
          try {
            this.deps.onVisibleResult?.(cleaned, seg, Date.now() - processingStartedAt);
          } catch {
            // Local metrics must never make successful output fatal.
          }
        };
        if (cleaned.text.length === 0) {
          reportVisible();
          continue; // 空转写(段内无有效内容)跳过插入——非丢段,转写结果本为空
        }

        try {
          await this.deps.insert(cleaned.text, seg, reportVisible);
        } catch (err) {
          this.failFatal(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
    } finally {
      this.processing = false;
      this.notifyIfIdle();
    }
  }

  /** 重试门控(v3-③/v6-⑤/v9-③);WAV 在**全部尝试结束后**的 finally 删(v8-①/v5-①)。 */
  private async transcribeWithRetry(seg: PipelineSegment): Promise<SegmentTranscript> {
    try {
      this.throwIfCancelled(); // 尝试前取消检查(v9-③)
      try {
        return await this.deps.transcribe(seg.wavPath, this.abortController.signal, seg);
      } catch (err) {
        if (!(err instanceof WhisperError) || err.kind !== 'transient') throw err;
        this.throwIfCancelled(); // 重试前再查:Esc 落在两次尝试之间不拉起新请求(v9-③)
        this.deps.log(`[pipeline] segment #${seg.index} transient error, retrying once: ${err.message}`);
        return await this.deps.transcribe(seg.wavPath, this.abortController.signal, seg);
      }
    } finally {
      await this.deps.deleteWav(seg.wavPath).catch(() => {}); // 成功失败同待遇即时删(v5-①)
    }
  }

  private throwIfCancelled(): void {
    if (this.abortController.signal.aborted || this.closed) {
      throw new WhisperError('cancelled', 'pipeline closed');
    }
  }

  /** 显式终止(评审 ③):报 fatal → 清队列(删文件)→ 后续段拒收。绝不静默缺句。 */
  private failFatal(err: Error): void {
    if (this.closed) return;
    this.deps.log(`[pipeline] fatal: ${err.message}`);
    this.deps.onFatal(err);
    this.cancel();
  }
}
