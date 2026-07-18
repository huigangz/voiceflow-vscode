/**
 * VoiceFlow 入口:命令注册 + 会话状态机编排。
 * Phase 0 — 已接入:S1 录音(Step 1)。待接入:whisper(Step 2)、插入(Step 3+)。
 */
import * as vscode from 'vscode';
import { Session, toggleActionForSession } from './session';
// WebviewRecorder 源码保留但运行时不可达(webview 无麦克风权限,microsoft/vscode#250568);
// 不再 import,避免打包无用代码。
import { HelperRecorder } from './audio/helperRecorder';
import { AddonRecorder } from './audio/addonRecorder';
import { RecordingController, cleanTmpWavs } from './audio/recordingController';
import { SegmentedRecordingController } from './audio/segmentedRecordingController';
import { LoopbackRecorder, loadVoiceflowAudio } from './audio/loopbackRecorder';
import { SileroVad } from './audio/sileroVad';
import { Recorder, RecorderError } from './audio/recorder';
import { ModelManager, ModelTier } from './stt/modelManager';
import {
  DEFAULT_INITIAL_PROMPT,
  WhisperConfig,
  WhisperError,
  WhisperMode,
  WhisperRunner,
  serverBinaryStamp,
} from './stt/whisperRunner';
import { BlockedMemory, EngineManager, resolveEngineMode } from './stt/engineManager';
import { InprocessEngine } from './stt/inprocessEngine';
import { normalizeDetectedLanguage } from './stt/engine';
import { InprocessTier } from './stt/onnxModels';
import {
  FocusHint,
  FocusedInputOpts,
  InsertTarget,
  captureTarget,
  dispatchInsert,
} from './insert/dispatcher';
import { SegmentInserter } from './insert/segmentInserter';
import { SegmentPipeline } from './segment/pipeline';
import { validateSegmentedConfig } from './segment/config';
import { RulesConfig, applyRules } from './cleanup/rulesLayer';
import { isRealEditorDocScheme } from './insert/logic';
import { CleanupCancelled, runCleanup } from './cleanup/pipeline';
import { LlmProvider } from './cleanup/llmProvider';
import { createVscodeLmProvider } from './cleanup/vscodeLmProvider';
import {
  CliKind,
  createCliExecutionContext,
  createCliProvider,
} from './cleanup/cliProvider';
import { StatusBar, refreshTranslationTargetOnConfigurationChange } from './ui/statusBar';
import { maybePromptSetup, runSetupWizard } from './ui/setupWizard';
import {
  MutableStartupResource,
  SessionPreflight,
  TranslationSessionSnapshot,
  TranslationTarget,
  TranslationUnsupportedError,
  createTranslationSessionSnapshot,
  languageHintForSession,
  runCancellableStartup,
  startCancellableFallback,
  transcribeOptionsForSession,
  prepareTranslationSnapshot,
} from './translation/sessionPreflight';
import { runTranslate, TranslationResult } from './translation/pipeline';
import { TranslationCoordinator } from './translation/coordinator';
import { TranslationSessionFeedback } from './translation/feedback';
import { TranslationSessionMetrics } from './translation/metrics';
import { maybeShowTranslationPrivacyNotice } from './translation/privacyNotice';
import {
  EMPTY_TRANSLATION_USAGE,
  TranslationUsageStore,
  TranslationUsageTotals,
  addUsage,
  formatSessionUsage,
  formatTranslationUsageReport,
  recordRequest,
} from './translation/usage';

let output: vscode.OutputChannel;
let session: Session;
let recording: RecordingController | undefined;
let extContext: vscode.ExtensionContext;
let modelManager: ModelManager;
let whisper: EngineManager | undefined;
let insertTarget: InsertTarget = { kind: 'none' };
/** 会话级转写取消(v12-①:runner 无实例级 cancel,取消所有权归调用方)。 */
let sttAbort: AbortController | undefined;
let cleaningAbort: AbortController | undefined;
let statusBar: StatusBar;
let sessionPreflight: SessionPreflight;
let translationUsageStore: TranslationUsageStore;
interface SessionUsageAccounting {
  snapshot(): TranslationUsageTotals;
  translationStarted(): void;
  translationUsage(usage: import('./cleanup/llmProvider').TokenUsage): void;
  authorizationUsage(usage: import('./cleanup/llmProvider').TokenUsage): void;
}
interface PreparedSession {
  snapshot: TranslationSessionSnapshot;
  runner: EngineManager | undefined;
  usage: SessionUsageAccounting;
  feedback: TranslationSessionFeedback;
  metrics: TranslationSessionMetrics;
}
let preparedSession: PreparedSession | undefined;
/**
 * P2a 回退链(评审 ⑥/v7-②):addon 首次 start 失败且 code 为 module-unavailable /
 * blocked-by-policy → 当次回退 HelperRecorder,并在运行期记住(按 code,不靠 message)。
 * 仅 auto 模式回退;显式 addon = 用户强制,失败直接呈现。
 */
let addonFallbackCode: 'module-unavailable' | 'blocked-by-policy' | undefined;

/** P2b:segmented 会话(与 batch 的 `recording` 互斥;同一时刻只有一种会话形态)。 */
interface SegmentedSession {
  controller: SegmentedRecordingController | undefined;
  controllerOwner: MutableStartupResource<SegmentedRecordingController>;
  pipeline: SegmentPipeline;
  inserter: SegmentInserter;
  releaseLease: (() => void) | undefined;
  pending: number;
  stopping: boolean;
  prepared: PreparedSession;
  metricsLogged: boolean;
  disposed: boolean;
}
let segmented: SegmentedSession | undefined;

/**
 * chat-insert v1(plan v5 §3.1):focused-input 会话的编辑器交互防线(best-effort,v4-①)
 * + 确认框标记(v4-③)。extension 持生命周期,dispatcher 只收布尔判定。
 */
let focusedInputTracker:
  | { interacted: boolean; confirmShown: boolean; disposables: vscode.Disposable[] }
  | undefined;

function armFocusedInputTracker(): void {
  disposeFocusedInputTracker();
  const t = { interacted: false, confirmShown: false, disposables: [] as vscode.Disposable[] };
  // 只认真实文档编辑器(t3 实测修:输出面板/调试控制台也是 editor,自家日志会稳定误报防线)
  t.disposables.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (isRealEditorDocScheme(e?.document.uri.scheme)) t.interacted = true;
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (isRealEditorDocScheme(e.textEditor.document.uri.scheme)) t.interacted = true;
    }),
  );
  focusedInputTracker = t;
}

