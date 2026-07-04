/**
 * 模型档位管理 + 下载编排(F5.2,S2 mini-spike 的 vscode 胶水层)。
 * 下载核心逻辑在 ./download.ts(纯 Node,可测试)。
 */
import * as vscode from 'vscode';
import {
  DownloadError,
  checkDiskSpace,
  downloadWithResume,
  fetchExpectedSha256,
} from './download';

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
  ) {}

  modelDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, 'models');
  }

  modelPath(tier: ModelTier): vscode.Uri {
    return vscode.Uri.joinPath(this.modelDir(), MODELS[tier].fileName);
  }

  async isDownloaded(tier: ModelTier): Promise<boolean> {
    try {
      const st = await vscode.workspace.fs.stat(this.modelPath(tier));
      return st.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * 确保模型可用:已下载直接返回;否则带进度/可取消地下载。
   * 兜底(spec §9.1 No-Go 备案):手动下载后把 .bin 放进 models/ 目录即被识别。
   */
  async ensureModel(tier: ModelTier): Promise<vscode.Uri> {
    const spec = MODELS[tier];
    const dest = this.modelPath(tier);
    if (await this.isDownloaded(tier)) return dest;

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
          urls: [
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

  /** 交互式选择档位并下载(voiceflow.downloadModel 命令)。 */
  async pickAndDownload(): Promise<void> {
    const items = await Promise.all(
      (Object.values(MODELS) as ModelSpec[]).map(async (m) => ({
        label: m.label,
        description: (await this.isDownloaded(m.tier)) ? '✓ Downloaded' : '',
        tier: m.tier,
      })),
    );
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a whisper model tier',
    });
    if (!picked) return;
    try {
      await this.downloadAndSetCurrent(picked.tier);
      void vscode.window.showInformationMessage(`VoiceFlow: model ${picked.tier} is ready and set as current.`);
    } catch (err) {
      if (err instanceof DownloadError && err.code === 'cancelled') {
        void vscode.window.showInformationMessage('VoiceFlow: download cancelled (partial download kept; resumable).');
      } else {
        void vscode.window.showErrorMessage(`VoiceFlow: model download failed — ${String(err)}`);
      }
    }
  }
}
