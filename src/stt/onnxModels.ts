/**
 * inproc-s3:目录型 ONNX 模型(plan v7 §3.2)—— 纯 Node,无 vscode 依赖,可单元测试。
 *
 * - 清单 fail-closed(评审 ①/同 bin.manifest):文件名 + SHA-256 **钉死在代码里**
 *   (来源 = s1 实测验证过的 HF 正本),逐文件校验;无动态 SHA 兜底,校验不过即失败
 * - 原子完成(评审 ⑥):下载进 `<dir>.partial/` → 全部文件 SHA 过 → rename 为最终目录
 *   → 写 `.voiceflow-complete` 标记;**半下载目录永不被采信**(就绪 = 标记在 + 标记内容
 *   与当前清单一致 + 文件在——清单升级自动判不就绪)
 * - 修复路径:最终目录在但无标记(rename 后写标记前崩溃)→ 逐文件 SHA 全过则补标记,
 *   否则整目录删除重下
 * - v4-⑧ 拆分映射(单点):transformers.js `env.localModelPath` = modelsDir/onnx(根),
 *   模型 id = HF repo(含斜杠,落成嵌套目录);`inprocessModelPath` 是派生值(v6-②)
 * - 评审 ④ 禁网 fail-closed:`configureInprocessEnv` 是 env 覆写的唯一入口
 *   (allowRemoteModels=false:缺文件 = 本地报错,零网络请求)
 */
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DownloadError, checkDiskSpace, downloadWithResume, sha256File } from './download';

export type InprocessTier = 'small-q8';

export interface InprocessFileSpec {
  /** repo 内相对路径(正斜杠)。 */
  path: string;
  bytes: number;
  sha256: string;
}

export interface InprocessModelSpec {
  tier: InprocessTier;
  /** HF repo,同时是 transformers.js 的模型 id(env.localModelPath 下的嵌套目录名)。 */
  repo: string;
  approxBytes: number;
  label: string;
  /** dtype=q8 所需文件全集(transformers.js 3.8.1 命名:q8 → *_quantized.onnx)。 */
  files: InprocessFileSpec[];
}

