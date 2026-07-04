/**
 * VoiceFlow 入口:命令注册 + 会话状态机编排。
 * Phase 0 — 已接入:S1 录音(Step 1)。待接入:whisper(Step 2)、插入(Step 3+)。
 */
import * as vscode from 'vscode';
import { Session } from './session';
// WebviewRecorder 源码保留但运行时不可达(webview 无麦克风权限,microsoft/vscode#250568);
// 不再 import,避免打包无用代码。
import { HelperRecorder } from './audio/helperRecorder';
import { RecordingController, cleanTmpWavs } from './audio/recordingController';
import { RecorderError } from './audio/recorder';
import { ModelManager, ModelTier } from './stt/modelManager';
import { DEFAULT_INITIAL_PROMPT, WhisperMode, WhisperRunner } from './stt/whisperRunner';
import { FocusHint, InsertTarget, captureTarget, dispatchInsert } from './insert/dispatcher';
import { RulesConfig } from './cleanup/rulesLayer';
import { CleanupCancelled, EnhanceProvider, runCleanup } from './cleanup/pipeline';
import { createVscodeLmProvider } from './cleanup/vscodeLmProvider';
import { CliKind, createCliProvider } from './cleanup/cliProvider';
import { StatusBar } from './ui/statusBar';
import { maybePromptSetup, runSetupWizard } from './ui/setupWizard';

let output: vscode.OutputChannel;
let session: Session;
let recording: RecordingController | undefined;
let extContext: vscode.ExtensionContext;
let modelManager: ModelManager;
let whisper: WhisperRunner | undefined;
let insertTarget: InsertTarget = { kind: 'none' };
let cleaningAbort: AbortController | undefined;
let statusBar: StatusBar;

function log(line: string): void {
  output.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  output = vscode.window.createOutputChannel('VoiceFlow');
  session = new Session();

  statusBar = new StatusBar();

  session.onTransition((state, prev) => {
    log(`[session] ${prev} -> ${state}`);
    statusBar.setSession(state);
    void vscode.commands.executeCommand('setContext', 'voiceflow.sessionActive', session.active);
  });

  // Reload Window gate:清理上次会话可能残留的临时 WAV
  void cleanTmpWavs(context.globalStorageUri, log);

  modelManager = new ModelManager(context.globalStorageUri, log);

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('voiceflow.toggleDictation', toggleDictation),
    vscode.commands.registerCommand('voiceflow.cancelSession', cancelSession),
    vscode.commands.registerCommand('voiceflow.showLogs', () => output.show()),
    vscode.commands.registerCommand('voiceflow.downloadModel', () => modelManager.pickAndDownload()),
    vscode.commands.registerCommand('voiceflow.openSetupWizard', () =>
      runSetupWizard({ context, modelManager, log }),
    ),
    // Reload Window gate:销毁 helper/音频流 + kill whisper 子进程
    { dispose: () => { recording?.dispose(); whisper?.dispose(); } },
  );

  // 首启邀请(F5):仅 pending 弹一次;不阻塞 activate
  void maybePromptSetup({ context, modelManager, log });
}

/** 懒构建/更新 WhisperRunner(配置变更时热更新;模型换档触发 server 重载)。 */
async function getWhisper(): Promise<WhisperRunner> {
  const cfg = vscode.workspace.getConfiguration('voiceflow');
  const tier = cfg.get<ModelTier>('model', 'small');
  const modelUri = await modelManager.ensureModel(tier); // 未下载则带进度下载(F2.1 懒启动)
  const binaryDir =
    cfg.get<string>('whisper.binaryDir', '') ||
    vscode.Uri.joinPath(extContext.extensionUri, 'bin').fsPath;
  const runnerCfg = {
    binaryDir,
    modelPath: modelUri.fsPath,
    language: cfg.get<'zh' | 'en' | 'auto'>('language', 'auto'),
    initialPrompt: DEFAULT_INITIAL_PROMPT,
    mode: cfg.get<WhisperMode | 'auto'>('whisper.mode', 'auto'),
    idleUnloadMinutes: cfg.get<number>('whisper.idleUnload', 10),
    log,
    onColdStart: (loading: boolean) => statusBar.setModelLoading(loading), // F2.1
  };
  if (!whisper) whisper = new WhisperRunner(runnerCfg);
  else whisper.updateConfig(runnerCfg);
  return whisper;
}

async function toggleDictation(args?: { focus?: FocusHint }): Promise<void> {
  if (session.state === 'idle') {
    await startRecording(args?.focus);
  } else if (session.state === 'recording') {
    await stopRecordingAndProcess('toggle');
  }
  // 其他阶段:toggle 无效(取消走 Esc,spec §5.3)
}

