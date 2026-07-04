import { describe, expect, it } from 'vitest';
import { decideEditorAction, escapeSnippetText, outcomeMessage } from '../src/insert/logic';

describe('escapeSnippetText (F4 snippet 转义)', () => {
  it('转义 $ / } / \\,普通文本原样', () => {
    expect(escapeSnippetText('echo $HOME 和 ${var} 以及 C:\\path')).toBe(
      'echo \\$HOME 和 \\${var\\} 以及 C:\\\\path',
    );
    expect(escapeSnippetText('普通中文 English mixed。')).toBe('普通中文 English mixed。');
  });

  it('snippet 占位符语法被中和(插入字面文本)', () => {
    expect(escapeSnippetText('$1 ${2:default} $TM_SELECTED_TEXT')).toBe(
      '\\$1 \\${2:default\\} \\$TM_SELECTED_TEXT',
    );
  });
});

describe('decideEditorAction (F4 editor 决策)', () => {
  it('光标/选区未变 → 原位置插入', () => {
    expect(
      decideEditorAction({ selectionUnchanged: true, recordedRangeValid: true }),
    ).toBe('insert-at-current');
  });

  it('选区已变但记录 range 仍有效 → 插入记录位置', () => {
    expect(
      decideEditorAction({ selectionUnchanged: false, recordedRangeValid: true }),
    ).toBe('insert-at-recorded');
  });

  it('记录 range 已因编辑失效 → 剪贴板', () => {
    expect(
      decideEditorAction({ selectionUnchanged: false, recordedRangeValid: false }),
    ).toBe('clipboard');
  });
});

describe('outcomeMessage', () => {
  it('每种 outcome 都有非空提示文案', () => {
    for (const o of [
      'inserted-editor',
      'inserted-terminal',
      'clipboard-editor-closed',
      'clipboard-range-invalid',
      'clipboard-terminal-dead',
      'clipboard-no-target',
    ] as const) {
      expect(outcomeMessage(o).length).toBeGreaterThan(0);
    }
  });

  it('clipboard outcomes mention "clipboard"', () => {
    expect(outcomeMessage('clipboard-editor-closed')).toContain('clipboard');
    expect(outcomeMessage('clipboard-no-target')).toContain('clipboard');
  });

  it('terminal outcome stresses "not executed"', () => {
    expect(outcomeMessage('inserted-terminal')).toContain('not executed');
  });
});
