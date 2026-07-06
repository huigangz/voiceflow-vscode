/**
 * P2c:渲染混音格式转换纯逻辑 —— 交错 float32(任意采样率/声道,实测默认 48kHz stereo)
 * → 16kHz mono s16(whisper/VAD 管线的统一入格)。不依赖 vscode,全量单测。
 *
 * 管线:downmix(声道均值)→ FIR 低通(Hamming 窗 sinc,截止 0.45×outRate,防混叠)
 * → 线性插值重采样(任意比率,含 44.1k 等非整数比)→ s16 四舍五入钳位。
 * 流式:FIR 历史与重采样相位跨 push 保持;交错流按帧切,尾部不完整帧留待下次。
 */

export interface InputFormat {
  sampleRate: number;
  channels: number;
}

export const TARGET_RATE = 16000;

/** 交错多声道 → 单声道(均值)。length 必须是 channels 的整数倍。 */
export function downmixInterleaved(f32: Float32Array, channels: number): Float32Array {
  if (channels === 1) return f32;
  const frames = Math.floor(f32.length / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    const base = i * channels;
    for (let c = 0; c < channels; c++) s += f32[base + c]!;
    out[i] = s / channels;
  }
  return out;
}

/** Hamming 窗 sinc 低通 FIR 系数(奇数 taps,线性相位)。cutoffHz 相对 inRate。 */
export function designLowpassFir(inRate: number, cutoffHz: number, taps = 63): Float32Array {
  if (taps % 2 === 0) taps += 1;
  const fc = cutoffHz / inRate; // 归一化(0..0.5)
  const mid = (taps - 1) / 2;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - mid;
    const sinc = k === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * k) / k;
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1));
    h[n] = sinc * win;
    sum += h[n]!;
  }
  for (let n = 0; n < taps; n++) h[n]! /= sum; // 直流增益 1
  return h;
}

export class F32ToS16Converter {
  private readonly fir: Float32Array | undefined; // 不降采样时无需滤波
  /** FIR 输入历史(前 taps-1 个样本)。 */
  private history: Float32Array;
  /** 重采样读取位置(滤波后信号坐标,含小数相位)。 */
  private pos = 0;
  /** 上一批滤波输出的最后一个样本(跨批线性插值)。 */
  private lastFiltered = 0;
  private producedFiltered = 0; // 已产出的滤波样本总数(绝对坐标)
  /** 交错流尾部不完整帧暂存。 */
  private leftover: Float32Array = new Float32Array(0);

  constructor(
    private readonly input: InputFormat,
    private readonly outRate: number = TARGET_RATE,
  ) {
    if (input.sampleRate <= 0 || input.channels <= 0 || !Number.isFinite(input.sampleRate)) {
      throw new Error(`invalid input format: ${input.sampleRate}Hz x${input.channels}`);
    }
    if (input.sampleRate > outRate) {
      this.fir = designLowpassFir(input.sampleRate, 0.45 * outRate);
      this.history = new Float32Array(this.fir.length - 1);
    } else {
      this.history = new Float32Array(0);
    }
  }

  /** 喂入任意长度交错 f32 块,产出转换完成的 s16 mono(可能为空)。 */
  push(chunk: Float32Array): Int16Array {
    // ① 帧对齐(交错流可能在帧中间被切开)
    let data = chunk;
    if (this.leftover.length > 0) {
      data = new Float32Array(this.leftover.length + chunk.length);
      data.set(this.leftover, 0);
      data.set(chunk, this.leftover.length);
    }
    const usable = data.length - (data.length % this.input.channels);
    this.leftover = data.subarray(usable).slice();
    if (usable === 0) return new Int16Array(0);

    // ② downmix
    const mono = downmixInterleaved(data.subarray(0, usable), this.input.channels);

    // ③ FIR 低通(流式卷积:history + mono)
    let filtered: Float32Array;
    if (this.fir) {
      const taps = this.fir.length;
      const ext = new Float32Array(this.history.length + mono.length);
      ext.set(this.history, 0);
      ext.set(mono, this.history.length);
      const n = ext.length - (taps - 1);
      filtered = new Float32Array(Math.max(0, n));
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let t = 0; t < taps; t++) acc += ext[i + t]! * this.fir[t]!;
        filtered[i] = acc;
      }
      // 保存尾部 taps-1 个输入作下批历史
      this.history = ext.subarray(ext.length - (taps - 1)).slice();
    } else {
      filtered = mono;
    }
    if (filtered.length === 0) return new Int16Array(0);

    // ④ 线性插值重采样(绝对坐标:producedFiltered 为本批首样本的下标)
    const step = this.input.sampleRate / this.outRate;
    const batchStart = this.producedFiltered;
    const batchEnd = batchStart + filtered.length; // exclusive
    const out: number[] = [];
    // 需要 pos+1 < batchEnd 才能插值(留最后一个样本给下一批的跨批插值)
    while (this.pos + 1 < batchEnd) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s0 = i < batchStart ? this.lastFiltered : filtered[i - batchStart]!;
      const s1 = filtered[i + 1 - batchStart]!;
      out.push(s0 + (s1 - s0) * frac);
      this.pos += step;
    }
    this.lastFiltered = filtered[filtered.length - 1]!;
    this.producedFiltered = batchEnd;

    // ⑤ s16 钳位
    const s16 = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const v = Math.round(out[i]! * 32767);
      s16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return s16;
  }
}
