/**
 * chat-insert t2:focused-input 分发单测(plan v5 §4-t2/评审 ④)。
 * vscode mock 直测 dispatchInsert:何时调 type / reject 仍写剪贴板 /
 * resolve undefined → attempted 文案 / attempted 后仍双写 / 三闸(配置关/防线/确认框)零调用 /
 * 'none' 分支零回归 / opts 缺失保守。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commands, env, window, workspace } from './__mocks__/vscode';
import { FocusedInputOpts, captureTarget, dispatchInsert } from '../src/insert/dispatcher';
import {
  changeMatchesTypedText,
  decideFocusedInputAction,
  isRealEditorDocScheme,
  outcomeMessage,
} from '../src/insert/logic';

const typeCalls: Array<{ command: string; args: unknown }> = [];
const clipboardWrites: string[] = [];
let typeBehavior: 'resolve-undefined' | 'reject' = 'resolve-undefined';
let statusMessages: string[] = [];

beforeEach(() => {
  typeCalls.length = 0;
  clipboardWrites.length = 0;
  statusMessages = [];
  typeBehavior = 'resolve-undefined';
  commands.executeCommand = async (command: string, ...args: unknown[]) => {
    typeCalls.push({ command, args: args[0] });
    if (typeBehavior === 'reject') throw new Error('no focused editor widget');
    return undefined; // 官方语义:无返回值 handler resolve undefined
  };
  env.clipboard.writeText = async (t: string) => {
    clipboardWrites.push(t);
  };
  window.setStatusBarMessage = (m: string) => {
    statusMessages.push(m);
  };
});

const OPEN: FocusedInputOpts = { enabled: true, editorInteracted: false, confirmShown: false };

describe('captureTarget:input hint(plan v2-①,when-clause 判定)', () => {
  it("focusHint 'input' → focused-input;既有 hint 语义零改动", () => {
    expect(captureTarget('input')).toEqual({ kind: 'focused-input' });
    expect(captureTarget('none')).toEqual({ kind: 'none' });
  });
});

describe('dispatchInsert focused-input 分支', () => {
  it('三闸全开 → 调 type(文本原样)→ resolve undefined = attempted 文案 + 仍双写剪贴板(v3-②)', async () => {
    const outcome = await dispatchInsert({ kind: 'focused-input' }, '你好 chat', OPEN);
    expect(outcome).toBe('focused-input-attempted');
    expect(typeCalls).toEqual([{ command: 'type', args: { text: '你好 chat' } }]);
    expect(clipboardWrites).toEqual(['你好 chat']); // attempted 也双写
    expect(statusMessages[0]).toContain('Input attempted'); // 诚实文案,不说"已插入"
  });

  it('type reject(真失败)→ clipboard-no-target,剪贴板仍有副本', async () => {
    typeBehavior = 'reject';
    const outcome = await dispatchInsert({ kind: 'focused-input' }, 'txt', OPEN);
    expect(outcome).toBe('clipboard-no-target');
    expect(clipboardWrites).toEqual(['txt']);
  });

  it('配置关(D2 默认)→ type 零调用,纯剪贴板', async () => {
    const outcome = await dispatchInsert({ kind: 'focused-input' }, 'txt', { ...OPEN, enabled: false });
    expect(outcome).toBe('clipboard-no-target');
    expect(typeCalls).toEqual([]);
    expect(clipboardWrites).toEqual(['txt']);
  });

  it('编辑器交互防线触发(v4-①)→ type 零调用', async () => {
    const outcome = await dispatchInsert({ kind: 'focused-input' }, 'txt', { ...OPEN, editorInteracted: true });
    expect(outcome).toBe('clipboard-no-target');
    expect(typeCalls).toEqual([]);
  });

  it('经确认框的会话(v4-③)→ type 零调用', async () => {
    const outcome = await dispatchInsert({ kind: 'focused-input' }, 'txt', { ...OPEN, confirmShown: true });
    expect(outcome).toBe('clipboard-no-target');
    expect(typeCalls).toEqual([]);
  });

  it('opts 缺失(异常路径无 tracker)→ 保守不 type', async () => {
    const outcome = await dispatchInsert({ kind: 'focused-input' }, 'txt');
    expect(outcome).toBe('clipboard-no-target');
    expect(typeCalls).toEqual([]);
  });

  it("'none' 分支零回归:绝不调 type(Explorer 起始会话不盲注入,v2-②)", async () => {
    const outcome = await dispatchInsert({ kind: 'none' }, 'txt', OPEN);
    expect(outcome).toBe('clipboard-no-target');
    expect(typeCalls).toEqual([]);
    expect(clipboardWrites).toEqual(['txt']);
  });
});

describe('v6-A:type 后验证 + 自动撤销', () => {
  /** type 时模拟"落进编辑器":executeCommand('type') 期间发真实 scheme 文档变更事件。 */
  function typeLandsIn(scheme: string, changeText: (typed: string) => string): void {
    commands.executeCommand = async (command: string, ...args: unknown[]) => {
      typeCalls.push({ command, args: args[0] });
      if (command === 'type') {
        const typed = (args[0] as { text: string }).text;
        workspace.__emitDocChange({
          document: { uri: { scheme } },
          contentChanges: [{ text: changeText(typed) }],
        });
      }
      return undefined;
    };
  }

  it('type 落入真实编辑器(精确匹配)→ undo + clipboard-focus-drifted + 剪贴板有副本', async () => {
    typeLandsIn('file', (t) => t);
    const outcome = await dispatchInsert({ kind: 'focused-input' }, '整段听写文本', OPEN);
    expect(outcome).toBe('clipboard-focus-drifted');
    expect(typeCalls.map((c) => c.command)).toEqual(['type', 'undo']); // 撤销发出
    expect(clipboardWrites).toEqual(['整段听写文本']);
    expect(statusMessages[0]).toContain('reverted');
  });

  it('编辑器 auto-indent 改写多行(前缀包含匹配)→ 仍判 drifted', async () => {
    typeLandsIn('file', (t) => t.replace(/\n/g, '\n    ')); // 缩进被改写
    const outcome = await dispatchInsert({ kind: 'focused-input' }, '第一行文本内容\n第二行', OPEN);
    expect(outcome).toBe('clipboard-focus-drifted');
    expect(typeCalls.map((c) => c.command)).toEqual(['type', 'undo']);
  });

  it('变更来自非真实 scheme(chat 输入框底层文档)→ 不误伤,attempted', async () => {
    typeLandsIn('vscode-chat-input', (t) => t);
    const outcome = await dispatchInsert({ kind: 'focused-input' }, '进 chat 的文本', OPEN);
    expect(outcome).toBe('focused-input-attempted');
    expect(typeCalls.map((c) => c.command)).toEqual(['type']); // 无 undo
  });

  it('无关小变更(不匹配我们的文本)→ 不误判', async () => {
    typeLandsIn('file', () => 'x'); // 别的什么改了一个字符
    const outcome = await dispatchInsert({ kind: 'focused-input' }, '我们的听写文本内容', OPEN);
    expect(outcome).toBe('focused-input-attempted');
  });

  it('监听器随调用释放(含 reject 路径),不泄漏', async () => {
    await dispatchInsert({ kind: 'focused-input' }, 'a', OPEN);
    typeBehavior = 'reject';
    await dispatchInsert({ kind: 'focused-input' }, 'b', OPEN);
    expect(workspace.__docChangeListenerCount()).toBe(0);
  });
});

