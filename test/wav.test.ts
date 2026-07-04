import { describe, expect, it } from 'vitest';
import { base64ToInt16, encodeWavPcm16 } from '../src/audio/wav';

describe('WAV 编码', () => {
  it('生成合法 RIFF/WAVE 头(16kHz mono s16le)', () => {
    const chunk = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const wav = encodeWavPcm16([chunk], 16000);

    expect(wav.length).toBe(44 + 10);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 10);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000); // byte rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.readUInt32LE(40)).toBe(10); // data bytes
    // 采样数据往返
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(46)).toBe(1000);
    expect(wav.readInt16LE(48)).toBe(-1000);
    expect(wav.readInt16LE(50)).toBe(32767);
    expect(wav.readInt16LE(52)).toBe(-32768);
  });

  it('多 chunk 顺序拼接', () => {
    const wav = encodeWavPcm16([new Int16Array([1, 2]), new Int16Array([3])], 16000);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.readInt16LE(44)).toBe(1);
    expect(wav.readInt16LE(46)).toBe(2);
    expect(wav.readInt16LE(48)).toBe(3);
  });

  it('空录音 → 仅 44 字节头', () => {
    const wav = encodeWavPcm16([], 16000);
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0);
  });

  it('base64ToInt16 与 webview 编码互逆', () => {
    const samples = new Int16Array([0, 1, -1, 12345, -12345, 32767, -32768]);
    const b64 = Buffer.from(samples.buffer).toString('base64');
    expect(Array.from(base64ToInt16(b64))).toEqual(Array.from(samples));
  });
});
