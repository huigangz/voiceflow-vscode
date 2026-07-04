/**
 * 插入分发决策(F4 表)— 纯逻辑,可单元测试。
 * vscode API 侧在 dispatcher.ts。
 */

/** snippet 转义:插入字面文本,不触发 tabstop/变量解析(F4"snippet 转义,不触发补全")。 */
export function escapeSnippetText(text: string): string {
  return text.replace(/[\\$}]/g, (m) => `\\${m}`);
}

export type EditorAction = 'insert-at-current' | 'insert-at-recorded' | 'clipboard';

/**
 * F4 editor 三行决策:
 * - 光标/选区未变 → 原位置插入
 * - 已变 → 插入录音开始时记录的 range;range 已因编辑失效 → 剪贴板
 * (编辑器已关闭的判定在 dispatcher:找不到可见 editor 直接剪贴板。)
 */
export function decideEditorAction(input: {
  selectionUnchanged: boolean;
  /** 录音开始时记录的 range 在当前文档中是否仍是合法坐标。 */
  recordedRangeValid: boolean;
}): EditorAction {
  if (input.selectionUnchanged) return 'insert-at-current';
  if (input.recordedRangeValid) return 'insert-at-recorded';
  return 'clipboard';
}

export type InsertOutcome =
  | 'inserted-editor'          // 原位/记录位插入成功
  | 'inserted-terminal'        // 已写入终端(不回车)
  | 'clipboard-editor-closed'  // 原 editor 已关闭
  | 'clipboard-range-invalid'  // 记录 range 失效
  | 'clipboard-terminal-dead'  // 终端 shell 已退出
  | 'clipboard-no-target';     // 焦点从头就不在编辑器/终端

/** 各 outcome 的状态栏提示文案(F4 表)。 */
export function outcomeMessage(outcome: InsertOutcome): string {
  switch (outcome) {
    case 'inserted-editor':
      return '$(check) VoiceFlow: Inserted';
    case 'inserted-terminal':
      return '$(terminal) VoiceFlow: Sent to terminal (not executed)';
    case 'clipboard-editor-closed':
      return '$(clippy) VoiceFlow: Original editor closed — copied to clipboard';
    case 'clipboard-range-invalid':
      return '$(clippy) VoiceFlow: Original position no longer valid — copied to clipboard';
    case 'clipboard-terminal-dead':
      return '$(clippy) VoiceFlow: Terminal exited — copied to clipboard';
    case 'clipboard-no-target':
      return '$(clippy) VoiceFlow: No insertion target — copied to clipboard';
  }
}
