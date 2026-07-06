/**
 * inproc-s2:spawn 错误三分 + 策略拦截判据单测(plan v7 §3.1,s1-d B' 形态定案)。
 *
 * 判据(worklog inproc-s1):
 * ① spawn error UNKNOWN/EPERM → EngineBlockedError(SAC 形态副判据);其余 → permanent
 * ② 静默无输出(主判据):零 stderr + 退出任意码(含 0)+ 非自杀 → EngineBlockedError;
 *    零 stderr + watchdog 到点(弹框挂起)→ kill + EngineBlockedError
 * ③ 有 stderr / 非零码真实崩溃 → 维持 transient(不误判)
 * ④ 自杀(dispose/代际 kill,proc.killed)→ 维持 transient(既有行为零回归)
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineBlockedError } from '../src/stt/engine';
import { WhisperConfig, WhisperRunner, WhisperRuntime } from '../src/stt/whisperRunner';

let serverDir: string;
let cliOnlyDir: string;

beforeAll(() => {
  serverDir = mkdtempSync(join(tmpdir(), 'vf-blk-srv-'));
  writeFileSync(join(serverDir, 'whisper-server.exe'), '');
  cliOnlyDir = mkdtempSync(join(tmpdir(), 'vf-blk-cli-'));
  writeFileSync(join(cliOnlyDir, 'whisper-cli.exe'), '');
});

/** stdout/stderr 均可发事件的 FakeProc(server 只用 stderr;CLI 两者都用)。 */
class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.exitCode = 1;
    this.emit('exit', 1);
    return true;
  }
  /** 模拟外部退出(非自杀):设 exitCode 后发 exit/close。 */
  exitExternally(code: number): void {
    this.exitCode = code;
    this.emit('exit', code);
    this.emit('close', code);
  }
}

interface World {
  runtime: WhisperRuntime;
  procs: FakeProc[];
  /** spawn 后下一 tick 自动执行(模拟 error/exit 时序)。 */
  onSpawn?: (p: FakeProc) => void;
}

function makeWorld(): World {
  const w: World = {
    procs: [],
    runtime: {
      spawn: (() => {
        const p = new FakeProc();
        w.procs.push(p);
        if (w.onSpawn) setImmediate(() => w.onSpawn!(p));
        return p as never;
      }) as never,
      fetch: (async () => {
        throw new Error('ECONNREFUSED'); // 健康探测永不就绪(blocked 场景 server 不会起)
      }) as never,
      openWavAsBlob: async () => new Blob(['fake-wav']),
    },
  };
  return w;
}

function cfg(overrides: Partial<WhisperConfig> = {}): WhisperConfig {
  return {
    binaryDir: serverDir,
    modelPath: 'C:/m/ggml-small.bin',
    language: 'auto',
    initialPrompt: 'p',
    mode: 'server',
    idleUnloadMinutes: 0,
    silentBlockTimeoutMs: 400, // 测试注入:watchdog 缩到 400ms
    log: () => {},
    ...overrides,
  };
}

