/** P2c-2:SileroVad 集成测试(真模型 + 合成语音 fixture;harness PR5 起不再依赖本地录音)。 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { SileroVad } from '../src/audio/sileroVad';
import { requireInCi } from './ciPrereq';

const MODEL = 'media/vad/silero_vad_v5.onnx';
const MANIFEST = 'test/fixtures/audio/fixtures.json';
const FIXTURE = 'speech-en-tts.wav';
const FRAME = 512;

// 断言阈值(spec §10.7 B 预注册;依据 = PR5 spike 实测:语音区 0.89–0.99,语音后拖尾 ≤ 2 帧,噪声 / 纯音 0)
const MIN_SPEECH_RATIO = 0.8;
const HANGOVER_FRAMES = 8; // 语音结束后允许的拖尾(256ms),之后必须全为非语音
const MAX_NEGATIVE_RATIO = 0.05;

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
// 合成 fixture 随 git 提交(test/fixtures/audio/,来源见其 README)→ CI 缺失即失败
const canRunFixture =
  canRunModel &&
  requireInCi(existsSync(MANIFEST) && existsSync(`test/fixtures/audio/${FIXTURE}`), `${MANIFEST} 或 fixture ${FIXTURE} 缺失`);

async function flagsOf(vad: SileroVad, pcm: Int16Array): Promise<boolean[]> {
  const flags: boolean[] = [];
  for (let off = 0; off + FRAME <= pcm.length; off += FRAME) flags.push(await vad.process(pcm.subarray(off, off + FRAME)));
  return flags;
}

/** 完整落在 [start, end) 内的帧下标范围(跨边界的帧不计)。 */
function framesWithin(start: number, end: number): [number, number] {
  return [Math.ceil(start / FRAME), Math.floor(end / FRAME)];
}

/** 确定性负对照:LCG 白噪声 / 纯音(不落盘)。 */
function whiteNoise(samples: number, amp: number): Int16Array {
  const out = new Int16Array(samples);
  let r = 7;
  for (let i = 0; i < samples; i++) {
    r = (r * 1103515245 + 12345) & 0x7fffffff;
    out[i] = Math.round((r / 0x7fffffff - 0.5) * 2 * amp);
  }
  return out;
}
function tone(samples: number, hz: number, amp: number): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 16000));
  return out;
}
const ratio = (flags: boolean[]) => flags.filter(Boolean).length / flags.length;

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

  // Silero 取代 energy 的理由(D4):BGM / 噪声下 energy 必然误触发,Silero 不应
  it('负对照:白噪声、440Hz 纯音 → 基本不判为语音', async () => {
    const vad = await SileroVad.create(MODEL);
    expect(ratio(await flagsOf(vad, whiteNoise(3 * 16000, 3000)))).toBeLessThanOrEqual(MAX_NEGATIVE_RATIO);
    vad.reset();
    expect(ratio(await flagsOf(vad, tone(3 * 16000, 440, 8000)))).toBeLessThanOrEqual(MAX_NEGATIVE_RATIO);
  }, 30_000);
});

describe.skipIf(!canRunFixture)('SileroVad(真模型 + 合成语音 fixture)', () => {
  type Region = { kind: 'speech' | 'silence'; startSample: number; endSample: number };
  let pcm: Int16Array;
  let regions: Region[];

  beforeAll(async () => {
    const { decodeWav } = await import('../scripts/audioFixtures.mjs');
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { fixtures: { file: string; regions: Region[] }[] };
    const entry = manifest.fixtures.find((f) => f.file === FIXTURE);
    if (!entry) throw new Error(`${MANIFEST} 中没有 ${FIXTURE}`);
    regions = entry.regions;
    pcm = decodeWav(readFileSync(`test/fixtures/audio/${FIXTURE}`)).pcm;
  });

  it('语音区段判为语音,静音区段(拖尾之后)判为非语音', async () => {
    const flags = await flagsOf(await SileroVad.create(MODEL), pcm);
    expect(regions.some((r) => r.kind === 'speech')).toBe(true);
    let afterSpeech = false;
    for (const r of regions) {
      const [a, b] = framesWithin(r.startSample, r.endSample);
      const fr = flags.slice(a, b);
      const where = `${r.kind} [${r.startSample}, ${r.endSample})`;
      if (r.kind === 'speech') {
        expect(ratio(fr), where).toBeGreaterThanOrEqual(MIN_SPEECH_RATIO);
      } else {
        const strict = afterSpeech ? fr.slice(HANGOVER_FRAMES) : fr;
        expect(strict.filter(Boolean).length, where).toBe(0);
      }
      afterSpeech = r.kind === 'speech';
    }
  }, 30_000);

  it('说话态中 reset → 下一静音帧为非语音(RNN 状态被清空)', async () => {
    const vad = await SileroVad.create(MODEL);
    const speech = regions.find((r) => r.kind === 'speech')!;
    const [a, b] = framesWithin(speech.startSample, speech.endSample);
    const mid = Math.floor((a + b) / 2);
    let speaking = false;
    for (let k = 0; k < b; k++) {
      speaking = await vad.process(pcm.subarray(k * FRAME, (k + 1) * FRAME));
      if (k >= mid && speaking) break;
    }
    expect(speaking).toBe(true); // 确实是在说话态里 reset,否则本用例证明不了什么
    vad.reset();
    await expect(vad.process(new Int16Array(FRAME))).resolves.toBe(false);
  }, 30_000);
});
