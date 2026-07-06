/**
 * inproc-s3:目录型 ONNX 模型编排单测(plan v7 §3.2,评审 ①/④/⑥)。
 * 微型清单 + 注入 download,覆盖:原子完成/半下载不采信/修复/续传跳过/
 * fail-closed(真 downloadWithResume + stub fetch 供错内容)/取消保留 .partial/
 * 清单升级判不就绪/导入校验。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadError } from '../src/stt/download';
import {
  COMPLETE_MARKER,
  InprocessModelSpec,
  ensureInprocessModelFiles,
  importInprocessDir,
  isInprocessModelReady,
  resolveInprocessPaths,
  verifyInprocessDir,
} from '../src/stt/onnxModels';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 微型清单:两个文件,一个嵌套(模拟 onnx/ 子目录)。 */
const CONTENT: Record<string, string> = {
  'config.json': '{"tiny":true}',
  'onnx/model.onnx': 'fake-onnx-bytes',
};
function tinySpec(): InprocessModelSpec {
  return {
    tier: 'small-q8',
    repo: 'test-org/tiny-model',
    approxBytes: 30,
    label: 'tiny',
    files: Object.entries(CONTENT).map(([path, c]) => ({
      path,
      bytes: Buffer.byteLength(c),
      sha256: sha(c),
    })),
  };
}

/** 注入 download:按 CONTENT 写正确内容,记录调用。 */
function fakeDownload(calls: string[]): typeof import('../src/stt/download').downloadWithResume {
  return async (opts) => {
    const rel = Object.keys(CONTENT).find((p) => opts.destPath.replaceAll('\\', '/').endsWith(p));
    calls.push(rel!);
    await mkdir(dirname(opts.destPath), { recursive: true });
    await writeFile(opts.destPath, CONTENT[rel!]!);
  };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'vf-onnx-'));

/** 微型 spec 的目录(与 ensureInprocessModelFiles 内部 pathsForRepo 同构)。 */
const tinyDir = (modelsDir: string): string => join(modelsDir, 'onnx', 'test-org', 'tiny-model');

afterEach(() => vi.unstubAllGlobals());

describe('拆分映射(v4-⑧)与就绪判据(评审 ⑥)', () => {
  it('resolveInprocessPaths:localModelPath=modelsDir/onnx,dir 按 repo 嵌套', () => {
    const p = resolveInprocessPaths(join('C:', 'store', 'models'), 'small-q8');
    expect(p.localModelPath).toBe(join('C:', 'store', 'models', 'onnx'));
    expect(p.modelId).toBe('onnx-community/whisper-small');
    expect(p.dir).toBe(join('C:', 'store', 'models', 'onnx', 'onnx-community', 'whisper-small'));
  });

  it('半下载/裸目录/标记不一致 一律不就绪;完整流程后就绪', async () => {
    const spec = tinySpec();
    const modelsDir = tmp();
    const calls: string[] = [];
    const paths = await ensureInprocessModelFiles({
      modelsDir, tier: 'small-q8', spec, download: fakeDownload(calls),
    });
    expect(calls).toEqual(Object.keys(CONTENT));
    expect(await isInprocessModelReady(paths.dir, spec)).toBe(true);
    expect(existsSync(`${paths.dir}.partial`)).toBe(false); // 原子 rename,无残留

    // 清单升级(SHA 变化)→ 同一目录判不就绪(v7-① ready 语义与清单绑定)
    const upgraded = tinySpec();
    upgraded.files[0]!.sha256 = sha('new-version');
    expect(await isInprocessModelReady(paths.dir, upgraded)).toBe(false);

    // 删标记 = 不就绪(半完成形态)
    await rm(join(paths.dir, COMPLETE_MARKER));
    expect(await isInprocessModelReady(paths.dir, spec)).toBe(false);
  });
});

describe('修复路径(评审 ⑥:rename 后写标记前崩溃)', () => {
  it('目录在、无标记、文件全对 → 补标记,零下载', async () => {
    const spec = tinySpec();
    const modelsDir = tmp();
    const dir = tinyDir(modelsDir);
    // 手工布置"崩溃现场":完整文件、无标记
    for (const [p, c] of Object.entries(CONTENT)) {
      const dest = join(dir, ...p.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, c);
    }
    const calls: string[] = [];
    await ensureInprocessModelFiles({ modelsDir, tier: 'small-q8', spec, download: fakeDownload(calls) });
    expect(calls).toEqual([]); // 修复不重下
    expect(await isInprocessModelReady(dir, spec)).toBe(true);
  });

  it('目录在、无标记、有坏文件 → 整目录重下', async () => {
    const spec = tinySpec();
    const modelsDir = tmp();
    const dir = tinyDir(modelsDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), 'corrupted');
    const calls: string[] = [];
    await ensureInprocessModelFiles({ modelsDir, tier: 'small-q8', spec, download: fakeDownload(calls) });
    expect(calls).toEqual(Object.keys(CONTENT)); // 全量重下
    expect(await isInprocessModelReady(dir, spec)).toBe(true);
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(CONTENT['config.json']);
  });
});

