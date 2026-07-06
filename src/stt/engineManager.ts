/**
 * inproc-s4:EngineManager —— 回退链唯一归属(plan v7 §3.1,v4-③/v5/v6/v7 全条款)。
 *
 * - pipeline / extension / batch 只见 manager(WhisperEngine 面),不感知引擎切换
 * - 内部 blocked(EngineBlockedError)不出 manager(v5-④):
 *   auto → 回退协议;显式 server/cli → 对外映射 permanent(带指引)
 * - 回退协议:捕获 blocked → 记忆(内存 + 持久化 v4-④)→ 模型分支(v5-②):
 *   即时可得 → 切 InprocessEngine + **同一 wav 重试一次**(不与 pipeline transient 重试叠加);
 *   需下载 → 当次 permanent 失败 + 发起 ensure(single-flight 所有权归 manager,v6-①,
 *   代际 key = tier+modelPath,v7-①)
 * - 逻辑 lease(v5-③):调用方只见 manager 的逻辑 lease;切换引擎时旧 backend 全释放、
 *   新 backend 按存活逻辑 lease 数补获取
 * - 纯逻辑层:不 import vscode;UI 能力(ensure 进度/提示)全部注入
 */
import { EngineBlockedError, type WhisperEngine } from './engine';
import { WhisperError } from './whisperRunner';
import type { TranscribeOptions, TranscribeResult, WhisperConfig } from './whisperRunner';
import type { InprocessPaths, InprocessTier } from './onnxModels';

/** blocked 记忆(v4-④):globalState 持久化,key 含 server bin 标识,变更即失效重探。 */
export interface BlockedMemory {
  get(): { binaryDir: string; binStamp: string } | undefined;
  set(record: { binaryDir: string; binStamp: string }): void;
  clear(): void;
}

export interface EngineManagerDeps {
  /** server/cli 引擎(现 WhisperRunner)。 */
  runner: WhisperEngine;
  /** inprocess 引擎工厂(切换/显式 inprocess 时创建;cfg.inprocess 已填派生路径)。 */
  createInprocess(cfg: WhisperConfig): WhisperEngine;
  /** 模型确保(extension 注入 ModelManager 实现,带进度 UI;v5-②)。 */
  ensureInprocessModel(tier: InprocessTier): Promise<InprocessPaths>;
  /** 就绪快速预检(§3.5:不加载模型不联网)。 */
  isInprocessReady(tier: InprocessTier): Promise<InprocessPaths | undefined>;
  /** server bin 标识(mtime/size 串;bin 缺失返回 undefined)。记忆失效判据。 */
  serverBinStamp(binaryDir: string): Promise<string | undefined>;
  memory: BlockedMemory;
  /** 一次性提示(已自动切换 + 建议固定 mode=inprocess)。 */
  notifyFallback(): void;
  inprocessTier(): InprocessTier;
  log(line: string): void;
}

/** manager 视角的运行模式(resolveEngineMode 的输出)。 */
export type EngineMode = 'server' | 'cli' | 'inprocess';

export interface ResolveEngineModeOpts {
  mode: EngineMode | 'auto';
  binaryDir: string;
  serverBinStamp(): Promise<string | undefined>;
  memory: BlockedMemory;
  /** 运行期内存记忆(manager 内部注入;外部准入调用可省)。 */
  blockedThisRun?: boolean;
}

/**
 * 解析链(§3.1/§3.5,manager 与 segmented 准入共用):显式直通;auto = bin 缺失 → cli,
 * blocked 记忆(运行期或持久化且 bin 标识未变)→ inprocess,否则 server。
 * bin 标识变更 → 清持久化记忆(明确触发的失效重探,v4-④)。
 */
export async function resolveEngineMode(o: ResolveEngineModeOpts): Promise<EngineMode> {
  if (o.mode !== 'auto') return o.mode;
  const stamp = await o.serverBinStamp();
  if (stamp === undefined) return 'cli';
  if (o.blockedThisRun) return 'inprocess';
  const remembered = o.memory.get();
  if (remembered && remembered.binaryDir === o.binaryDir && remembered.binStamp === stamp) {
    return 'inprocess'; // 跨窗口不再向被拦 exe 发 spawn(s1-d:每次探测必弹框)
  }
  if (remembered) o.memory.clear(); // bin 变更 → 失效重探
  return 'server';
}

