/**
 * Phase 2a:PvRecorder 进程内录音(替换 voiceflow-mic.exe 的默认路线)。
 *
 * 设计由 2a-1 spike 实测驱动(worklog/2026-07-04-p2a1-pvrecorder-spike.md):
 * - native read 在缓冲空时**阻塞调用线程 ≈32ms**(官方 async read 只是 setTimeout 包同步调用)
 *   → 定时器节拍 + 按墙钟欠账批量补读,每次 read 都命中非空缓冲(留 1 帧余量),不吸干扩展主线程;
 * - stop() 后缓冲立即不可读(第 1 帧即抛错)→ 停止序列 = **先 drain 到空再 stop()**(S2 尾字不吞);
 * - release() 后的滞后 native read 抛可捕获异常、不崩进程(uaf 相实测)→ 同步 dispose 契约成立;
 *   JS 单线程,所有 native 调用都在本文件自有代码路径上,每次调用前同步查代际/停止标志即可,
 *   无真并发(评审 v8-③/v12-③ Go)。
 * - .node 在 require 包时即加载(类静态初始化)→ 懒加载 = 首次 start() 才 loadModule();
 *   load 失败 → module-unavailable(可回退 helper),仅命中实测策略特征串才 blocked-by-policy(评审 v6-⑦/v7-②)。
 *
 * loadModule 构造器注入:单测用 fake;2c 自研 miniaudio addon 的换底预留点。
 */
import { EnergyVad, FRAME_SAMPLES } from './energyVad';
import { Recorder, RecorderError, RecorderEvents, SAMPLE_RATE } from './recorder';

/** 与 PvRecorder 实例对齐的最小结构类型(fake/自研 addon 都实现它)。 */
export interface AddonRecorderHandle {
  start(): void;
  stop(): void;
  release(): void;
  /** 同步读一帧(FRAME_SAMPLES 采样);缓冲空时阻塞至下一帧到达(实测 ≈32ms)。 */
  readSync(): Int16Array;
  readonly sampleRate: number;
  getSelectedDevice(): string;
}

export interface AddonModule {
  getAvailableDevices(): string[];
  create(frameLength: number): AddonRecorderHandle;
}

export type LoadModule = () => AddonModule;

/** 默认实现:真 PvRecorder。require 时即加载 .node(SAC/损坏在此抛,可捕获)。 */
export const loadPvRecorderModule: LoadModule = () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PvRecorder } = require('@picovoice/pvrecorder-node') as {
    PvRecorder: {
      new (frameLength: number, deviceIndex?: number): AddonRecorderHandle;
      getAvailableDevices(): string[];
    };
  };
  return {
    getAvailableDevices: () => PvRecorder.getAvailableDevices(),
    create: (frameLength) => new PvRecorder(frameLength, -1),
  };
};

const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000; // 32ms
const TICK_MS = 100;               // 节拍周期(与 helper ~100ms 帧节奏对齐)
const OWED_MARGIN = 1;             // 常态补读余量:欠 1 帧不读,保证 read 命中非空缓冲
const SUSPECT_MARGIN = 3;          // 上次 read 阻塞过(缓冲曾见底)→ 多欠几帧再读
const BLOCKED_READ_MS = 20;        // 单次 read 超此耗时 = 缓冲已空(实测空读 ≈32ms)
const MAX_READS_PER_TICK = 32;     // 单 tick 补读上限(~1s 音频),防长挂起后恢复时吸干主线程
const MAX_DRAIN_READS = 64;        // stop 时 drain 上限(~2s),防墙钟欠账异常时死循环
const DATA_WATCHDOG_MS = 1500;     // 与 helper 一致:持续无帧 → device-lost

// —— 特征串(实测回填;命中前默认保守映射,防坏包被静默掩盖,评审 v6-⑦)——
const POLICY_SIGNATURES: string[] = []; // SAC 拦截 .node 时 require 报错特征:待 SAC 机器实测(p2a5 清单 B9)
// 隐私开关实测(2026-07-04):开关关闭 + 设备在场 → 构造抛 PvRecorderStatusRuntimeError
// "PvRecorder failed to initialize."。同类错误在"设备不在场"时也会抛,但该路径已被
// no-device 前置检查拦截(枚举返回 []),故本映射仅在设备在场时命中——与 helper 对
// winmm exit code 3 的映射姿态一致(现代 Windows 上隐私拦截是最常见原因)。
const PERMISSION_SIGNATURES: string[] = ['PvRecorderStatusRuntimeError'];

