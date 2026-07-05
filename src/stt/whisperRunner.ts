/**
 * whisper.cpp 封装 — server / CLI 双形态。纯 Node(无 vscode 依赖),便于独立测试。
 *
 * P2b 改造(路线图 v12 评审约束逐条落地):
 * - typed error 三分(v3-③/v6-⑤):cancelled(永不重试)/ transient(重试一次)/ permanent(不重试)
 * - `transcribe(wav, {signal, language})`(v9-③/⑦/v12-①):取消所有权归调用方(会话级
 *   AbortController 由管线/extension 持有),runner 无实例级单槽取消;language per-call 覆盖
 * - `resolveWhisperMode()`(v10-③/v11-⑤):独立纯函数,只依赖 binaryDir+mode 配置,
 *   不碰模型/不等 server;segmented 准入拒绝挂这里
 * - `prepare()` single-flight(v7-③):共享启动 promise,key = {modelPath, mode, binaryDir}
 *   (v8-④/v9-⑥);启动**不收 session signal**(v10-①)——生命周期只受 dispose/代际失效终止,
 *   调用方对它 race 等待;失败清空允许重试;`this.server` 仅 ready 后赋值(消 v7-③ 未就绪端口)
 * - idle-unload 改 active-use lease(v9-②/v11-②):acquireLease/内部 lease 计数,
 *   计数归零且 server ready 才武装;lease 获取即清计时器(在途请求不被 idle kill)
 * - transient 失效策略(v11-④):连接层错误(reset/refused/进程退出)先失效 server 代际再抛
 *   transient(重试自然重新 prepare);HTTP 5xx 保留 server 直接 transient
 */
import { ChildProcess, spawn } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

export type WhisperMode = 'server' | 'cli';
export type WhisperLanguage = 'zh' | 'en' | 'auto';

export type WhisperErrorKind = 'cancelled' | 'transient' | 'permanent';

export class WhisperError extends Error {
  constructor(
    public readonly kind: WhisperErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'WhisperError';
  }
}

export interface WhisperConfig {
  binaryDir: string;
  modelPath: string;
  language: WhisperLanguage;
  initialPrompt: string;
  mode: WhisperMode | 'auto';
  /** F2.4:空闲卸载(分钟,0=常驻)。仅 server 模式有意义。 */
  idleUnloadMinutes: number;
  log: (line: string) => void;
  onColdStart?: (loading: boolean) => void;
}

export interface TranscribeOptions {
  /** 会话级取消(管线/extension 持有;Esc → abort)。启动中的 server 不被它终止(v10-①)。 */
  signal?: AbortSignal;
  /** 会话语言锁定的 per-call 覆盖(v9-⑦);缺省用 cfg.language。 */
  language?: WhisperLanguage;
}

export interface TranscribeResult {
  text: string;
  /** server verbose_json 的 detected_language(如 "chinese"/"english";CLI 形态无)。P2b 语言锁定用。 */
  detectedLanguage?: string;
  coldStartMs?: number;
  transcribeMs: number;
  mode: WhisperMode;
}

const SERVER_BINARIES = ['whisper-server.exe', 'server.exe'];
const CLI_BINARIES = ['whisper-cli.exe', 'main.exe'];
const SERVER_READY_TIMEOUT_MS = 120_000; // 大模型冷加载可能很慢

export const DEFAULT_INITIAL_PROMPT = '以下是简体中文普通话的句子,使用标点符号。';