/** SHA 来源:2026-07-06 s1 实测验证过的 HF 正本(spike/wasm-stt 缓存逐文件计算)。 */
export const INPROCESS_MODELS: Record<InprocessTier, InprocessModelSpec> = {
  'small-q8': {
    tier: 'small-q8',
    repo: 'onnx-community/whisper-small',
    approxBytes: 251_846_613,
    label: 'inprocess small-q8 (~252MB, ONNX, for managed/company machines)',
    files: [
      { path: 'config.json', bytes: 2227, sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18' },
      { path: 'generation_config.json', bytes: 3893, sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0' },
      { path: 'preprocessor_config.json', bytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', bytes: 2_480_466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', bytes: 282_683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 92_326_160, sha256: 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 156_750_845, sha256: 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9' },
    ],
  },
};

export const COMPLETE_MARKER = '.voiceflow-complete';

const HF_PRIMARY = 'https://huggingface.co';
const HF_MIRROR = 'https://hf-mirror.com';

export interface InprocessPaths {
  /** transformers.js env.localModelPath 应指向的根目录。 */
  localModelPath: string;
  /** transformers.js pipeline 的模型 id(= HF repo)。 */
  modelId: string;
  /** 模型文件所在目录(= localModelPath/repo,派生值,v6-②)。 */
  dir: string;
}

function pathsForRepo(modelsDir: string, repo: string): InprocessPaths {
  const localModelPath = join(modelsDir, 'onnx');
  return {
    localModelPath,
    modelId: repo,
    dir: join(localModelPath, ...repo.split('/')),
  };
}

/** v4-⑧ 拆分映射(唯一入口):modelsDir → (localModelPath 根, 模型 id, 目录)。 */
export function resolveInprocessPaths(modelsDir: string, tier: InprocessTier): InprocessPaths {
  return pathsForRepo(modelsDir, INPROCESS_MODELS[tier].repo);
}

/** 评审 ④:transformers.js env 覆写的唯一入口(防多处互踩)。缺文件 = 本地报错,零网络。 */
export function configureInprocessEnv(
  env: { allowRemoteModels: boolean; localModelPath: string },
  localModelPath: string,
): void {
  env.allowRemoteModels = false;
  env.localModelPath = localModelPath;
}

/** 标记文件内容:与清单绑定,清单升级(文件/SHA 变化)自动判不就绪。 */
function markerContent(spec: InprocessModelSpec): string {
  return JSON.stringify(
    { tier: spec.tier, repo: spec.repo, files: Object.fromEntries(spec.files.map((f) => [f.path, f.sha256])) },
    null,
    2,
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 就绪判据(评审 ⑥ + v6-①"ready 与完成标记一致"):标记存在、内容与当前清单一致、
 * 文件全部在。**不重算 SHA**(启动预检要快);SHA 只在下载/导入/修复时算。
 */
export async function isInprocessModelReady(dir: string, spec: InprocessModelSpec): Promise<boolean> {
  try {
    const marker = await readFile(join(dir, COMPLETE_MARKER), 'utf8');
    if (marker !== markerContent(spec)) return false;
  } catch {
    return false;
  }
  for (const f of spec.files) {
    if (!(await exists(join(dir, ...f.path.split('/'))))) return false;
  }
  return true;
}

/** 逐文件 SHA 校验(修复/导入路径用)。返回首个不匹配的文件路径,全过返回 undefined。 */
export async function verifyInprocessDir(
  dir: string,
  spec: InprocessModelSpec,
): Promise<string | undefined> {
  for (const f of spec.files) {
    const p = join(dir, ...f.path.split('/'));
    if (!(await exists(p))) return f.path;
    if ((await sha256File(p)) !== f.sha256) return f.path;
  }
  return undefined;
}

export interface EnsureInprocessOptions {
  modelsDir: string;
  tier: InprocessTier;
  /** 自定义 http 源(受限网络,按 HF 布局:<base>/<repo>/resolve/main/<path>)。 */
  httpBase?: string;
  signal?: AbortSignal;
  /** 聚合进度(全清单口径)。 */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  log?: (line: string) => void;
  /** 测试注入;缺省真实 downloadWithResume。 */
  download?: typeof downloadWithResume;
  /** 测试注入:微型清单(真实清单文件太大无法在单测覆盖编排逻辑);缺省按 tier 查表。 */
  spec?: InprocessModelSpec;
}

/**
 * 目录型模型确保(纯逻辑;UI 进度由 modelManager 包装):
 * 就绪 → 直接返回;目录在无标记 → 修复;否则 `.partial` 逐文件下载(断点续传:
 * 已下载且 SHA 过的文件跳过)→ 原子 rename → 写标记。
 * 取消/失败:`.partial` 保留供续传;抛 DownloadError(cancelled/sha-mismatch/…)。
 */
export async function ensureInprocessModelFiles(opts: EnsureInprocessOptions): Promise<InprocessPaths> {
  const spec = opts.spec ?? INPROCESS_MODELS[opts.tier];
  const paths = pathsForRepo(opts.modelsDir, spec.repo);
  const log = opts.log ?? ((): void => {});
  const download = opts.download ?? downloadWithResume;

  if (await isInprocessModelReady(paths.dir, spec)) return paths;

  // 修复路径(评审 ⑥):rename 后写标记前崩溃 → 目录在、标记不在/不一致
  if (await exists(paths.dir)) {
    log(`[onnx-model] ${spec.tier}: dir exists without valid marker, verifying…`);
    const bad = await verifyInprocessDir(paths.dir, spec);
    if (bad === undefined) {
      await writeFile(join(paths.dir, COMPLETE_MARKER), markerContent(spec));
      log(`[onnx-model] ${spec.tier}: repaired (all files verified, marker written)`);
      return paths;
    }
    log(`[onnx-model] ${spec.tier}: verification failed at ${bad}, re-downloading`);
    await rm(paths.dir, { recursive: true, force: true });
  }

  const partialDir = `${paths.dir}.partial`;
  await checkDiskSpace(join(partialDir, 'x'), spec.approxBytes);

  const totalBytes = spec.files.reduce((s, f) => s + f.bytes, 0);
  let completedBytes = 0;
  for (const f of spec.files) {
    const dest = join(partialDir, ...f.path.split('/'));
    // 续传:上次已下完且校验过的文件直接跳过(downloadWithResume 的 .part 续传覆盖半个文件的情形)
    if ((await exists(dest)) && (await sha256File(dest)) === f.sha256) {
      completedBytes += f.bytes;
      opts.onProgress?.(completedBytes, totalBytes);
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    log(`[onnx-model] ${spec.tier}: downloading ${f.path} (${(f.bytes / 1e6).toFixed(0)}MB)`);
    await download({
      urls: [
        ...(opts.httpBase ? [`${opts.httpBase}/${spec.repo}/resolve/main/${f.path}`] : []),
        `${HF_PRIMARY}/${spec.repo}/resolve/main/${f.path}`,
        `${HF_MIRROR}/${spec.repo}/resolve/main/${f.path}`,
      ],
      destPath: dest,
      expectedSha256: f.sha256, // fail-closed:清单钉死,无动态兜底
      signal: opts.signal,
      onProgress: (received) => opts.onProgress?.(completedBytes + received, totalBytes),
    });
    completedBytes += f.bytes;
    opts.onProgress?.(completedBytes, totalBytes);
  }

  // 原子完成(评审 ⑥):全部文件就位且逐文件校验过 → rename → 标记
  await rename(partialDir, paths.dir);
  await writeFile(join(paths.dir, COMPLETE_MARKER), markerContent(spec));
  log(`[onnx-model] ${spec.tier}: complete (${(totalBytes / 1e6).toFixed(0)}MB, marker written)`);
  return paths;
}

/**
 * 目录导入(v5-② importModel 目录型;合规渠道拿到的模型文件夹):
 * 先对**源**逐文件 SHA 校验(fail-closed,坏源不落地)→ 拷进 `.partial` → 原子 rename → 标记。
 * 源目录布局兼容两种:文件直接在选中目录下,或嵌套 <repo> 子目录(HF 下载器常见)。
 */
export async function importInprocessDir(
  srcDir: string,
  modelsDir: string,
  tier: InprocessTier,
  onProgress?: (done: number, total: number) => void,
  specOverride?: InprocessModelSpec,
): Promise<InprocessPaths> {
  const spec = specOverride ?? INPROCESS_MODELS[tier];
  const paths = pathsForRepo(modelsDir, spec.repo);

  // 源布局探测:直接布局 or <repo> 嵌套布局
  const nested = join(srcDir, ...spec.repo.split('/'));
  const root = (await exists(join(nested, spec.files[0]!.path.split('/')[0]!))) ? nested : srcDir;
  const bad = await verifyInprocessDir(root, spec);
  if (bad !== undefined) {
    throw new DownloadError('sha-mismatch', `import verification failed at ${bad}(选中的文件夹不是完整的 ${spec.tier} 模型)`);
  }

  await rm(paths.dir, { recursive: true, force: true });
  const partialDir = `${paths.dir}.partial`;
  await rm(partialDir, { recursive: true, force: true });
  let done = 0;
  for (const f of spec.files) {
    const dest = join(partialDir, ...f.path.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(root, ...f.path.split('/')), dest);
    onProgress?.(++done, spec.files.length);
  }
  await rename(partialDir, paths.dir);
  await writeFile(join(paths.dir, COMPLETE_MARKER), markerContent(spec));
  return paths;
}

export { DownloadError };
