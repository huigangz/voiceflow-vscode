/**
 * whisper.cpp 封装(S2 spike)— server / CLI 双形态,P1 收敛前两者都保留。
 * 纯 Node(无 vscode 依赖),便于独立测试与形态对比计时。
 *
 * - server 模式:long-running whisper-server.exe,HTTP /inference;
 *   cold start = spawn + 模型加载(健康探测通过);warm = 单次 POST 耗时。
 *   空闲 idleUnload 分钟后 kill(F2.4;unload → reload 由懒启动天然覆盖)。
 * - CLI 模式:每次 spawn whisper-cli.exe,冷加载计入每次调用(P1 注:对
 *   turbo 1.6GB 大概率不可接受,对 small/量化档位可能可行)。
 */
import { ChildProcess, spawn } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

export type WhisperMode = 'server' | 'cli';

export interface WhisperConfig {
  /** whisper.cpp 二进制目录(含 whisper-server.exe / whisper-cli.exe)。 */
  binaryDir: string;
  modelPath: string;
  language: 'zh' | 'en' | 'auto';
  /** F2.3:简体带标点引导。 */
  initialPrompt: string;
  mode: WhisperMode | 'auto';
  /** F2.4:空闲卸载(分钟,0=常驻)。仅 server 模式有意义。 */
  idleUnloadMinutes: number;
  log: (line: string) => void;
  /** F2.1:模型冷加载开始/结束(UI 呈现"模型加载中",不计入延迟指标)。 */
  onColdStart?: (loading: boolean) => void;
}

export interface TranscribeResult {
  text: string;
  /** 模型加载耗时(仅本次触发了冷启动时有值;不计入端到端延迟指标,§8.1)。 */
  coldStartMs?: number;
  /** warm 转写耗时。 */
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

/** server /inference 响应解析 — 导出供单元测试。 */
export function parseServerResponse(body: string): string {
  const json = JSON.parse(body) as { text?: string; error?: string };
  if (json.error !== undefined) throw new Error(`whisper-server: ${json.error}`);
  return (json.text ?? '').trim();
}

export class WhisperRunner {
  private server: { proc: ChildProcess; port: number } | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private current: AbortController | undefined;

  constructor(private cfg: WhisperConfig) {}

  updateConfig(cfg: WhisperConfig): void {
    const modelChanged = cfg.modelPath !== this.cfg.modelPath;
    this.cfg = cfg;
    if (modelChanged) this.unloadServer('model changed');
  }

  /** Esc 取消当前转写(kill CLI / abort HTTP;server 进程保留)。 */
  cancel(): void {
    this.current?.abort();
  }

  async transcribe(wavPath: string): Promise<TranscribeResult> {
    this.current = new AbortController();
    const signal = this.current.signal;
    try {
      let mode = this.cfg.mode;
      if (mode === 'auto') {
        // auto:找得到 server 二进制则 server,否则 CLI
        mode = (await findBinary(this.cfg.binaryDir, SERVER_BINARIES)) !== undefined ? 'server' : 'cli';
      }
      return mode === 'server'
        ? await this.transcribeServer(wavPath, signal)
        : await this.transcribeCli(wavPath, signal);
    } finally {
      this.current = undefined;
      this.armIdleUnload();
    }
  }