/** 幂等释放(v5-①);挂三处:启动失败 catch / cancelSession / stopRecordingAndProcess finally。 */
function disposeFocusedInputTracker(): void {
  focusedInputTracker?.disposables.forEach((d) => d.dispose());
  focusedInputTracker = undefined;
}

/** dispatch 用的判定快照;tracker 缺失(异常路径)→ 保守不 type。 */
function focusedInputOpts(): FocusedInputOpts {
  return {
    enabled: vscode.workspace
      .getConfiguration('voiceflow')
      .get<boolean>('insert.typeIntoFocusedInput', false),
    editorInteracted: focusedInputTracker?.interacted ?? true,
    confirmShown: focusedInputTracker?.confirmShown ?? true,
  };
}

function log(line: string): void {
  output.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);
}

function createSessionUsageAccounting(): SessionUsageAccounting {
  let totals = {
    translationCalls: { ...EMPTY_TRANSLATION_USAGE.translationCalls },
    authorizationCalls: { ...EMPTY_TRANSLATION_USAGE.authorizationCalls },
  };
  return {
    snapshot: () => totals,
    translationStarted: () => {
      totals = recordRequest(totals, 'translationCalls');
      translationUsageStore.recordRequest('translationCalls');
    },
    translationUsage: (usage) => {
      totals = addUsage(totals, 'translationCalls', usage);
      translationUsageStore.addUsage('translationCalls', usage);
      if (!session.active) log(formatSessionUsage(totals));
    },
    authorizationUsage: (usage) => {
      totals = recordRequest(totals, 'authorizationCalls', usage);
      translationUsageStore.recordRequest('authorizationCalls', usage);
    },
  };
}

function showTranslationUsage(): void {
  output.appendLine(formatTranslationUsageReport(translationUsageStore.snapshot()));
  output.show();
  void vscode.window.showInformationMessage('VoiceFlow: cumulative translation usage is shown in the VoiceFlow Output channel.');
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  output = vscode.window.createOutputChannel('VoiceFlow');
  session = new Session();
  sessionPreflight = new SessionPreflight(session);
  translationUsageStore = new TranslationUsageStore(context.globalState);

  statusBar = new StatusBar();
  statusBar.setConfiguredTranslationTarget(
    vscode.workspace.getConfiguration('voiceflow').get<TranslationTarget>('translate.target', 'off'),
  );

  session.onTransition((state, prev) => {
    log(`[session] ${prev} -> ${state}`);
    statusBar.setSession(state);
    void vscode.commands.executeCommand('setContext', 'voiceflow.sessionActive', session.active);
  });

  // Reload Window gate:清理上次会话可能残留的临时 WAV
  void cleanTmpWavs(context.globalStorageUri, log);

  // offline VSIX(B 方案):内置模型放 extensionUri/offline-model;存在则运行时零下载
  modelManager = new ModelManager(
    context.globalStorageUri,
    log,
    vscode.Uri.joinPath(context.extensionUri, 'offline-model'),
  );

  context.subscriptions.push(
    output,
    statusBar,
    vscode.workspace.onDidChangeConfiguration((event) =>
      refreshTranslationTargetOnConfigurationChange(
        event,
        () => vscode.workspace
          .getConfiguration('voiceflow')
          .get<TranslationTarget>('translate.target', 'off'),
        (target) => statusBar.setConfiguredTranslationTarget(target),
      ),
    ),
    vscode.commands.registerCommand('voiceflow.toggleDictation', toggleDictation),
    vscode.commands.registerCommand('voiceflow.cancelSession', cancelSession),
    vscode.commands.registerCommand('voiceflow.showLogs', () => output.show()),
    vscode.commands.registerCommand('voiceflow.showTranslationUsage', showTranslationUsage),
    vscode.commands.registerCommand('voiceflow.dictateSystemAudio', dictateSystemAudio),
    vscode.commands.registerCommand('voiceflow.downloadModel', () => modelManager.pickAndDownload()),
    vscode.commands.registerCommand('voiceflow.importModel', () => modelManager.pickAndImport()),
    vscode.commands.registerCommand('voiceflow.openSetupWizard', () =>
      runSetupWizard({ context, modelManager, log }),
    ),
    // Reload Window gate:销毁 helper/音频流/分段会话 + kill whisper 子进程
    // (分段 Reload:异步剪贴板写入无法保证 → 已知限制,不持久化文本,v4-②)
    {
      dispose: () => {
        recording?.dispose();
        if (segmented) {
          segmented.pipeline.cancel();
          segmented.controllerOwner.dispose();
          segmented.releaseLease?.();
          segmented = undefined;
        }
        void whisper?.dispose(); // v6-③ 异步签名;server/cli kill 同步生效
      },
    },
  );

  // 首启邀请(F5):仅 pending 弹一次;不阻塞 activate
  void maybePromptSetup({ context, modelManager, log });
}

/** blocked 记忆(v4-④):globalState 持久化,跨 Reload 不再向被拦 exe 发 spawn(每次探测必弹框,s1-d)。 */
const BLOCKED_MEMORY_KEY = 'voiceflow.serverBlockedByPolicy';
function blockedMemory(): BlockedMemory {
  return {
    get: () => extContext.globalState.get(BLOCKED_MEMORY_KEY),
    set: (r) => void extContext.globalState.update(BLOCKED_MEMORY_KEY, r),
    clear: () => void extContext.globalState.update(BLOCKED_MEMORY_KEY, undefined),
  };
}

function whisperBinaryDir(cfg: vscode.WorkspaceConfiguration): string {
  return (
    cfg.get<string>('whisper.binaryDir', '') ||
    vscode.Uri.joinPath(extContext.extensionUri, 'bin').fsPath
  );
}

