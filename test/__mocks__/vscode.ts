/**
 * 最小 vscode stub —— 让导入了 vscode 的模块能在 vitest 中加载。
 * chat-insert t2 扩展:commands/env/window 提供**可替换的**函数桩,
 * 使 dispatchInsert 的分支逻辑可直接单测(plan v5 评审 ④);
 * editor/terminal 分支仍走 EDH 人工验证。
 */
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const window: {
  setStatusBarMessage: (text: string, timeout?: number) => void;
  visibleTextEditors: unknown[];
  terminals: unknown[];
  activeTextEditor: unknown;
  activeTerminal: unknown;
  [k: string]: unknown;
} = {
  setStatusBarMessage: () => {},
  visibleTextEditors: [],
  terminals: [],
  activeTextEditor: undefined,
  activeTerminal: undefined,
};

type DocChangeListener = (e: unknown) => void;
const docChangeListeners = new Set<DocChangeListener>();

export const workspace: {
  onDidChangeTextDocument: (l: DocChangeListener) => { dispose(): void };
  /** 测试钩子:向所有在挂监听器发一个文档变更事件。 */
  __emitDocChange: (e: unknown) => void;
  __docChangeListenerCount: () => number;
  [k: string]: unknown;
} = {
  onDidChangeTextDocument: (l: DocChangeListener) => {
    docChangeListeners.add(l);
    return { dispose: () => docChangeListeners.delete(l) };
  },
  __emitDocChange: (e: unknown) => {
    for (const l of [...docChangeListeners]) l(e);
  },
  __docChangeListenerCount: () => docChangeListeners.size,
};

export const commands: {
  executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
} = {
  executeCommand: async () => undefined,
};

export const env: { clipboard: { writeText: (t: string) => Promise<void> } } = {
  clipboard: { writeText: async () => {} },
};

export class Uri {}
export const ProgressLocation = { Notification: 15 };
export default {};
