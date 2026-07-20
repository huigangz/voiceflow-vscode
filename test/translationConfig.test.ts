import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('voiceflow.translate.target 配置(t2a)', () => {
  it('off(default)/zh/en 三态', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['voiceflow.translate.target'];
    expect(setting).toMatchObject({ type: 'string', enum: ['off', 'zh', 'en'], default: 'off' });
  });

  it('contributes the explicit LLM text-exfiltration gate, disabled by default', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['voiceflow.translate.useLlm'];
    expect(setting).toMatchObject({ type: 'boolean', default: false });
    expect(setting.description).toMatch(/transcript text/i);
    expect(setting.description).toMatch(/external|send|leave/i);
  });

  it('contributes the translation usage command', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.contributes.commands).toContainEqual({
      command: 'voiceflow.showTranslationUsage',
      title: 'VoiceFlow: Show Translation Usage',
    });
  });
});
