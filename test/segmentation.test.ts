/**
 * P2b-1:分段纯逻辑单测 —— 2b gate 自动项:分段切割 / 短段并段(评审 ③/v4-④)/
 * 纯静音尾段不提交(评审 v8-②)/ 段级 hasSpeech(评审 v9-④)/ segmentPause 边界值(评审 v5-②/v7-⑥)。
 */
import { describe, expect, it } from 'vitest';
import { SealedSegment, SegmentAccumulator, MIN_SPEECH_MS } from '../src/segment/segmentation';
import { validateSegmentedConfig } from '../src/segment/config';
import { PcmChunk } from '../src/audio/recorder';

const FRAME_MS = 32;

function chunk(timeMs: number, isSpeech: boolean): PcmChunk {
  return { pcm: new Int16Array(512).fill(isSpeech ? 5000 : 0), isSpeech, timeMs };
}

/** 依次喂入 speech/silence 时长(ms,按 32ms 帧展开),返回封口段列表。 */
function feed(acc: SegmentAccumulator, pattern: Array<['s' | '_', number]>, startMs = 0): number {
  let t = startMs;
  for (const [kind, ms] of pattern) {
    for (let i = 0; i < Math.round(ms / FRAME_MS); i++) {
      acc.push(chunk(t, kind === 's'));
      t += FRAME_MS;
    }
  }
  return t;
}

function collect(): { segs: SealedSegment[]; onSeal: (s: SealedSegment) => void } {
  const segs: SealedSegment[] = [];
  return { segs, onSeal: (s) => segs.push(s) };
}

describe('SegmentAccumulator 切段', () => {
  it('语音 1s + 静音 1.5s → 封口一段(含尾部静音帧,帧无缝分区)', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 1000], ['_', 1600]]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.hasSpeech).toBe(true);
    expect(segs[0]!.speechMs).toBeCloseTo(992, -2); // ~1s 语音(32ms 量化)
    expect(segs[0]!.startMs).toBe(0);
    // 段含语音 + 触发边界的静音(≈1.5s),帧数 = 段时长/32
    expect(segs[0]!.frames.length).toBe((segs[0]!.endMs - segs[0]!.startMs) / FRAME_MS);
  });

  it('纯静音永不切段(段内无语音不触发边界)', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['_', 10_000]]);
    expect(segs).toHaveLength(0);
  });

  it('连续多段:语音-停顿-语音-停顿 → 两段,顺序与时间戳正确', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 1000], ['_', 1600], ['s', 1000], ['_', 1600]]);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.startMs).toBe(0);
    expect(segs[1]!.startMs).toBe(segs[0]!.endMs); // 无缝衔接,不重叠不丢帧
    expect(segs[1]!.endMs).toBeGreaterThan(segs[1]!.startMs);
  });

  it('停顿不足 segmentPause 不切段', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 1000], ['_', 1400], ['s', 500]]);
    expect(segs).toHaveLength(0); // 1.4s < 1.5s,同一段还在积累
  });
});

describe('短段挂起并入(评审 ③ / v4-④)', () => {
  it('短段(<0.5s 语音)不发出,并入下一段一起封口', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    // "对。"(0.2s)+ 停顿 → 挂起;再说 1s → 停顿 → 合并封口
    feed(acc, [['s', 192], ['_', 1600], ['s', 1000], ['_', 1600]]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.mergedShortSegments).toBe(1);
    expect(segs[0]!.startMs).toBe(0); // 起点是短段的起点
    expect(segs[0]!.speechMs).toBeGreaterThan(MIN_SPEECH_MS);
  });

  it('连续多个短段可叠加挂起,最终一起并入', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 128], ['_', 1600], ['s', 128], ['_', 1600], ['s', 1000], ['_', 1600]]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.mergedShortSegments).toBe(2);
  });

  it('会话结束仍挂起 + 尾段有内容 → 合并提交(v8-②"有 pending 时提交")', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 192], ['_', 1600], ['_', 800]]); // 短段挂起,尾段纯静音
    acc.finalize();
    expect(segs).toHaveLength(1); // 纯静音尾段本不提交,但 pending 有语音 → 合并提交
    expect(segs[0]!.hasSpeech).toBe(true);
  });

  it('整场只说一个"对"(尾段 <0.5s 无相邻段)→ 单独提交,绝不丢弃(v4-④)', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 192], ['_', 500]]); // 未到切段停顿就结束
    acc.finalize();
    expect(segs).toHaveLength(1);
    expect(segs[0]!.speechMs).toBeLessThan(MIN_SPEECH_MS);
    expect(segs[0]!.hasSpeech).toBe(true);
  });
});

describe('尾段与丢弃(评审 v8-②)', () => {
  it('纯静音尾段且无 pending → 不提交(无语音≠丢内容)', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 1000], ['_', 1600], ['_', 2000]]); // 切走一段后,尾段全静音
    acc.finalize();
    expect(segs).toHaveLength(1); // 只有第一段;纯静音尾段没进 whisper
  });

  it('含语音尾段 → finalize 提交(段级 hasSpeech 判定,评审 v9-④)', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 1000], ['_', 1600], ['s', 800]]);
    acc.finalize();
    expect(segs).toHaveLength(2);
    expect(segs[1]!.hasSpeech).toBe(true);
  });

  it('discard(Esc/device-lost)→ 未发出内容全部丢弃,finalize 也不再产出', () => {
    const { segs, onSeal } = collect();
    const acc = new SegmentAccumulator(1500, onSeal);
    feed(acc, [['s', 192], ['_', 1600], ['s', 800]]); // pending + 进行中段
    acc.discard();
    acc.finalize();
    expect(segs).toHaveLength(0);
  });
});

describe('segmentPause 配置校验(评审 v5-② / v7-⑥,不 clamp)', () => {
  const cases: Array<[unknown, number, boolean]> = [
    // [segmentPause, autoStopSilence, 应通过]
    [1.5, 3, true],
    [0.5, 3, true],
    [0, 3, false],
    [-1, 3, false],
    [NaN, 3, false],
    [Infinity, 3, false],
    [0.4, 3, false],          // < schema minimum,运行时同拒
    ['1.5', 3, false],        // settings.json 手写字符串绕过 schema
    [1.5, 1, false],          // pause ≥ autoStop → 永远切不了段
    [3, 3, false],            // 相等同样拒绝
    [999, 0, true],           // autoStop 禁用 → 无上界(评审 v5-②)
  ];
  for (const [pause, autoStop, ok] of cases) {
    it(`pause=${String(pause)} autoStop=${autoStop} → ${ok ? 'ok' : '配置错误'}`, () => {
      const r = validateSegmentedConfig({ segmentPauseS: pause, autoStopSilenceS: autoStop });
      expect(r.ok).toBe(ok);
      if (!r.ok) expect(r.error).toContain('voiceflow.output.segmentPause');
      if (r.ok && typeof pause === 'number') expect(r.segmentPauseMs).toBe(pause * 1000);
    });
  }
});
