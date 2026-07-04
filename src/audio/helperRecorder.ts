/**
 * 方案 B:native helper exe 录音(spec D7 备用路线)。
 * S1 结论(2026-07-03):VS Code webview 的 permissions-policy 禁止 getUserMedia
 * (upstream microsoft/vscode#250568,Backlog),Webview 路线 No-Go → 本实现转正。
 *
 * helper 协议见 helper/MicCapture.cs:
 *   stdout=s16le PCM 流;stderr READY/ERROR 行;stdin EOF=停止;
 *   退出码 0 正常 / 2 无设备 / 3 打开失败 / 4 设备错误。
 */
import { ChildProcess, spawn } from 'node:child_process';
import { EnergyVad } from './energyVad';
import { Recorder, RecorderError, RecorderErrorCode, RecorderEvents } from './recorder';

const READY_TIMEOUT_MS = 5000;
const STOP_GRACE_MS = 2000;
// 数据流水位:helper 每 ~100ms 发一帧(即使静音)。READY 后持续无数据 =
// 设备被拔出/切换后 winmm 静默挂起(经典行为:不报错、不退出)→ 判定 device-lost。
const DATA_WATCHDOG_MS = 1500;

function mapExitCode(code: number | null, stderrTail: string): RecorderError {
  if (code === 2) return new RecorderError('no-device', '未找到麦克风设备');
  if (code === 3) {
    // winmm 无法区分"隐私设置拒绝"与其他打开失败;现代 Windows 上前者最常见
    return new RecorderError(
      'permission-denied',
      `打开麦克风失败(请检查 Windows 设置 → 隐私 → 麦克风 → 允许桌面应用访问)。${stderrTail}`,
    );
  }
  return new RecorderError('device-lost', `录音进程异常退出(code ${code})。${stderrTail}`);
}

export class HelperRecorder implements Recorder {
  /** 采集实现标识(供日志/S1 评估,与 WebviewRecorder.mode 对齐)。 */
  public mode = 'helper-energy';
  private proc: ChildProcess | undefined;
  private stopping = false;
  private watchdog: NodeJS.Timeout | undefined;

  constructor(
    private readonly exePath: string,
    private readonly log: (line: string) => void,
  ) {}

  async start(events: RecorderEvents): Promise<void> {
    const vad = new EnergyVad();
    let speechAnnounced = false;
    let stderrTail = '';
    let ready = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn();
        }
      };
      const timer = setTimeout(
        () => settle(() => reject(new RecorderError('init-failed', `helper 未在 ${READY_TIMEOUT_MS}ms 内就绪`))),
        READY_TIMEOUT_MS,
      );

      // 录音中数据断流 → device-lost(winmm 静默挂起兜底,不依赖 helper 报错)
      const raiseDeviceLost = () => {
        if (this.stopping) return;
        this.clearWatchdog();
        const err = new RecorderError('device-lost', '录音设备数据中断(可能被拔出或切换)');
        this.log(`[recorder] ${err.message} — watchdog`);
        this.stopping = true;
        this.proc?.kill();
        events.onError(err);
      };
      const kickWatchdog = () => {
        if (this.stopping) return;
        this.clearWatchdog();
        this.watchdog = setTimeout(raiseDeviceLost, DATA_WATCHDOG_MS);
      };

      let proc: ChildProcess;
      try {
        proc = spawn(this.exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        settle(() => reject(new RecorderError('init-failed', `helper 启动失败:${String(err)}`)));
        return;
      }
      this.proc = proc;

      proc.on('error', (err: NodeJS.ErrnoException) => {
        // Windows Smart App Control / 应用控制策略拦截未签名 exe → spawn 报 UNKNOWN(errno -4094)
        // 或 EPERM。归 blocked-by-policy 以给出针对性指引;其余(ENOENT 等)= 安装损坏 → init-failed。
        const blocked = err.code === 'UNKNOWN' || err.code === 'EPERM';
        const code: RecorderErrorCode = blocked ? 'blocked-by-policy' : 'init-failed';
        const rerr = new RecorderError(
          code,
          blocked
            ? `录音组件被系统应用控制策略(Smart App Control)拦截:${this.exePath}`
            : `helper 启动失败:${err.message}(路径 ${this.exePath})`,
        );
        this.clearWatchdog();
        settle(() => reject(rerr));
        if (settled) events.onError(rerr);
      });

      proc.stderr!.setEncoding('utf8').on('data', (d: string) => {
        stderrTail = (stderrTail + d).slice(-500);
        for (const line of d.split(/\r?\n/)) {
          if (line.startsWith('READY')) {
            ready = true;
            this.log(`[recorder] helper ready: ${line.trim()}`);
            kickWatchdog(); // READY 后必须开始来数据,否则判 device-lost
            settle(resolve);
          } else if (line.trim().length > 0) {
            this.log(`[helper] ${line.trim()}`);
          }
        }
      });

      // 注意:不按 stopping 丢帧 —— stop() 后 helper 仍会冲刷尾部缓冲(用户最后的词),
      // 数据流以进程 close 为自然终点
      proc.stdout!.on('data', (data: Buffer) => {
        if (ready) kickWatchdog(); // 每帧刷新水位;断流 1.5s → device-lost
        for (const chunk of vad.push(data)) {
          if (chunk.isSpeech && !speechAnnounced) {
            speechAnnounced = true;
            events.onSpeechStart();
          }
          events.onChunk(chunk);
        }
      });

      proc.on('close', (code) => {
        if (this.proc === proc) this.proc = undefined;
        this.clearWatchdog();
        if (this.stopping) return; // 正常停止 / watchdog 已处理
        const err = mapExitCode(code, stderrTail.trim());
        this.log(`[recorder] helper exited unexpectedly: ${err.code} — ${err.message}`);
        settle(() => reject(err));
        if (settled) events.onError(err); // 录音中途设备失败 → 上层丢弃数据回 idle(S1 gate)
      });
    });
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) {
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
    }
  }

  /** 正常结束:stdin EOF → helper 冲刷尾部缓冲后退出;超时兜底 kill。 */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    this.clearWatchdog();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, STOP_GRACE_MS);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.stdin!.end();
    });
    this.proc = undefined;
  }

  /** Reload Window gate:kill 子进程,无残留。 */
  dispose(): void {
    this.stopping = true;
    this.clearWatchdog();
    this.proc?.kill();
    this.proc = undefined;
  }
}
