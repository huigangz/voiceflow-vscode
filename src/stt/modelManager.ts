/**
 * 模型档位管理 + 下载编排(F5.2,S2 mini-spike 的 vscode 胶水层)。
 * 下载核心逻辑在 ./download.ts(纯 Node,可测试)。
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';
import {
  DownloadError,
  checkDiskSpace,
  downloadWithResume,
  fetchExpectedSha256,
} from './download';
import {
  INPROCESS_MODELS,
  InprocessPaths,
  InprocessTier,
  ensureInprocessModelFiles,
  importInprocessDir,
  isInprocessModelReady,
  resolveInprocessPaths,
} from './onnxModels';

export type ModelTier = 'base' | 'small' | 'small-q5' | 'large-v3-turbo-q5' | 'large-v3-turbo';

export interface ModelSpec {
  tier: ModelTier;
  fileName: string;
  /** 近似大小(bytes),仅用于磁盘预检与进度展示。 */
  approxBytes: number;
  label: string;
}

const HF_REPO = 'ggerganov/whisper.cpp';
const PRIMARY = 'https://huggingface.co';
const MIRROR = 'https://hf-mirror.com'; // 国内镜像(F5.2)

export const MODELS: Record<ModelTier, ModelSpec> = {
  // Labels describe memory / quality / speed (preview is a CPU build; no GPU wording — GPU acceleration is a later release)
  base: {
    tier: 'base',
    fileName: 'ggml-base.bin',
    approxBytes: 148_000_000,
    label: 'base (~148MB, fastest, lowest memory, basic quality)',
  },
  small: {
    tier: 'small',
    fileName: 'ggml-small.bin',
    approxBytes: 488_000_000,
    label: 'small (~488MB, balanced, recommended)',
  },
  'small-q5': {
    tier: 'small-q5',
    fileName: 'ggml-small-q5_1.bin',
    approxBytes: 190_000_000,
    label: 'small-q5 (~190MB, quantized, low memory, near-small quality)',
  },
  'large-v3-turbo-q5': {
    tier: 'large-v3-turbo-q5',
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    approxBytes: 574_000_000,
    label: 'large-v3-turbo-q5 (~574MB, better quality, slower, more memory)',
  },
  'large-v3-turbo': {
    tier: 'large-v3-turbo',
    fileName: 'ggml-large-v3-turbo.bin',
    approxBytes: 1_624_000_000,
    label: 'large-v3-turbo (~1.6GB, best quality, slowest, highest memory)',
  },
};

