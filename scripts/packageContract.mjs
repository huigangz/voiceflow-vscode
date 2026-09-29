/**
 * VSIX 内容契约(harness PR1)—— 纯逻辑,无 IO,供 verify-package.mjs 与单测共用。
 *
 * 判定对象是**实际产物的条目列表**,不是 .vscodeignore:ignore 只是配置,产物才是事实。
 * 主防线 = 根目录白名单(黑名单漏新文件的失败模式已发生过:0.2.1 test-audio、
 * 0.3.1 plan 文档 / debug.log);每个白名单目录内部再做精确集合(bin / media / node_modules / offline-model)。
 * variant 分支:offline-model/ 在 standard 是禁令、在 offline 是必需,不得写成单一规则表。
 */

import { createHash } from 'node:crypto';

export const SIZE_BUDGET = {
  standard: { min: 0, max: 25 * 1024 * 1024 },
  offline: { min: 400 * 1024 * 1024, max: 700 * 1024 * 1024 },
};

/** zip 根级(extension/ 之外)只允许 vsce 自身产出的两个条目。 */
const ZIP_ROOT_ALLOWED = new Set(['extension.vsixmanifest', '[Content_Types].xml']);

/** extension/ 第一层文件白名单(小写比较:vsce 会把 README.md → readme.md、LICENSE → LICENSE.txt)。 */
const TOP_FILES = new Set(['package.json', 'readme.md', 'license.txt', 'license', 'third-party-notices.md']);

const TOP_DIRS = { standard: ['dist', 'bin', 'media', 'node_modules'], offline: ['dist', 'bin', 'media', 'node_modules', 'offline-model'] };

const REQUIRED_EXTRA = ['package.json', 'dist/extension.js'];

/**
 * offline 包内置的 inprocess ONNX 模型(= src/stt/onnxModels.ts INPROCESS_MODELS['small-q8'],
 * 由 test/packageContract.test.ts 交叉校验一致;stage-bundled-model.mjs --onnx 暂存的就是它)。
 * 完成标记只证明"暂存脚本跑完过",不证明文件在包里 —— 必须逐文件要求 + 产物内 SHA。
 * 标记内容本身也要校验:运行时 isInprocessModelReady 逐字比较标记与清单,空/过期标记 = 内置模型不可用。
 */