/** 懒构建/更新 EngineManager(inproc-s4;配置变更时热更新;模型换档触发引擎重载)。 */
async function getWhisper(): Promise<EngineManager> {
  const cfg = vscode.workspace.getConfiguration('voiceflow');
  const tier = cfg.get<ModelTier>('model', 'small');
  const binaryDir = whisperBinaryDir(cfg);
  const mode = cfg.get<WhisperMode | 'auto' | 'inprocess'>('whisper.mode', 'auto');
  const memory = blockedMemory();
  // 受管机路径(mode=inprocess / blocked 记忆生效)不确保 .bin —— 下载 488MB 的 .bin 毫无意义
  const engineMode = await resolveEngineMode({
    mode,
    binaryDir,
    serverBinStamp: (d = binaryDir) => serverBinaryStamp(d),
    memory,
  });
  const modelUri = engineMode === 'inprocess' ? undefined : await modelManager.ensureModel(tier);
  const runnerCfg: WhisperConfig = {
    binaryDir,
    modelPath: modelUri?.fsPath ?? '',
    language: cfg.get<'zh' | 'en' | 'auto'>('language', 'auto'),
    initialPrompt: DEFAULT_INITIAL_PROMPT,
    mode,
    idleUnloadMinutes: cfg.get<number>('whisper.idleUnload', 10),
    // localModelPath/modelId 是派生值,由 manager 在激活 inprocess 时经 ensure/ready 填入(v6-②)
    inprocess: {
      localModelPath: '',
      modelId: '',
      maxResidentMinutes: cfg.get<number>('inprocess.maxResidentMinutes', 30),
    },
    log,
    onColdStart: (loading: boolean) => statusBar.setModelLoading(loading), // F2.1
  };
  if (!whisper) {
    whisper = new EngineManager(runnerCfg, {
      runner: new WhisperRunner(runnerCfg),
      createInprocess: (c) => new InprocessEngine(c),
      ensureInprocessModel: (t) => modelManager.ensureInprocessModel(t),
      isInprocessReady: (t) => modelManager.resolveExistingInprocess(t),
      serverBinStamp: (d) => serverBinaryStamp(d),
      memory,
      notifyFallback: () =>
        void vscode.window.showInformationMessage(
          'VoiceFlow: whisper server 被系统应用控制策略拦截,已自动切换到进程内转写(inprocess)。' +
            '建议把 "voiceflow.whisper.mode" 固定为 "inprocess" 以跳过探测(或重跑 Setup Wizard)。',
        ),
      inprocessTier: () =>
        vscode.workspace.getConfiguration('voiceflow').get<InprocessTier>('inprocessModel', 'small-q8'),
      log,
    });
  } else {
    await whisper.updateConfig(runnerCfg); // v7-②:等旧代际释放,防新旧引擎并存
  }
  return whisper;
}

async function toggleDictation(args?: { focus?: FocusHint }): Promise<void> {
  switch (toggleActionForSession(session.state, sessionPreflight.active)) {
    case 'start':
      await startRecording(args?.focus);
      return;
    case 'cancel-startup':
      cancelStartingSession('toggle');
      return;
    case 'stop-recording':
      if (segmented) await stopSegmentedSession('toggle');
      else await stopRecordingAndProcess('toggle');
      return;
    case 'none':
      return;
  }
}

/** P2a:按配置与运行期回退状态选录音后端。webview 路线已 No-Go(microsoft/vscode#250568),不在枚举内。 */
function makeRecorder(kind: 'addon' | 'helper'): Recorder {
  return kind === 'addon'
    ? new AddonRecorder(log)
    : new HelperRecorder(
        vscode.Uri.joinPath(extContext.extensionUri, 'bin', 'voiceflow-mic.exe').fsPath,
        log,
      );
}

function buildController(recorder: Recorder, cfg: vscode.WorkspaceConfiguration): RecordingController {
  const controller = new RecordingController(
    recorder,
    {
      maxDurationMs: cfg.get<number>('recording.maxDuration', 120) * 1000,
      autoStopSilenceMs: cfg.get<number>('recording.autoStopSilence', 3) * 1000,
    },
    extContext.globalStorageUri,
    log,
  );
  controller.onAutoStop = (reason) => {
    log(`[recording] auto-stop: ${reason}`);
    void stopRecordingAndProcess(reason);
  };
  controller.onError = (err: RecorderError) => {
    log(`[recording] failed: ${err.code} — ${err.message}`);
    session.dispatch('error');
    statusBar.showError(`Recording failed: ${err.code}`);
    recording?.dispose();
    recording = undefined;
    preparedSession = undefined;
    void showRecorderError(err);
  };
  return controller;
}

/** 回退提示按 code 区分(评审 v6-⑦:策略拦截指引 README vs 安装损坏建议重装,防坏包被静默掩盖)。 */
function notifyAddonFallback(code: 'module-unavailable' | 'blocked-by-policy'): void {
  const msg =
    code === 'blocked-by-policy'
      ? 'VoiceFlow: the native recording module was blocked by Windows app control policy (Smart App Control); switched to the helper recorder. See "Known limitations · Smart App Control" in the README.'
      : 'VoiceFlow: the native recording module failed to load (the installation may be corrupted); switched to the helper recorder. If this persists, try reinstalling the extension.';
  void vscode.window.showWarningMessage(msg);
}

/**
 * 录音后端选择 + 回退链(2a,评审 ⑥/v7-②)的通用外壳:batch/segmented 共用。
 * 仅 auto 模式 + addon + {module-unavailable, blocked-by-policy} → 当次切 helper 重试一次
 * 并运行期记住;其余错误直接抛给调用方呈现。
 */
async function startWithRecorderFallback<T extends { start(): Promise<void>; dispose(): void }>(
  cfg: vscode.WorkspaceConfiguration,
  build: (recorder: Recorder) => T,
  startup?: { signal: AbortSignal; owner: MutableStartupResource<T> },
): Promise<T> {
  const setting = cfg.get<'auto' | 'addon' | 'helper'>('recorder', 'auto');
  const kind: 'addon' | 'helper' =
    setting === 'helper' ? 'helper'
    : setting === 'addon' ? 'addon'
    : addonFallbackCode ? 'helper' : 'addon';
  if (startup) {
    let activeKind = kind;
    const ctrl = await startCancellableFallback({
      signal: startup.signal,
      owner: startup.owner,
      createPrimary: () => build(makeRecorder(kind)),
      createFallback: () => build(makeRecorder('helper')),
      shouldFallback: (err) =>
        setting === 'auto' &&
        kind === 'addon' &&
        err instanceof RecorderError &&
        (err.code === 'module-unavailable' || err.code === 'blocked-by-policy'),
      onFallback: (err) => {
        const code = (err as RecorderError).code as 'module-unavailable' | 'blocked-by-policy';
        addonFallbackCode = code;
        activeKind = 'helper';
        log(`[recorder] addon start failed (${code}) — falling back to helper for this runtime`);
        notifyAddonFallback(code);
      },
    });
    log(
      activeKind === 'helper' && kind === 'addon'
        ? '[dictation] recording via helper (fallback)…'
        : `[dictation] recording via ${activeKind}… (press Ctrl+Alt+L to stop, Esc to cancel)`,
    );
    return ctrl;
  }
  let ctrl = build(makeRecorder(kind));
  try {
    await ctrl.start();
    log(`[dictation] recording via ${kind}… (press Ctrl+Alt+L to stop, Esc to cancel)`);
    return ctrl;
  } catch (err) {
    ctrl.dispose();
    if (
      setting === 'auto' &&
      kind === 'addon' &&
      err instanceof RecorderError &&
      (err.code === 'module-unavailable' || err.code === 'blocked-by-policy')
    ) {
      addonFallbackCode = err.code;
      log(`[recorder] addon start failed (${err.code}) — falling back to helper for this runtime`);
      notifyAddonFallback(err.code);
      ctrl = build(makeRecorder('helper'));
      await ctrl.start();
      log('[dictation] recording via helper (fallback)…');
      return ctrl;
    }
    throw err;
  }
}

