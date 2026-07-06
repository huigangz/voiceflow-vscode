/**
 * VoiceFlow 入口:命令注册 + 会话状态机编排。
 * Phase 0 — 已接入:S1 录音(Step 1)。待接入:whisper(Step 2)、插入(Step 3+)。
 */
import * as vscode from 'vscode';
import { Session } from './session';
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
import { FocusHint, InsertTarget, captureTarget, dispatchInsert } from './insert/dispatcher';
import { SegmentInserter } from './insert/segmentInserter';
import { SegmentPipeline } from './segment/pipeline';
import { validateSegmentedConfig } from './segment/config';
import { RulesConfig, applyRules } from './cleanup/rulesLayer';
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
let whisper: EngineManager | undefined;
let insertTarget: InsertTarget = { kind: 'none' };
/** 会话级转写取消(v12-①:runner 无实例级 cancel,取消所有权归调用方)。 */
let sttAbort: AbortController | undefined;
let cleaningAbort: AbortController | undefined;
let statusBar: StatusBar;
/**
 * P2a 回退链(评审 ⑥/v7-②):addon 首次 start 失败且 code 为 module-unavailable /
 * blocked-by-policy → 当次回退 HelperRecorder,并在运行期记住(按 code,不靠 message)。
 * 仅 auto 模式回退;显式 addon = 用户强制,失败直接呈现。
 */
let addonFallbackCode: 'module-unavailable' | 'blocked-by-policy' | undefined;

