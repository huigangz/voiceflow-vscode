import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MODELS } from '../src/stt/modelManager';
import { INPROCESS_MODELS, markerContent } from '../src/stt/onnxModels';

// 测试文件按 CommonJS 编译(tsconfig module=Node16,无 type:module),静态 import .mjs 会被 tsc 拒绝 → 动态加载
type Contract = typeof import('../scripts/packageContract.mjs', { with: { 'resolution-mode': 'import' } });
let checkEntries: Contract['checkEntries'];
let checkSize: Contract['checkSize'];
let checkVersion: Contract['checkVersion'];
let hashExpectations: Contract['hashExpectations'];
let smokeScript: Contract['smokeScript'];
let OFFLINE_ONNX: Contract['OFFLINE_ONNX'];
let offlineMarkerContent: Contract['offlineMarkerContent'];
let OFFLINE_WHISPER: Contract['OFFLINE_WHISPER'];
let offlineModelFiles: Contract['offlineModelFiles'];
let vsixFileName: Contract['vsixFileName'];
beforeAll(async () => {
  ({
    checkEntries,
    checkSize,
    checkVersion,
    hashExpectations,
    smokeScript,
    OFFLINE_ONNX,
    offlineMarkerContent,
    OFFLINE_WHISPER,
    offlineModelFiles,
    vsixFileName,
  } = await import('../scripts/packageContract.mjs'));
});

const manifest = {
  files: {
    'whisper-server.exe': { source: 'whisper', sha256: 'aa' },
    'voiceflow-audio.node': { source: 'prebuilt', sha256: 'bb' },
  },
  nodeAddons: {
    'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll': { sha256: 'cc' },
  },
  runtimeAssets: {
    'media/vad/silero_vad_v5.onnx': { sha256: 'dd' },
  },
  nodeRuntime: {
    _comment: 'ignored',
    'node_modules/onnxruntime-node': { package: 'onnxruntime-node@1.27.0', files: ['package.json', 'dist/index.js', 'dist/backend.js'] },
    'node_modules/onnxruntime-common': { package: 'onnxruntime-common@1.27.0', files: ['package.json', 'dist/cjs/package.json', 'dist/cjs/index.js'] },
    'node_modules/@picovoice/pvrecorder-node': { package: '@picovoice/pvrecorder-node@1.2.9', files: ['package.json', 'dist/index.js'] },
  },
};

const ONNX_DIR = 'extension/offline-model/onnx/onnx-community/whisper-small/';
const ONNX_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
  '.voiceflow-complete',
];

/** 一个合规 standard 包的条目列表(vsce 实际命名:readme.md / LICENSE.txt)。 */
function goodStandard(): string[] {
  return [
    'extension.vsixmanifest',
    '[Content_Types].xml',
    'extension/package.json',
    'extension/readme.md',
    'extension/LICENSE.txt',
    'extension/THIRD-PARTY-NOTICES.md',
    'extension/dist/extension.js',
    'extension/bin/whisper-server.exe',
    'extension/bin/voiceflow-audio.node',
    'extension/media/vad/silero_vad_v5.onnx',
    'extension/node_modules/onnxruntime-node/package.json',
    'extension/node_modules/onnxruntime-node/dist/index.js',
    'extension/node_modules/onnxruntime-node/dist/backend.js',
    'extension/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
    'extension/node_modules/onnxruntime-common/package.json',
    'extension/node_modules/onnxruntime-common/dist/cjs/package.json',
    'extension/node_modules/onnxruntime-common/dist/cjs/index.js',
    'extension/node_modules/@picovoice/pvrecorder-node/package.json',
    'extension/node_modules/@picovoice/pvrecorder-node/dist/index.js',
  ];
}

function goodOffline(): string[] {
  return [
    ...goodStandard(),
    'extension/offline-model/ggml-small.bin',
    ...ONNX_FILES.map((p) => ONNX_DIR + p),
  ];
}

const check = (entries: string[], variant: 'standard' | 'offline' = 'standard') =>
  checkEntries({ entries, variant, manifest });