async function startRecording(focusHint: FocusHint): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('voiceflow');
  if (cfg.get<'batch' | 'segmented'>('output.mode', 'batch') === 'segmented') {
    return startSegmentedSession(cfg, focusHint);
  }
  return startBatchSession(cfg, focusHint);
}

function captureTranslationSnapshot(cfg: vscode.WorkspaceConfiguration): TranslationSessionSnapshot {
  return createTranslationSessionSnapshot({
    target: cfg.get<TranslationTarget>('translate.target', 'off'),
    sourceHint: cfg.get<'zh' | 'en' | 'auto'>('language', 'auto'),
    useLlm: cfg.get<boolean>('translate.useLlm', false),
    provider: undefined,
    timeoutMs: cfg.get<number>('cleanup.timeout', 8000),
    rules: getRulesConfig(),
  });
}

/** Resolve translation admission without ending the startup generation before recorder readiness. */
async function admitBatchSession(
  snapshot: TranslationSessionSnapshot,
  providerPolicy: string,
  usage: SessionUsageAccounting,
  signal: AbortSignal,
): Promise<PreparedSession> {
  let resolvedRunner: EngineManager | undefined;
  const preparedSnapshot = await prepareTranslationSnapshot(
    snapshot,
    async () => {
      resolvedRunner = await getWhisper();
      return resolvedRunner.resolveCapabilities();
    },
    () => pickEnhancer(providerPolicy),
    signal,
    (authorizationUsage) => usage.authorizationUsage(authorizationUsage),
  );
  if (preparedSnapshot.target === 'zh') {
    maybeShowTranslationPrivacyNotice(
      extContext.globalState,
      (message) => vscode.window.showInformationMessage(message),
    );
  }
  return {
    snapshot: preparedSnapshot,
    runner: resolvedRunner,
    usage,
    feedback: new TranslationSessionFeedback(),
    metrics: new TranslationSessionMetrics(),
  };
}

async function startBatchSession(
  cfg: vscode.WorkspaceConfiguration,
  focusHint: FocusHint,
): Promise<void> {
  const snapshot = captureTranslationSnapshot(cfg);
  const providerPolicy = cfg.get<string>('cleanup.provider', 'auto');
  const usage = createSessionUsageAccounting();
  statusBar.setTranslationTarget(snapshot.target);
  const controllerOwner = new MutableStartupResource<RecordingController>((controller) => {
    controller.cancel();
    controller.dispose();
  });
  try {
    const result = await runCancellableStartup(
      sessionPreflight,
      (signal) => admitBatchSession(snapshot, providerPolicy, usage, signal),
      async (prepared, signal, frozenTarget) => {
        // F4:插入目标在录音开始时锁定
        insertTarget = frozenTarget;
        log(`[dictation] target locked: ${insertTarget.kind}`);
        if (insertTarget.kind === 'focused-input') armFocusedInputTracker(); // chat-insert v1
        const controller = await startWithRecorderFallback(
          cfg,
          (recorder) => buildController(recorder, cfg),
          { signal, owner: controllerOwner },
        );
        return { prepared, controller };
      },
      () => controllerOwner.dispose(),
      {
        commitImmediately: snapshot.target === 'off',
        onCancel: () => {
          controllerOwner.dispose();
          disposeFocusedInputTracker();
        },
        captureBeforeAdmission: () => captureTarget(focusHint),
      },
    );
    if (!result.started) return;
    preparedSession = result.value.prepared;
    recording = result.value.controller;
    statusBar.recordingLive(); // 麦克风就绪才亮红点,防开头吞字
  } catch (err) {
    session.dispatch('error');
    const preflightFailed = snapshot.target !== 'off' && controllerOwner.isDisposed === false;
    statusBar.showError(preflightFailed ? 'Translation preflight failed' : 'Failed to start recording');
    controllerOwner.dispose();
    recording = undefined;
    preparedSession = undefined;
    disposeFocusedInputTracker(); // v5-① 挂点①:启动失败不经处理流程 finally
    if (err instanceof RecorderError) {
      void showRecorderError(err);
    } else {
      const message = String(err);
      if (preflightFailed) log(`[translation] preflight failed: ${message}`);
      void vscode.window.showErrorMessage(
        preflightFailed ? `VoiceFlow: ${message}` : `VoiceFlow: failed to start recording — ${message}`,
      );
    }
  }
}

// ---------- P2b:segmented 会话编排 ----------

/**
 * P2c:系统音频听写(评审 v5-⑤ 隐私 UX:显式命令启动、首次模态确认、状态栏全程明示)。
 * 强制 segmented(长流只能分段出字);D6:独立会话上限 + 禁用静音自动停
 * (系统音频常有长静默——会议冷场/视频暂停,自动停会误伤;靠显式停止/上限)。
 */