function matchesAny(err: unknown, signatures: string[]): boolean {
  if (signatures.length === 0) return false;
  const text = `${(err as Error)?.constructor?.name ?? ''} ${(err as Error)?.message ?? ''}`;
  return signatures.some((s) => text.includes(s));
}

export class AddonRecorder implements Recorder {
  /** 采集实现标识(日志/埋点,与 'helper-energy' 对齐)。 */
  public mode = 'addon-energy';

  private handle: AddonRecorderHandle | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private stopping = false;
  /** 每次 start 递增;过期回调不再发任何事件(评审 v7-④ generation 防护)。 */
  private generation = 0;
  private startedAt = 0;
  private framesRead = 0;
  private suspectEmpty = false;

  constructor(
    private readonly log: (line: string) => void,
    private readonly loadModule: LoadModule = loadPvRecorderModule,
  ) {}

  async start(events: RecorderEvents): Promise<void> {
    const gen = ++this.generation;
    this.stopping = false;
    this.framesRead = 0;
    this.suspectEmpty = false;

    // ① 懒加载 native 模块(activate 不碰 native;失败可回退 helper)
    let mod: AddonModule;
    try {
      mod = this.loadModule();
    } catch (err) {
      const blocked = matchesAny(err, POLICY_SIGNATURES);
      throw new RecorderError(
        blocked ? 'blocked-by-policy' : 'module-unavailable',
        blocked
          ? `录音组件(pv_recorder.node)被系统应用控制策略拦截:${String((err as Error)?.message ?? err)}`
          : `native 录音模块加载失败(缺文件/ABI 不匹配/损坏):${String((err as Error)?.message ?? err)}`,
      );
    }

    // ② 设备枚举:空列表 → no-device(换后端也无解,不回退)
    let devices: string[];
    try {
      devices = mod.getAvailableDevices();
    } catch (err) {
      throw this.mapStartError(err);
    }
    if (devices.length === 0) {
      throw new RecorderError('no-device', '未找到麦克风设备');
    }

    // ③ 创建 + 启动采集
    try {
      this.handle = mod.create(FRAME_SAMPLES);
      this.handle.start();
    } catch (err) {
      this.releaseHandle();
      throw this.mapStartError(err);
    }
    this.startedAt = Date.now();
    this.log(`[recorder] addon started: ${this.safeDeviceName()} @${this.handle.sampleRate}Hz`);

    // ④ 节拍补读循环 + 数据水位 watchdog
    const vad = new EnergyVad();
    let speechAnnounced = false;
    const deliver = (pcm: Int16Array): void => {
      // Int16Array → Buffer 视图喂 EnergyVad,与 helper 共用同一 VAD/时间戳语义
      const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2);
      for (const chunk of vad.push(buf)) {
        if (chunk.isSpeech && !speechAnnounced) {
          speechAnnounced = true;
          events.onSpeechStart();
        }
        events.onChunk(chunk);
      }
    };
    this.pendingDeliver = deliver; // stop() 的 drain 尾帧走同一交付通道(同一 VAD 实例,时间戳连续)

