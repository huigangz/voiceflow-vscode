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

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this.setSession('idle');
    this.item.show();
  }

  setSession(state: SessionState): void {
    this.stopTimer();
    switch (state) {
      case 'idle':
        this.item.text = '$(mic) VoiceFlow';
        this.item.tooltip = 'Ctrl+Alt+L 开始听写';
        this.item.command = 'voiceflow.toggleDictation';
        this.item.backgroundColor = undefined;
        break;
      case 'recording':
        this.recordingSince = Date.now();
        this.item.command = 'voiceflow.toggleDictation';
        this.item.tooltip = '再按 Ctrl+Alt+L 结束,Esc 取消';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.renderRecording();
        this.timer = setInterval(() => this.renderRecording(), 1000);
        break;
      case 'transcribing':
        this.item.text = this.modelLoading
          ? '$(loading~spin) VoiceFlow: 模型加载中…'
          : '$(loading~spin) VoiceFlow: 转写中…';
        this.item.tooltip = 'Esc 取消';
        this.item.command = 'voiceflow.cancelSession';
        this.item.backgroundColor = undefined;
        break;
      case 'cleaning':
        this.item.text = '$(loading~spin) VoiceFlow: 清理中…';
        this.item.tooltip = 'Esc 取消';
        this.item.command = 'voiceflow.cancelSession';
        break;
      case 'inserting':
        this.item.text = '$(loading~spin) VoiceFlow: 插入中…';
        this.item.command = undefined;
        break;
    }
  }

  /** F2.1:模型加载单独呈现(cold start 不计入听写延迟)。 */
  setModelLoading(loading: boolean): void {
    this.modelLoading = loading;
    if (loading) {
      this.item.text = '$(loading~spin) VoiceFlow: 模型加载中…';
    }
  }

  /** 错误:图标可点击查看 OutputChannel(§5.3),下次会话自动复位。 */
  showError(brief: string): void {
    this.stopTimer();
    this.item.text = '$(error) VoiceFlow';
    this.item.tooltip = `${brief} — 点击查看日志`;
    this.item.command = 'voiceflow.showLogs';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  private renderRecording(): void {
    const secs = Math.floor((Date.now() - this.recordingSince) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    this.item.text = `$(record) VoiceFlow ${mm}:${ss}`;
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