export class EngineManager implements WhisperEngine {
  private active: 'runner' | 'inprocess' = 'runner';
  private inprocess: WhisperEngine | undefined;
  /** 逻辑 lease(v5-③):id → 当前 backend 的 release(切换时重绑)。 */
  private readonly logicalLeases = new Map<number, () => void>();
  private leaseSeq = 0;
  /** 运行期 blocked 记忆(globalState 之上的内存层)。 */
  private blockedThisRun = false;
  private fallbackNotified = false;
  /** ensure single-flight(v6-①):key = tier+modelPath 代际(v7-①)。 */
  private ensureFlight: { key: string; promise: Promise<InprocessPaths>; state: 'preparing' | 'ready' | 'failed' } | undefined;

  constructor(
    private cfg: WhisperConfig,
    private readonly deps: EngineManagerDeps,
  ) {}

  // ---------- WhisperEngine 面 ----------

  async updateConfig(cfg: WhisperConfig): Promise<void> {
    this.cfg = cfg;
    await this.deps.runner.updateConfig(cfg);
    if (this.inprocess) await this.inprocess.updateConfig(await this.withInprocessPaths(cfg));
  }

  acquireLease(): () => void {
    const id = this.leaseSeq++;
    this.logicalLeases.set(id, this.currentEngine().acquireLease());
    return () => {
      const release = this.logicalLeases.get(id);
      if (!release) return; // 幂等
      this.logicalLeases.delete(id);
      release();
    };
  }

  async prepare(): Promise<{ coldStartMs?: number }> {
    const mode = await this.resolveMode();
    if (mode === 'inprocess') {
      await this.activateInprocess('resolve');
      return this.inprocess!.prepare();
    }
    try {
      return await this.deps.runner.prepare();
    } catch (e) {
      return this.handleBlocked(e, async () => this.inprocess!.prepare());
    }
  }

