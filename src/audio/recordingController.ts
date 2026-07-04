/**
 * 录音会话控制器:Recorder(采集)+ RecordingPolicy(自动结束)+ WAV 落盘。
 * 错误语义(S1 gate):任何 RecorderError → 丢弃全部缓冲,不产生半截 WAV。
 */
import * as vscode from 'vscode';
import { PcmChunk, Recorder, RecorderError, SAMPLE_RATE } from './recorder';
import { RecordingPolicy, RecordingPolicyConfig } from './recordingPolicy';
import { encodeWavPcm16 } from './wav';

export interface RecordingResult {
  wavUri: vscode.Uri;
  durationMs: number;
  /** 是否检测到语音段(false → 上层可直接判空,防幻觉,spec §9.2 静音/误触发)。 */
  hasSpeech: boolean;
  mode: string;
}

export class RecordingController {
  private chunks: Int16Array[] = [];
  private policy: RecordingPolicy;
  private lastTimeMs = 0;
  private stopped = false;
  /** finish() 冲刷阶段:继续缓冲尾部帧,但不再做自动结束判定。 */
  private flushing = false;

  /** 自动结束回调(静音/超时)— 由 extension.ts 接到 toggle 同一路径。 */
  onAutoStop: ((reason: 'silence' | 'max-duration') => void) | undefined;
  /** 录音失败回调 — 上层丢会话回 idle。 */
  onError: ((err: RecorderError) => void) | undefined;
  onSpeechStart: (() => void) | undefined;

  constructor(
    private readonly recorder: Recorder,
    policyCfg: RecordingPolicyConfig,
    private readonly storageUri: vscode.Uri,
    private readonly log: (line: string) => void,
  ) {
    this.policy = new RecordingPolicy(policyCfg);
  }

  async start(): Promise<void> {
    await this.recorder.start({
      onChunk: (c) => this.handleChunk(c),
      onSpeechStart: () => this.onSpeechStart?.(),
      onError: (err) => {
        this.chunks = []; // 丢弃脏数据
        this.stopped = true;
        this.onError?.(err);
      },
    });
  }

  private handleChunk(c: PcmChunk): void {
    if (this.stopped) return;
    this.chunks.push(c.pcm);
    this.lastTimeMs = c.timeMs;
    if (this.flushing) return; // 尾部冲刷:只收数据,不再触发自动结束
    const decision = this.policy.onChunk(c.timeMs, c.isSpeech);
    if (decision === 'stop-silence') {
      this.stopped = true;
      this.onAutoStop?.('silence');
    } else if (decision === 'stop-max-duration') {
      this.stopped = true;
      this.onAutoStop?.('max-duration');
    }
  }

  /** 正常结束:冲刷尾部 → 编码 WAV → 落盘 globalStorage/tmp。 */
  async finish(): Promise<RecordingResult> {
    this.flushing = true;
    await this.recorder.stop(); // stop 期间到达的尾帧仍被缓冲
    this.stopped = true;
    const wav = encodeWavPcm16(this.chunks, SAMPLE_RATE);
    const tmpDir = vscode.Uri.joinPath(this.storageUri, 'tmp');
    await vscode.workspace.fs.createDirectory(tmpDir);
    const wavUri = vscode.Uri.joinPath(tmpDir, `rec-${Date.now()}.wav`);
    await vscode.workspace.fs.writeFile(wavUri, wav);
    const samples = (wav.length - 44) / 2;
    this.log(
      `[recording] finished: ${(samples / SAMPLE_RATE).toFixed(1)}s audio, ` +
        `${(wav.length / 1024).toFixed(0)}KB, hasSpeech=${this.policy.hasSpeech}`,
    );
    return {
      wavUri,
      durationMs: this.lastTimeMs,
      hasSpeech: this.policy.hasSpeech,
      mode: (this.recorder as { mode?: string }).mode ?? 'unknown',
    };
  }

  /** 取消(Esc):丢弃全部数据,无落盘。 */
  cancel(): void {
    this.stopped = true;
    this.chunks = [];
  }

  dispose(): void {
    this.recorder.dispose();
    this.chunks = [];
  }
}

/** 清理 tmp 目录残留 WAV(Reload Window gate:启动时调用)。 */
export async function cleanTmpWavs(storageUri: vscode.Uri, log: (l: string) => void): Promise<void> {
  const tmpDir = vscode.Uri.joinPath(storageUri, 'tmp');
  try {
    const entries = await vscode.workspace.fs.readDirectory(tmpDir);
    for (const [name] of entries) {
      if (name.endsWith('.wav')) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(tmpDir, name));
      }
    }
    if (entries.length > 0) log(`[recording] cleaned ${entries.length} leftover tmp file(s)`);
  } catch {
    // tmp 目录不存在 = 无残留
  }
}
