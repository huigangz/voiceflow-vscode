import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildCliArgs, parseServerResponse, TranscribeOptions } from '../src/stt/whisperRunner';

describe('whisperRunner 纯逻辑', () => {
  it('原生 translationTarget 类型只允许 English', () => {
    expectTypeOf<NonNullable<TranscribeOptions['translationTarget']>>().toEqualTypeOf<'en'>();
  });
  it('CLI 参数包含模型/文件/语言/引导 prompt,禁时间戳', () => {
    const args = buildCliArgs({
      modelPath: 'C:\\m\\ggml-small.bin',
      wavPath: 'C:\\t\\rec.wav',
      language: 'zh',
      initialPrompt: '以下是简体中文普通话的句子,使用标点符号。',
    });
    expect(args).toContain('-m');
    expect(args).toContain('C:\\m\\ggml-small.bin');
    expect(args).toContain('-f');
    expect(args).toContain('-l');
    expect(args).toContain('zh');
    expect(args).toContain('--prompt');
    expect(args).toContain('-nt');
    expect(args).not.toContain('-tr');
  });

  it('CLI translate 任务映射为 -tr', () => {
    const args = buildCliArgs({
      modelPath: 'C:\\m\\ggml-small.bin',
      wavPath: 'C:\\t\\rec.wav',
      language: 'auto',
      initialPrompt: '',
      task: 'translate',
    });
    expect(args).toContain('-tr');
  });

  it('解析 server JSON 响应并 trim', () => {
    expect(parseServerResponse('{"text":"  你好,世界。\\n"}')).toEqual({
      text: '你好,世界。',
      detectedLanguage: undefined,
    });
  });

  it('verbose_json:detected_language 一并解析(P2b 语言锁定,评审 ⑤)', () => {
    expect(
      parseServerResponse('{"text":"你好","detected_language":"chinese","language":"chinese"}'),
    ).toEqual({ text: '你好', detectedLanguage: 'chinese' });
  });

  it('server 返回 error 字段 → 抛错', () => {
    expect(() => parseServerResponse('{"error":"failed to load model"}')).toThrow(
      /failed to load model/,
    );
  });
});
