/**
 * 录音抽象接口(spec §5.2)。
 * 方案 A:webviewRecorder(S1 首选);方案 B:helperRecorder(S1 No-Go 时启用,P3)。
 * 两方案对上层暴露同一接口,便于切换。
 */

export const SAMPLE_RATE = 16000; // 16kHz 单声道 PCM(spec §4)

export type RecorderErrorCode =
  | 'permission-denied' // 无麦克风权限(F1.4:需给出重新授权指引)
  | 'no-device'         // 无可用输入设备
  | 'device-lost'       // 录音中设备拔出/切换(S1 gate:明确失败回 idle,无半截脏数据)
  | 'init-failed';      // webview/VAD/音频管线初始化失败

export class RecorderError extends Error {
  constructor(
    public readonly code: RecorderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecorderError';
  }
}

/** 一帧 16kHz 单声道 PCM(Int16),带 VAD 语音标记与相对时间戳。 */
export interface PcmChunk {
  pcm: Int16Array;
  isSpeech: boolean;
  /** 相对录音开始的毫秒数(webview 侧时钟)。 */
  timeMs: number;
}

export interface RecorderEvents {
  onChunk(chunk: PcmChunk): void;
  /** VAD 检测到语音段开始(用于 UI 提示,非必需)。 */
  onSpeechStart(): void;
  /** 录音异常终止。调用方必须丢弃已缓冲数据并回 idle(S1 gate)。 */
  onError(err: RecorderError): void;
}

export interface Recorder {
  /** 开始录音。resolve = 音频管线已就绪并在采集;reject = RecorderError。 */
  start(events: RecorderEvents): Promise<void>;
  /** 结束录音并等待尾部 chunk 冲刷完成。 */
  stop(): Promise<void>;
  /** 释放全部资源(webview/音频流)。Reload Window gate:必须无残留。 */
  dispose(): void;
}