    const raiseDeviceLost = (detail: string): void => {
      if (gen !== this.generation || this.stopping) return;
      this.stopping = true;
      this.clearTimers();
      this.releaseHandle();
      const err = new RecorderError('device-lost', `录音设备数据中断(可能被拔出或切换)。${detail}`);
      this.log(`[recorder] ${err.message}`);
      events.onError(err);
    };
    const kickWatchdog = (): void => {
      if (gen !== this.generation || this.stopping) return;
      if (this.watchdog !== undefined) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => raiseDeviceLost('watchdog: 1.5s 无数据'), DATA_WATCHDOG_MS);
    };
    kickWatchdog(); // start 后必须开始来数据

    this.tickTimer = setInterval(() => {
      if (gen !== this.generation || this.stopping || !this.handle) return;
      try {
        const got = this.readOwedFrames(deliver, MAX_READS_PER_TICK, this.suspectEmpty ? SUSPECT_MARGIN : OWED_MARGIN);
        if (got > 0) kickWatchdog();
      } catch (err) {
        // 录音中 read 抛错 = 设备失效 → device-lost(评审 v3-④)。
        // 拔设备实测(2026-07-04,unplug 相):拔出后 ~0.13s 抛 PvRecorderStatusInvalidStateError,
        // 无永久阻塞 → Go;检测延迟 = 下一 tick 补读,~100-200ms,满足 S1 ≤1.6s
        raiseDeviceLost(String((err as Error)?.message ?? err));
      }
    }, TICK_MS);
  }

  /**
   * 按墙钟欠账补读:owed = 设备应产帧数 − 已读帧数。
   * 只在 owed > margin 时读(保证命中非空缓冲);单次 read 耗时超阈值说明缓冲已见底,
   * 立即收手并进入 suspect 模式(欠更多再读),避免下一次 read 阻塞主线程。
   */
  private readOwedFrames(
    deliver: (pcm: Int16Array) => void,
    maxReads: number,
    margin: number,
  ): number {
    let reads = 0;
    while (reads < maxReads) {
      const owed = Math.floor((Date.now() - this.startedAt) / FRAME_MS) - this.framesRead;
      if (owed <= margin) break;
      const t0 = Date.now();
      const pcm = this.handle!.readSync();
      this.framesRead++;
      reads++;
      deliver(pcm);
      if (Date.now() - t0 > BLOCKED_READ_MS) {
        this.suspectEmpty = true; // 缓冲见底:这帧是现等来的,别再连读
        return reads;
      }
    }
    if (reads > 0) this.suspectEmpty = false;
    return reads;
  }

  /**
   * 正常结束:先 drain 缓冲到空、再 stop+release(spike 实测:stop 后缓冲立即不可读,
   * 顺序不能反)。drain 出的尾帧照常经 onChunk 交付(RecordingController flushing 态缓冲)。
   */
  async stop(): Promise<void> {
    if (this.stopping || !this.handle) return;
    this.stopping = true;
    this.clearTimers();
    const handle = this.handle;
    try {
      let reads = 0;
      // 直接续用节拍循环的欠账口径:margin 0 = 读到墙钟欠账清零或缓冲见底
      while (reads < MAX_DRAIN_READS) {
        const owed = Math.floor((Date.now() - this.startedAt) / FRAME_MS) - this.framesRead;
        if (owed <= 0) break;
        const t0 = Date.now();
        const pcm = handle.readSync();
        this.framesRead++;
        reads++;
        // stop 语义下直接交付原始帧:VAD 标记对尾帧无决策意义(flushing 态只缓冲不判停)
        this.pendingDeliver?.(pcm);
        if (Date.now() - t0 > BLOCKED_READ_MS) break; // 缓冲已空,后面没有了
      }
      this.log(`[recorder] addon drained ${reads} tail frame(s) before stop`);
    } catch {
      // drain 中途抛错(设备恰在此刻失效):已读到的尾帧保留,直接进入停止
    }
    this.releaseHandle();
  }

  /**
   * stop() 的尾帧交付通道:start() 时装配(闭包持有 vad/events)。
   * 单独存放是为了 stop 复用同一 VAD 实例的时间戳连续性。
   */
  private pendingDeliver: ((pcm: Int16Array) => void) | undefined;

  /** Reload Window gate:同步收尾,无残留(spike uaf 相已证 release 后滞后调用安全)。 */
  dispose(): void {
    this.generation++;
    this.stopping = true;
    this.pendingDeliver = undefined;
    this.clearTimers();
    this.releaseHandle();
  }

  private clearTimers(): void {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.watchdog !== undefined) {
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private releaseHandle(): void {
    const h = this.handle;
    this.handle = undefined;
    if (!h) return;
    try { h.stop(); } catch { /* 已停/已失效 */ }
    try { h.release(); } catch { /* 已释放 */ }
  }

  private safeDeviceName(): string {
    try {
      return this.handle?.getSelectedDevice() ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** start/init 阶段错误映射:仅命中实测权限特征串才 permission-denied,其余 init-failed(评审 v3-④)。 */
  private mapStartError(err: unknown): RecorderError {
    if (err instanceof RecorderError) return err;
    if (matchesAny(err, PERMISSION_SIGNATURES)) {
      return new RecorderError(
        'permission-denied',
        `打开麦克风失败(请检查 Windows 设置 → 隐私 → 麦克风 → 允许桌面应用访问)。${String((err as Error)?.message ?? err)}`,
      );
    }
    return new RecorderError(
      'init-failed',
      `native 录音初始化失败:${(err as Error)?.constructor?.name ?? ''} ${String((err as Error)?.message ?? err)}`,
    );
  }
}
