/**
 * 插入分发器(F4):目标在录音开始时锁定,结束后按 F4 表三路径分发。
 * 决策纯逻辑在 ./logic.ts。
 */
import * as vscode from 'vscode';
import {
  InsertOutcome,
  changeMatchesTypedText,
  decideEditorAction,
  decideFocusedInputAction,
  escapeSnippetText,
  isRealEditorDocScheme,
  outcomeMessage,
} from './logic';

export type FocusHint = 'editor' | 'terminal' | 'input' | 'none' | undefined;

export type InsertTarget =
  | {
      kind: 'editor';
      uri: string;
      /** 录音开始时的文档版本(用于 range 失效判定)。 */
      version: number;
      selection: vscode.Selection;
    }
  | { kind: 'terminal'; terminal: vscode.Terminal }
  /** chat-insert v1:录音开始时焦点在非编辑器/终端的输入部件(when-clause 判定,plan v2-①)。 */
  | { kind: 'focused-input' }
  | { kind: 'none' };

/** chat-insert v1:focused-input 分发判定的输入(由 extension 计算,dispatcher 不读配置不持订阅)。 */
export interface FocusedInputOpts {
  /** voiceflow.insert.typeIntoFocusedInput(D2 默认 false)。 */
  enabled: boolean;
  /** 会话期间发生过编辑器交互(best-effort 防线,v4-①)。 */
  editorInteracted: boolean;
  /** 本会话经过了长录音确认框(定死不 type,v4-③)。 */
  confirmShown: boolean;
}

/**
 * 录音开始时锁定插入目标。
 * focusHint 来自 keybinding args(editorTextFocus/terminalFocus/inputFocus when 子句),
 * 命令面板等无 hint 场景回退为:有可见活动编辑器则 editor,否则 none。
 */
export function captureTarget(focusHint: FocusHint): InsertTarget {
  if (focusHint === 'terminal') {
    const t = vscode.window.activeTerminal;
    if (t) return { kind: 'terminal', terminal: t };
    return { kind: 'none' };
  }
  if (focusHint === 'input') return { kind: 'focused-input' }; // when-clause 时刻 = 真实时焦点
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

export async function dispatchInsert(
  target: InsertTarget,
  text: string,
  focusedInput?: FocusedInputOpts,
): Promise<InsertOutcome> {
  let outcome: InsertOutcome;
  switch (target.kind) {
    case 'editor':
      outcome = await insertToEditor(target, text);
      break;
    case 'terminal':
      outcome = insertToTerminal(target.terminal, text);
      break;
    case 'focused-input':
      outcome = await insertToFocusedInput(text, focusedInput);
      break;
    case 'none':
      outcome = 'clipboard-no-target';
      break;
  }
  // attempted 也双写剪贴板(v3-②:成败不可观测,副本必须常在)
  if (outcome.startsWith('clipboard') || outcome === 'focused-input-attempted') {
    await vscode.env.clipboard.writeText(text);
  }
  vscode.window.setStatusBarMessage(outcomeMessage(outcome), 5000);
  return outcome;
}

/**
 * chat-insert v1:type 注入当前聚焦输入部件(plan v5 §3.1)。
 * 三闸判定在 logic.decideFocusedInputAction;opts 缺失(异常路径无 tracker)保守走剪贴板。
 * resolve(含 undefined,官方定义无返回值 handler 即如此)→ attempted;仅 reject → 剪贴板。
 *
 * v6-A type 后验证 + 自动撤销:事前防线测不到"焦点在哪",但 type 落到哪里**可事后观测**——
 * type 前后挂一瞬 onDidChangeTextDocument,真实 scheme 文档出现匹配我们文本的变更
 * = 插进了编辑器(t3 实测命中的漏报形态:点回同一背景编辑器,双事件静默)→ 立即 undo
 * (焦点编辑器 = 刚收到 type 的编辑器)→ 退剪贴板。Chat 输入框底层文档非真实 scheme,不误伤。
 */
async function insertToFocusedInput(
  text: string,
  opts: FocusedInputOpts | undefined,
): Promise<InsertOutcome> {
  if (!opts || decideFocusedInputAction(opts) === 'clipboard') return 'clipboard-no-target';
  let driftedIntoEditor = false;
  const watch = vscode.workspace.onDidChangeTextDocument((e) => {
    if (!isRealEditorDocScheme(e.document.uri.scheme)) return;
    if (e.contentChanges.some((c) => changeMatchesTypedText(c.text, text))) driftedIntoEditor = true;
  });
  try {
    await vscode.commands.executeCommand('type', { text });
    await new Promise((r) => setTimeout(r, 0)); // 让文档变更事件派发完一拍
    if (driftedIntoEditor) {
      await vscode.commands.executeCommand('undo'); // 撤销刚落进焦点编辑器的那次插入
      return 'clipboard-focus-drifted';
    }
    return 'focused-input-attempted';
  } catch {
    return 'clipboard-no-target'; // 真失败(reject)
  } finally {
    watch.dispose();
  }
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