async function dictateSystemAudio(): Promise<void> {
  if (session.active) {
    vscode.window.setStatusBarMessage('$(warning) VoiceFlow: a session is already active', 3000);
    return;
  }
  const noticeKey = 'voiceflow.systemAudioNoticeShown';
  if (!extContext.globalState.get<boolean>(noticeKey)) {
    const choice = await vscode.window.showInformationMessage(
      'VoiceFlow will capture ALL sound your computer plays (from every app), transcribe it locally, ' +
        'and insert the text incrementally. Audio never leaves your machine and temporary files are ' +
        'deleted right after transcription. Continue?',
      { modal: true },
      'Start',
    );
    if (choice !== 'Start') return;
    await extContext.globalState.update(noticeKey, true);
  }
  const cfg = vscode.workspace.getConfiguration('voiceflow');
  return startSegmentedSession(cfg, undefined, { systemAudio: true });
}

async function startSegmentedSession(
  cfg: vscode.WorkspaceConfiguration,
  focusHint: FocusHint,
  opts: { systemAudio?: boolean } = {},
): Promise<void> {
  // ① 配置校验(评审 v5-②/v7-⑥:非法值拒绝进入,不静默 clamp);
  //    系统音频禁用静音自动停 → 无上界约束(评审 v5-② 的 autoStop=0 分支)
  const autoStopSilenceS = opts.systemAudio ? 0 : cfg.get<number>('recording.autoStopSilence', 3);
  // 系统音频独立切段停顿(默认 0.8s):专业播音句间停顿远短于口述,1.5s 会整场切不出段
  const valid = validateSegmentedConfig({
    segmentPauseS: opts.systemAudio
      ? cfg.get('systemAudio.segmentPause', 0.8)
      : cfg.get('output.segmentPause', 1.5),
    autoStopSilenceS,
  });
  if (!valid.ok) {
    statusBar.showError('Segmented config error');
    void vscode.window.showErrorMessage(`VoiceFlow: ${valid.error}`);
    return;
  }
  const snapshot = captureTranslationSnapshot(cfg);
  const providerPolicy = cfg.get<string>('cleanup.provider', 'auto');
  const usage = createSessionUsageAccounting();
  statusBar.setTranslationTarget(snapshot.target);
  let resolvedRunner: EngineManager | undefined;
  try {
    const result = await runCancellableStartup(
      sessionPreflight,
      async (signal) => {
        const preparedSnapshot = await prepareTranslationSnapshot(
          snapshot,
          async () => {
            resolvedRunner = await getWhisper();
            return resolvedRunner.resolveCapabilities();
          },
          () => pickEnhancer(providerPolicy),
          signal,
          (authorizationUsage) => usage.authorizationUsage(authorizationUsage),
        );
        if (preparedSnapshot.target === 'zh') {
          maybeShowTranslationPrivacyNotice(
            extContext.globalState,
            (message) => vscode.window.showInformationMessage(message),
          );
        }
        if (signal.aborted) throw new Error('segmented admission cancelled');
        // ② 形态准入属于同一可取消代际;off 虽已同步显示 recording,Esc 仍阻止晚到采集。
        const binaryDir = whisperBinaryDir(cfg);
        const engineMode = await resolveEngineMode({
          mode: cfg.get<WhisperMode | 'auto' | 'inprocess'>('whisper.mode', 'auto'),
          binaryDir,
          serverBinStamp: (d = binaryDir) => serverBinaryStamp(d),
          memory: blockedMemory(),
        });
        if (engineMode === 'cli') {
          throw new TranslationUnsupportedError(
            'Segmented mode requires the whisper server or in-process engine. Restore whisper-server.exe or use batch mode.',
          );
        }
        return {
          snapshot: preparedSnapshot,
          runner: resolvedRunner,
          usage,
          feedback: new TranslationSessionFeedback(),
          metrics: new TranslationSessionMetrics(),
        };
      },
      (prepared, signal) => startSegmentedCapture(
        cfg,
        focusHint,
        opts,
        prepared,
        valid.segmentPauseMs,
        autoStopSilenceS,
        signal,
      ),
      disposeSegmentedResources,
      { commitImmediately: snapshot.target === 'off' },
    );
    if (!result.started) return;
    statusBar.recordingLive(opts.systemAudio ? 'system' : 'mic');
  } catch (err) {
    statusBar.showError('Failed to start recording');
    if (err instanceof RecorderError) void showRecorderError(err);
    else void vscode.window.showErrorMessage(`VoiceFlow: failed to start recording — ${String(err)}`);
  }
}

