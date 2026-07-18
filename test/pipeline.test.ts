import { describe, expect, it } from 'vitest';
import { CLEANUP_PROMPT, CleanupCancelled, runCleanup } from '../src/cleanup/pipeline';
import { LlmProvider, ProviderResult } from '../src/cleanup/llmProvider';
import { DEFAULT_RULES } from '../src/cleanup/rulesLayer';

const base = { rules: DEFAULT_RULES, timeoutMs: 300 };

const usage = { inputTokens: 10, outputTokens: 3, estimate: false } as const;

function provider(fn: LlmProvider['run'], name = 'fake-llm'): LlmProvider {
  return { name, prepare: async () => ({ ok: true }), run: fn };
}

function enhancer(
  fn: (text: string, signal: AbortSignal) => Promise<string>,
  name = 'fake-llm',
): LlmProvider {
  return provider(
    async (_instruction, text, signal) => ({
      ok: true,
      text: await fn(text, signal),
      usage,
    }),
    name,
  );
}

describe('清理管线 (F3.3/F3.4)', () => {
  it('rules-only(无 enhancer)→ 仅规则层', async () => {
    const r = await runCleanup('用React寫代碼', base);
    expect(r.text).toBe('用 React 写代码');
    expect(r.usedProvider).toBe('rules');
  });

  it('增强层正常返回 → 用增强结果,记录耗时', async () => {
    let instruction = '';
    const r = await runCleanup('你好world', {
      ...base,
      enhancer: provider(async (receivedInstruction, text) => {
        instruction = receivedInstruction;
        return { ok: true, text: `${text}(已润色)`, usage };
      }),
    });
    expect(instruction).toBe(CLEANUP_PROMPT);
    expect(r.text).toBe('你好 world(已润色)');
    expect(r.usedProvider).toBe('fake-llm');
    expect(r.enhanceMs).toBeGreaterThanOrEqual(0);
    expect(r.degraded).toBeUndefined();
  });

  it('增强层超时 → 回落规则层结果(闭环不被 LLM 阻塞)', async () => {
    const r = await runCleanup('你好world', {
      ...base,
      timeoutMs: 50,
      enhancer: provider(
        async (_instruction, _text, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => resolve({ ok: false, kind: 'aborted', usage }),
              { once: true },
            );
          }),
      ),
    });
    expect(r.text).toBe('你好 world');
    expect(r.usedProvider).toBe('rules');
    expect(r.degraded).toBe('timeout');
  });

  it('增强层抛错 → 回落规则层结果', async () => {
    const r = await runCleanup('你好world', {
      ...base,
      enhancer: enhancer(async () => {
        throw new Error('model unavailable');
      }),
    });
    expect(r.text).toBe('你好 world');
    expect(r.degraded).toBe('error');
  });

  it.each(['rate-limit', 'unavailable', 'error'] as const)(
    'provider failure %s → 回落规则层结果',
    async (kind) => {
      const result = await runCleanup('你好world', {
        ...base,
        enhancer: provider(async (): Promise<ProviderResult> => ({
          ok: false,
          kind,
          usage,
          message: 'provider failed',
        })),
      });
      expect(result.text).toBe('你好 world');
      expect(result.degraded).toBe('error');
    },
  );

  it('provider aborted without outer cancellation or timeout → error fallback', async () => {
    const result = await runCleanup('你好world', {
      ...base,
      enhancer: provider(async () => ({ ok: false, kind: 'aborted', usage })),
    });
    expect(result.text).toBe('你好 world');
    expect(result.degraded).toBe('error');
  });

  it('增强层返回空 → 回落规则层结果', async () => {
    const r = await runCleanup('你好world', {
      ...base,
      enhancer: enhancer(async () => '  \n '),
    });
    expect(r.text).toBe('你好 world');
    expect(r.degraded).toBe('empty');
  });

  it('规则层结果为空(纯幻觉)→ 不调用增强层', async () => {
    let called = false;
    const r = await runCleanup('谢谢观看', {
      ...base,
      enhancer: enhancer(async (t) => {
        called = true;
        return t;
      }),
    });
    expect(r.text).toBe('');
    expect(called).toBe(false);
  });

  it('LLM 返回拒绝语 → 回落规则层(gate 实测场景:"中文输入检查"→拒绝)', async () => {
    const r = await runCleanup('中文输入检查', {
      ...base,
      enhancer: enhancer(async () => '抱歉,我无法协助处理该请求。'),
    });
    expect(r.text).toBe('中文输入检查');
    expect(r.usedProvider).toBe('rules');
    expect(r.degraded).toBe('rejected');
  });

  it('用户本来就在说"抱歉…" → 不误判为拒绝', async () => {
    const r = await runCleanup('抱歉今天不能参加会议了', {
      ...base,
      enhancer: enhancer(async () => '抱歉,今天不能参加会议了。'),
    });
    expect(r.usedProvider).toBe('fake-llm');
    expect(r.degraded).toBeUndefined();
  });

  it('LLM 大幅扩写(解释性输出)→ 回落规则层', async () => {
    const r = await runCleanup('部署完成了', {
      ...base,
      enhancer: enhancer(async () =>
        '好的!以下是清理后的文本。这段话的意思是部署工作已经结束,原文经过我的整理变得更加通顺:部署完成了。希望对你有帮助!',
      ),
    });
    expect(r.text).toBe('部署完成了');
    expect(r.degraded).toBe('rejected');
  });

  it('strips echoed delimiter, then uses the result', async () => {
    const r = await runCleanup('你好world', {
      ...base,
      enhancer: enhancer(async () => '<transcript>\n你好 world。\n</transcript>'),
    });
    expect(r.text).toBe('你好 world。');
    expect(r.usedProvider).toBe('fake-llm');
  });

  it('用户取消(外部 signal)→ 抛 CleanupCancelled(非降级)', async () => {
    const ac = new AbortController();
    const p = runCleanup(
      '你好world',
      {
        ...base,
        timeoutMs: 10_000,
        enhancer: provider(
          async (_instruction, _text, signal) =>
            new Promise((resolve) =>
              signal.addEventListener(
                'abort',
                () => resolve({ ok: false, kind: 'aborted', usage }),
                { once: true },
              ),
            ),
        ),
      },
      ac.signal,
    );
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toBeInstanceOf(CleanupCancelled);
  });
});
