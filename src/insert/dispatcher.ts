/**
 * 插入分发器(F4):目标在录音开始时锁定,结束后按 F4 表三路径分发。
 * 决策纯逻辑在 ./logic.ts。
 */
import * as vscode from 'vscode';
import { InsertOutcome, decideEditorAction, escapeSnippetText, outcomeMessage } from './logic';

export type FocusHint = 'editor' | 'terminal' | 'none' | undefined;

export type InsertTarget =
  | {
      kind: 'editor';
      uri: string;
      /** 录音开始时的文档版本(用于 range 失效判定)。 */
      version: number;
      selection: vscode.Selection;
    }
  | { kind: 'terminal'; terminal: vscode.Terminal }
  | { kind: 'none' };

/**
 * 录音开始时锁定插入目标。
 * focusHint 来自 keybinding args(editorTextFocus/terminalFocus when 子句),
 * 命令面板等无 hint 场景回退为:有可见活动编辑器则 editor,否则 none。
 */
export function captureTarget(focusHint: FocusHint): InsertTarget {
  if (focusHint === 'terminal') {
    const t = vscode.window.activeTerminal;
    if (t) return { kind: 'terminal', terminal: t };
    return { kind: 'none' };
  }
  const editor = vscode.window.activeTextEditor;
  if ((focusHint === 'editor' || focusHint === undefined) && editor) {
    return {
      kind: 'editor',
      uri: editor.document.uri.toString(),
      version: editor.document.version,
      selection: editor.selection,
    };
  }
  return { kind: 'none' };
}

export async function dispatchInsert(target: InsertTarget, text: string): Promise<InsertOutcome> {
  let outcome: InsertOutcome;
  switch (target.kind) {
    case 'editor':
      outcome = await insertToEditor(target, text);
      break;
    case 'terminal':
      outcome = insertToTerminal(target.terminal, text);
      break;
    case 'none':
      outcome = 'clipboard-no-target';
      break;
  }
  if (outcome.startsWith('clipboard')) {
    await vscode.env.clipboard.writeText(text);
  }
  vscode.window.setStatusBarMessage(outcomeMessage(outcome), 5000);
  return outcome;
}

async function insertToEditor(
  target: Extract<InsertTarget, { kind: 'editor' }>,
  text: string,
): Promise<InsertOutcome> {
  // 原 editor 是否仍打开(任一可见编辑器持有同一文档)
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === target.uri,
  );
  if (!editor) return 'clipboard-editor-closed';

  const doc = editor.document;
  const selectionUnchanged =
    doc.version === target.version && editor.selection.isEqual(target.selection);

  // range 失效判定:文档未变则必然有效;变过则用 validateRange 检查坐标是否仍在文档内
  const recordedRangeValid =
    doc.version === target.version || doc.validateRange(target.selection).isEqual(target.selection);

  const action = decideEditorAction({ selectionUnchanged, recordedRangeValid });
  if (action === 'clipboard') return 'clipboard-range-invalid';

  const range = action === 'insert-at-current' ? editor.selection : target.selection;
  // snippet 转义插入:字面文本、正确 undo、光标落在插入文本末尾、不触发补全
  const ok = await editor.insertSnippet(new vscode.SnippetString(escapeSnippetText(text)), range, {
    undoStopBefore: true,
    undoStopAfter: true,
  });
  return ok ? 'inserted-editor' : 'clipboard-range-invalid';
}

function insertToTerminal(terminal: vscode.Terminal, text: string): InsertOutcome {
  // shell 已退出 or 终端已被关闭 → 剪贴板
  const alive =
    terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal);
  if (!alive) return 'clipboard-terminal-dead';
  // F4:不自动回车、不转义、绝不代执行
  terminal.sendText(text, false);
  return 'inserted-terminal';
}