async function startSegmentedCapture(
  cfg: vscode.WorkspaceConfiguration,
  focusHint: FocusHint,
  opts: { systemAudio?: boolean },
  prepared: PreparedSession,
  segmentPauseMs: number,
  autoStopSilenceS: number,
  signal: AbortSignal,
): Promise<SegmentedSession> {
  if (signal.aborted) throw new Error('segmented startup cancelled before capture');
  insertTarget = captureTarget(focusHint);
  log(`[dictation] target locked: ${insertTarget.kind} (segmented)`);
  if (insertTarget.kind === 'focused-input') armFocusedInputTracker();
  const inserter = new SegmentInserter(insertTarget, log, async (text) => {
    const fiOpts = focusedInputOpts();
    log(
      `[insert] focused-input gates (segmented flush): enabled=${fiOpts.enabled} ` +
        `editorInteracted=${fiOpts.editorInteracted} confirmShown=${fiOpts.confirmShown}`,
    );
    await dispatchInsert({ kind: 'focused-input' }, text, fiOpts);
  });

  // Preserve off-mode parallel warmup. If it resolves after cancellation, release its lease immediately.
  const warmup = (async () => {
    const runner = prepared.runner ?? await getWhisper();
    const release = runner.acquireLease();
    runner.prepare().catch((e: unknown) =>
      log(`[whisper] warmup failed (first segment will retry): ${String((e as Error)?.message ?? e)}`),
    );
    return { runner, release };
  })();

  const controllerOwner = new MutableStartupResource<SegmentedRecordingController>((controller) => {
    controller.cancel();
    controller.dispose();
  });
  const seg: SegmentedSession = {
    controller: undefined,
    controllerOwner,
    pipeline: undefined as unknown as SegmentPipeline,
    inserter,
    releaseLease: undefined,
    pending: 0,
    stopping: false,
    prepared,
    metricsLogged: false,
    disposed: false,
  };
  warmup.then(
    ({ release }) => {
      if (signal.aborted || segmented !== seg || seg.disposed) release();
      else seg.releaseLease = release;
    },
    () => { /* 首段 transcribe 走同一失败路径 */ },
  );

  const rulesCfg = prepared.snapshot.rules as RulesConfig;
  if (prepared.snapshot.target === 'zh' && prepared.snapshot.provider === undefined) {
    throw new TranslationUnsupportedError('The frozen LLM translation provider is unavailable.');
  }
  const coordinator = prepared.snapshot.target === 'zh'
    ? new TranslationCoordinator(
        (source, detectedLanguage, segmentSignal) => runTranslate(
          source,
          detectedLanguage,
          {
            rules: rulesCfg,
            timeoutMs: prepared.snapshot.timeoutMs,
            provider: prepared.snapshot.provider!,
            log,
            onRequestStart: () => prepared.usage.translationStarted(),
            onUsage: (usage) => prepared.usage.translationUsage(usage),
          },
          segmentSignal,
        ),
        (source) => applyRules(source, rulesCfg),
      )
    : undefined;
  const notifyTranslationResult = (result: TranslationResult, segmentIndex?: number): void => {
    const fallback = ['timeout', 'error', 'empty', 'rejected', 'circuit-open'].includes(result.outcome);
    log(`[translation]${segmentIndex === undefined ? '' : ` segment #${segmentIndex}`} ${result.outcome}` +
      (fallback ? ' — inserted original' : ''));
    const notice = prepared.feedback.notificationFor(result);
    if (notice !== undefined) void vscode.window.showWarningMessage(notice);
    if (coordinator?.isOpen && result.outcome !== 'circuit-open') {
      const circuitNotice = prepared.feedback.notificationFor({ text: result.text, outcome: 'circuit-open' });
      if (circuitNotice !== undefined) void vscode.window.showWarningMessage(circuitNotice);
    }
  };
  const baseLanguage = prepared.snapshot.sourceHint;
  let lockedLanguage: 'zh' | 'en' | undefined;
  let firstSegmentDone = false;
  const MIN_LOCK_SPEECH_MS = 2000;
  const pipeline = new SegmentPipeline({
    transcribe: async (wav, segmentSignal, s) => {
      const { runner } = await warmup;
      const decodeLanguageHint = languageHintForSession(prepared.snapshot, lockedLanguage);
      const r = await runner.transcribe(wav, {
        ...transcribeOptionsForSession(prepared.snapshot),
        signal: segmentSignal,
        language: decodeLanguageHint,
      });
      log(
        `[metrics] segment #${s.index}${firstSegmentDone ? '' : ' (first)'} ` +
          `cold=${r.coldStartMs ?? 0}ms warm=${r.transcribeMs}ms ` +
          `lang=${lockedLanguage ?? baseLanguage}${r.detectedLanguage ? ` detected=${r.detectedLanguage}` : ''}`,
      );
      firstSegmentDone = true;
      if (
        prepared.snapshot.target === 'off' &&
        baseLanguage === 'auto' &&
        lockedLanguage === undefined &&
        s.speechMs >= MIN_LOCK_SPEECH_MS
      ) {
        const mapped = normalizeDetectedLanguage(r.detectedLanguage);
        if (mapped) {
          lockedLanguage = mapped;
          log(`[dictation] session language locked: ${mapped} (segment #${s.index}, speech ${(s.speechMs / 1000).toFixed(1)}s)`);
        }
      }
      return {
        text: r.text,
        detectedLanguage: normalizeDetectedLanguage(r.detectedLanguage),
        decodeLanguageHint,
      };
    },
    cleanup: async (raw, detectedLanguage, segmentSignal) => coordinator === undefined
      ? { text: applyRules(raw, rulesCfg), outcome: 'rules-only' }
      : coordinator.run(raw, detectedLanguage, segmentSignal),
    insert: async (text) => inserter.insertSegment(text),
    deleteWav: async (p) => {
      seg.pending = Math.max(0, seg.pending - 1);
      statusBar.setSegmentActivity(seg.pending);
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(p));
      } catch { /* 已被清扫 */ }
    },
    log,
    onFatal: (err) => {
      statusBar.showError('Dictation failed');
      void vscode.window.showErrorMessage(`VoiceFlow: ${err.message}`);
      inserter.flushFallback('fatal');
      teardownSegmented('error');
    },
    onResult: (result, segment, processingMs) => {
      if (prepared.snapshot.target !== 'zh') return;
      prepared.metrics.observe(result.outcome, processingMs);
      notifyTranslationResult(result, segment.index);
    },
    onBacklogPressure: (queuedMs) => {
      if (coordinator === undefined) return;
      coordinator.openForBacklog(queuedMs);
      const notice = prepared.feedback.notificationFor({ text: '', outcome: 'circuit-open' });
      if (notice !== undefined) void vscode.window.showWarningMessage(notice);
      log(`[translation] circuit opened by backlog pressure (${queuedMs}ms queued)`);
    },
    onBacklogLimit: () => {
      void vscode.window.showWarningMessage(
        'VoiceFlow: transcription is falling behind — recording stopped early. Queued segments will still be inserted.',
      );
      void stopSegmentedSession('backlog');
    },
  });
  seg.pipeline = pipeline;
  // Ownership is visible before recorder.start():Esc can now cancel/dispose an in-progress startup.
  segmented = seg;

  const maxDurationMs =
    (opts.systemAudio
      ? cfg.get<number>('systemAudio.maxDuration', 1800)
      : cfg.get<number>('recording.maxDuration', 120)) * 1000;
  const buildSegController = (r: Recorder): SegmentedRecordingController => {
    const c = new SegmentedRecordingController(
      r,
      { maxDurationMs, autoStopSilenceMs: autoStopSilenceS * 1000 },
      segmentPauseMs,
      extContext.globalStorageUri,
      log,
      { maxSegmentMs: 20_000 },
    );
    c.onSegment = (s) => {
      seg.pending++;
      statusBar.setSegmentActivity(seg.pending);
      pipeline.enqueue({
        wavPath: s.wavUri.fsPath,
        index: s.index,
        startMs: s.startMs,
        endMs: s.endMs,
        speechMs: s.speechMs,
      });
    };
    c.onSegmentError = (err) => {
      statusBar.showError('Dictation failed');
      void vscode.window.showErrorMessage(`VoiceFlow: failed to persist a segment — ${err.message}`);
      inserter.flushFallback('segment-write-failed');
      teardownSegmented('error');
    };
    c.onAutoStop = (reason) => {
      log(`[recording] auto-stop: ${reason}`);
      void stopSegmentedSession(reason);
    };
    c.onError = (err) => {
      log(`[recording] failed: ${err.code} — ${err.message}`);
      inserter.flushFallback('device-lost');
      statusBar.showError(`Recording failed: ${err.code}`);
      teardownSegmented('error');
      void showRecorderError(err);
    };
    return c;
  };

  try {
    if (opts.systemAudio) {
      const addonPath = vscode.Uri.joinPath(extContext.extensionUri, 'bin', 'voiceflow-audio.node').fsPath;
      const modelPath = vscode.Uri.joinPath(
        extContext.extensionUri, 'media', 'vad', 'silero_vad_v5.onnx',
      ).fsPath;
      const recorder = new LoopbackRecorder(
        log,
        loadVoiceflowAudio(addonPath),
        () => SileroVad.create(modelPath),
      );
      const controller = buildSegController(recorder);
      if (!controllerOwner.replace(controller)) throw new Error('segmented startup cancelled');
      await controller.start();
      if (signal.aborted) throw new Error('segmented startup cancelled');
      seg.controller = controller;
      log('[dictation] recording via loopback (system audio)… (Ctrl+Alt+L to stop, Esc to cancel)');
    } else {
      seg.controller = await startWithRecorderFallback(
        cfg,
        buildSegController,
        { signal, owner: controllerOwner },
      );
    }
    return seg;
  } catch (error) {
    disposeSegmentedResources(seg);
    throw error;
  }
}