  async transcribe(wavPath: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    const mode = await this.resolveMode();
    if (mode === 'inprocess') {
      await this.activateInprocess('resolve');
      return this.inprocess!.transcribe(wavPath, opts);
    }
    try {
      return await this.deps.runner.transcribe(wavPath, opts);
    } catch (e) {
      // v4-③:同一 wav 立即重试一次;pipeline 看到的是一次成功或一次非 transient 失败
      return this.handleBlocked(e, async () => this.inprocess!.transcribe(wavPath, opts));
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([this.deps.runner.dispose(), this.inprocess?.dispose()]);
  }

  // ---------- 解析链(§3.1/§3.5)----------

  /** 见模块级 resolveEngineMode(与 segmented 准入共用同一实现)。 */
  async resolveMode(): Promise<EngineMode> {
    return resolveEngineMode({
      mode: this.cfg.mode as EngineMode | 'auto',
      binaryDir: this.cfg.binaryDir,
      serverBinStamp: () => this.deps.serverBinStamp(this.cfg.binaryDir),
      memory: this.deps.memory,
      blockedThisRun: this.blockedThisRun,
    });
  }

  // ---------- 回退协议(v4-③/v5-②)----------

  private async handleBlocked<T>(err: unknown, retry: () => Promise<T>): Promise<T> {
    if (!(err instanceof EngineBlockedError)) throw err;
    const mode = this.cfg.mode as EngineMode | 'auto';
    if (mode !== 'auto') {
      // v5-④:显式 server/cli 不回退,对外映射 permanent(带指引)
      throw new WhisperError(
        'permanent',
        `${err.message}\n受管(公司)环境请把 voiceflow.whisper.mode 设为 "inprocess"(或重跑 Setup Wizard 选"受管机")。`,
      );
    }
    this.deps.log(`[engine] blocked by policy: ${err.message}`);
    await this.rememberBlocked();

    const tier = this.deps.inprocessTier();
    const ready = await this.deps.isInprocessReady(tier);
    if (ready) {
      // 模型即时可得 → 切换 + 同 wav 重试一次
      await this.activateInprocess('fallback');
      if (!this.fallbackNotified) {
        this.fallbackNotified = true;
        this.deps.notifyFallback();
      }
      return retry();
    }
    // 需下载 → 当次会话明确失败(不静默等下载)+ 发起 ensure(所有权归 manager,v6-①)
    this.kickEnsure(tier);
    throw new WhisperError(
      'permanent',
      '检测到系统策略拦截 whisper server;正在后台准备本地转写模型(inprocess),完成后下次听写自动可用。',
    );
  }

  private async rememberBlocked(): Promise<void> {
    this.blockedThisRun = true;
    const stamp = await this.deps.serverBinStamp(this.cfg.binaryDir);
    if (stamp !== undefined) this.deps.memory.set({ binaryDir: this.cfg.binaryDir, binStamp: stamp });
  }

  /** ensure single-flight(v6-①)+ 代际 key(v7-①):key 不符的完成/失败不碰当前代际。 */
  private kickEnsure(tier: InprocessTier): void {
    const key = `${tier}`;
    if (this.ensureFlight?.key === key && this.ensureFlight.state === 'preparing') return; // 共享在途
    if (this.ensureFlight?.key === key && this.ensureFlight.state === 'ready') return;
    const flight = {
      key,
      state: 'preparing' as 'preparing' | 'ready' | 'failed',
      promise: this.deps.ensureInprocessModel(tier),
    };
    this.ensureFlight = flight;
    // 显式 .catch:取消/失败不产生未处理 rejection,只置状态(v6-①)
    flight.promise.then(
      () => {
        if (this.ensureFlight === flight) flight.state = 'ready'; // 代际 key 一致才更新(v7-①)
        this.deps.log(`[engine] inprocess model ${tier} ready (background ensure)`);
      },
      (e: unknown) => {
        if (this.ensureFlight === flight) flight.state = 'failed'; // failed:下次触发点重试
        this.deps.log(`[engine] inprocess model ensure failed: ${String((e as Error)?.message ?? e)}`);
      },
    );
  }

  // ---------- 引擎切换(v5-③ 逻辑 lease 重绑)----------

  private currentEngine(): WhisperEngine {
    return this.active === 'inprocess' ? this.inprocess! : this.deps.runner;
  }

  /** 激活 inprocess(显式/记忆/回退共用):建引擎、迁移 lease、旧 runner dispose(await,v6-③)。 */
  private async activateInprocess(reason: 'resolve' | 'fallback'): Promise<void> {
    if (this.active === 'inprocess' && this.inprocess) return;
    // 显式 mode=inprocess 且未就绪 → 先走 ensure(v5-②:启动听写前确保,仅 ensure 失败才报错)
    const tier = this.deps.inprocessTier();
    let paths = await this.deps.isInprocessReady(tier);
    if (!paths) {
      paths = await this.ensureForeground(tier);
    }
    if (!this.inprocess) {
      this.inprocess = this.deps.createInprocess(this.cfgWithPaths(paths));
    } else {
      await this.inprocess.updateConfig(this.cfgWithPaths(paths));
    }
    if (this.active !== 'inprocess') {
      this.active = 'inprocess';
      // 逻辑 lease 重绑:旧 backend 全释放、新 backend 按存活数补获取(v5-③)
      for (const [id, release] of this.logicalLeases) {
        release();
        this.logicalLeases.set(id, this.inprocess.acquireLease());
      }
      if (reason === 'fallback') await this.deps.runner.dispose(); // 旧 ServerEngine 释放(v6-③)
      this.deps.log(`[engine] switched to inprocess (${reason})`);
    }
  }

  /** 前台 ensure(显式 inprocess 路径):共享 single-flight;失败置 failed 后上抛 permanent。 */
  private async ensureForeground(tier: InprocessTier): Promise<InprocessPaths> {
    this.kickEnsure(tier);
    try {
      return await this.ensureFlight!.promise;
    } catch (e) {
      throw new WhisperError(
        'permanent',
        `inprocess 模型未就绪且准备失败:${String((e as Error)?.message ?? e)}`,
      );
    }
  }

  private cfgWithPaths(paths: InprocessPaths): WhisperConfig {
    return {
      ...this.cfg,
      inprocess: {
        localModelPath: paths.localModelPath,
        modelId: paths.modelId,
        maxResidentMinutes: this.cfg.inprocess?.maxResidentMinutes ?? 30,
      },
    };
  }

  private async withInprocessPaths(cfg: WhisperConfig): Promise<WhisperConfig> {
    const ready = await this.deps.isInprocessReady(this.deps.inprocessTier());
    return ready ? { ...cfg, inprocess: { ...this.cfgWithPaths(ready).inprocess! } } : cfg;
  }
}