/** P2b:segmented 会话(与 batch 的 `recording` 互斥;同一时刻只有一种会话形态)。 */
interface SegmentedSession {
  controller: SegmentedRecordingController;
  pipeline: SegmentPipeline;
  inserter: SegmentInserter;
  releaseLease: (() => void) | undefined;
  pending: number;
  stopping: boolean;
}
let segmented: SegmentedSession | undefined;

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

  // offline VSIX(B 方案):内置模型放 extensionUri/offline-model;存在则运行时零下载
  modelManager = new ModelManager(
    context.globalStorageUri,
    log,
    vscode.Uri.joinPath(context.extensionUri, 'offline-model'),
  );

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('voiceflow.toggleDictation', toggleDictation),
    vscode.commands.registerCommand('voiceflow.cancelSession', cancelSession),
    vscode.commands.registerCommand('voiceflow.showLogs', () => output.show()),
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
          segmented.controller?.dispose();
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
  if (session.state === 'idle') {
    await startRecording(args?.focus);
  } else if (session.state === 'recording') {
    if (segmented) await stopSegmentedSession('toggle');
    else await stopRecordingAndProcess('toggle');
  }
  // 其他阶段(含 draining):toggle 无效(取消走 Esc,spec §5.3)
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
): Promise<T> {
  const setting = cfg.get<'auto' | 'addon' | 'helper'>('recorder', 'auto');
  const kind: 'addon' | 'helper' =
    setting === 'helper' ? 'helper'
    : setting === 'addon' ? 'addon'
    : addonFallbackCode ? 'helper' : 'addon';
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

async function startBatchSession(
  cfg: vscode.WorkspaceConfiguration,
  focusHint: FocusHint,
): Promise<void> {
  // F4:插入目标在录音开始时锁定
  insertTarget = captureTarget(focusHint);
  log(`[dictation] target locked: ${insertTarget.kind}`);
  session.dispatch('start');
  try {
    recording = await startWithRecorderFallback(cfg, (r) => buildController(r, cfg));
    statusBar.recordingLive(); // 麦克风就绪才亮红点,防开头吞字
  } catch (err) {
    session.dispatch('error');
    statusBar.showError('Failed to start recording');
    recording?.dispose();
    recording = undefined;
    if (err instanceof RecorderError) void showRecorderError(err);
    else void vscode.window.showErrorMessage(`VoiceFlow: failed to start recording — ${String(err)}`);
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
  // ② 形态准入(评审 v8-⑤:CLI 显式拒绝不静默降级;v10-③/v11-⑤:快速判定不碰模型;
  //    inproc-s4/§3.5:准入从"server"放宽为"server 或 inprocess"——两者常驻、无每段冷加载)
  const binaryDir = whisperBinaryDir(cfg);
  const engineMode = await resolveEngineMode({
    mode: cfg.get<WhisperMode | 'auto' | 'inprocess'>('whisper.mode', 'auto'),
    binaryDir,
    serverBinStamp: (d = binaryDir) => serverBinaryStamp(d),
    memory: blockedMemory(),
  });
  if (engineMode === 'cli') {
    statusBar.showError('Segmented requires whisper server');
    void vscode.window.showErrorMessage(
      'VoiceFlow: segmented mode requires the whisper server binary (per-segment CLI cold-load latency is unacceptable). ' +
        'Restore whisper-server.exe or set "voiceflow.output.mode" back to "batch".',
    );
    return;
  }

  insertTarget = captureTarget(focusHint);
  log(`[dictation] target locked: ${insertTarget.kind} (segmented)`);
  const inserter = new SegmentInserter(insertTarget, log);

  // ③ 并行预热(评审 v6-⑥):会话 lease 先行(v11-②);prepare 失败不阻会话,首段会再试
  const warmup = (async () => {
    const runner = await getWhisper(); // 含模型确保(首次可能下载)
    const release = runner.acquireLease();
    runner.prepare().catch((e: unknown) =>
      log(`[whisper] warmup failed (first segment will retry): ${String((e as Error)?.message ?? e)}`),
    );
    return { runner, release };
  })();

  const seg: SegmentedSession = {
    controller: undefined as unknown as SegmentedRecordingController,
    pipeline: undefined as unknown as SegmentPipeline,
    inserter,
    releaseLease: undefined,
    pending: 0,
    stopping: false,
  };
  warmup.then(
    ({ release }) => { seg.releaseLease = release; },
    () => { /* 预热失败:首段 transcribe 走同一失败路径(fatal 显式终止) */ },
  );

  const rulesCfg = getRulesConfig();
  // 会话语言锁定(评审 ⑤ + v9-⑦):仅 language=auto 参与;首个语音 ≥2s 的段锁定(过短首段不锁);
  // detected_language 拿不到(如 CLI)则维持逐段 auto。锁定状态由管线闭包持有,不污染 cfg。
  const baseLanguage = cfg.get<'zh' | 'en' | 'auto'>('language', 'auto');
  let lockedLanguage: 'zh' | 'en' | undefined;
  let firstSegmentDone = false;
  const MIN_LOCK_SPEECH_MS = 2000;
  const pipeline = new SegmentPipeline({
    transcribe: async (wav, signal, s) => {
      const { runner } = await warmup;
      const r = await runner.transcribe(wav, { signal, language: lockedLanguage });
      // 首段 cold latency 单列(评审 v6-⑥,不计入 P50/P95)
      log(
        `[metrics] segment #${s.index}${firstSegmentDone ? '' : ' (first)'} ` +
          `cold=${r.coldStartMs ?? 0}ms warm=${r.transcribeMs}ms ` +
          `lang=${lockedLanguage ?? baseLanguage}${r.detectedLanguage ? ` detected=${r.detectedLanguage}` : ''}`,
      );
      firstSegmentDone = true;
      if (baseLanguage === 'auto' && lockedLanguage === undefined && s.speechMs >= MIN_LOCK_SPEECH_MS) {
        // v4-⑦ 唯一映射点:server('chinese'/'english')与 inprocess('zh'/'en')双词汇归一
        const mapped = normalizeDetectedLanguage(r.detectedLanguage);
        if (mapped) {
          lockedLanguage = mapped;
          log(`[dictation] session language locked: ${mapped} (segment #${s.index}, speech ${(s.speechMs / 1000).toFixed(1)}s)`);
        }
      }
      return r.text;
    },
    cleanup: (raw) => applyRules(raw, rulesCfg), // v1:分段只做规则清理(D2 定 LLM 是否按段开)
    insert: async (text) => inserter.insertSegment(text),
    deleteWav: async (p) => {
      seg.pending = Math.max(0, seg.pending - 1); // 每段恰好删一次(成败同待遇)→ 计数在此收敛
      statusBar.setSegmentActivity(seg.pending);
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(p));
      } catch { /* 已被清扫 */ }
    },
    log,
    onFatal: (err) => {
      // 显式终止(评审 ③):停录 + 状态栏错误 + flush 兜底,绝不静默缺句
      statusBar.showError('Dictation failed');
      void vscode.window.showErrorMessage(`VoiceFlow: ${err.message}`);
      inserter.flushFallback('fatal'); // 错误路径销毁管线前先 flush(v4-②)
      teardownSegmented('error');
    },
    onBacklogLimit: () => {
      // v12-②:停采集,已入队段照常 drain 全部出字
      void vscode.window.showWarningMessage(
        'VoiceFlow: transcription is falling behind — recording stopped early. Queued segments will still be inserted.',
      );
      void stopSegmentedSession('backlog');
    },
  });
  seg.pipeline = pipeline;

  // D6:系统音频独立会话上限(默认 30min;分段管线段完即插即删,长会话内存平稳)
  const maxDurationMs =
    (opts.systemAudio
      ? cfg.get<number>('systemAudio.maxDuration', 1800)
      : cfg.get<number>('recording.maxDuration', 120)) * 1000;

  session.dispatch('start');
  try {
    const buildSegController = (r: Recorder): SegmentedRecordingController => {
      const c = new SegmentedRecordingController(
        r,
        {
          maxDurationMs,
          autoStopSilenceMs: autoStopSilenceS * 1000,
        },
        valid.segmentPauseMs,
        extContext.globalStorageUri,
        log,
        // 强制切分 20s(P2c gate 实测:连续解说无停顿 → 段膨胀触发 backlog 停采;
        // 对口述同样防长独白撑爆;whisper 30s 窗内,20s 段 warm ~6s 管线稳跟)
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
        // 段 WAV 落盘失败 = 内容已丢 → 显式终止(评审 ③)
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
        // device-lost 等:在途段全弃(S1 按段重申),已插入保留,累计 flush(v4-②)
        log(`[recording] failed: ${err.code} — ${err.message}`);
        inserter.flushFallback('device-lost');
        statusBar.showError(`Recording failed: ${err.code}`);
        teardownSegmented('error');
        void showRecorderError(err);
      };
      return c;
    };

    if (opts.systemAudio) {
      // P2c:LoopbackRecorder(自研 addon + Silero VAD)。无 helper 回退——系统音频
      // 没有备用采集路径,失败直接呈现(module-unavailable/init-failed 文案指引)
      const addonPath = vscode.Uri.joinPath(extContext.extensionUri, 'bin', 'voiceflow-audio.node').fsPath;
      const modelPath = vscode.Uri.joinPath(
        extContext.extensionUri, 'media', 'vad', 'silero_vad_v5.onnx',
      ).fsPath;
      const recorder = new LoopbackRecorder(
        log,
        loadVoiceflowAudio(addonPath),
        () => SileroVad.create(modelPath),
      );
      const c = buildSegController(recorder);
      await c.start();
      log('[dictation] recording via loopback (system audio)… (Ctrl+Alt+L to stop, Esc to cancel)');
      seg.controller = c;
    } else {
      seg.controller = await startWithRecorderFallback(cfg, buildSegController);
    }
    segmented = seg;
    statusBar.recordingLive(opts.systemAudio ? 'system' : 'mic');
  } catch (err) {
    pipeline.cancel();
    seg.releaseLease?.();
    session.dispatch('error');
    statusBar.showError('Failed to start recording');
    if (err instanceof RecorderError) void showRecorderError(err);
    else void vscode.window.showErrorMessage(`VoiceFlow: failed to start recording — ${String(err)}`);
  }
}