describe('package contract: entries', () => {
  it('合规 standard / offline 包通过', () => {
    expect(check(goodStandard())).toEqual([]);
    expect(check(goodOffline(), 'offline')).toEqual([]);
  });

  it('docs/** 泄漏 → FAIL 并指名', () => {
    const errs = check([...goodStandard(), 'extension/docs/plans/PLAN-x.md']);
    expect(errs.join('\n')).toMatch(/白名单外目录: docs\/ ← docs\/plans\/PLAN-x\.md/);
  });

  it('根目录任意新文件(debug.log / plan / ignore 文件)→ FAIL(白名单而非黑名单)', () => {
    for (const stray of ['debug.log', 'PLAN-tmp-test.md', '.vscodeignore-offline', 'release-notes-0.2.0.md', 'CLAUDE.md']) {
      const errs = check([...goodStandard(), `extension/${stray}`]);
      expect(errs.some((e) => e.includes(stray))).toBe(true);
    }
  });

  it('VAD 模型缺失 → FAIL', () => {
    const errs = check(goodStandard().filter((e) => !e.includes('silero')));
    expect(errs).toContain('[required] 缺失: media/vad/silero_vad_v5.onnx');
  });

  it('media/ 下 runtimeAssets 之外的文件(vad-web 残留)→ FAIL', () => {
    const errs = check([...goodStandard(), 'extension/media/vad/silero_vad_legacy.onnx', 'extension/media/recorder.js']);
    expect(errs).toHaveLength(2);
  });

  it('双包陷阱哨兵缺失 → FAIL', () => {
    const errs = check(goodStandard().filter((e) => !e.endsWith('onnxruntime-common/dist/cjs/package.json')));
    expect(errs).toContain('[required] 缺失: node_modules/onnxruntime-common/dist/cjs/package.json');
  });

  it('bin/ 多出或缺少 manifest 文件 → FAIL', () => {
    expect(check([...goodStandard(), 'extension/bin/stale.exe'])).toContain('[bin] manifest 外文件: bin/stale.exe');
    expect(check(goodStandard().filter((e) => !e.endsWith('whisper-server.exe')))).toContain(
      '[required] 缺失: bin/whisper-server.exe',
    );
  });

  it('node_modules 运行时清单外的文件(新包或打洞包内多余文件)→ FAIL', () => {
    const errs = check([
      ...goodStandard(),
      'extension/node_modules/@huggingface/transformers/package.json',
      'extension/node_modules/onnxruntime-node/lib/index.ts',
    ]);
    expect(errs.filter((e) => e.startsWith('[node_modules] 运行时清单外文件'))).toHaveLength(2);
  });

  it('review-P1:打洞包运行时 JS 缺失 → FAIL(原生二进制都在也不行)', () => {
    const noOrtJs = goodStandard().filter((e) => !/onnxruntime-node\/dist\/.+\.js$/.test(e));
    const errs = check(noOrtJs);
    expect(errs).toContain('[required] 缺失: node_modules/onnxruntime-node/dist/index.js');
    expect(errs).toContain('[required] 缺失: node_modules/onnxruntime-node/dist/backend.js');
    expect(check(goodStandard().filter((e) => !e.endsWith('pvrecorder-node/dist/index.js')))).toContain(
      '[required] 缺失: node_modules/@picovoice/pvrecorder-node/dist/index.js',
    );
  });

  it('白名单目录内部的 sourcemap / pdb → FAIL', () => {
    const errs = check([...goodStandard(), 'extension/dist/extension.js.map', 'extension/node_modules/onnxruntime-node/x.pdb']);
    expect(errs.filter((e) => e.startsWith('[forbidden]'))).toHaveLength(2);
  });

  it('offline-model 在 standard 中是禁令,在 offline 中是必需', () => {
    expect(check(goodOffline(), 'standard').join()).toMatch(/standard 包永不带模型/);
    const noModel = check(goodStandard(), 'offline');
    expect(noModel.join()).toMatch(/offline 缺 whisper 模型/);
    expect(noModel).toContain('[required] 缺失: offline-model/onnx/onnx-community/whisper-small/.voiceflow-complete');
  });

  it('review-P2:完成标记在但 ONNX 文件缺失 → FAIL(标记不等于内容)', () => {
    for (const missing of ['config.json', 'onnx/encoder_model_quantized.onnx']) {
      const errs = check(goodOffline().filter((e) => e !== ONNX_DIR + missing), 'offline');
      expect(errs).toEqual([`[required] 缺失: offline-model/onnx/onnx-community/whisper-small/${missing}`]);
    }
  });

  it('offline-model 下清单外文件 → FAIL', () => {
    const errs = check([...goodOffline(), `${ONNX_DIR}onnx/encoder_model.onnx`], 'offline');
    expect(errs.join()).toMatch(/\[offline-model\] 清单外文件/);
  });

  it('PR3:whisper 模型钉死为 ggml-small.bin —— 换成其他 ggml-*.bin 或多带一个都 FAIL', () => {
    const swapped = goodOffline().map((e) => e.replace('ggml-small.bin', 'ggml-base.bin'));
    const errs = check(swapped, 'offline');
    expect(errs).toContain('[offline-model] 清单外文件: offline-model/ggml-base.bin');
    expect(errs).toContain('[required] offline 缺 whisper 模型: offline-model/ggml-small.bin');
    expect(check([...goodOffline(), 'extension/offline-model/ggml-small-q5_1.bin'], 'offline')).toEqual([
      '[offline-model] 清单外文件: offline-model/ggml-small-q5_1.bin',
    ]);
  });

  it('未 strip extension/ 前缀的列表不会"空转通过"', () => {
    const stripped = goodStandard().map((e) => e.replace(/^extension\//, ''));
    expect(check(stripped).length).toBeGreaterThan(0);
  });

  it('zip 根级非 vsce 条目 → FAIL', () => {
    expect(check([...goodStandard(), 'evil.txt'])).toContain('[zip-root] 非 vsce 条目: evil.txt');
  });

  it('未知 variant 抛错', () => {
    expect(() => checkEntries({ entries: [], variant: 'x' as never, manifest })).toThrow();
  });
});

describe('package contract: version / size / hashes', () => {
  it('三方版本一致才通过', () => {
    const ok = { repoVersion: '0.3.1', innerVersion: '0.3.1', fileName: 'voiceflow-vscode-win32-x64-0.3.1.vsix', variant: 'standard' as const };
    expect(checkVersion(ok)).toEqual([]);
    expect(checkVersion({ ...ok, innerVersion: '0.3.0' })).toHaveLength(1);
    expect(checkVersion({ ...ok, fileName: 'voiceflow-vscode-win32-x64-0.3.0.vsix' })).toHaveLength(1);
    expect(checkVersion({ ...ok, variant: 'offline' })).toHaveLength(1);
    expect(checkVersion({ ...ok, variant: 'offline', fileName: 'voiceflow-vscode-win32-x64-0.3.1-offline.vsix' })).toEqual([]);
  });

  it('PR3:文件名只由 package.json 推导,且与 checkVersion 的期望一致', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const variant of ['standard', 'offline'] as const) {
      const fileName = vsixFileName(pkg, variant);
      expect(fileName.startsWith(`${pkg.name}-win32-x64-${pkg.version}`)).toBe(true);
      expect(checkVersion({ repoVersion: pkg.version, innerVersion: pkg.version, fileName, variant })).toEqual([]);
    }
    expect(vsixFileName({ name: 'x', version: '1.2.3-rc.1' }, 'offline')).toBe('x-win32-x64-1.2.3-rc.1-offline.vsix');
    expect(() => vsixFileName({ name: 'x', version: '' }, 'standard')).toThrow();
    expect(() => vsixFileName({ name: 'x', version: '1.2.3' }, 'y' as never)).toThrow();
  });

  it('尺寸预算', () => {
    const MB = 1024 * 1024;
    expect(checkSize({ bytes: 16 * MB, variant: 'standard' })).toEqual([]);
    expect(checkSize({ bytes: 41 * MB, variant: 'standard' })).toHaveLength(1);
    expect(checkSize({ bytes: 594 * MB, variant: 'offline' })).toEqual([]);
    expect(checkSize({ bytes: 16 * MB, variant: 'offline' })).toHaveLength(1);
  });

  it('offline 的 SHA 期望额外覆盖 whisper 模型 + 7 个 ONNX 文件 + 完成标记(按规范内容)', () => {
    const std = hashExpectations(manifest, 'standard');
    const off = hashExpectations(manifest, 'offline');
    expect(off.size - std.size).toBe(9);
    expect(off.get('offline-model/ggml-small.bin')).toBe(OFFLINE_WHISPER.sha256);
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    const markerSha = off.get('offline-model/onnx/onnx-community/whisper-small/.voiceflow-complete');
    expect(markerSha).toBe(sha(offlineMarkerContent()));
    // 空标记 / 过期标记(清单旧 SHA)都不会命中期望值
    expect(markerSha).not.toBe(sha(''));
    expect(markerSha).not.toBe(sha(offlineMarkerContent().replace(/"a43a83f3/, '"00000000')));
    expect(off.get('offline-model/onnx/onnx-community/whisper-small/onnx/encoder_model_quantized.onnx')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SHA 期望覆盖 bin / nodeAddons / runtimeAssets', () => {
    const m = hashExpectations(manifest);
    expect([...m.keys()].sort()).toEqual([
      'bin/voiceflow-audio.node',
      'bin/whisper-server.exe',
      'media/vad/silero_vad_v5.onnx',
      'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
    ]);
  });
});

describe('package contract: 与真实来源交叉校验', () => {
  it('OFFLINE_ONNX 与 src/stt/onnxModels.ts 的 small-q8 规格逐文件一致(路径 + SHA)', () => {
    const spec = INPROCESS_MODELS['small-q8'];
    expect(OFFLINE_ONNX.dir).toBe(`offline-model/onnx/${spec.repo}/`);
    expect(OFFLINE_ONNX.files).toEqual(spec.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
  });

  it('PR3:OFFLINE_WHISPER 文件名 = modelManager 的 small 档(默认档位)', () => {
    expect(OFFLINE_WHISPER.tier).toBe('small');
    expect(OFFLINE_WHISPER.path).toBe(`offline-model/${MODELS.small.fileName}`);
    expect(OFFLINE_WHISPER.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PR3:offlineModelFiles = whisper + 7 个 ONNX,来源 revision 钉死为 commit SHA', () => {
    const files = offlineModelFiles();
    expect(files).toHaveLength(1 + OFFLINE_ONNX.files.length);
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
    for (const f of files) {
      expect(f.path.startsWith('offline-model/')).toBe(true);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.revision).toMatch(/^[0-9a-f]{40}$/); // 不是 main 之类的可变分支名
    }
    expect(files[0]).toMatchObject({ repo: 'ggerganov/whisper.cpp', repoPath: 'ggml-small.bin' });
    expect(files.slice(1).map((f) => OFFLINE_ONNX.dir + f.repoPath)).toEqual(files.slice(1).map((f) => f.path));
    // 与 SHA 期望表一致:下载校验与产物校验用的是同一份清单
    const off = hashExpectations(manifest, 'offline');
    for (const f of files) expect(off.get(f.path)).toBe(f.sha256);
  });

  it('review-2:规范完成标记与运行时 markerContent() 逐字相等(运行时 isInprocessModelReady 逐字比较)', () => {
    expect(offlineMarkerContent()).toBe(markerContent(INPROCESS_MODELS['small-q8']));
  });

  it('bin.manifest.json 的 nodeRuntime 覆盖每个打洞包的 main 入口与双包哨兵', () => {
    const real = JSON.parse(readFileSync('bin.manifest.json', 'utf8'));
    for (const [dir, meta] of Object.entries(real.nodeRuntime as Record<string, { files: string[] }>)) {
      if (dir.startsWith('_')) continue;
      const main: string = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).main;
      expect(meta.files).toContain(main.replace(/^\.\//, ''));
    }
    expect(real.nodeRuntime['node_modules/onnxruntime-common'].files).toContain('dist/cjs/package.json');
  });

  it('require 冒烟脚本:真实依赖树可加载;不存在的目录 → 抛错', () => {
    const repoRoot = process.cwd().replace(/\\/g, '/');
    const ok = execFileSync(process.execPath, ['-e', smokeScript(repoRoot)], { encoding: 'utf8' });
    expect(ok).toMatch(/smoke ok/);
    // 反例用从未创建的路径:无需建目录,也就无需删除(用户规则:禁止递归删除目录)
    const missing = join(tmpdir(), `vf-smoke-missing-${randomUUID()}`);
    expect(existsSync(missing)).toBe(false);
    expect(() =>
      execFileSync(process.execPath, ['-e', smokeScript(missing.replace(/\\/g, '/'))], { cwd: tmpdir(), stdio: 'pipe' }),
    ).toThrow();
  });
});
