/**
 * 方案 A:Webview + getUserMedia 录音(spec D7,S1 spike)。
 * webview 仅负责采集与 VAD 标记;缓冲与自动结束策略在 extension host(recordingPolicy)。
 */
import * as vscode from 'vscode';
import {
  PcmChunk,
  Recorder,
  RecorderError,
  RecorderErrorCode,
  RecorderEvents,
} from './recorder';
import { base64ToInt16 } from './wav';

const START_TIMEOUT_MS = 10_000;

interface WebviewMsg {
  type: 'ready' | 'started' | 'chunk' | 'speech-start' | 'stopped' | 'error';
  mode?: 'vad' | 'energy';
  b64?: string;
  isSpeech?: boolean;
  tMs?: number;
  code?: RecorderErrorCode;
  message?: string;
}

export class WebviewRecorder implements Recorder {
  private panel: vscode.WebviewPanel | undefined;
  private events: RecorderEvents | undefined;
  private disposables: vscode.Disposable[] = [];
  /** 录音采集模式(started 消息回填),供日志与 S1 评估。 */
  public mode: 'vad' | 'energy' | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: (line: string) => void,
  ) {}

  async start(events: RecorderEvents): Promise<void> {
    this.events = events;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');

    this.panel = vscode.window.createWebviewPanel(
      'voiceflowRecorder',
      'VoiceFlow 录音',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true, // S1 gate:隐藏/切窗口时录音持续
        localResourceRoots: [mediaRoot],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview, mediaRoot);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new RecorderError('init-failed', `webview 未在 ${START_TIMEOUT_MS}ms 内就绪`));
        }
      }, START_TIMEOUT_MS);

      this.disposables.push(
        this.panel!.webview.onDidReceiveMessage((msg: WebviewMsg) => {
          switch (msg.type) {
            case 'ready':
              void this.panel!.webview.postMessage({ type: 'start' });
              break;
            case 'started':
              this.mode = msg.mode;
              this.log(`[recorder] started, mode=${msg.mode}`);
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve();
              }
              break;
            case 'chunk':
              if (msg.b64 !== undefined && msg.tMs !== undefined) {
                const chunk: PcmChunk = {
                  pcm: base64ToInt16(msg.b64),
                  isSpeech: msg.isSpeech === true,
                  timeMs: msg.tMs,
                };
                this.events?.onChunk(chunk);
              }
              break;
            case 'speech-start':
              this.events?.onSpeechStart();
              break;
            case 'error': {
              const err = new RecorderError(msg.code ?? 'init-failed', msg.message ?? 'unknown');
              this.log(`[recorder] error: ${err.code} ${err.message}`);
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
              } else {
                this.events?.onError(err);
              }
              break;
            }
            case 'stopped':
              this.stopResolve?.();
              break;
          }
        }),
        // 用户手动关掉录音面板 = 设备级失败,会话应回 idle
        this.panel!.onDidDispose(() => {
          this.panel = undefined;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new RecorderError('init-failed', '录音面板被关闭'));
          } else {
            this.events?.onError(new RecorderError('device-lost', '录音面板被关闭'));
          }
        }),
      );
    });
  }

  private stopResolve: (() => void) | undefined;

  async stop(): Promise<void> {
    if (!this.panel) return;
    const stopped = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
      // stopped 消息 2s 未达也继续(尾部 chunk 损失可接受,不阻塞闭环)
      setTimeout(resolve, 2000);
    });
    void this.panel.webview.postMessage({ type: 'stop' });
    await stopped;
    this.stopResolve = undefined;
  }

  /** Reload Window gate:panel dispose → webview 销毁 → 音频流随之释放,无残留进程。 */
  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.events = undefined;
    this.panel?.dispose();
    this.panel = undefined;
  }

  private buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const csp = webview.cspSource;
    const recorderJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'recorder.js'));
    const vadBase = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vad'));
    const ortJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vad', 'ort.min.js'));
    const vadJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vad', 'bundle.min.js'));
    // wasm 需要 'wasm-unsafe-eval';onnx 模型与 .mjs 经 fetch/dynamic import 加载(connect-src/script-src)
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src ${csp} 'wasm-unsafe-eval';
    connect-src ${csp} blob: data:;
    worker-src blob: ${csp};
    style-src 'unsafe-inline';
    media-src ${csp} blob: mediastream:;
  ">
  <style>body{font-family:sans-serif;padding:8px;font-size:12px;opacity:.75}</style>
</head>
<body data-asset-base="${vadBase.toString()}/">
  <div>🎙 VoiceFlow 录音面板 — 请勿关闭(可隐藏)。</div>
  <div id="status">加载中…</div>
  <script src="${ortJs}"></script>
  <script src="${vadJs}"></script>
  <script src="${recorderJs}"></script>
</body>
</html>`;
  }
}