describe('续传与取消', () => {
  it('中途失败 → .partial 保留、不就绪;重试只下缺的文件(续传跳过已校验文件)', async () => {
    const spec = tinySpec();
    const modelsDir = tmp();
    const dir = tinyDir(modelsDir);
    // 第一轮:第二个文件下载失败
    const calls1: string[] = [];
    const failing: typeof import('../src/stt/download').downloadWithResume = async (opts) => {
      if (opts.destPath.endsWith('model.onnx')) throw new DownloadError('all-sources-failed', 'net down');
      await fakeDownload(calls1)(opts);
    };
    await expect(
      ensureInprocessModelFiles({ modelsDir, tier: 'small-q8', spec, download: failing }),
    ).rejects.toMatchObject({ code: 'all-sources-failed' });
    expect(existsSync(dir)).toBe(false); // 半下载永不成为最终目录
    expect(existsSync(`${dir}.partial`)).toBe(true);

    // 第二轮:已下且 SHA 过的 config.json 跳过,只下 model.onnx
    const calls2: string[] = [];
    await ensureInprocessModelFiles({ modelsDir, tier: 'small-q8', spec, download: fakeDownload(calls2) });
    expect(calls2).toEqual(['onnx/model.onnx']);
    expect(await isInprocessModelReady(dir, spec)).toBe(true);
  });

  it('取消 → cancelled 上抛,.partial 保留供续传', async () => {
    const spec = tinySpec();
    const modelsDir = tmp();
    const dir = tinyDir(modelsDir);
    const cancelling: typeof import('../src/stt/download').downloadWithResume = async (opts) => {
      if (opts.destPath.endsWith('model.onnx')) throw new DownloadError('cancelled', 'user cancelled');
      await fakeDownload([])(opts);
    };
    await expect(
      ensureInprocessModelFiles({ modelsDir, tier: 'small-q8', spec, download: cancelling }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(existsSync(join(`${dir}.partial`, 'config.json'))).toBe(true);
  });
});

describe('fail-closed(评审 ①:真 downloadWithResume + 错误内容源)', () => {
  it('源内容与钉死 SHA 不符 → sha-mismatch,目录不落地', async () => {
    const spec = tinySpec();
    const modelsDir = tmp();
    vi.stubGlobal('fetch', async () =>
      new Response('EVIL-CONTENT', { status: 200, headers: { 'content-length': '12' } }),
    );
    await expect(
      ensureInprocessModelFiles({ modelsDir, tier: 'small-q8', spec }), // 真 download
    ).rejects.toMatchObject({ code: expect.stringMatching(/sha-mismatch|all-sources-failed/) });
    expect(existsSync(tinyDir(modelsDir))).toBe(false);
  });
});

describe('目录导入(v5-②)', () => {
  it('合法源(直接布局)→ 导入就绪;嵌套 repo 布局同样识别', async () => {
    const spec = tinySpec();
    for (const nest of [false, true]) {
      const src = tmp();
      const root = nest ? join(src, ...spec.repo.split('/')) : src;
      for (const [p, c] of Object.entries(CONTENT)) {
        const f = join(root, ...p.split('/'));
        await mkdir(dirname(f), { recursive: true });
        await writeFile(f, c);
      }
      const modelsDir = tmp();
      const paths = await importInprocessDir(src, modelsDir, 'small-q8', undefined, spec);
      expect(await isInprocessModelReady(paths.dir, spec)).toBe(true);
    }
  });

  it('坏源 → sha-mismatch,不落地(fail-closed)', async () => {
    const spec = tinySpec();
    const src = tmp();
    await writeFile(join(src, 'config.json'), CONTENT['config.json']!);
    await mkdir(join(src, 'onnx'), { recursive: true });
    await writeFile(join(src, 'onnx', 'model.onnx'), 'tampered');
    const modelsDir = tmp();
    await expect(importInprocessDir(src, modelsDir, 'small-q8', undefined, spec)).rejects.toMatchObject({
      code: 'sha-mismatch',
    });
    expect(existsSync(tinyDir(modelsDir))).toBe(false);
  });

  it('verifyInprocessDir 返回首个坏文件路径', async () => {
    const spec = tinySpec();
    const dir = tmp();
    await writeFile(join(dir, 'config.json'), 'wrong');
    expect(await verifyInprocessDir(dir, spec)).toBe('config.json');
  });
});
