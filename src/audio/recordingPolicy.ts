/**
 * 录音自动结束策略(F1.2 / F1.3)— 纯逻辑,可单元测试。
 * 策略放 extension host 侧(而非 webview),保持单一决策点。
 */

export interface RecordingPolicyConfig {
  /** 最大录音时长 ms(F1.2,默认 120s)。 */
  maxDurationMs: number;
  /** 连续静音自动结束 ms(F1.3,0=关闭)。仅在已出现语音段后生效。 */
  autoStopSilenceMs: number;
}

export type PolicyDecision = 'continue' | 'stop-silence' | 'stop-max-duration';

export class RecordingPolicy {
  private lastSpeechMs = -1;
  private sawSpeech = false;

  constructor(private readonly cfg: RecordingPolicyConfig) {}

  get hasSpeech(): boolean {
    return this.sawSpeech;
  }

  /** 每收到一帧调用一次;返回是否应当自动结束。 */
  onChunk(timeMs: number, isSpeech: boolean): PolicyDecision {
    if (isSpeech) {
      this.sawSpeech = true;
      this.lastSpeechMs = timeMs;
    }
    if (timeMs >= this.cfg.maxDurationMs) {
      return 'stop-max-duration';
    }
    if (
      this.cfg.autoStopSilenceMs > 0 &&
      this.sawSpeech &&
      !isSpeech &&
      timeMs - this.lastSpeechMs >= this.cfg.autoStopSilenceMs
    ) {
      return 'stop-silence';
    }
    return 'continue';
  }
}