async function startRecording(focusHint: FocusHint): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('voiceflow');
  // F4:插入目标在录音开始时锁定
  insertTarget = captureTarget(focusHint);
  log(`[dictation] target locked: ${insertTarget.kind}`);
  // P3 已收敛(2026-07-03):webview 无麦克风权限(upstream microsoft/vscode#250568)→
  // 硬编码 native helper exe。WebviewRecorder 源码保留但运行时不可达,无配置可路由到它
  // (旧的 "voiceflow.recorder": "webview" 设置升级后无效,不会再走坏分支)。
  const recorder = new HelperRecorder(
    vscode.Uri.joinPath(extContext.extensionUri, 'bin', 'voiceflow-mic.exe').fsPath,
    log,
  );
  recording = new RecordingController(
    recorder,
    {
      maxDurationMs: cfg.get<number>('recording.maxDuration', 120) * 1000,
      autoStopSilenceMs: cfg.get<number>('recording.autoStopSilence', 3) * 1000,
    },
    extContext.globalStorageUri,
    log,
  );
  recording.onAutoStop = (reason) => {
    log(`[recording] auto-stop: ${reason}`);
    void stopRecordingAndProcess(reason);
  };
  recording.onError = (err: RecorderError) => {
    log(`[recording] failed: ${err.code} — ${err.message}`);
    session.dispatch('error');
    statusBar.showError(`Recording failed: ${err.code}`);
    recording?.dispose();
    recording = undefined;
    void showRecorderError(err);
  };

  session.dispatch('start');
  try {
    await recording.start();
    statusBar.recordingLive(); // 麦克风就绪才亮红点,防开头吞字
    log('[dictation] recording… (press Ctrl+Alt+L to stop, Esc to cancel)');
  } catch (err) {
    session.dispatch('error');
    statusBar.showError('Failed to start recording');
    recording.dispose();
    recording = undefined;
    if (err instanceof RecorderError) void showRecorderError(err);
    else void vscode.window.showErrorMessage(`VoiceFlow: failed to start recording — ${String(err)}`);
  }
}

async function stopRecordingAndProcess(reason: string): Promise<void> {
  if (!recording || session.state !== 'recording') return;
  session.dispatch('stopRecording');
  let wavUri: vscode.Uri | undefined;
  try {
    const result = await recording.finish();
    wavUri = result.wavUri;
    log(`[dictation] stop(${reason}): ${result.durationMs}ms, mode=${result.mode}`);
    if (!result.hasSpeech) {
      // 防幻觉(spec §9.2 静音/误触发 → 预期空结果):直接结束会话
      log('[dictation] no speech detected, skip transcription');
      session.dispatch('cancel');
      return;
    }

    // Step 2:whisper 转写(埋点:cold start 与 warm 分开,§8.1)
    const runner = await getWhisper();
    const stt = await runner.transcribe(result.wavUri.fsPath);
    if ((session.state as string) !== 'transcribing') return; // Esc 已取消
    log(
      `[metrics] coldStart=${stt.coldStartMs ?? 0}ms warmTranscribe=${stt.transcribeMs}ms mode=${stt.mode}`,
    );
    session.dispatch('transcribed');

    // Step 4/5:清理管线 —— ① rules 必跑 ② 增强层可选(超时回落,F3.4)
    const vfCfg = vscode.workspace.getConfiguration('voiceflow');
    cleaningAbort = new AbortController();
    const tClean = Date.now();
    const cleanResult = await runCleanup(
      stt.text,
      {
        rules: getRulesConfig(),
        timeoutMs: vfCfg.get<number>('cleanup.timeout', 8000),
        enhancer: await pickEnhancer(vfCfg.get<string>('cleanup.provider', 'auto')),
        log,
      },
      cleaningAbort.signal,
    );
    cleaningAbort = undefined;
    const cleaned = cleanResult.text;
    log(
      `[metrics] cleanup=${Date.now() - tClean}ms provider=${cleanResult.usedProvider}` +
        (cleanResult.degraded !== undefined ? ` degraded=${cleanResult.degraded}` : ''),
    );
    if ((session.state as string) !== 'cleaning') return; // Esc 已取消
    session.dispatch('cleaned');

    if (cleaned.length === 0) {
      log('[dictation] empty transcription, nothing to insert');
      session.dispatch('cancel');
      return;
    }

    // F4:>30s 录音插入前 lightweight 确认(可配置 0=关闭)
    const confirmThreshold = vscode.workspace
      .getConfiguration('voiceflow')
      .get<number>('recording.confirmThreshold', 30);
    if (confirmThreshold > 0 && result.durationMs > confirmThreshold * 1000) {
      const preview = cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
      const choice = await vscode.window.showQuickPick(['Insert', 'Copy to clipboard', 'Discard'], {
        placeHolder: `Long recording (${(result.durationMs / 1000).toFixed(0)}s) — confirm: ${preview}`,
      });
      if (choice === undefined || choice === 'Discard') {
        session.dispatch('cancel');
        return;
      }
      if (choice === 'Copy to clipboard') {
        await vscode.env.clipboard.writeText(cleaned);
        vscode.window.setStatusBarMessage('$(clippy) VoiceFlow: Copied to clipboard', 5000);
        session.dispatch('cancel');
        return;
      }
    }

    // Step 3:插入分发(F4 表)
    const t0 = Date.now();
    const outcome = await dispatchInsert(insertTarget, cleaned);
    session.dispatch('inserted');
    log(`[metrics] insert=${Date.now() - t0}ms outcome=${outcome}`);
  } catch (err) {
    if (err instanceof CleanupCancelled) {
      log('[dictation] cleanup cancelled by user');
      return; // 会话已由 cancelSession 置回 idle
    }
    session.dispatch('error');
    statusBar.showError('Dictation failed');
    log(`[dictation] failed: ${String(err)}`);
    void vscode.window.showErrorMessage(`VoiceFlow: ${String(err)}`);
  } finally {
    recording?.dispose();
    recording = undefined;
    // 临时 WAV 用完即删(隐私:音频不留盘)
    if (wavUri) {
      try {
        await vscode.workspace.fs.delete(wavUri);
      } catch { /* 已被清扫 */ }
    }
  }
}

