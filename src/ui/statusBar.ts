/**
 * 状态栏(F1.1 / §5.3 错误呈现 / F2.1 模型加载提示)。
 * idle:🎙 点击开始;recording:红点 + 计时,点击结束;
 * 处理中:spinner;错误:error 图标可点击看日志;模型加载中单独提示(不计入延迟)。
 */
import * as vscode from 'vscode';
import { SessionState } from '../session';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private recordingSince = 0;
  private modelLoading = false;
  /** P2b:管线中未完成段数(在录 + 在转并行呈现,spec §5.3 修订)。 */
  private pendingSegments = 0;
  private state: SessionState = 'idle';

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this.setSession('idle');
    this.item.show();
  }

  setSession(state: SessionState): void {
    this.state = state;
    if (state === 'idle') this.pendingSegments = 0;
    this.stopTimer();
    switch (state) {
      case 'idle':
        this.item.text = '$(mic) VoiceFlow';
        this.item.tooltip = 'Ctrl+Alt+L to start dictation';
        this.item.command = 'voiceflow.toggleDictation';
        this.item.backgroundColor = undefined;
        break;
      case 'recording':
        // 麦克风尚未就绪(helper spawn ~200-300ms):先示"启动中",
        // recordingLive() 后才亮红点计时 —— 否则用户见红即说,开头吞字(gate 实测)
        this.item.text = '$(loading~spin) VoiceFlow: Starting mic…';
        this.item.command = 'voiceflow.cancelSession';
        this.item.tooltip = 'Esc to cancel';
        this.item.backgroundColor = undefined;
        break;
      case 'transcribing':
        this.item.text = this.modelLoading
          ? '$(loading~spin) VoiceFlow: Loading model…'
          : '$(loading~spin) VoiceFlow: Transcribing…';
        this.item.tooltip = 'Esc to cancel';
        this.item.command = 'voiceflow.cancelSession';
        this.item.backgroundColor = undefined;
        break;
      case 'cleaning':
        this.item.text = '$(loading~spin) VoiceFlow: Cleaning up…';
        this.item.tooltip = 'Esc to cancel';
        this.item.command = 'voiceflow.cancelSession';
        break;
      case 'inserting':
        this.item.text = '$(loading~spin) VoiceFlow: Inserting…';
        this.item.command = undefined;
        break;
      case 'draining':
        this.renderDraining();
        this.item.tooltip = 'Esc to cancel (inserted segments are kept)';
        this.item.command = 'voiceflow.cancelSession';
        this.item.backgroundColor = undefined;
        break;
    }
  }

  /** P2b:段管线活动计数(录音中显示 ✍N;draining 显示剩余)。 */
  setSegmentActivity(pending: number): void {
    this.pendingSegments = pending;
    if (this.state === 'recording' && this.recordingSince > 0) this.renderRecording();
    else if (this.state === 'draining') this.renderDraining();
  }

  private renderDraining(): void {
    this.item.text =
      this.pendingSegments > 0
        ? `$(loading~spin) VoiceFlow: Finishing ${this.pendingSegments} segment(s)…`
        : '$(loading~spin) VoiceFlow: Finishing…';
  }

  /** 麦克风就绪,开始亮红点计时(录音管线 start() resolve 后调用)。 */
  recordingLive(): void {
    this.recordingSince = Date.now();
    this.item.command = 'voiceflow.toggleDictation';
    this.item.tooltip = 'Press Ctrl+Alt+L to stop, Esc to cancel';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.renderRecording();
    this.timer = setInterval(() => this.renderRecording(), 1000);
  }

  /** F2.1:模型加载单独呈现(cold start 不计入听写延迟)。 */
  setModelLoading(loading: boolean): void {
    this.modelLoading = loading;
    if (loading) {
      this.item.text = '$(loading~spin) VoiceFlow: Loading model…';
    }
  }

  /** 错误:图标可点击查看 OutputChannel(§5.3),下次会话自动复位。 */
  showError(brief: string): void {
    this.stopTimer();
    this.item.text = '$(error) VoiceFlow';
    this.item.tooltip = `${brief} — click to view logs`;
    this.item.command = 'voiceflow.showLogs';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  private renderRecording(): void {
    const secs = Math.floor((Date.now() - this.recordingSince) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    // 在录 + 在转并行呈现(P2b:✍N = 管线中未完成段数)
    const seg = this.pendingSegments > 0 ? ` ✍${this.pendingSegments}` : '';
    this.item.text = `$(record) VoiceFlow ${mm}:${ss}${seg}`;
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stopTimer();
    this.item.dispose();
  }
}
