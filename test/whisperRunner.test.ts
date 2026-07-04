import { describe, expect, it } from 'vitest';
import { buildCliArgs, parseServerResponse } from '../src/stt/whisperRunner';

describe('whisperRunner 纯逻辑', () => {
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
  });

  it('解析 server JSON 响应并 trim', () => {
    expect(parseServerResponse('{"text":"  你好,世界。\\n"}')).toBe('你好,世界。');
  });

  it('server 返回 error 字段 → 抛错', () => {
    expect(() => parseServerResponse('{"error":"failed to load model"}')).toThrow(
      /failed to load model/,
    );
  });
});
