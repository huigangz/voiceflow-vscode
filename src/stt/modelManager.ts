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
  // 标签按 内存/质量/速度 描述(preview 为 CPU 版,不提独显;GPU 加速在后续版本)
  base: {
    tier: 'base',
    fileName: 'ggml-base.bin',
    approxBytes: 148_000_000,
    label: 'base(~148MB,最快·内存最省·质量一般)',
  },
  small: {
    tier: 'small',
    fileName: 'ggml-small.bin',
    approxBytes: 488_000_000,
    label: 'small(~488MB,均衡·推荐)',
  },
  'small-q5': {
    tier: 'small-q5',
    fileName: 'ggml-small-q5_1.bin',
    approxBytes: 190_000_000,
    label: 'small-q5(~190MB,量化·内存省·质量近 small)',
  },
  'large-v3-turbo-q5': {
    tier: 'large-v3-turbo-q5',
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    approxBytes: 574_000_000,
    label: 'large-v3-turbo-q5(~574MB,质量更好·更慢·更占内存)',
  },
  'large-v3-turbo': {
    tier: 'large-v3-turbo',
    fileName: 'ggml-large-v3-turbo.bin',
    approxBytes: 1_624_000_000,
    label: 'large-v3-turbo(~1.6GB,质量最佳·最慢·内存最高)',
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
        title: `VoiceFlow: 下载模型 ${spec.fileName}`,
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
          this.log('[model] WARN: 无法获取期望 SHA-256(HF API 不可达),本次跳过校验');
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
        description: (await this.isDownloaded(m.tier)) ? '✓ 已下载' : '',
        tier: m.tier,
      })),
    );
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择 whisper 模型档位',
    });
    if (!picked) return;
    try {
      await this.downloadAndSetCurrent(picked.tier);
      void vscode.window.showInformationMessage(`VoiceFlow: 模型 ${picked.tier} 就绪,已设为当前档位。`);
    } catch (err) {
      if (err instanceof DownloadError && err.code === 'cancelled') {
        void vscode.window.showInformationMessage('VoiceFlow: 下载已取消(已下载部分保留,可续传)。');
      } else {
        void vscode.window.showErrorMessage(`VoiceFlow: 模型下载失败 — ${String(err)}`);
      }
    }
  }
}