function logSegmentedTranslationMetrics(seg: SegmentedSession): void {
  if (seg.metricsLogged || seg.prepared.snapshot.target !== 'zh') return;
  seg.metricsLogged = true;
  log(formatSessionUsage(seg.prepared.usage.snapshot()));
  log(`[metrics] translate-session: ${JSON.stringify(seg.prepared.metrics.summary())}`);
}

function disposeSegmentedResources(seg: SegmentedSession): void {
  if (seg.disposed) return;
  seg.disposed = true;
  logSegmentedTranslationMetrics(seg);
  if (segmented === seg) segmented = undefined;
  seg.pipeline.cancel();
  seg.controllerOwner.dispose();
  seg.releaseLease?.();
  disposeFocusedInputTracker();
  statusBar.setSegmentActivity(0);
}

/** 正常停止(热键/自动停/backlog):封口尾段 → drain FIFO 全部段完成 → 终端确认/兜底 flush → idle。 */
async function stopSegmentedSession(reason: string): Promise<void> {
  const s = segmented;
  if (!s || !s.controller || s.stopping || session.state !== 'recording') return;
  const controller = s.controller;
  s.stopping = true;
  log(`[dictation] segmented stop(${reason})`);
  session.dispatch('drainStart');
  try {
    const { durationMs } = await controller.finish(); // 冲刷尾帧 + 封口尾段 + 段 WAV 全落盘
    log(`[dictation] recording ended (${durationMs}ms), draining ${s.pending} pending segment(s)…`);
    await s.pipeline.drained();
    if (segmented !== s) return; // drain 期间 fatal/Esc 已 teardown
    await s.inserter.finishSession(); // 终端 Send/Copy 确认(v7-⑤)/ focused-input 单次注入(v6-B)/ 累计入剪贴板
    segmented = undefined;
    s.controllerOwner.dispose();
    s.releaseLease?.();
    disposeFocusedInputTracker(); // v6-B:segmented 正常结束收口(注入判定已在 finishSession 内取过快照)
    statusBar.setSegmentActivity(0);
    session.dispatch('drained');
    log(`[metrics] segmented session done: inserted=${s.inserter.stats.inserted}`);
    logSegmentedTranslationMetrics(s);
  } catch (err) {
    log(`[dictation] segmented stop failed: ${String(err)}`);
    s.inserter.flushFallback('stop-error');
    teardownSegmented('error');
  }
}

