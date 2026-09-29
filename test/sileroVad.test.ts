/** P2c-2:SileroVad 集成测试(真模型;语音占比用例另需本地语音样本)。 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SileroVad } from '../src/audio/sileroVad';
import { requireInCi } from './ciPrereq';

const MODEL = 'media/vad/silero_vad_v5.onnx';
const SPEECH_WAV = 'test-audio/zh.wav';

function modelAvailable(): boolean {
  try {
    require('onnxruntime-node');
    return existsSync(MODEL);
  } catch {
    return false;
  }
}

// 确定性:模型随 git 提交(bin.manifest.json runtimeAssets)、onnxruntime-node 是正式依赖 → CI 缺失即失败
const canRunModel = requireInCi(modelAvailable(), `onnxruntime-node 或 ${MODEL} 缺失`);

describe.skipIf(!canRunModel)('SileroVad(真模型)', () => {
  it('纯静音 → 非语音;reset 复位状态', async () => {
    const vad = await SileroVad.create(MODEL);
    for (let i = 0; i < 5; i++) {
      await expect(vad.process(new Int16Array(512))).resolves.toBe(false);
    }
    vad.reset();
    await expect(vad.process(new Int16Array(512))).resolves.toBe(false);
  }, 30_000);

  it('非 512 帧长抛错', async () => {
    const vad = await SileroVad.create(MODEL);
    await expect(vad.process(new Int16Array(256))).rejects.toThrow(/512/);
  });
});

// 本地语音样本:test-audio/ 不入 git(含个人录音)→ CI 暂允许跳过(登记于 scripts/check-test-skips.mjs 白名单);
// harness PR5 改用可再分发的合成 fixture 后移出白名单。
describe.skipIf(!(canRunModel && existsSync(SPEECH_WAV)))('SileroVad(真模型 + 本地语音样本)', () => {
  it('真人语音样本 → 语音帧占比合理', async () => {
    const vad = await SileroVad.create(MODEL);
    // zh.wav:16k mono s16
    const buf = readFileSync(SPEECH_WAV);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, Math.floor((buf.length - 44) / 2));
    let speech = 0;
    let frames = 0;
    for (let off = 0; off + 512 <= pcm.length; off += 512) {
      if (await vad.process(pcm.subarray(off, off + 512))) speech++;
      frames++;
    }
    expect(speech / frames).toBeGreaterThan(0.2); // 5.8s 口述样本,语音帧显著存在
    expect(speech / frames).toBeLessThan(0.98); // 且非全帧误判(区别于 energy 在 BGM 的失效形态)
    // 语音之后 reset 必须清掉 RNN 状态(静音后 reset 证明不了这一点)
    vad.reset();
    await expect(vad.process(new Int16Array(512))).resolves.toBe(false);
  }, 30_000);
});
