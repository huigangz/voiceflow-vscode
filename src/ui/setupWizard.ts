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
import { InprocessTier } from '../stt/onnxModels';
import { createVscodeLmProvider } from '../cleanup/vscodeLmProvider';

export type SetupState = 'pending' | 'dismissed' | 'completed';
const STATE_KEY = 'voiceflow.setupState';

/** Privacy statement (spec §1). */
const PRIVACY =
  'Privacy: your audio never leaves your machine. When AI cleanup is enabled, the transcribed ' +
  'text is sent to the model service you choose (Copilot / Claude / Codex); in rules-only mode ' +
  'the text also stays on your machine. VoiceFlow has zero telemetry.';

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

  // ① Privacy statement (F5.4)
  const ack = await vscode.window.showInformationMessage(PRIVACY, { modal: true }, 'Got it');
  if (ack !== 'Got it') return;

  // ①.5 环境类型(inproc-s5,v5-①/v6-②:必须先于模型选择——受管机分支只给 ONNX,
  //     绝不引导下载 .bin;显式设置保证零策略弹窗,不依赖探测)
  const envKind = await vscode.window.showQuickPick(
    [
      {
        label: '$(device-desktop) Standard machine',
        detail: 'Personal / unmanaged PC — uses the whisper.cpp server engine (default).',
        envKind: 'standard' as const,
      },
      {
        label: '$(shield) Managed / company machine',
        detail:
          'IT application-control policy blocks external EXEs (e.g. policy popup on whisper-server.exe) — uses the in-process engine, no child process, no popups.',
        envKind: 'managed' as const,
      },
    ],
    { placeHolder: 'What kind of machine is this?', ignoreFocusOut: true },
  );
  if (!envKind) return; // cancelled → don't change state
  if (envKind.envKind === 'managed') return runManagedSetup(deps);

  // ② Tier recommendation (F5.1, show — don't auto-switch)
  const totalGb = Math.round(os.totalmem() / 1e9);
  const recommended = recommendTier(os.totalmem());
  const items = (Object.values(MODELS) as ModelSpec[]).map((m) => ({
    label: (m.tier === recommended ? '$(star-full) ' : '') + m.label,
    description: m.tier === recommended ? 'Recommended' : '',
    tier: m.tier,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Select a voice model tier (${totalGb}GB RAM; this is a CPU build, GPU acceleration is a later release)`,
    ignoreFocusOut: true,
  });
  if (!picked) return; // cancelled → don't change state

  // ③ Download + write back config (F5.2); only reach completed on success
  try {
    await modelManager.downloadAndSetCurrent(picked.tier);
  } catch (err) {
    if (err instanceof DownloadError && err.code === 'cancelled') {
      void vscode.window.showInformationMessage(
        'VoiceFlow: download cancelled (partial download kept; resumable). You can run "VoiceFlow: Setup Wizard" again later.',
      );
    } else {
      void vscode.window.showErrorMessage(`VoiceFlow: model download failed — ${String(err)}`);
    }
    return; // don't mark completed, don't change config
  }

  // ④ vscode.lm availability (F5.3)
  const lm = await createVscodeLmProvider(log, context.languageModelAccessInformation);
  const lmMsg = lm
    ? `AI cleanup available (${lm.name}) — will enhance automatically`
    : 'No AI model detected → using local rules cleanup (text stays on your machine). For AI cleanup, install Copilot or select claude-cli / codex-cli in settings';

  // ⑤ Done + guide first dictation (F5.4)
  await setState(context, 'completed');
  void vscode.window.showInformationMessage(
    `VoiceFlow is ready! ${lmMsg}. Now focus an editor and press Ctrl+Alt+L to try dictating a sentence.`,
  );
}

/**
 * 受管机分支(v5-① 产品主路径):写 mode=inprocess(auto 从不 spawn server,零弹窗由
 * 设置保证)→ 确保 ONNX 模型(offline VSIX 内置则零下载)→ completed。
 */
async function runManagedSetup(deps: WizardDeps): Promise<void> {
  const { context, modelManager, log } = deps;
  const cfg = vscode.workspace.getConfiguration('voiceflow');
  const tier = cfg.get<InprocessTier>('inprocessModel', 'small-q8');
  try {
    await modelManager.ensureInprocessModel(tier); // bundled(offline VSIX)命中则即时返回
  } catch (err) {
    if (err instanceof DownloadError && err.code === 'cancelled') {
      void vscode.window.showInformationMessage(
        'VoiceFlow: download cancelled (partial download kept; resumable). You can run "VoiceFlow: Setup Wizard" again later.',
      );
    } else {
      void vscode.window.showErrorMessage(`VoiceFlow: in-process model setup failed — ${String(err)}`);
    }
    return; // don't mark completed, don't change config
  }
  // 模型就绪才写配置(与 .bin 分支"下载成功才写回"同规则)
  await cfg.update('whisper.mode', 'inprocess', vscode.ConfigurationTarget.Global);
  await cfg.update('inprocessModel', tier, vscode.ConfigurationTarget.Global);
  log(`[wizard] managed machine setup: whisper.mode=inprocess, model=${tier}`);

  const lm = await createVscodeLmProvider(log, context.languageModelAccessInformation);
  const lmMsg = lm
    ? `AI cleanup available (${lm.name}) — will enhance automatically`
    : 'No AI model detected → using local rules cleanup (text stays on your machine). For AI cleanup, install Copilot or select claude-cli / codex-cli in settings';
  await setState(context, 'completed');
  void vscode.window.showInformationMessage(
    `VoiceFlow is ready (in-process engine, no policy popups)! ${lmMsg}. Now focus an editor and press Ctrl+Alt+L to try dictating a sentence.`,
  );
}

/**
 * Called on activate: prompt once only while pending, then mark dismissed (**the first-run
 * invite shows only once**, no repeated nagging); choosing "Run wizard" enters runSetupWizard
 * (success → completed). The command can always reopen it manually.
 */
export async function maybePromptSetup(deps: WizardDeps): Promise<void> {
  if (getSetupState(deps.context) !== 'pending') return;
  const choice = await vscode.window.showInformationMessage(
    'VoiceFlow: run the first-time setup wizard? It downloads the local voice model and finishes configuration (a few minutes).',
    'Run wizard',
    'Later',
  );
  await setState(deps.context, 'dismissed'); // whichever choice, the first-run invite shows only once
  if (choice === 'Run wizard') await runSetupWizard(deps);
}
