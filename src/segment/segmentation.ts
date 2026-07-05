/**
 * P2b:VAD 分段纯逻辑(不依赖 vscode,可单测)。
 *
 * SegmentAccumulator 消费 PcmChunk 流,规则:
 * - 切段:静音 ≥ segmentPause 且当前段已有语音 → 封口(边界含触发的静音帧,帧无缝分区,
 *   不重叠不丢帧);录音继续,新段从下一帧开始
 * - 段级语音统计(评审 v9-④):hasSpeech/speechMs 都是**段内**状态,会话级锁存答不了
 *   "纯静音尾段"判定
 * - 短段挂起(质量防线/评审 ③):封口段语音 < MIN_SPEECH_MS → 不发出,挂起并入下一段
 *   (可连续并多次);防短段幻觉靠"并段增上下文",不靠丢弃
 * - 尾段(finalize,评审 v8-② + v4-④):有 pending → 与尾段合并提交(纯静音尾段也提交,
 *   因为 pending 里有语音);无 pending 且尾段含语音 → 提交(即使 <0.5s,"对/不/行"绝不丢);
 *   无 pending 且尾段纯静音 → 不提交(送 whisper 必幻觉,无语音≠丢内容)
 * - discard(Esc/device-lost):未发出的全部丢弃
 */
import { PcmChunk } from '../audio/recorder';

/** 短段阈值:段内语音时长低于此值挂起并入下一段(spec 质量防线 0.5s)。 */
export const MIN_SPEECH_MS = 500;

export interface SealedSegment {
  /** 段内全部帧(含并入的挂起短段,顺序保持)。encodeWavPcm16 直接可用。 */
  frames: Int16Array[];
  /** 会话相对时间(ms):段首帧起点 / 段末帧终点。 */
  startMs: number;
  endMs: number;
  /** 段内语音帧累计时长(ms)。 */
  speechMs: number;
  hasSpeech: boolean;
  /** 并入了几个挂起短段(埋点/调试)。 */
  mergedShortSegments: number;
}

interface Buf {
  frames: Int16Array[];
  startMs: number;
  endMs: number;
  speechMs: number;
  merged: number;
}

const FRAME_MS = 32; // 512 samples @ 16kHz;时长按帧数推算,与 energyVad 时间戳同源

export class SegmentAccumulator {
  private cur: Buf | undefined;
  private pending: Buf | undefined;
  /** 当前段内最后语音时刻(段边界检测用,段级状态)。 */
  private lastSpeechMs = -1;

  constructor(
    private readonly segmentPauseMs: number,
    private readonly onSeal: (seg: SealedSegment) => void,
  ) {}

  push(chunk: PcmChunk): void {
    if (!this.cur) {
      this.cur = { frames: [], startMs: chunk.timeMs, endMs: chunk.timeMs, speechMs: 0, merged: 0 };
      this.lastSpeechMs = -1;
    }
    this.cur.frames.push(chunk.pcm);
    this.cur.endMs = chunk.timeMs + FRAME_MS;
    if (chunk.isSpeech) {
      this.cur.speechMs += FRAME_MS;
      this.lastSpeechMs = chunk.timeMs;
    } else if (
      this.cur.speechMs > 0 &&
      this.lastSpeechMs >= 0 &&
      chunk.timeMs - this.lastSpeechMs >= this.segmentPauseMs
    ) {
      this.sealCurrent();
    }
  }

  /** 会话正常结束(热键/自动停):封口尾段,应用 v8-②/v4-④ 规则。 */
  finalize(): void {
    const tail = this.cur;
    const pending = this.pending;
    this.cur = undefined;
    this.pending = undefined;
    this.lastSpeechMs = -1;

    if (pending && tail) {
      this.onSeal(toSealed(merge(pending, tail))); // pending 有语音 → 合并提交(v8-②"有 pending 短段时提交")
    } else if (pending) {
      this.onSeal(toSealed(pending)); // 尾段为空:挂起短段单独转写,绝不丢弃(v4-④)
    } else if (tail && tail.speechMs > 0) {
      this.onSeal(toSealed(tail)); // 含语音即提交,即使 <0.5s(v4-④)
    }
    // 无 pending 且尾段纯静音 → 不提交(v8-②)
  }

  /** Esc / device-lost / Reload:未发出内容全部丢弃(S1"无半截脏数据"按段重申)。 */
  discard(): void {
    this.cur = undefined;
    this.pending = undefined;
    this.lastSpeechMs = -1;
  }

  private sealCurrent(): void {
    const candidate = this.cur!;
    this.cur = undefined;
    this.lastSpeechMs = -1;

    const unit = this.pending ? merge(this.pending, candidate) : candidate;
    this.pending = undefined;
    if (unit.speechMs < MIN_SPEECH_MS) {
      this.pending = unit; // 语音过短:挂起并入下一段(评审 ③,不丢弃)
      return;
    }
    this.onSeal(toSealed(unit));
  }
}

function merge(earlier: Buf, later: Buf): Buf {
  return {
    frames: [...earlier.frames, ...later.frames],
    startMs: earlier.startMs,
    endMs: later.endMs,
    speechMs: earlier.speechMs + later.speechMs,
    merged: earlier.merged + later.merged + 1,
  };
}

function toSealed(b: Buf): SealedSegment {
  return {
    frames: b.frames,
    startMs: b.startMs,
    endMs: b.endMs,
    speechMs: b.speechMs,
    hasSpeech: b.speechMs > 0,
    mergedShortSegments: b.merged,
  };
}