/** 正常停止(热键/自动停/backlog):封口尾段 → drain FIFO 全部段完成 → 终端确认/兜底 flush → idle。 */
async function stopSegmentedSession(reason: string): Promise<void> {
  const s = segmented;
  if (!s || s.stopping || session.state !== 'recording') return;
  s.stopping = true;
  log(`[dictation] segmented stop(${reason})`);
  session.dispatch('drainStart');
  try {
    const { durationMs } = await s.controller.finish(); // 冲刷尾帧 + 封口尾段 + 段 WAV 全落盘
    log(`[dictation] recording ended (${durationMs}ms), draining ${s.pending} pending segment(s)…`);
    await s.pipeline.drained();
    if (segmented !== s) return; // drain 期间 fatal/Esc 已 teardown
    await s.inserter.finishSession(); // 终端 Send/Copy 确认(v7-⑤)/ 累计入剪贴板(v4-② 正常停止路径)
    segmented = undefined;
    s.controller.dispose();
    s.releaseLease?.();
    statusBar.setSegmentActivity(0);
    session.dispatch('drained');
    log(`[metrics] segmented session done: inserted=${s.inserter.stats.inserted}`);
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
  segmented = undefined;
  s.pipeline.cancel();
  s.controller?.cancel();
  s.controller?.dispose();
  s.releaseLease?.();
  statusBar.setSegmentActivity(0);
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
    const runner = await getWhisper();
    sttAbort = new AbortController();
    const stt = await runner.transcribe(result.wavUri.fsPath, { signal: sttAbort.signal });
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
    if (err instanceof CleanupCancelled || (err instanceof WhisperError && err.kind === 'cancelled')) {
      log('[dictation] cancelled by user');
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
  recording?.dispose();
  recording = undefined;
  if (segmented) {
    segmented.pipeline.cancel();
    segmented.controller?.dispose();
    segmented.releaseLease?.();
    segmented = undefined;
  }
  // Reload Window gate:kill whisper server,无残留进程。
  // v6-③:返回 dispose promise(inprocess 引擎需等在途推理 settle;server/cli 即时)
  const disposed = whisper?.dispose();
  whisper = undefined;
  return disposed;
}
