/** P2c-2:SileroVad 集成测试(真模型 + 真语音样本;onnxruntime/模型/样本缺失时优雅跳过)。 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SileroVad } from '../src/audio/sileroVad';

const MODEL = 'media/vad/silero_vad_v5.onnx';
const SPEECH_WAV = 'test-audio/zh.wav';

function canRun(): boolean {
  try {
    require('onnxruntime-node');
    return existsSync(MODEL) && existsSync(SPEECH_WAV);
  } catch {
    return false;
  }
}

describe.skipIf(!canRun())('SileroVad(真模型)', () => {
  it('纯静音 → 非语音;真人语音样本 → 语音帧占比合理;reset 复位状态', async () => {
    const vad = await SileroVad.create(MODEL);
    // 静音
    for (let i = 0; i < 5; i++) {
      await expect(vad.process(new Int16Array(512))).resolves.toBe(false);
    }
    // 真语音(zh.wav:16k mono s16)
    const buf = readFileSync(SPEECH_WAV);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, Math.floor((buf.length - 44) / 2));
    let speech = 0;
    let frames = 0;
    for (let off = 0; off + 512 <= pcm.length; off += 512) {
      if (await vad.process(pcm.subarray(off, off + 512))) speech++;
      frames++;
    }
    expect(speech / frames).toBeGreaterThan(0.2); // 5.8s 口述样本,语音帧显著存在
    expect(speech / frames).toBeLessThan(0.98);   // 且非全帧误判(区别于 energy 在 BGM 的失效形态)
    vad.reset();
    await expect(vad.process(new Int16Array(512))).resolves.toBe(false);
  }, 30_000);

  it('非 512 帧长抛错', async () => {
    const vad = await SileroVad.create(MODEL);
    await expect(vad.process(new Int16Array(256))).rejects.toThrow(/512/);
  });
});