/** D9/F3.3 provider 逻辑:auto=rules+vscode.lm(可用则用);CLI 仅显式选择。 */
async function pickEnhancer(provider: string): Promise<EnhanceProvider | undefined> {
  switch (provider) {
    case 'auto':
      return createVscodeLmProvider(log); // 无模型 → undefined = rules-only
    case 'claude-cli':
    case 'codex-cli':
      return createCliProvider(provider as CliKind);
    default: // 'rules-only'
      return undefined;
  }
}

function getRulesConfig(): RulesConfig {
  const cfg = vscode.workspace.getConfiguration('voiceflow.rules');
  return {
    convertToSimplified: cfg.get<boolean>('convertToSimplified', true),
    spacingCJKLatin: cfg.get<boolean>('spacingCJKLatin', true),
    normalizePunctuation: cfg.get<boolean>('normalizePunctuation', true),
    collapseSpaces: cfg.get<boolean>('collapseSpaces', true),
    stripHallucinations: cfg.get<boolean>('stripHallucinations', true),
  };
}

function cancelSession(): void {
  if (!session.active) return;
  recording?.cancel();
  recording?.dispose();
  recording = undefined;
  whisper?.cancel(); // 中止进行中的转写(CLI kill / HTTP abort;server 进程保留)
  cleaningAbort?.abort(); // 中止进行中的清理(LLM 请求 / CLI 子进程)
  cleaningAbort = undefined;
  session.dispatch('cancel');
  log('[dictation] session cancelled (Esc)');
}

async function showRecorderError(err: RecorderError): Promise<void> {
  // F1.4: clear error message + guidance; can re-prompt for permission after a denial
  const guides: Record<string, string> = {
    'permission-denied':
      'VoiceFlow: microphone permission denied. Check Windows Settings → Privacy → Microphone and allow desktop apps to access it, then retry (the permission prompt will reappear).',
    'no-device': 'VoiceFlow: no microphone found. Connect a microphone and retry.',
    'device-lost': 'VoiceFlow: the recording device was disconnected; this recording was discarded. Please start again.',
    'blocked-by-policy':
      'VoiceFlow: the recording component was blocked by Windows Smart App Control (which blocks unsigned programs). ' +
      'This is a known preview limitation (the recording helper is not yet code-signed). It is usually temporary — wait a moment and try again. See the "Known limitations · Smart App Control" section in the README.',
    'init-failed': 'VoiceFlow: failed to initialize recording. See the logs (VoiceFlow: Show Logs).',
  };
  const isPolicy = err.code === 'blocked-by-policy';
  const buttons = isPolicy ? ['View Logs'] : ['Retry', 'View Logs'];
  const action = await vscode.window.showErrorMessage(guides[err.code] ?? err.message, ...buttons);
  if (action === 'Retry') void vscode.commands.executeCommand('voiceflow.toggleDictation');
  else if (action === 'View Logs') output.show();
}

export function deactivate(): void {
  recording?.dispose();
  recording = undefined;
  whisper?.dispose(); // Reload Window gate:kill whisper server,无残留进程
  whisper = undefined;
}
