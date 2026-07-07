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
  | 'focused-input-attempted'  // chat-insert v1:type 已发出且 resolve——成败现实不可观测(v3-② 诚实文案)
  | 'clipboard-focus-drifted'  // chat-insert v6-A:type 被观测到落入真实编辑器 → 已 undo 撤销,退剪贴板
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
    case 'focused-input-attempted':
      // executeCommand('type') 对无返回值 handler 本就 resolve undefined,不可当成功判据——
      // 文案只说"尝试过 + 剪贴板有副本",不说谎"已插入"(plan v3-②)
      return '$(clippy) VoiceFlow: Input attempted — also copied to clipboard';
    case 'clipboard-focus-drifted':
      return '$(clippy) VoiceFlow: Focus had moved to an editor — reverted, copied to clipboard';
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

/**
 * chat-insert v1(t3 实测修):编辑器交互防线只认**真实文档编辑器**的事件。
 * 输出面板(scheme=output)/调试控制台等也是 text editor,我们自己的日志每行都会
 * 触发 selection 事件 → 不过滤则防线被自家日志稳定误报,type 永不执行。
 * 防线要防的是"type 绕过 F4 保护写进真实文档",面板类只读文档不在风险面内。
 */
const REAL_EDITOR_SCHEMES = new Set([
  'file',
  'untitled',
  'vscode-notebook-cell',
  'vscode-remote',
  'vscode-userdata',
]);

export function isRealEditorDocScheme(scheme: string | undefined): boolean {
  return scheme !== undefined && REAL_EDITOR_SCHEMES.has(scheme);
}

/**
 * chat-insert v6-A:type 后验证——某次文档变更是否"就是我们刚 type 的文本落进了真实编辑器"。
 * 精确匹配为主;包含匹配用**首行**前 32 字作探针(auto-indent 只改行首缩进,首行内容不动),
 * ≥4 字才启用(误报面 = 同一 tick 内恰有别的真实文档编辑且含同串,可忽略)。
 */
export function changeMatchesTypedText(changeText: string, typedText: string): boolean {
  if (changeText.length === 0) return false;
  if (changeText === typedText) return true;
  const probe = (typedText.split('\n', 1)[0] ?? '').slice(0, 32);
  return probe.length >= 4 && changeText.includes(probe);
}

/**
 * chat-insert v1:focused-input 目标是否执行 type(plan v5 §3.1)。
 * 三闸全过才 type:配置显式开启(D2 默认关)/ 会话期间无编辑器交互(best-effort 防线,
 * v4-①,漏报明示于配置描述)/ 未经确认框(QuickPick 是扩展自己造成的焦点变化,v4-③)。
 */
export function decideFocusedInputAction(input: {
  enabled: boolean;
  editorInteracted: boolean;
  confirmShown: boolean;
}): 'type' | 'clipboard' {
  if (!input.enabled) return 'clipboard';
  if (input.editorInteracted) return 'clipboard';
  if (input.confirmShown) return 'clipboard';
  return 'type';
}
