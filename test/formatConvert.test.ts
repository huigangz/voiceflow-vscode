/** P2c-s2:格式转换层全量单测(路线图 2c 设计要点:新增纯逻辑模块,全量单测)。 */
import { describe, expect, it } from 'vitest';
import {
  F32ToS16Converter,
  designLowpassFir,
  downmixInterleaved,
} from '../src/audio/formatConvert';

/** 生成交错立体声正弦。 */
function stereoSine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const frames = Math.round(rate * seconds);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / rate);
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

/** Goertzel:输出信号在 freq 处的幅度估计。 */
function toneAmplitude(s16: Int16Array, rate: number, freq: number): number {
  const n = s16.length;
  const k = Math.round((n * freq) / rate);
  const w = (2 * Math.PI * k) / n;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = s16[i]! / 32767 + 2 * Math.cos(w) * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / (n / 2);
}

describe('downmixInterleaved', () => {
  it('立体声均值;单声道直通', () => {
    const st = new Float32Array([1, 0, 0.5, 0.5, -1, 1]);
    expect(Array.from(downmixInterleaved(st, 2))).toEqual([0.5, 0.5, 0]);
    const mono = new Float32Array([0.1, 0.2]);
    expect(downmixInterleaved(mono, 1)).toBe(mono);
  });
});

describe('designLowpassFir', () => {
  it('直流增益 1,系数对称(线性相位)', () => {
    const h = designLowpassFir(48000, 7200, 63);
    const sum = h.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    for (let i = 0; i < h.length; i++) expect(h[i]).toBeCloseTo(h[h.length - 1 - i]!, 6);
  });
});

describe('F32ToS16Converter 48k stereo → 16k mono', () => {
  it('DC 0.5 → 恒定 ~16384,输出长度 ≈ 1/3', () => {
    const c = new F32ToS16Converter({ sampleRate: 48000, channels: 2 });
    const input = new Float32Array(48000 * 2).fill(0.5); // 1s
    const out = c.push(input);
    expect(out.length).toBeGreaterThan(15900);
    expect(out.length).toBeLessThanOrEqual(16000);
    // 跳过 FIR 暖机段后应为恒定值
    for (let i = 100; i < out.length; i++) {
      expect(Math.abs(out[i]! - 16384)).toBeLessThanOrEqual(2);
    }
  });

  it('1kHz 通带正弦保真;10kHz(超出 16k Nyquist)被抑制 —— 防混叠', () => {
    const c1 = new F32ToS16Converter({ sampleRate: 48000, channels: 2 });
    const pass = c1.push(stereoSine(1000, 48000, 1));
    expect(toneAmplitude(pass, 16000, 1000)).toBeGreaterThan(0.4); // 幅值 0.5 基本保留

    const c2 = new F32ToS16Converter({ sampleRate: 48000, channels: 2 });
    const stop = c2.push(stereoSine(10000, 48000, 1));
    // 10kHz 若被 naive 抽取会混叠到 6kHz;FIR 应把总能量压低一个数量级以上
    let sum = 0;
    for (let i = 0; i < stop.length; i++) sum += (stop[i]! / 32767) ** 2;
    const rms = Math.sqrt(sum / stop.length);
    expect(rms).toBeLessThan(0.05); // 输入 RMS ≈0.35
  });

  it('流式一致:整块 vs 小块(含帧中间切开)输出完全一致', () => {
    const input = stereoSine(440, 48000, 0.5);
    const whole = new F32ToS16Converter({ sampleRate: 48000, channels: 2 }).push(input);

    const chunked = new F32ToS16Converter({ sampleRate: 48000, channels: 2 });
    const parts: number[] = [];
    let off = 0;
    const sizes = [3, 1001, 7, 4096, 333]; // 故意含奇数(把交错帧切开)
    let si = 0;
    while (off < input.length) {
      const len = Math.min(sizes[si++ % sizes.length]!, input.length - off);
      const out = chunked.push(input.subarray(off, off + len));
      for (let i = 0; i < out.length; i++) parts.push(out[i]!);
      off += len;
    }
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBe(whole[i]);
  });

  it('钳位:超幅值不溢出', () => {
    const c = new F32ToS16Converter({ sampleRate: 48000, channels: 1 });
    const loud = new Float32Array(4800).fill(1.5);
    const out = c.push(loud);
    for (const v of out) expect(v).toBeLessThanOrEqual(32767);
    const c2 = new F32ToS16Converter({ sampleRate: 48000, channels: 1 });
    const neg = new Float32Array(4800).fill(-1.5);
    for (const v of c2.push(neg)) expect(v).toBeGreaterThanOrEqual(-32768);
  });

  it('44.1k 非整数比:DC 保真,长度 ≈ n×16000/44100', () => {
    const c = new F32ToS16Converter({ sampleRate: 44100, channels: 2 });
    const out = c.push(new Float32Array(44100 * 2).fill(0.25)); // 1s
    expect(out.length).toBeGreaterThan(15800);
    expect(out.length).toBeLessThanOrEqual(16000);
    for (let i = 100; i < out.length; i++) {
      expect(Math.abs(out[i]! - 8192)).toBeLessThanOrEqual(2);
    }
  });

  it('非法输入格式 → 抛错;16k 直通不滤波', () => {
    expect(() => new F32ToS16Converter({ sampleRate: 0, channels: 2 })).toThrow();
    const c = new F32ToS16Converter({ sampleRate: 16000, channels: 1 });
    const out = c.push(new Float32Array([0.5, -0.5, 0.25]));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toBe(16384);
  });
});
