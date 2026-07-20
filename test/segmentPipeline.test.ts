/**
 * P2b-2:SegmentPipeline 单测 —— 2b gate 自动项:保序 / typed error 三分门控
 * (cancelled 永不重试、transient 重试一次、permanent 直接终止)/ **WAV 在重试全部尝试
 * 结束后才删**(评审 v8-①)/ **重试尝试前取消检查**(评审 v9-③)/ backlog 超限停采集但
 * drain 不丢段(评审 v11-③/v12-②)/ Esc 删未提交段(评审 ④)。
 */
import { describe, expect, it, vi } from 'vitest';
import { CleanupCancelled } from '../src/cleanup/pipeline';
import { PipelineDeps, PipelineSegment, SegmentPipeline, SegmentTranscript } from '../src/segment/pipeline';
import { WhisperError } from '../src/stt/whisperRunner';
import { TranslationResult } from '../src/translation/pipeline';

function seg(index: number, durMs = 2000): PipelineSegment {
  return { wavPath: `tmp/seg-${index}.wav`, index, startMs: index * durMs, endMs: (index + 1) * durMs, speechMs: durMs / 2 };
}

interface Trace {
  events: string[];
  deps: PipelineDeps;
  fatal: Error[];
  backlog: number[];
  pressure: number[];
}

function makeDeps(
  transcribeImpl?: (wavPath: string, signal: AbortSignal) => Promise<SegmentTranscript>,
): Trace {
  const events: string[] = [];
  const fatal: Error[] = [];
  const backlog: number[] = [];
  const pressure: number[] = [];
  const deps: PipelineDeps = {
    transcribe: async (wav, signal) => {
      events.push(`transcribe:${wav}`);
      if (transcribeImpl) return transcribeImpl(wav, signal);
      await new Promise((r) => setTimeout(r, 1));
      return { text: `text-${wav}`, detectedLanguage: 'en' };
    },
    cleanup: async (raw, detectedLanguage, signal): Promise<TranslationResult> => {
      events.push(`cleanup:${detectedLanguage ?? 'unknown'}:${signal.aborted}`);
      return { text: raw, outcome: 'rules-only' };
    },
    insert: async (text) => {
      events.push(`insert:${text}`);
    },
    deleteWav: async (wav) => {
      events.push(`delete:${wav}`);
    },
    log: () => {},
    onFatal: (e) => fatal.push(e),
    onBacklogPressure: (ms) => pressure.push(ms),
    onBacklogLimit: (ms) => backlog.push(ms),
  };
  return { events, deps, fatal, backlog, pressure };
}