export class ModelManager {
  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly log: (line: string) => void,
    /**
     * 可选:随扩展打包的离线模型目录(offline build,B 方案)。
     * = extensionUri/offline-model。存在对应 .bin 则直接使用,运行时零下载。
     */
    private readonly bundledModelsUri?: vscode.Uri,
  ) {}

  modelDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, 'models');
  }

  /** globalStorage 下的目标路径(下载/手动导入位置)。 */
  modelPath(tier: ModelTier): vscode.Uri {
    return vscode.Uri.joinPath(this.modelDir(), MODELS[tier].fileName);
  }

  private async statSize(uri: vscode.Uri): Promise<number> {
    try {
      return (await vscode.workspace.fs.stat(uri)).size;
    } catch {
      return 0;
    }
  }

  /**
   * 解析已存在的模型文件:优先 globalStorage(用户下载/手动导入),
   * 其次扩展内置 offline-model(打包模型)。都没有则 undefined。
   */
  private async resolveExisting(tier: ModelTier): Promise<vscode.Uri | undefined> {
    const local = this.modelPath(tier);
    if ((await this.statSize(local)) > 0) return local;
    if (this.bundledModelsUri) {
      const bundled = vscode.Uri.joinPath(this.bundledModelsUri, MODELS[tier].fileName);
      if ((await this.statSize(bundled)) > 0) return bundled;
    }
    return undefined;
  }

  async isDownloaded(tier: ModelTier): Promise<boolean> {
    return (await this.resolveExisting(tier)) !== undefined;
  }

  /**
   * 确保模型可用:已存在(globalStorage 或内置离线模型)直接返回;否则带进度/可取消地下载。
   * 兜底(spec §9.1 No-Go 备案):手动下载后把 .bin 放进 models/ 目录即被识别;
   * 或使用 offline VSIX(模型已内置,零下载)。
   */
  async ensureModel(tier: ModelTier): Promise<vscode.Uri> {
    const spec = MODELS[tier];
    const dest = this.modelPath(tier);
    const existing = await this.resolveExisting(tier);
    if (existing) {
      this.log(`[model] using existing ${spec.fileName} at ${existing.fsPath}`);
      return existing;
    }

    // C:自定义模型源(内部镜像 / 本地共享)。http(s) → 加入下载源;本地/UNC 路径 → 直接复制。
    const sourceUrl = vscode.workspace
      .getConfiguration('voiceflow')
      .get<string>('model.sourceUrl', '')
      .trim();
    const httpSource = /^https?:\/\//i.test(sourceUrl) ? sourceUrl.replace(/\/+$/, '') : undefined;
    const localDir = sourceUrl && !httpSource ? sourceUrl.replace(/^file:\/\//i, '') : undefined;
    if (localDir) {
      const src = join(localDir, spec.fileName);
      if (existsSync(src)) {
        await this.copyModelWithProgress(src, dest, spec);
        this.log(`[model] copied ${spec.fileName} from custom local source ${localDir}`);
        return dest;
      }
      this.log(`[model] custom local source set but ${src} not found; falling back to download`);
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `VoiceFlow: Downloading model ${spec.fileName}`,
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        await checkDiskSpace(dest.fsPath, spec.approxBytes);

        this.log(`[model] fetching expected sha256 for ${spec.fileName}…`);
        const expectedSha256 = await fetchExpectedSha256(
          [PRIMARY, MIRROR],
          HF_REPO,
          spec.fileName,
          controller.signal,
        );
        if (expectedSha256 === undefined) {
          this.log('[model] WARN: could not fetch expected SHA-256 (HF API unreachable); skipping verification this time');
        }

        let lastPct = 0;
        const t0 = Date.now();
        await downloadWithResume({
          // C:自定义 http 镜像优先,其次 HF + 国内镜像
          urls: [
            ...(httpSource ? [`${httpSource}/${spec.fileName}`] : []),
            `${PRIMARY}/${HF_REPO}/resolve/main/${spec.fileName}`,
            `${MIRROR}/${HF_REPO}/resolve/main/${spec.fileName}`,
          ],
          destPath: dest.fsPath,
          expectedSha256,
          signal: controller.signal,
          onProgress: (received, total) => {
            const pct = total !== undefined ? Math.floor((received / total) * 100) : 0;
            if (pct > lastPct) {
              progress.report({
                increment: pct - lastPct,
                message: `${(received / 1e6).toFixed(0)}MB / ${total !== undefined ? (total / 1e6).toFixed(0) : '?'}MB`,
              });
              lastPct = pct;
            }
          },
        });
        this.log(
          `[model] downloaded ${spec.fileName} in ${((Date.now() - t0) / 1000).toFixed(0)}s` +
            (expectedSha256 !== undefined ? ' (sha256 verified)' : ' (sha256 SKIPPED)'),
        );
        return dest;
      },
    );
  }

  /** 带进度地把一个模型文件复制到 globalStorage(用于 C 本地源 / D 导入)。原子:.part → rename。 */
  private async copyModelWithProgress(srcFsPath: string, destUri: vscode.Uri, spec: ModelSpec): Promise<void> {
    await checkDiskSpace(destUri.fsPath, spec.approxBytes);
    await mkdir(dirname(destUri.fsPath), { recursive: true });
    const part = `${destUri.fsPath}.part`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `VoiceFlow: Importing model ${spec.fileName}`,
        cancellable: false,
      },
      async (progress) => {
        const total = (await stat(srcFsPath)).size;
        let copied = 0;
        let lastPct = 0;
        const counter = async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            copied += chunk.length;
            const pct = Math.floor((copied / total) * 100);
            if (pct > lastPct) {
              progress.report({
                increment: pct - lastPct,
                message: `${(copied / 1e6).toFixed(0)}MB / ${(total / 1e6).toFixed(0)}MB`,
              });
              lastPct = pct;
            }
            yield chunk;
          }
        };
        await pipeline(createReadStream(srcFsPath), counter, createWriteStream(part));
      },
    );
    await rename(part, destUri.fsPath);
  }

  // ---------- inprocess 目录型模型(inproc-s3,plan v7 §3.2)----------

  /** v4-⑧ 拆分映射(globalStorage 侧派生值)。 */
  inprocessPaths(tier: InprocessTier): InprocessPaths {
    return resolveInprocessPaths(this.modelDir().fsPath, tier);
  }

  /** 就绪的现有模型:globalStorage 优先,其次 offline VSIX 内置(与 .bin 的 resolveExisting 同构)。 */
  async resolveExistingInprocess(tier: InprocessTier): Promise<InprocessPaths | undefined> {
    const spec = INPROCESS_MODELS[tier];
    const local = this.inprocessPaths(tier);
    if (await isInprocessModelReady(local.dir, spec)) return local;
    if (this.bundledModelsUri) {
      const bundled = resolveInprocessPaths(this.bundledModelsUri.fsPath, tier);
      if (await isInprocessModelReady(bundled.dir, spec)) return bundled;
    }
    return undefined;
  }

  async isInprocessDownloaded(tier: InprocessTier): Promise<boolean> {
    return (await this.resolveExistingInprocess(tier)) !== undefined;
  }

  /**
   * 确保 inprocess ONNX 模型可用(s4 EngineManager 注入的 ensureInprocessModel 实现):
   * 就绪(含 bundled)直接返回;否则带进度/可取消地目录型下载(.partial 原子完成,评审 ⑥)。
   * 自定义 http 源复用 voiceflow.model.sourceUrl(HF 布局);本地/UNC 目录源走 importModel 通道。
   */
  async ensureInprocessModel(tier: InprocessTier): Promise<InprocessPaths> {
    const existing = await this.resolveExistingInprocess(tier);
    if (existing) {
      this.log(`[onnx-model] using existing ${tier} at ${existing.dir}`);
      return existing;
    }
    const spec = INPROCESS_MODELS[tier];
    const sourceUrl = vscode.workspace
      .getConfiguration('voiceflow')
      .get<string>('model.sourceUrl', '')
      .trim();
    const httpBase = /^https?:\/\//i.test(sourceUrl) ? sourceUrl.replace(/\/+$/, '') : undefined;

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `VoiceFlow: Downloading inprocess model ${tier}`,
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        let lastPct = 0;
        return ensureInprocessModelFiles({
          modelsDir: this.modelDir().fsPath,
          tier,
          httpBase,
          signal: controller.signal,
          log: this.log,
          onProgress: (received, total) => {
            const pct = Math.floor((received / total) * 100);
            if (pct > lastPct) {
              progress.report({
                increment: pct - lastPct,
                message: `${(received / 1e6).toFixed(0)}MB / ${(total / 1e6).toFixed(0)}MB (${spec.files.length} files)`,
              });
              lastPct = pct;
            }
          },
        });
      },
    );
  }

  /** 档位 ← 文件名(D:导入时从选中文件名推断档位)。 */
  tierFromFileName(fileName: string): ModelTier | undefined {
    const base = fileName.split(/[\\/]/).pop() ?? fileName;
    const entry = (Object.values(MODELS) as ModelSpec[]).find(
      (m) => m.fileName.toLowerCase() === base.toLowerCase(),
    );
    return entry?.tier;
  }

  /**
   * D:导入本地模型文件命令(`voiceflow.importModel`)。文件选择器 → 复制到 globalStorage
   * (存为该档位的规范文件名)→ 写回 `voiceflow.model`。合规渠道拿到的模型无需下载即可用。
   */
  async pickAndImport(): Promise<void> {
    // v5-②:类型分流——.bin 单文件(现状)vs inprocess ONNX 文件夹(目录型)
    const kind = await vscode.window.showQuickPick(
      [
        { label: 'whisper.cpp model (.bin file)', modelKind: 'bin' as const },
        { label: 'inprocess ONNX model (folder, for managed/company machines)', modelKind: 'onnx' as const },
      ],
      { placeHolder: 'What kind of model do you want to import?' },
    );
    if (!kind) return;
    if (kind.modelKind === 'onnx') return this.importInprocessFolder();

    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'whisper model': ['bin'] },
      openLabel: 'Import',
      title: 'Select a whisper model file (.bin) to import',
    });
    if (!picked || picked.length === 0) return;
    const src = picked[0]!.fsPath;
    const name = src.split(/[\\/]/).pop() ?? '';

    let tier = this.tierFromFileName(name);
    if (!tier) {
      const items = (Object.values(MODELS) as ModelSpec[]).map((m) => ({
        label: m.label,
        detail: `stored as ${m.fileName}`,
        tier: m.tier,
      }));
      const t = await vscode.window.showQuickPick(items, {
        placeHolder: `Which tier is "${name}"? (it will be stored under that tier's expected filename)`,
      });
      if (!t) return;
      tier = t.tier;
    }

    try {
      await this.copyModelWithProgress(src, this.modelPath(tier), MODELS[tier]);
      const cfg = vscode.workspace.getConfiguration('voiceflow');
      await cfg.update('model', tier, vscode.ConfigurationTarget.Global);
      this.log(`[model] imported ${MODELS[tier].fileName} from ${src}, set as current`);
      void vscode.window.showInformationMessage(
        `VoiceFlow: model ${tier} imported and set as current.`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`VoiceFlow: model import failed — ${String(err)}`);
    }
  }

  /**
   * 下载指定档位并**写回 `voiceflow.model`**(向导与命令共用)。
   * 成功返回 true;下载成功才写配置 —— 取消/失败不改配置(评审 High:
   * 否则用户选 base/turbo 后首次听写仍按默认 small 再下一次)。
   */
  async downloadAndSetCurrent(tier: ModelTier): Promise<boolean> {
    await this.ensureModel(tier); // 抛错(cancelled/失败)→ 不写配置,交调用方处理
    const cfg = vscode.workspace.getConfiguration('voiceflow');
    await cfg.update('model', tier, vscode.ConfigurationTarget.Global);
    this.log(`[model] ${tier} 就绪并已设为当前档位`);
    return true;
  }

  /** 交互式选择档位并下载(voiceflow.downloadModel 命令;v5-②:含 inprocess ONNX 目录型)。 */
  async pickAndDownload(): Promise<void> {
    const binItems = await Promise.all(
      (Object.values(MODELS) as ModelSpec[]).map(async (m) => ({
        label: m.label,
        description: (await this.isDownloaded(m.tier)) ? '✓ Downloaded' : '',
        tier: m.tier as ModelTier | undefined,
        inprocessTier: undefined as InprocessTier | undefined,
      })),
    );
    const onnxItems = await Promise.all(
      (Object.keys(INPROCESS_MODELS) as InprocessTier[]).map(async (t) => ({
        label: INPROCESS_MODELS[t].label,
        description: (await this.isInprocessDownloaded(t)) ? '✓ Downloaded' : '',
        tier: undefined as ModelTier | undefined,
        inprocessTier: t as InprocessTier | undefined,
      })),
    );
    const picked = await vscode.window.showQuickPick([...binItems, ...onnxItems], {
      placeHolder: 'Select a whisper model tier',
    });
    if (!picked) return;
    try {
      if (picked.inprocessTier) {
        await this.ensureInprocessModel(picked.inprocessTier);
        const cfg = vscode.workspace.getConfiguration('voiceflow');
        await cfg.update('inprocessModel', picked.inprocessTier, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(
          `VoiceFlow: inprocess model ${picked.inprocessTier} is ready.`,
        );
      } else if (picked.tier) {
        await this.downloadAndSetCurrent(picked.tier);
        void vscode.window.showInformationMessage(`VoiceFlow: model ${picked.tier} is ready and set as current.`);
      }
    } catch (err) {
      if (err instanceof DownloadError && err.code === 'cancelled') {
        void vscode.window.showInformationMessage('VoiceFlow: download cancelled (partial download kept; resumable).');
      } else {
        void vscode.window.showErrorMessage(`VoiceFlow: model download failed — ${String(err)}`);
      }
    }
  }

  /**
   * inprocess ONNX 目录导入(v5-②,pickAndImport 的目录型分支):选文件夹 → 源逐文件
   * SHA 校验(fail-closed,坏源不落地)→ 原子拷入 globalStorage + 完成标记。
   */
  private async importInprocessFolder(): Promise<void> {
    const tier: InprocessTier = 'small-q8'; // 单档位;扩档后加 quickpick
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Import folder',
      title: `Select the ${INPROCESS_MODELS[tier].repo} model folder (ONNX q8)`,
    });
    if (!picked || picked.length === 0) return;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'VoiceFlow: Importing inprocess model (verifying SHA-256)',
          cancellable: false,
        },
        () => importInprocessDir(picked[0]!.fsPath, this.modelDir().fsPath, tier),
      );
      const cfg = vscode.workspace.getConfiguration('voiceflow');
      await cfg.update('inprocessModel', tier, vscode.ConfigurationTarget.Global);
      this.log(`[onnx-model] imported ${tier} from ${picked[0]!.fsPath}`);
      void vscode.window.showInformationMessage(`VoiceFlow: inprocess model ${tier} imported.`);
    } catch (err) {
      void vscode.window.showErrorMessage(`VoiceFlow: inprocess model import failed — ${String(err)}`);
    }
  }
}