/** 错误/取消统一收尾:管线取消(删未提交段)、控制器销毁、lease 释放、会话回 idle。幂等。 */
function teardownSegmented(kind: 'error' | 'cancel'): void {
  const s = segmented;
  if (!s) return;
  disposeSegmentedResources(s);
  session.dispatch(kind);
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
    const translationStartedAt = Date.now();
    const activeTranslation = preparedSession;
    const snapshot = activeTranslation?.snapshot ?? captureTranslationSnapshot(vscode.workspace.getConfiguration('voiceflow'));
    const runner = activeTranslation?.runner ?? await getWhisper();
    sttAbort = new AbortController();
    const stt = await runner.transcribe(result.wavUri.fsPath, {
      ...transcribeOptionsForSession(snapshot),
      signal: sttAbort.signal,
      language: snapshot.target === 'off'
        ? undefined
        : snapshot.target === 'zh' ? 'auto' : snapshot.sourceHint,
    });
    sttAbort = undefined;
    if ((session.state as string) !== 'transcribing') return; // Esc 已取消
    log(
      `[metrics] coldStart=${stt.coldStartMs ?? 0}ms warmTranscribe=${stt.transcribeMs}ms mode=${stt.mode}`,
    );
    session.dispatch('transcribed');

    // Step 4/5:清理管线 —— ① rules 必跑 ② 增强层可选(超时回落,F3.4)
    const vfCfg = vscode.workspace.getConfiguration('voiceflow');
    cleaningAbort = new AbortController();
    const tClean = Date.now();
    let cleaned: string;
    if (snapshot.target === 'zh') {
      if (!activeTranslation || snapshot.provider === undefined) {
        throw new TranslationUnsupportedError('The frozen LLM translation provider is unavailable.');
      }
      const translated = await runTranslate(
        stt.text,
        normalizeDetectedLanguage(stt.detectedLanguage),
        {
          rules: snapshot.rules as RulesConfig,
          timeoutMs: snapshot.timeoutMs,
          provider: snapshot.provider,
          log,
          onRequestStart: () => activeTranslation.usage.translationStarted(),
          onUsage: (usage) => activeTranslation.usage.translationUsage(usage),
        },
        cleaningAbort.signal,
      );
      cleaned = translated.text;
      activeTranslation.metrics.observe(translated.outcome, Date.now() - translationStartedAt);
      const notice = activeTranslation.feedback.notificationFor(translated);
      if (notice !== undefined) void vscode.window.showWarningMessage(notice);
      log(`[translation] batch ${translated.outcome}` +
        (['timeout', 'error', 'empty', 'rejected'].includes(translated.outcome)
          ? ' — inserted original'
          : ''));
      log(`[metrics] translate=${Date.now() - tClean}ms`);
    } else {
      const cleanResult = await runCleanup(
        stt.text,
        {
          rules: snapshot.target === 'off' ? getRulesConfig() : snapshot.rules as RulesConfig,
          timeoutMs: snapshot.target === 'off' ? vfCfg.get<number>('cleanup.timeout', 8000) : snapshot.timeoutMs,
          enhancer: snapshot.target === 'off'
            ? await pickEnhancer(vfCfg.get<string>('cleanup.provider', 'auto'))
            : undefined,
          log,
        },
        cleaningAbort.signal,
      );
      cleaned = cleanResult.text;
      log(
        `[metrics] cleanup=${Date.now() - tClean}ms provider=${cleanResult.usedProvider}` +
          (cleanResult.degraded !== undefined ? ` degraded=${cleanResult.degraded}` : ''),
      );
    }
    cleaningAbort = undefined;
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
      // chat-insert v4-③:确认框是扩展自己造成的焦点变化,该会话定死不 type
      if (focusedInputTracker) focusedInputTracker.confirmShown = true;
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

    // Step 3:插入分发(F4 表;focused-input 判定快照随 dispatch 传入,chat-insert v1)
    const t0 = Date.now();
    const fiOpts = focusedInputOpts();
    if (insertTarget.kind === 'focused-input') {
      // 三闸快照(t3 实测加):outcome=clipboard 时一眼定位是哪闸拦的
      log(
        `[insert] focused-input gates: enabled=${fiOpts.enabled} ` +
          `editorInteracted=${fiOpts.editorInteracted} confirmShown=${fiOpts.confirmShown}`,
      );
    }
    const outcome = await dispatchInsert(insertTarget, cleaned, fiOpts);
    session.dispatch('inserted');
    log(`[metrics] insert=${Date.now() - t0}ms outcome=${outcome}`);
  } catch (err) {
    if (err instanceof CleanupCancelled || (err instanceof WhisperError && err.kind === 'cancelled')) {
      log('[dictation] cancelled by user');
      return; // 会话已由 cancelSession 置回 idle
    }
    session.dispatch('error');
    statusBar.showError('Dictation failed');
    log(`[dictation] failed: ${String(err)}`);
    void vscode.window.showErrorMessage(`VoiceFlow: ${String(err)}`);
  } finally {
    if (preparedSession?.snapshot.target === 'zh') {
      log(formatSessionUsage(preparedSession.usage.snapshot()));
      log(`[metrics] translate-session: ${JSON.stringify(preparedSession.metrics.summary())}`);
    }
    recording?.dispose();
    recording = undefined;
    preparedSession = undefined;
    disposeFocusedInputTracker(); // v5-① 挂点③:转写失败/空文本/Copy/Discard/正常完成全收口
    // 临时 WAV 用完即删(隐私:音频不留盘)
    if (wavUri) {
      try {
        await vscode.workspace.fs.delete(wavUri);
      } catch { /* 已被清扫 */ }
    }
  }
}

/** D9/F3.3 provider 逻辑:auto=rules+vscode.lm(可用则用);CLI 仅显式选择。 */
async function pickEnhancer(provider: string): Promise<LlmProvider | undefined> {
  switch (provider) {
    case 'auto':
      return createVscodeLmProvider(log, extContext.languageModelAccessInformation); // 无模型 → undefined = rules-only
    case 'claude-cli':
    case 'codex-cli':
      return createCliProvider(
        provider as CliKind,
        createCliExecutionContext(extContext.globalStorageUri.fsPath),
      );
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

function cancelStartingSession(trigger: 'Esc' | 'toggle'): boolean {
  if (!sessionPreflight.cancel()) return false;
  if (segmented) {
    segmented.inserter.flushFallback(trigger === 'Esc' ? 'esc-startup' : 'toggle-startup');
    disposeSegmentedResources(segmented);
  }
  preparedSession = undefined;
  disposeFocusedInputTracker();
  log(`[dictation] session startup cancelled (${trigger})`);
  return true;
}

function cancelSession(): void {
  if (!session.active) return;
  if (cancelStartingSession('Esc')) return;
  if (segmented) {
    // 分段 Esc 语义(spec §5.3 修订):停录 + abort 在途 + 删未提交段文件,已插入的段不回收;
    // 已完成未插入的累计文本先 flush(v4-② Esc 路径)
    segmented.inserter.flushFallback('esc');
    teardownSegmented('cancel');
    log('[dictation] segmented session cancelled (Esc)');
    return;
  }
  recording?.cancel();
  recording?.dispose();
  recording = undefined;
  preparedSession = undefined;
  disposeFocusedInputTracker(); // v5-① 挂点②:录音期 Esc 不经处理流程 finally
  sttAbort?.abort(); // 中止进行中的转写(CLI kill / HTTP abort;server 进程保留,v10-① 双信号)
  sttAbort = undefined;
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
      'This is a known preview limitation (the recording component is not yet code-signed). It is usually temporary — wait a moment and try again. See the "Known limitations · Smart App Control" section in the README.',
    'module-unavailable':
      'VoiceFlow: the native recording module failed to load. Set "voiceflow.recorder" to "auto" or "helper" to use the helper recorder, or reinstall the extension. See the logs (VoiceFlow: Show Logs).',
    'init-failed': 'VoiceFlow: failed to initialize recording. See the logs (VoiceFlow: Show Logs).',
  };
  const isPolicy = err.code === 'blocked-by-policy';
  const buttons = isPolicy ? ['View Logs'] : ['Retry', 'View Logs'];
  const action = await vscode.window.showErrorMessage(guides[err.code] ?? err.message, ...buttons);
  if (action === 'Retry') void vscode.commands.executeCommand('voiceflow.toggleDictation');
  else if (action === 'View Logs') output.show();
}

export function deactivate(): Promise<void> | undefined {
  sessionPreflight?.cancel();
  recording?.dispose();
  recording = undefined;
  if (segmented) {
    segmented.pipeline.cancel();
    segmented.controllerOwner.dispose();
    segmented.releaseLease?.();
    segmented = undefined;
  }
  // Reload Window gate:kill whisper server,无残留进程。
  // v6-③:返回 dispose promise(inprocess 引擎需等在途推理 settle;server/cli 即时)
  const disposed = whisper?.dispose();
  whisper = undefined;
  return disposed;
}