async function findBinary(dir: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    const p = join(dir, name);
    try {
      await access(p);
      return p;
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

/**
 * 模式解析(v10-③/v11-⑤):只做配置判断 + findBinary 磁盘检查,毫秒级;
 * 不依赖 modelPath、不经模型下载、不等 server ready。segmented 准入在录音开始前调它。
 */
export async function resolveWhisperMode(
  binaryDir: string,
  mode: WhisperMode | 'auto',
): Promise<WhisperMode> {
  if (mode !== 'auto') return mode;
  return (await findBinary(binaryDir, SERVER_BINARIES)) !== undefined ? 'server' : 'cli';
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** CLI 参数构建 — 导出供单元测试。 */
export function buildCliArgs(cfg: {
  modelPath: string;
  wavPath: string;
  language: string;
  initialPrompt: string;
}): string[] {
  return [
    '-m', cfg.modelPath,
    '-f', cfg.wavPath,
    '-l', cfg.language,
    '--prompt', cfg.initialPrompt,
    '-nt',        // 不输出时间戳
    '-np',        // 不输出进度/系统信息到 stdout
  ];
}

/** server /inference 响应解析(json/verbose_json 双兼容)— 导出供单元测试。 */
export function parseServerResponse(body: string): { text: string; detectedLanguage?: string } {
  const json = JSON.parse(body) as { text?: string; error?: string; detected_language?: string };
  if (json.error !== undefined) throw new Error(`whisper-server: ${json.error}`);
  return { text: (json.text ?? '').trim(), detectedLanguage: json.detected_language };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WhisperError('cancelled', 'cancelled by session');
}

/** 等待 promise,但允许 signal 提前放弃**等待**(底层任务继续跑,v10-① 双信号契约)。 */
async function raceWithSignal<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      p.catch(() => { /* 继续在跑的启动;结果由 single-flight 缓存,失败也有自己的清理 */ });
      reject(new WhisperError('cancelled', 'cancelled while waiting'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

interface ServerHandle {
  port: number;
  coldStartMs?: number;
}

/** 运行时注入(单测 fake spawn/fetch/文件;生产用默认真实实现)。 */
export interface WhisperRuntime {
  spawn: typeof spawn;
  fetch: typeof fetch;
  openWavAsBlob: (path: string) => Promise<Blob>;
}

const DEFAULT_RUNTIME: WhisperRuntime = {
  spawn,
  fetch: (...args) => fetch(...args),
  openWavAsBlob: (p) => openAsBlob(p),
};

export class WhisperRunner {
  private server: { proc: ChildProcess; port: number } | undefined; // 仅 ready 后赋值(v7-③)
  private startingProc: ChildProcess | undefined; // 启动中的进程(dispose 需能杀到)
  private serverReady: { key: string; promise: Promise<ServerHandle> } | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private leases = 0; // active-use lease(v11-②):会话 lease + 在途调用

  constructor(
    private cfg: WhisperConfig,
    private readonly runtime: WhisperRuntime = DEFAULT_RUNTIME,
  ) {}

  private generationKey(): string {
    return `${this.cfg.modelPath}|${this.cfg.mode}|${this.cfg.binaryDir}`;
  }

  updateConfig(cfg: WhisperConfig): void {
    // v9-⑥:server 身份 = {modelPath, mode, binaryDir},任一变更即失效旧代际
    const identityChanged =
      cfg.modelPath !== this.cfg.modelPath ||
      cfg.binaryDir !== this.cfg.binaryDir ||
      cfg.mode !== this.cfg.mode;
    this.cfg = cfg;
    if (identityChanged) this.unloadServer('config generation changed');
  }

  /**
   * 会话 lease(v11-②):获取即清 idle 计时器(会话活跃期间不卸载);
   * 释放时计数归零且 server ready → 立即武装。管线在会话开始获取、drain 完释放。
   */
  acquireLease(): () => void {
    this.leases++;
    this.clearIdleTimer();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases--;
      this.armIdleIfIdle();
    };
  }

  /**
   * 预热(v7-③ single-flight):所有调用共享同一启动 promise;失败清空允许重试;
   * 不收 session signal(v10-①)——只有 dispose / 代际失效能终止启动。
   * 完成时若 lease 计数为 0 → 立即武装 idle(v11-②:Esc 后完成的预热不会永不卸载)。
   */
  prepare(): Promise<ServerHandle> {
    const key = this.generationKey();
    if (this.serverReady?.key === key) return this.serverReady.promise;
    if (this.serverReady) this.unloadServer('superseded generation'); // 旧代际立即失效(v8-④)

    const promise = this.startServer();
    this.serverReady = { key, promise };
    promise.then(
      () => { this.armIdleIfIdle(); },
      () => { if (this.serverReady?.promise === promise) this.serverReady = undefined; },
    );
    return promise;
  }

  async transcribe(wavPath: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    const releaseLease = this.acquireLease(); // 在途请求不被 idle kill(v9-②)
    try {
      throwIfAborted(opts.signal);
      const mode = await resolveWhisperMode(this.cfg.binaryDir, this.cfg.mode);
      return mode === 'server'
        ? await this.transcribeServer(wavPath, opts)
        : await this.transcribeCli(wavPath, opts);
    } finally {
      releaseLease();
    }
  }

  // ---------- server 形态 ----------

  private async startServer(): Promise<ServerHandle> {
    const bin = await findBinary(this.cfg.binaryDir, SERVER_BINARIES);
    if (bin === undefined) {
      throw new WhisperError(
        'permanent',
        `未找到 whisper server 二进制(在 ${this.cfg.binaryDir} 找过 ${SERVER_BINARIES.join(', ')})`,
      );
    }
    const port = await freePort();
    const t0 = Date.now();
    this.cfg.onColdStart?.(true);
    this.cfg.log(`[whisper] spawning server: ${bin} (port ${port})`);
    const proc = this.runtime.spawn(
      bin,
      ['-m', this.cfg.modelPath, '--host', '127.0.0.1', '--port', String(port)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    this.startingProc = proc;
    proc.stderr?.on('data', (d: Buffer) => this.cfg.log(`[whisper-server] ${d.toString().trimEnd()}`));
    proc.on('exit', (code) => {
      this.cfg.log(`[whisper] server exited (code ${code})`);
      if (this.server?.proc === proc) this.server = undefined;
      if (this.startingProc === proc) this.startingProc = undefined;
    });

    try {
      // 健康探测:模型加载完成前连接会被拒
      const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
      for (;;) {
        if (proc.exitCode !== null) {
          throw new WhisperError('transient', `whisper-server 启动即退出(code ${proc.exitCode})`);
        }
        if (Date.now() > deadline) {
          proc.kill();
          throw new WhisperError('transient', 'whisper-server 加载超时');
        }
        try {
          await this.runtime.fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
          break; // 任何 HTTP 响应都说明端口已就绪
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } finally {
      this.cfg.onColdStart?.(false);
    }
    this.server = { proc, port }; // 就绪后才可见(v7-③:并发调用拿不到未就绪端口)
    this.startingProc = undefined;
    const coldStartMs = Date.now() - t0;
    this.cfg.log(`[whisper] server ready, cold start ${coldStartMs}ms`);
    return { port, coldStartMs };
  }

  private async transcribeServer(wavPath: string, opts: TranscribeOptions): Promise<TranscribeResult> {
    // 等待启动可被会话取消;启动本身不被杀(v10-①)
    const { port, coldStartMs } = await raceWithSignal(this.prepare(), opts.signal);
    throwIfAborted(opts.signal);

    const language = opts.language ?? this.cfg.language;
    const form = new FormData();
    form.append('file', await this.runtime.openWavAsBlob(wavPath), 'audio.wav');
    // verbose_json:拿 detected_language(P2b 语言锁定,评审 ⑤ 已实测支持)
    form.append('response_format', 'verbose_json');
    // 关键(2026-07-04 spike 实测修 bug):language 缺省时 server 默认 **en**(即使 detection
    // 给出 chinese p=0.99 也输出英文翻译)——auto 必须**显式**发 'auto' 才是真自动检测
    form.append('language', language);
    form.append('prompt', this.cfg.initialPrompt);

    const t0 = Date.now();
    let res: Response;
    let bodyText: string;
    try {
      res = await this.runtime.fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
        signal: opts.signal,
      });
      bodyText = await res.text();
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new WhisperError('cancelled', 'transcription aborted');
      }
      // 连接层失败(reset/refused/半死 server):先失效当前代际再抛 transient(v11-④),
      // 重试路径自然重新 prepare,不会再打死端口
      this.unloadServer('connection-level failure');
      throw new WhisperError('transient', `whisper-server 连接失败:${String((err as Error)?.message ?? err)}`);
    }
    if (!res.ok) {
      const detail = `whisper-server HTTP ${res.status}: ${bodyText.slice(0, 300)}`;
      if (res.status >= 500) throw new WhisperError('transient', detail); // server 活着,可复用重试(v11-④)
      throw new WhisperError('permanent', detail); // 4xx:请求/配置问题,重试无意义
    }
    let parsed: { text: string; detectedLanguage?: string };
    try {
      parsed = parseServerResponse(bodyText);
    } catch (err) {
      // server 明确报错(无效 WAV/模型错误)→ permanent(v6-⑤)
      throw new WhisperError('permanent', String((err as Error)?.message ?? err));
    }
    const transcribeMs = Date.now() - t0;
    this.cfg.log(`[whisper] server transcribe ${transcribeMs}ms → ${parsed.text.length} chars`);
    return { ...parsed, coldStartMs, transcribeMs, mode: 'server' };
  }

  // ---------- CLI 形态(batch 兜底;segmented 在准入层已拒绝 CLI,v8-⑤)----------

  private async transcribeCli(wavPath: string, opts: TranscribeOptions): Promise<TranscribeResult> {
    const bin = await findBinary(this.cfg.binaryDir, CLI_BINARIES);
    if (bin === undefined) {
      throw new WhisperError(
        'permanent',
        `未找到 whisper CLI 二进制(在 ${this.cfg.binaryDir} 找过 ${CLI_BINARIES.join(', ')})`,
      );
    }
    const args = buildCliArgs({
      modelPath: this.cfg.modelPath,
      wavPath,
      language: opts.language ?? this.cfg.language,
      initialPrompt: this.cfg.initialPrompt,
    });
    const t0 = Date.now();
    const text = await new Promise<string>((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const onAbort = (): void => {
        proc.kill();
        reject(new WhisperError('cancelled', 'transcription aborted'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (err) => reject(new WhisperError('permanent', `whisper-cli 启动失败:${err.message}`)));
      proc.on('close', (code) => {
        opts.signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve(stdout.trim());
        else reject(new WhisperError('permanent', `whisper-cli 退出码 ${code}: ${stderr.slice(-500)}`));
      });
    });
    const transcribeMs = Date.now() - t0; // CLI 形态冷加载计入每次调用
    this.cfg.log(`[whisper] cli transcribe(含冷加载)${transcribeMs}ms → ${text.length} chars`);
    return { text, transcribeMs, mode: 'cli' };
  }

  // ---------- 生命周期 ----------

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** lease 计数归零且 server ready 才武装(v11-②)。 */
  private armIdleIfIdle(): void {
    this.clearIdleTimer();
    if (this.leases > 0 || this.cfg.idleUnloadMinutes <= 0 || !this.server) return;
    this.idleTimer = setTimeout(
      () => this.unloadServer(`idle ${this.cfg.idleUnloadMinutes}min`),
      this.cfg.idleUnloadMinutes * 60_000,
    );
  }

  private unloadServer(reason: string): void {
    if (this.server || this.startingProc || this.serverReady) {
      this.cfg.log(`[whisper] unloading server (${reason})`);
    }
    this.serverReady = undefined; // 失效代际:后续 prepare 重新启动(v8-④/v11-④)
    this.startingProc?.kill(); // 启动中的进程一并终止(健康探测循环随即以"启动即退出"失败)
    this.startingProc = undefined;
    this.server?.proc.kill();
    this.server = undefined;
    this.clearIdleTimer();
  }

  /** Reload Window gate:kill 子进程(含启动中的),无残留。 */
  dispose(): void {
    this.unloadServer('dispose');
  }
}
