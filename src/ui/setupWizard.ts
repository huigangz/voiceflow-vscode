/**
 * 首启向导(F5)。spec §5.2 UI 约束:QuickPick/通知序列,不用 webview。
 *
 * 状态机(评审 Medium):globalState 存 `pending | dismissed | completed`
 * - pending:未跑过 → activate 弹一次邀请;
 * - dismissed:用户跳过/首启邀请已弹过 → 不再每次骚扰(命令仍可手动重开);
 * - completed:**仅当模型下载成功 + 已写回 voiceflow.model + 走完向导** 才置。
 *   下载取消/失败不得置 completed,也不得改配置。
 */
import * as os from 'node:os';
import * as vscode from 'vscode';
import { MODELS, ModelManager, ModelSpec, ModelTier } from '../stt/modelManager';
import { DownloadError } from '../stt/download';
import { createVscodeLmProvider } from '../cleanup/vscodeLmProvider';

export type SetupState = 'pending' | 'dismissed' | 'completed';
const STATE_KEY = 'voiceflow.setupState';

/** spec §1 隐私声明原文。 */
const PRIVACY =
  '隐私声明:音频永不离开本机。启用 AI 清理时,转写文本会发送给你选择的模型服务' +
  '(Copilot / Claude / Codex);rules-only 模式下文本也不出本机。VoiceFlow 零遥测。';

/**
 * 内存 → 推荐档位(纯函数,可单元测试)。
 * CPU-only preview:按内存/质量权衡,不涉 GPU。< 8GB 用量化省内存版,否则均衡默认。
 */
export function recommendTier(totalMemBytes: number): ModelTier {
  return totalMemBytes / 1e9 < 8 ? 'small-q5' : 'small';
}

export function getSetupState(context: vscode.ExtensionContext): SetupState {
  return context.globalState.get<SetupState>(STATE_KEY, 'pending');
}

function setState(context: vscode.ExtensionContext, s: SetupState): Thenable<void> {
  return context.globalState.update(STATE_KEY, s);
}

export interface WizardDeps {
  context: vscode.ExtensionContext;
  modelManager: ModelManager;
  log: (line: string) => void;
}

/** 手动(命令)或首启邀请后调用。成功走完 → completed;中途取消 → 不改 completed。 */
export async function runSetupWizard(deps: WizardDeps): Promise<void> {
  const { context, modelManager, log } = deps;

  // ① 隐私声明(F5.4)
  const ack = await vscode.window.showInformationMessage(PRIVACY, { modal: true }, '我知道了');
  if (ack !== '我知道了') return;

  // ② 档位推荐(F5.1,展示不自动切)
  const totalGb = Math.round(os.totalmem() / 1e9);
  const recommended = recommendTier(os.totalmem());
  const items = (Object.values(MODELS) as ModelSpec[]).map((m) => ({
    label: (m.tier === recommended ? '$(star-full) ' : '') + m.label,
    description: m.tier === recommended ? '推荐' : '',
    tier: m.tier,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `选择语音模型档位(本机内存 ${totalGb}GB;当前为 CPU 版,GPU 加速在后续版本)`,
    ignoreFocusOut: true,
  });
  if (!picked) return; // 取消 → 不改状态

  // ③ 下载 + 写回配置(F5.2);仅成功才继续到 completed
  try {
    await modelManager.downloadAndSetCurrent(picked.tier);
  } catch (err) {
    if (err instanceof DownloadError && err.code === 'cancelled') {
      void vscode.window.showInformationMessage(
        'VoiceFlow: 下载已取消(已下载部分保留,可续传)。稍后可再次运行 “VoiceFlow: Setup Wizard”。',
      );
    } else {
      void vscode.window.showErrorMessage(`VoiceFlow: 模型下载失败 — ${String(err)}`);
    }
    return; // 不置 completed、不改配置
  }

  // ④ vscode.lm 探测展示(F5.3)
  const lm = await createVscodeLmProvider(log);
  const lmMsg = lm
    ? `AI 清理可用(${lm.name}),将自动增强`
    : '未检测到可用 AI 模型 → 使用本地规则清理(文本不出本机);如需 AI 清理可安装 Copilot,或在设置选 claude-cli / codex-cli';

  // ⑤ 完成 + 引导首次听写(F5.4)
  await setState(context, 'completed');
  void vscode.window.showInformationMessage(
    `VoiceFlow 就绪!${lmMsg}。现在聚焦编辑器,按 Ctrl+Alt+L 试录一句中文。`,
  );
}

/**
 * activate 时调用:仅 pending 弹一次首启邀请;弹过即置 dismissed(**首启邀请只弹一次**,
 * 不再骚扰);选“运行向导”则进 runSetupWizard(成功 → completed)。命令始终可手动重开。
 */
export async function maybePromptSetup(deps: WizardDeps): Promise<void> {
  if (getSetupState(deps.context) !== 'pending') return;
  const choice = await vscode.window.showInformationMessage(
    'VoiceFlow:运行首次设置向导?将下载本地语音模型并完成配置(约几分钟)。',
    '运行向导',
    '稍后',
  );
  await setState(deps.context, 'dismissed'); // 无论选择,首启邀请只弹一次
  if (choice === '运行向导') await runSetupWizard(deps);
}