  // ---------- server 形态 ----------
  private async ensureServer(): Promise<{ port: number; coldStartMs?: number }> {
    if (this.server && this.server.proc.exitCode === null) {
      return { port: this.server.port };
    }
    const bin = await findBinary(this.cfg.binaryDir, SERVER_BINARIES);
    if (bin === undefined) {
      throw new Error(
        `未找到 whisper server 二进制(在 ${this.cfg.binaryDir} 找过 ${SERVER_BINARIES.join(', ')})`,
      );
    }
    const port = await freePort();
    const t0 = Date.now();
    this.cfg.onColdStart?.(true);
    this.cfg.log(`[whisper] spawning server: ${bin} (port ${port})`);
    const proc = spawn(bin, ['-m', this.cfg.modelPath, '--host', '127.0.0.1', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.stderr?.on('data', (d: Buffer) => this.cfg.log(`[whisper-server] ${d.toString().trimEnd()}`));
    proc.on('exit', (code) => {
      this.cfg.log(`[whisper] server exited (code ${code})`);
      if (this.server?.proc === proc) this.server = undefined;
    });
    this.server = { proc, port };

    try {
      // 健康探测:模型加载完成前连接会被拒
      const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
      for (;;) {
        if (proc.exitCode !== null) throw new Error(`whisper-server 启动即退出(code ${proc.exitCode})`);
        if (Date.now() > deadline) {
          this.unloadServer('ready timeout');
          throw new Error('whisper-server 加载超时');
        }
        try {
          await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
          break; // 任何 HTTP 响应都说明端口已就绪
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } finally {
      this.cfg.onColdStart?.(false);
    }
    const coldStartMs = Date.now() - t0;
    this.cfg.log(`[whisper] server ready, cold start ${coldStartMs}ms`);
    return { port, coldStartMs };
  }

  private async transcribeServer(wavPath: string, signal: AbortSignal): Promise<TranscribeResult> {
    const { port, coldStartMs } = await this.ensureServer();
    const form = new FormData();
    form.append('file', await openAsBlob(wavPath), 'audio.wav');
    form.append('response_format', 'json');
    if (this.cfg.language !== 'auto') form.append('language', this.cfg.language);
    form.append('prompt', this.cfg.initialPrompt);

    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/inference`, {
      method: 'POST',
      body: form,
      signal,
    });
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    const text = parseServerResponse(bodyText);
    const transcribeMs = Date.now() - t0;
    this.cfg.log(`[whisper] server transcribe ${transcribeMs}ms → ${text.length} chars`);
    return { text, coldStartMs, transcribeMs, mode: 'server' };
  }

  // ---------- CLI 形态 ----------
  private async transcribeCli(wavPath: string, signal: AbortSignal): Promise<TranscribeResult> {
    const bin = await findBinary(this.cfg.binaryDir, CLI_BINARIES);
    if (bin === undefined) {
      throw new Error(
        `未找到 whisper CLI 二进制(在 ${this.cfg.binaryDir} 找过 ${CLI_BINARIES.join(', ')})`,
      );
    }
    const args = buildCliArgs({
      modelPath: this.cfg.modelPath,
      wavPath,
      language: this.cfg.language,
      initialPrompt: this.cfg.initialPrompt,
    });
    const t0 = Date.now();
    const text = await new Promise<string>((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const onAbort = () => {
        proc.kill();
        reject(new Error('cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', reject);
      proc.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`whisper-cli 退出码 ${code}: ${stderr.slice(-500)}`));
      });
    });
    const transcribeMs = Date.now() - t0; // CLI 形态冷加载计入每次调用(P1 对比数据点)
    this.cfg.log(`[whisper] cli transcribe(含冷加载)${transcribeMs}ms → ${text.length} chars`);
    return { text, transcribeMs, mode: 'cli' };
  }

  // ---------- 生命周期 ----------
  private armIdleUnload(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (this.cfg.idleUnloadMinutes <= 0 || !this.server) return;
    this.idleTimer = setTimeout(
      () => this.unloadServer(`idle ${this.cfg.idleUnloadMinutes}min`),
      this.cfg.idleUnloadMinutes * 60_000,
    );
  }

  private unloadServer(reason: string): void {
    if (this.server) {
      this.cfg.log(`[whisper] unloading server (${reason})`);
      this.server.proc.kill();
      this.server = undefined;
    }
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Reload Window gate:kill 子进程,无残留。 */
  dispose(): void {
    this.cancel();
    this.unloadServer('dispose');
  }
}
