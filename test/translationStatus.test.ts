import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { StatusBar, refreshTranslationTargetOnConfigurationChange } from '../src/ui/statusBar';

interface FakeItem { text: string; tooltip?: string; command?: string; backgroundColor?: unknown; }

describe('翻译状态栏矩阵(t2a,v3-⑤)', () => {
  let item: FakeItem;

  beforeEach(() => {
    item = { text: '' };
    (vscode.window as Record<string, unknown>).createStatusBarItem = () => ({
      ...item,
      show() {},
      dispose() {},
      set text(value: string) { item.text = value; },
      get text() { return item.text; },
      set tooltip(value: string | undefined) { item.tooltip = value; },
      set command(value: string | undefined) { item.command = value; },
      set backgroundColor(value: unknown) { item.backgroundColor = value; },
    });
    (vscode as Record<string, unknown>).StatusBarAlignment = { Right: 2 };
    (vscode as Record<string, unknown>).ThemeColor = class { constructor(public id: string) {} };
  });

  it.each([
    ['off', 'idle', '$(mic) VoiceFlow'],
    ['en', 'idle', '$(mic) VoiceFlow →英'],
    ['zh', 'idle', '$(mic) VoiceFlow →中'],
    ['en', 'preparing', '$(loading~spin) VoiceFlow →英: Preparing…'],
    ['zh', 'preparing', '$(loading~spin) VoiceFlow →中: Preparing…'],
  ] as const)('%s + %s', (target, state, expected) => {
    const bar = new StatusBar();
    bar.setTranslationTarget(target);
    bar.setSession(state);
    expect(item.text).toBe(expected);
    bar.dispose();
  });

  it.each(['preparing', 'recording', 'transcribing', 'cleaning', 'inserting', 'draining'] as const)(
    'target badge survives %s state rendering',
    (state) => {
      const bar = new StatusBar();
      bar.setTranslationTarget('en');
      bar.setSession(state);
      expect(item.text).toContain('→英');
      bar.dispose();
    },
  );

  it('idle 时 translate.target 配置变化立即刷新徽标,无关配置不刷新', () => {
    const bar = new StatusBar();
    let target: 'off' | 'zh' | 'en' = 'off';
    let reads = 0;
    const read = () => { reads++; return target; };
    refreshTranslationTargetOnConfigurationChange(
      { affectsConfiguration: () => false }, read, (value) => bar.setConfiguredTranslationTarget(value),
    );
    expect(reads).toBe(0);
    target = 'en';
    refreshTranslationTargetOnConfigurationChange(
      { affectsConfiguration: (key) => key === 'voiceflow.translate.target' },
      read,
      (value) => bar.setConfiguredTranslationTarget(value),
    );
    expect(reads).toBe(1);
    expect(item.text).toContain('→英');

    target = 'zh';
    bar.setTranslationTarget('en');
    bar.setSession('recording');
    refreshTranslationTargetOnConfigurationChange(
      { affectsConfiguration: () => true }, read, (value) => bar.setConfiguredTranslationTarget(value),
    );
    expect(reads).toBe(2);
    expect(item.text).toContain('→英');
    expect(item.text).not.toContain('→中');

    bar.setSession('idle');
    expect(item.text).toContain('→中');
    expect(item.text).not.toContain('→英');
    bar.dispose();
  });
});