describe('SegmentPipeline', () => {
  it('includes FIFO queue wait in visible latency', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const t = makeDeps(async (wav) => {
        if (wav === 'tmp/seg-0.wav') await firstBlocked;
        return { text: wav, detectedLanguage: 'en' };
      });
      const visible = new Map<number, number>();
      t.deps.insert = async (_text, _segment, onVisible) => { onVisible(); };
      t.deps.onVisibleResult = (_result, segment, processingMs) => {
        visible.set(segment.index, processingMs);
      };
      const p = new SegmentPipeline(t.deps);

      p.enqueue(seg(0));
      vi.setSystemTime(100);
      p.enqueue(seg(1));
      vi.setSystemTime(1000);
      releaseFirst();
      await p.drained();

      expect(visible.get(1)).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });

  it('严格保序:前段插入完成后才开始后段转写', async () => {
    const t = makeDeps();
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    p.enqueue(seg(1));
    p.enqueue(seg(2));
    await p.drained();
    const order = t.events.filter((e) => !e.startsWith('delete'));
    expect(order).toEqual([
      'transcribe:tmp/seg-0.wav', 'cleanup:en:false', 'insert:text-tmp/seg-0.wav',
      'transcribe:tmp/seg-1.wav', 'cleanup:en:false', 'insert:text-tmp/seg-1.wav',
      'transcribe:tmp/seg-2.wav', 'cleanup:en:false', 'insert:text-tmp/seg-2.wav',
    ]);
  });

  it('WAV 在重试全部尝试结束后才删,只删一次(评审 v8-①)', async () => {
    let attempt = 0;
    const t = makeDeps(async () => {
      attempt++;
      if (attempt === 1) throw new WhisperError('transient', 'reset');
      return { text: 'ok', detectedLanguage: 'en' };
    });
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    await p.drained();
    expect(attempt).toBe(2); // transient → 重试一次成功
    const i1 = t.events.indexOf('transcribe:tmp/seg-0.wav');
    const i2 = t.events.lastIndexOf('transcribe:tmp/seg-0.wav');
    const del = t.events.indexOf('delete:tmp/seg-0.wav');
    expect(i2).toBeGreaterThan(i1);            // 确有两次尝试
    expect(del).toBeGreaterThan(i2);           // 删除在全部尝试之后
    expect(t.events.filter((e) => e === 'delete:tmp/seg-0.wav')).toHaveLength(1);
    expect(t.fatal).toHaveLength(0);
  });

  it('permanent 不重试:一次失败即显式终止,队列剩余段文件被删(评审 ③/v6-⑤)', async () => {
    let calls = 0;
    const t = makeDeps(async (wav) => {
      calls++;
      if (wav === 'tmp/seg-0.wav') throw new WhisperError('permanent', 'invalid wav');
      return { text: 'ok', detectedLanguage: 'en' };
    });
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    p.enqueue(seg(1));
    await p.drained();
    expect(calls).toBe(1); // 不重试,seg-1 不再处理
    expect(t.fatal).toHaveLength(1);
    expect(t.events).toContain('delete:tmp/seg-0.wav'); // 失败段即时删(v5-①)
    expect(t.events).toContain('delete:tmp/seg-1.wav'); // 队列剩余也删,不留盘
    expect(t.events.filter((e) => e.startsWith('insert'))).toHaveLength(0);
  });

  it('transient 重试后仍失败 → 显式终止,绝不静默跳段(评审 ③)', async () => {
    const t = makeDeps(async () => {
      throw new WhisperError('transient', 'server keeps dying');
    });
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    p.enqueue(seg(1));
    await p.drained();
    expect(t.fatal).toHaveLength(1);
    // seg-0 两次尝试;seg-1 直接删不处理(没有"跳过 seg-0 继续 seg-1"的静默缺句)
    expect(t.events.filter((e) => e === 'transcribe:tmp/seg-0.wav')).toHaveLength(2);
    expect(t.events.filter((e) => e === 'transcribe:tmp/seg-1.wav')).toHaveLength(0);
  });

  it('cancelled 永不重试、不算 fatal(评审 v3-③)', async () => {
    const t = makeDeps(async () => {
      throw new WhisperError('cancelled', 'aborted');
    });
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    await p.drained();
    expect(t.events.filter((e) => e.startsWith('transcribe'))).toHaveLength(1);
    expect(t.fatal).toHaveLength(0);
  });

  it('Esc 落在两次尝试之间 → 重试前取消检查拦截,不拉起新请求(评审 v9-③)', async () => {
    let calls = 0;
    let pipeline: SegmentPipeline;
    const t = makeDeps(async () => {
      calls++;
      pipeline.cancel(); // 第一次尝试期间会话被取消
      throw new WhisperError('transient', 'reset');
    });
    pipeline = new SegmentPipeline(t.deps);
    pipeline.enqueue(seg(0));
    await pipeline.drained();
    expect(calls).toBe(1); // transient 本应重试,但取消位挡住了第二次
    expect(t.fatal).toHaveLength(0);
  });

  it('backlog 超限 → onBacklogLimit 恰一次,已入队段照常 drain 全部插入(评审 v12-②)', async () => {
    const t = makeDeps(async () => {
      await new Promise((r) => setTimeout(r, 5)); // 慢转写,让队列先堆起来
      return { text: 'ok', detectedLanguage: 'en' };
    });
    const p = new SegmentPipeline(t.deps, 5000); // 上限 5s
    for (let i = 0; i < 4; i++) p.enqueue(seg(i, 2000)); // 8s 音频 > 5s
    expect(t.pressure).toHaveLength(1);
    expect(t.backlog).toHaveLength(1);
    await p.drained();
    expect(t.pressure).toHaveLength(1);
    expect(t.backlog).toHaveLength(1); // 不重复触发
    expect(t.events.filter((e) => e.startsWith('insert'))).toHaveLength(4); // 不销毁队列不丢段
  });

  it('backlog pressure fires once above half-limit without changing the full-limit semantics', async () => {
    const t = makeDeps(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: 'ok', detectedLanguage: 'en' };
    });
    const p = new SegmentPipeline(t.deps, 10_000);
    for (let i = 0; i < 4; i++) p.enqueue(seg(i, 2000)); // first in flight + 6s queued
    expect(t.pressure).toHaveLength(1);
    expect(t.pressure[0]).toBe(6000);
    expect(t.backlog).toHaveLength(0);
    await p.drained();
    expect(t.pressure).toHaveLength(1);
    expect(t.backlog).toHaveLength(0);
  });

  it('cancel(Esc):在途 signal aborted、未处理段文件全删、已插入的保留(评审 ④)', async () => {
    let sawAbort = false;
    const t = makeDeps(async (wav, signal) => {
      if (wav === 'tmp/seg-1.wav') {
        await new Promise((r) => setTimeout(r, 20));
        sawAbort = signal.aborted;
        throw new WhisperError('cancelled', 'aborted');
      }
      return { text: 'ok', detectedLanguage: 'en' };
    });
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    p.enqueue(seg(1));
    p.enqueue(seg(2));
    await new Promise((r) => setTimeout(r, 10)); // seg-0 已插入,seg-1 在途
    p.cancel();
    await p.drained();
    await new Promise((r) => setTimeout(r, 30)); // 等在途的假转写醒来记录 signal 状态
    expect(t.events).toContain('insert:ok'); // 已插入保留(自定义 transcribe 返回 'ok')
    expect(sawAbort).toBe(true);                              // 在途被 abort
    expect(t.events).toContain('delete:tmp/seg-2.wav');       // 未处理段文件删除
    expect(t.events.filter((e) => e.startsWith('insert'))).toHaveLength(1);
  });

  it('closed 后 enqueue 的段直接删文件不处理', async () => {
    const t = makeDeps();
    const p = new SegmentPipeline(t.deps);
    p.cancel();
    p.enqueue(seg(7));
    await p.drained();
    expect(t.events).toEqual(['delete:tmp/seg-7.wav']);
  });

  it('空转写(cleanup 后为空)跳过插入,继续后段,不算错', async () => {
    const t = makeDeps(async (wav) => ({ text: wav === 'tmp/seg-0.wav' ? '   ' : 'real' }));
    t.deps.cleanup = async (raw) => ({ text: raw.trim(), outcome: 'rules-only' });
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    p.enqueue(seg(1));
    await p.drained();
    expect(t.events.filter((e) => e.startsWith('insert'))).toEqual(['insert:real']);
    expect(t.fatal).toHaveLength(0);
  });

  it('passes detected language and the session signal to async cleanup', async () => {
    const t = makeDeps(async () => ({ text: 'hello', detectedLanguage: 'en', decodeLanguageHint: 'zh' }));
    let received: [string | undefined, AbortSignal] | undefined;
    t.deps.cleanup = async (raw, detectedLanguage, signal) => {
      received = [detectedLanguage, signal];
      return { text: raw, outcome: 'translated' };
    };
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    await p.drained();
    expect(received?.[0]).toBe('en');
    expect(received?.[1]).toBe(p.signal);
  });

  it('never promotes decodeLanguageHint to detectedLanguage', async () => {
    const t = makeDeps(async () => ({ text: 'hello', decodeLanguageHint: 'zh' }));
    let detected: string | undefined = 'sentinel';
    t.deps.cleanup = async (raw, detectedLanguage) => {
      detected = detectedLanguage;
      return { text: raw, outcome: 'translated' };
    };
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    await p.drained();
    expect(detected).toBeUndefined();
  });

  it('reports each structured feedback result immediately after cleanup', async () => {
    const t = makeDeps(async () => ({ text: 'hello', detectedLanguage: 'en' }));
    const observed = vi.fn();
    t.deps.cleanup = async () => ({ text: '你好', outcome: 'translated', llmMs: 5 });
    t.deps.onResult = observed;
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(3));
    await p.drained();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ text: '你好', outcome: 'translated' });
    expect(observed.mock.calls[0]?.[1]).toEqual(seg(3));
    expect(observed.mock.calls[0]?.[2]).toBeGreaterThanOrEqual(0);
  });

  it('reports feedback after cleanup but visible completion only after insertion finishes', async () => {
    const t = makeDeps(async () => ({ text: 'hello', detectedLanguage: 'en' }));
    let finishInsert!: () => void;
    let insertStarted!: () => void;
    const started = new Promise<void>((resolve) => { insertStarted = resolve; });
    t.deps.cleanup = async () => ({ text: '你好', outcome: 'translated' });
    t.deps.insert = async (_text, _segment, onVisible) => {
      insertStarted();
      await new Promise<void>((resolve) => { finishInsert = resolve; });
      onVisible();
    };
    const feedback = vi.fn();
    const visible = vi.fn();
    t.deps.onResult = feedback;
    (t.deps as typeof t.deps & { onVisibleResult: typeof visible }).onVisibleResult = visible;
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(4));

    await started;
    expect(feedback).toHaveBeenCalledOnce();
    expect(visible).not.toHaveBeenCalled();
    finishInsert();
    await p.drained();
    expect(feedback).toHaveBeenCalledOnce();
    expect(visible).toHaveBeenCalledOnce();
  });

  it('drains accumulated insertion without waiting for its deferred visible completion', async () => {
    const t = makeDeps(async () => ({ text: 'hello', detectedLanguage: 'en' }));
    let completeVisible: (() => void) | undefined;
    t.deps.cleanup = async () => ({ text: '你好', outcome: 'translated' });
    t.deps.insert = async (_text, _segment, onVisible) => {
      completeVisible = onVisible;
    };
    const visible = vi.fn();
    (t.deps as typeof t.deps & { onVisibleResult: typeof visible }).onVisibleResult = visible;
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(5));

    await p.drained();
    expect(completeVisible).toBeTypeOf('function');
    expect(visible).not.toHaveBeenCalled();
    completeVisible?.();
    completeVisible?.();
    expect(visible).toHaveBeenCalledOnce();
  });

  it('CleanupCancelled stops the segment without insertion or fatal callback', async () => {
    const t = makeDeps(async () => ({ text: 'hello', detectedLanguage: 'en' }));
    t.deps.cleanup = async () => { throw new CleanupCancelled(); };
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    await p.drained();
    expect(t.events.filter((event) => event.startsWith('insert'))).toHaveLength(0);
    expect(t.fatal).toHaveLength(0);
  });

  it('off wrapper remains insert-identical while returning a structured Promise', async () => {
    const t = makeDeps(async () => ({ text: '  ordinary dictation  ' }));
    t.deps.cleanup = async (raw) => ({ text: raw.trim(), outcome: 'rules-only' });
    const p = new SegmentPipeline(t.deps);
    p.enqueue(seg(0));
    await p.drained();
    expect(t.events.filter((event) => event.startsWith('insert'))).toEqual(['insert:ordinary dictation']);
  });
});