describe('v6-A:changeMatchesTypedText 纯逻辑', () => {
  it('精确 / 首行探针包含(≥4 字)/ 超短只精确 / 空变更拒绝', () => {
    expect(changeMatchesTypedText('abc', 'abc')).toBe(true);
    expect(changeMatchesTypedText('  很长的一段听写文本内容啊', '很长的一段听写文本内容啊')).toBe(true);
    // 多行被 auto-indent 改写:首行探针仍命中
    expect(changeMatchesTypedText('第一行文本内容\n    第二行', '第一行文本内容\n第二行')).toBe(true);
    expect(changeMatchesTypedText('xyz', '短')).toBe(false); // 超短文本不做包含匹配
    expect(changeMatchesTypedText('', 'anything')).toBe(false);
  });
});

describe('logic 纯决策(三闸)', () => {
  it('decideFocusedInputAction:任一闸关即 clipboard', () => {
    expect(decideFocusedInputAction({ enabled: true, editorInteracted: false, confirmShown: false })).toBe('type');
    expect(decideFocusedInputAction({ enabled: false, editorInteracted: false, confirmShown: false })).toBe('clipboard');
    expect(decideFocusedInputAction({ enabled: true, editorInteracted: true, confirmShown: false })).toBe('clipboard');
    expect(decideFocusedInputAction({ enabled: true, editorInteracted: false, confirmShown: true })).toBe('clipboard');
  });

  it('防线只认真实文档编辑器 scheme(t3 实测修:输出面板自家日志误报)', () => {
    expect(isRealEditorDocScheme('file')).toBe(true);
    expect(isRealEditorDocScheme('untitled')).toBe(true);
    expect(isRealEditorDocScheme('vscode-notebook-cell')).toBe(true);
    expect(isRealEditorDocScheme('output')).toBe(false); // 输出面板 —— 自家日志的事件源
    expect(isRealEditorDocScheme('debug')).toBe(false);
    expect(isRealEditorDocScheme(undefined)).toBe(false); // 焦点离开全部编辑器
  });

  it('attempted 文案诚实(含剪贴板提示)', () => {
    const m = outcomeMessage('focused-input-attempted');
    expect(m).toContain('attempted');
    expect(m).toContain('clipboard');
    expect(m.toLowerCase()).not.toContain('inserted');
  });
});
