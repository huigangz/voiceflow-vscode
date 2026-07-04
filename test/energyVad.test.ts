import { describe, expect, it } from 'vitest';
import { EnergyVad, FRAME_SAMPLES, rmsInt16 } from '../src/audio/energyVad';

function sineFrame(amplitude: number, samples = FRAME_SAMPLES): Int16Array {
  const f = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    f[i] = Math.round(Math.sin((i / samples) * 20 * Math.PI) * amplitude * 32767);
  }
  return f;
}

function toBuffer(i16: Int16Array): Buffer {
  return Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);
}

describe('rmsInt16', () => {
  it('全零 → 0;满幅正弦 ≈ 0.707', () => {
    expect(rmsInt16(new Int16Array(512))).toBe(0);
    expect(rmsInt16(sineFrame(1))).toBeGreaterThan(0.6);
  });
});

describe('EnergyVad 帧切分', () => {
  it('响亮正弦 → isSpeech=true;静音 → false', () => {
    const vad = new EnergyVad();
    const loud = vad.push(toBuffer(sineFrame(0.3)));
    expect(loud).toHaveLength(1);
    expect(loud[0]!.isSpeech).toBe(true);
    const quiet = vad.push(Buffer.alloc(FRAME_SAMPLES * 2));
    expect(quiet[0]!.isSpeech).toBe(false);
  });

  it('任意 chunk 尺寸重组为定长帧,时间戳按采样数推进', () => {
    const vad = new EnergyVad();
    const whole = toBuffer(sineFrame(0.3, FRAME_SAMPLES * 3)); // 3 帧的数据
    const frames = [
      ...vad.push(whole.subarray(0, 100)), // 不足一帧
      ...vad.push(whole.subarray(100, 1500)),
      ...vad.push(whole.subarray(1500)),
    ];
    expect(frames).toHaveLength(3);
    expect(frames[0]!.timeMs).toBe(0);
    expect(frames[1]!.timeMs).toBe(32); // 512/16000 = 32ms
    expect(frames[2]!.timeMs).toBe(64);
    expect(frames.every((f) => f.pcm.length === FRAME_SAMPLES)).toBe(true);
    // 数据不丢不错位:重组后与原数据一致(前 3 帧部分)
    const joined = Buffer.concat(frames.map((f) => Buffer.from(f.pcm.buffer, f.pcm.byteOffset, f.pcm.byteLength)));
    expect(joined.equals(whole.subarray(0, FRAME_SAMPLES * 3 * 2))).toBe(true);
  });

  it('剩余不足一帧的字节留待下次', () => {
    const vad = new EnergyVad();
    expect(vad.push(Buffer.alloc(10))).toHaveLength(0);
    expect(vad.push(Buffer.alloc(FRAME_SAMPLES * 2 - 10))).toHaveLength(1);
  });
});