const errnoErr = (code: string): NodeJS.ErrnoException => {
  const e = new Error(`spawn ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
};

describe('判据 ①:spawn error 三分(SAC 形态)', () => {
  it('UNKNOWN → EngineBlockedError;single-flight promise settle 不悬挂', async () => {
    const w = makeWorld();
    w.onSpawn = (p) => p.emit('error', errnoErr('UNKNOWN'));
    const r = new WhisperRunner(cfg(), w.runtime);
    await expect(r.prepare()).rejects.toBeInstanceOf(EngineBlockedError);
    void r.dispose();
  });

  it('EPERM → EngineBlockedError', async () => {
    const w = makeWorld();
    w.onSpawn = (p) => p.emit('error', errnoErr('EPERM'));
    const r = new WhisperRunner(cfg(), w.runtime);
    await expect(r.prepare()).rejects.toBeInstanceOf(EngineBlockedError);
    void r.dispose();
  });

  it('其余 errno(ENOENT 等)→ permanent,不归 policy', async () => {
    const w = makeWorld();
    w.onSpawn = (p) => p.emit('error', errnoErr('ENOENT'));
    const r = new WhisperRunner(cfg(), w.runtime);
    await expect(r.prepare()).rejects.toMatchObject({ kind: 'permanent' });
    void r.dispose();
  });
});

describe('判据 ②:静默无输出(s1-d B' + " 主判据,公司机实测形态)", () => {
  it('B\':CreateProcess 成功 → 零 stderr → exit code 0 → EngineBlockedError', async () => {
    const w = makeWorld();
    w.onSpawn = (p) => p.exitExternally(0); // 公司机实测:点掉弹框后 code 0 退出
    const r = new WhisperRunner(cfg(), w.runtime);
    await expect(r.prepare()).rejects.toBeInstanceOf(EngineBlockedError);
    void r.dispose();
  });

  it('弹框挂起:零 stderr 不退出 → watchdog 到点 kill + EngineBlockedError', async () => {
    const w = makeWorld(); // 健康探测永不就绪,进程不退出,无 stderr
    const r = new WhisperRunner(cfg(), w.runtime);
    await expect(r.prepare()).rejects.toBeInstanceOf(EngineBlockedError);
    expect(w.procs[0]!.killed).toBe(true); // watchdog 主动收尾
    void r.dispose();
  }, 5_000);
});

describe('判据 ③/④:不误判', () => {
  it('真实崩溃(有 stderr + 非零码)→ 维持 transient', async () => {
    const w = makeWorld();
    w.onSpawn = (p) => {
      p.stderr.emit('data', Buffer.from('failed to open model')); // 正常/崩溃进程必有输出
      p.exitExternally(3);
    };
    const r = new WhisperRunner(cfg(), w.runtime);
    await expect(r.prepare()).rejects.toMatchObject({ kind: 'transient' });
    void r.dispose();
  });

  it('有 stderr 的 exit 0 同样不归 policy(维持 transient)', async () => {
    const w = makeWorld();
    w.onSpawn = (p) => {
      p.stderr.emit('data', Buffer.from('loading model...'));
      p.exitExternally(0);
    };
    const r = new WhisperRunner(cfg(), w.runtime);
    await expect(r.prepare()).rejects.toMatchObject({ kind: 'transient' });
    void r.dispose();
  });

  it('自杀(dispose kill,killed=true)→ 维持 transient(零回归,既有 Esc/代际路径)', async () => {
    const w = makeWorld();
    const r = new WhisperRunner(cfg({ silentBlockTimeoutMs: 60_000 }), w.runtime);
    const p = r.prepare();
    const rejection = expect(p).rejects.toMatchObject({ kind: 'transient' });
    await new Promise((res) => setTimeout(res, 50));
    void r.dispose(); // kill → exitCode 1 + killed=true + 零 stderr → 不得判 blocked
    await rejection;
  });
});

describe('判据 ①-CLI:spawn error 同款映射(v4-⑤)', () => {
  it('CLI UNKNOWN → EngineBlockedError;ENOENT → permanent', async () => {
    const w = makeWorld();
    w.onSpawn = (p) => p.emit('error', errnoErr('UNKNOWN'));
    const r = new WhisperRunner(cfg({ binaryDir: cliOnlyDir, mode: 'cli' }), w.runtime);
    await expect(r.transcribe('x.wav')).rejects.toBeInstanceOf(EngineBlockedError);

    w.onSpawn = (p) => p.emit('error', errnoErr('ENOENT'));
    await expect(r.transcribe('x.wav')).rejects.toMatchObject({ kind: 'permanent' });
    void r.dispose();
  });

  it('CLI 正常路径不受影响(stdout 正常解析)', async () => {
    const w = makeWorld();
    w.onSpawn = (p) => {
      p.stdout.emit('data', Buffer.from('你好世界'));
      p.exitExternally(0);
    };
    const r = new WhisperRunner(cfg({ binaryDir: cliOnlyDir, mode: 'cli' }), w.runtime);
    const result = await r.transcribe('x.wav');
    expect(result.text).toBe('你好世界');
    expect(result.mode).toBe('cli');
    void r.dispose();
  });
});