export const OFFLINE_ONNX = {
  tier: 'small-q8',
  repo: 'onnx-community/whisper-small',
  /** HF 来源 revision(harness PR3 查实:7 文件 SHA 与此 revision 逐个一致)。fetch-offline-models 按它下载。 */
  revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
  dir: 'offline-model/onnx/onnx-community/whisper-small/',
  marker: '.voiceflow-complete',
  files: [
    { path: 'config.json', sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18' },
    { path: 'generation_config.json', sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0' },
    { path: 'preprocessor_config.json', sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
    { path: 'tokenizer.json', sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
    { path: 'tokenizer_config.json', sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
    { path: 'onnx/encoder_model_quantized.onnx', sha256: 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92' },
    { path: 'onnx/decoder_model_merged_quantized.onnx', sha256: 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9' },
  ],
};

/**
 * offline 包内置的 whisper.cpp 模型(harness PR3:钉死文件名 + SHA,取代原先的 ggml-*.bin 文件名匹配)。
 * fileName = src/stt/modelManager.ts MODELS.small.fileName(单测交叉校验);SHA = HF LFS oid。
 */
export const OFFLINE_WHISPER = {
  tier: 'small',
  repo: 'ggerganov/whisper.cpp',
  revision: '5359861c739e955e79d9a303bcbc70fb988958b1',
  path: 'offline-model/ggml-small.bin',
  sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
};

/**
 * offline 包的全部模型文件(相对扩展根)→ SHA + HF 来源。fetch-offline-models / package-offline
 * 的唯一清单来源;不含完成标记(标记由 offlineMarkerContent() 派生)。
 * @returns {{ path: string, sha256: string, repo: string, revision: string, repoPath: string }[]}
 */
export function offlineModelFiles() {
  const whisperRepoPath = OFFLINE_WHISPER.path.slice('offline-model/'.length);
  return [
    { path: OFFLINE_WHISPER.path, sha256: OFFLINE_WHISPER.sha256, repo: OFFLINE_WHISPER.repo, revision: OFFLINE_WHISPER.revision, repoPath: whisperRepoPath },
    ...OFFLINE_ONNX.files.map((f) => ({
      path: OFFLINE_ONNX.dir + f.path,
      sha256: f.sha256,
      repo: OFFLINE_ONNX.repo,
      revision: OFFLINE_ONNX.revision,
      repoPath: f.path,
    })),
  ];
}

/**
 * VSIX 文件名 —— 版本只来自 package.json(harness PR3 §8.3:唯一版本 source of truth)。
 * vsce --target win32-x64 的默认命名为 `${name}-win32-x64-${version}.vsix`;offline 加 -offline。
 */
export function vsixFileName({ name, version }, variant) {
  if (variant !== 'standard' && variant !== 'offline') throw new Error(`unknown variant: ${variant}`);
  if (!name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error(`package.json name/version 无效: ${name}@${version}`);
  return `${name}-win32-x64-${version}${variant === 'offline' ? '-offline' : ''}.vsix`;
}

/** 规范标记内容 —— 与 src/stt/onnxModels.ts markerContent() 同构(单测交叉校验逐字相等)。 */
export function offlineMarkerContent() {
  return JSON.stringify(
    { tier: OFFLINE_ONNX.tier, repo: OFFLINE_ONNX.repo, files: Object.fromEntries(OFFLINE_ONNX.files.map((f) => [f.path, f.sha256])) },
    null,
    2,
  );
}

/**
 * VSIX 内 node_modules 的精确集合 = manifest.nodeRuntime(JS / package.json)∪ manifest.nodeAddons(二进制)。
 * 双包陷阱哨兵 onnxruntime-common/dist/cjs/package.json(p2c5)在 nodeRuntime 清单内。
 */
function nodeModulesExpected(manifest) {
  const set = new Set(Object.keys(manifest.nodeAddons ?? {}));
  for (const [dir, meta] of Object.entries(manifest.nodeRuntime ?? {})) {
    if (dir.startsWith('_')) continue;
    for (const f of meta.files) set.add(`${dir}/${f}`);
  }
  return set;
}

/** 纵深禁令:白名单目录内部的混入(node_modules 里的 sourcemap、调试符号等)。 */
const FORBIDDEN_ANYWHERE = [
  [/\.map$/i, 'sourcemap'],
  [/\.pdb$/i, 'debug symbols'],
  [/\.log$/i, 'log file'],
  [/\.wav$/i, 'audio sample'],
  [/\.vsix$/i, 'nested vsix'],
];

/**
 * @param {object} p
 * @param {string[]} p.entries  zip 条目路径(含 extension/ 前缀,目录条目以 / 结尾可有可无)
 * @param {'standard'|'offline'} p.variant
 * @param {object} p.manifest   bin.manifest.json
 * @returns {string[]} 违规列表(空 = 通过)
 */
export function checkEntries({ entries, variant, manifest }) {
  if (variant !== 'standard' && variant !== 'offline') throw new Error(`unknown variant: ${variant}`);
  const errors = [];
  const files = [];

  for (const raw of entries) {
    const e = raw.replace(/\\/g, '/');
    if (e.endsWith('/')) continue; // 目录条目
    if (!e.startsWith('extension/')) {
      if (!ZIP_ROOT_ALLOWED.has(e)) errors.push(`[zip-root] 非 vsce 条目: ${e}`);
      continue;
    }
    files.push(e.slice('extension/'.length));
  }
  const fileSet = new Set(files);

  // ① 第一层白名单
  const topDirs = new Set(TOP_DIRS[variant]);
  for (const f of files) {
    const slash = f.indexOf('/');
    if (slash < 0) {
      if (!TOP_FILES.has(f.toLowerCase())) errors.push(`[top-level] 白名单外文件: ${f}`);
    } else {
      const dir = f.slice(0, slash);
      if (!topDirs.has(dir)) {
        const why = dir === 'offline-model' ? '(standard 包永不带模型)' : '';
        errors.push(`[top-level] 白名单外目录: ${dir}/ ← ${f}${why}`);
      }
    }
  }

  // ② 目录内部精确集合 / 前缀白名单
  const binExpected = new Set(Object.keys(manifest.files ?? {}).map((n) => `bin/${n}`));
  const mediaExpected = new Set(Object.keys(manifest.runtimeAssets ?? {}).filter((p) => p.startsWith('media/')));
  const nmExpected = nodeModulesExpected(manifest);
  const onnxExpected = new Set([...OFFLINE_ONNX.files.map((f) => f.path), OFFLINE_ONNX.marker].map((p) => OFFLINE_ONNX.dir + p));
  const offlineExpected = new Set([...onnxExpected, OFFLINE_WHISPER.path]);
  for (const f of files) {
    if (f.startsWith('bin/') && !binExpected.has(f)) errors.push(`[bin] manifest 外文件: ${f}`);
    if (f.startsWith('media/') && !mediaExpected.has(f)) errors.push(`[media] runtimeAssets 外文件: ${f}`);
    if (f.startsWith('dist/') && !/^dist\/[^/]+\.js$/.test(f)) errors.push(`[dist] 非 bundle 文件: ${f}`);
    if (f.startsWith('node_modules/') && !nmExpected.has(f)) errors.push(`[node_modules] 运行时清单外文件: ${f}`);
    if (variant === 'offline' && f.startsWith('offline-model/') && !offlineExpected.has(f)) {
      errors.push(`[offline-model] 清单外文件: ${f}`);
    }
    for (const [re, label] of FORBIDDEN_ANYWHERE) if (re.test(f)) errors.push(`[forbidden] ${label}: ${f}`);
  }

  // ③ 必需文件
  const required = [...REQUIRED_EXTRA, ...binExpected, ...mediaExpected, ...nmExpected];
  if (variant === 'offline') required.push(...onnxExpected);
  for (const r of required) if (!fileSet.has(r)) errors.push(`[required] 缺失: ${r}`);
  if (!files.some((f) => /^license(\.txt)?$/i.test(f))) errors.push('[required] 缺失: LICENSE');
  if (!files.some((f) => f.toLowerCase() === 'third-party-notices.md')) errors.push('[required] 缺失: THIRD-PARTY-NOTICES.md');
  if (variant === 'offline' && !fileSet.has(OFFLINE_WHISPER.path)) {
    errors.push(`[required] offline 缺 whisper 模型: ${OFFLINE_WHISPER.path}`);
  }

  return errors;
}

/**
 * 版本一致性:package.json == VSIX 内 package.json == 文件名。
 * @returns {string[]}
 */
export function checkVersion({ repoVersion, innerVersion, fileName, variant }) {
  const errors = [];
  if (innerVersion !== repoVersion) errors.push(`[version] VSIX 内 package.json ${innerVersion} ≠ 仓库 package.json ${repoVersion}`);
  const suffix = variant === 'offline' ? '-offline.vsix' : '.vsix';
  if (!fileName.endsWith(`-${repoVersion}${suffix}`)) {
    errors.push(`[version] 文件名 ${fileName} 与 版本 ${repoVersion} / variant ${variant} 不符(期望以 -${repoVersion}${suffix} 结尾)`);
  }
  return errors;
}

/** @returns {string[]} */
export function checkSize({ bytes, variant }) {
  const { min, max } = SIZE_BUDGET[variant];
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (bytes > max) return [`[size] ${mb(bytes)} 超出 ${variant} 预算 ${mb(max)} —— 对比上一版尺寸,查混入物`];
  if (bytes < min) return [`[size] ${mb(bytes)} 低于 ${variant} 下限 ${mb(min)} —— 模型可能未暂存`];
  return [];
}

/**
 * 产物内应做 SHA 校验的文件(相对 extension/)→ 期望 SHA。
 * @param {object} manifest
 * @param {'standard'|'offline'} [variant]
 * @returns {Map<string, string>}
 */
export function hashExpectations(manifest, variant = 'standard') {
  const m = new Map();
  for (const [name, meta] of Object.entries(manifest.files ?? {})) if (meta.sha256) m.set(`bin/${name}`, meta.sha256);
  for (const [p, meta] of Object.entries(manifest.nodeAddons ?? {})) m.set(p, meta.sha256);
  for (const [p, meta] of Object.entries(manifest.runtimeAssets ?? {})) m.set(p, meta.sha256);
  if (variant === 'offline') {
    m.set(OFFLINE_WHISPER.path, OFFLINE_WHISPER.sha256);
    for (const f of OFFLINE_ONNX.files) m.set(OFFLINE_ONNX.dir + f.path, f.sha256);
    // 标记按内容校验:期望 SHA = 规范内容的 SHA(空 / 过期 / 手改的标记都会不匹配)
    m.set(OFFLINE_ONNX.dir + OFFLINE_ONNX.marker, createHash('sha256').update(offlineMarkerContent()).digest('hex'));
  }
  return m;
}

/**
 * require 冒烟:在解出的 extension/ 目录里真正加载打洞包(清单只能证明"文件在",
 * 冒烟证明"闭包可加载")。返回给 `node -e` 执行的脚本;extRoot 为解包后的 extension/ 绝对路径。
 */
export function smokeScript(extRoot) {
  const p = (rel) => JSON.stringify(`${extRoot}/node_modules/${rel}`);
  return [
    `const ort = require(${p('onnxruntime-node')});`,
    `if (typeof ort.InferenceSession?.create !== 'function') throw new Error('onnxruntime-node: InferenceSession.create missing');`,
    `const common = require(${p('onnxruntime-common')});`,
    `if (typeof common.Tensor !== 'function') throw new Error('onnxruntime-common: Tensor missing');`,
    `const pv = require(${p('@picovoice/pvrecorder-node')});`,
    `if (typeof pv.PvRecorder !== 'function') throw new Error('pvrecorder-node: PvRecorder missing');`,
    `console.log('smoke ok: onnxruntime-node ' + (ort.env?.versions?.node ?? '?') + ', pvrecorder-node');`,
  ].join('\n');
}
