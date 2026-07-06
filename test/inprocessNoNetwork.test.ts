/**
 * inproc-s3:禁网 fail-closed(plan v7 §3.2,评审 ④)—— 真 @huggingface/transformers。
 * transformers.js 缺省 allowRemoteModels=true(缺文件会偷偷访问 HF);
 * configureInprocessEnv 后:缺文件 = 本地报错,**零网络请求**。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureInprocessEnv, resolveInprocessPaths } from '../src/stt/onnxModels';

function canRun(): boolean {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!canRun())('inprocess 禁网(真 transformers.js)', () => {
  it('缺文件 → 本地报错且零 fetch(评审 ④ fail-closed)', async () => {
    const { env, pipeline } = await import('@huggingface/transformers');
    const modelsDir = mkdtempSync(join(tmpdir(), 'vf-nonet-'));
    const paths = resolveInprocessPaths(modelsDir, 'small-q8');
    configureInprocessEnv(env as never, paths.localModelPath);
    expect((env as { allowRemoteModels: boolean }).allowRemoteModels).toBe(false);

    const fetchSpy = vi.fn(async () => {
      throw new Error('network attempted — 禁网被穿透');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      pipeline('automatic-speech-recognition', paths.modelId, { dtype: 'q8' }),
    ).rejects.toThrow(/local/i); // transformers.js 本地缺文件错误
    expect(fetchSpy).not.toHaveBeenCalled(); // 零网络请求
  }, 30_000);
});
