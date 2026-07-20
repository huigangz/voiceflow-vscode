/**
 * P2b-2:WhisperRunner prepare/single-flight/代际/lease 单测(fake runtime 注入)——
 * 2b gate 自动项:prepare() single-flight + 代际(dispose 中断预热 / 预热中模型切换拿不到
 * 旧 server / 首段与预热并发不拿未就绪端口,评审 v7-③ + v8-④)/ prepare key 含 binaryDir
 * (评审 v9-⑥)/ idle lease 计数(评审 v9-② + v11-②)/ transient 失效策略(评审 v11-④)/
 * per-call language 覆盖(评审 v9-⑦)/ prepare() 不受 session signal 终止(评审 v10-①)。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  WhisperConfig,
  WhisperError,
  WhisperRunner,
  WhisperRuntime,
  resolveWhisperMode,
} from '../src/stt/whisperRunner';

let serverDir: string; // 含 whisper-server.exe(空文件,findBinary 只查存在)
let cliOnlyDir: string;
let emptyDir: string;

beforeAll(() => {
  serverDir = mkdtempSync(join(tmpdir(), 'vf-srv-'));
  writeFileSync(join(serverDir, 'whisper-server.exe'), '');
  cliOnlyDir = mkdtempSync(join(tmpdir(), 'vf-cli-'));
  writeFileSync(join(cliOnlyDir, 'whisper-cli.exe'), '');
  emptyDir = mkdtempSync(join(tmpdir(), 'vf-empty-'));
});

class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  stderr = { on: () => {} };
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.exitCode = 1;
    this.emit('exit', 1);
    return true;
  }
}

interface FakeWorld {
  runtime: WhisperRuntime;
  procs: FakeProc[];
  spawnArgs: string[][];
  fetchLog: string[];
  /** 健康探测('/')前 N 次拒绝(模拟模型加载中)。 */
  healthFailures: number;
  /** '/inference' 的行为。 */
  inference: (init?: RequestInit) => Promise<Response>;
}

function makeWorld(): FakeWorld {
  const w: FakeWorld = {
    procs: [],
    spawnArgs: [],
    fetchLog: [],
    healthFailures: 0,
    inference: async () =>
      new Response(JSON.stringify({ text: 'hello' }), { status: 200 }),
    runtime: {
      spawn: ((_bin: string, args: string[]) => {
        const p = new FakeProc();
        w.procs.push(p);
        w.spawnArgs.push(args);
        return p as never;
      }) as never,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        w.fetchLog.push(u.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));
        if (u.endsWith('/inference')) return w.inference(init);
        if (w.healthFailures > 0) {
          w.healthFailures--;
          throw new Error('ECONNREFUSED');
        }
        return new Response('ok', { status: 200 });
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
    log: () => {},
    ...overrides,
  };
}

describe('resolveWhisperMode(评审 v10-③/v11-⑤:纯磁盘检查,不碰模型)', () => {
  it('显式 mode 直通;auto 按 server 二进制存在性解析', async () => {
    expect(await resolveWhisperMode(emptyDir, 'server')).toBe('server');
    expect(await resolveWhisperMode(serverDir, 'auto')).toBe('server');
    expect(await resolveWhisperMode(cliOnlyDir, 'auto')).toBe('cli');
    expect(await resolveWhisperMode(emptyDir, 'auto')).toBe('cli');
  });
});

describe('prepare() single-flight 与代际', () => {
  it('并发 prepare 共享同一启动(单 spawn 单健康探测,评审 v7-③)', async () => {
    const w = makeWorld();
    const r = new WhisperRunner(cfg(), w.runtime);
    const [a, b] = await Promise.all([r.prepare(), r.prepare()]);
    expect(w.procs).toHaveLength(1);
    expect(a.port).toBe(b.port);
    r.dispose();
  });

  it('首段与预热并发:transcribe 等同一启动,inference 必在健康探测通过之后(评审 v7-③)', async () => {
    const w = makeWorld();
    w.healthFailures = 2; // 前两次健康探测拒绝(每次间隔 250ms)
    const r = new WhisperRunner(cfg(), w.runtime);
    const [, result] = await Promise.all([r.prepare(), r.transcribe('x.wav')]);
    expect(result.text).toBe('hello');
    expect(w.procs).toHaveLength(1); // 不重复 spawn
    const firstInference = w.fetchLog.indexOf('/inference');
    const lastHealth = w.fetchLog.lastIndexOf('/');
    expect(firstInference).toBeGreaterThan(lastHealth); // 未就绪端口从未被打
    r.dispose();
  }, 10_000);

  it('dispose 中断预热:启动 promise 以 transient 拒绝,进程被杀(评审 v8-④)', async () => {
    const w = makeWorld();
    w.healthFailures = 1000; // 永不就绪
    const r = new WhisperRunner(cfg(), w.runtime);
    const p = r.prepare();
    const rejection = expect(p).rejects.toMatchObject({ kind: 'transient' });
    await new Promise((res) => setTimeout(res, 50));
    r.dispose();
    await rejection;
    expect(w.procs[0]!.killed).toBe(true);
  });

  it('预热中模型切换:旧启动被杀、旧 promise 拒绝,新 prepare 用新模型(评审 v8-④)', async () => {
    const w = makeWorld();
    w.healthFailures = 1000;
    const r = new WhisperRunner(cfg({ modelPath: 'C:/m/A.bin' }), w.runtime);
    const oldP = r.prepare();
    const oldRejection = expect(oldP).rejects.toMatchObject({ kind: 'transient' });
    await new Promise((res) => setTimeout(res, 50));
    w.healthFailures = 0;
    r.updateConfig(cfg({ modelPath: 'C:/m/B.bin' })); // 代际失效
    await oldRejection;
    expect(w.procs[0]!.killed).toBe(true);
    const h = await r.prepare();
    expect(h.port).toBeGreaterThan(0);
    expect(w.spawnArgs[1]).toContain('C:/m/B.bin'); // 绝不把旧模型 server 交给新请求
    r.dispose();
  });

  it('binaryDir 变更同样失效代际(评审 v9-⑥)', async () => {
    const w = makeWorld();
    const r = new WhisperRunner(cfg(), w.runtime);
    await r.prepare();
    const dir2 = mkdtempSync(join(tmpdir(), 'vf-srv2-'));
    writeFileSync(join(dir2, 'whisper-server.exe'), '');
    r.updateConfig(cfg({ binaryDir: dir2 }));
    expect(w.procs[0]!.killed).toBe(true); // 旧 server 已卸载
    await r.prepare();
    expect(w.procs).toHaveLength(2); // 新代际重新启动
    r.dispose();
  });

  it('prepare 不受 session signal 影响:等待方取消后启动继续完成(评审 v10-①)', async () => {
    const w = makeWorld();
    w.healthFailures = 1; // 需要 ~250ms 就绪
    const r = new WhisperRunner(cfg(), w.runtime);
    const session = new AbortController();
    const t = r.transcribe('x.wav', { signal: session.signal });
    session.abort(); // Esc:等待方放弃
    await expect(t).rejects.toMatchObject({ kind: 'cancelled' });
    await r.prepare(); // 底层 single-flight 启动继续完成,同一 spawn
    expect(w.procs).toHaveLength(1);
    r.dispose();
  });
});

describe('idle lease(评审 v9-② + v11-②)', () => {
  it('无 lease:prepare 完成即武装,超时卸载(Esc 后预热完成不会永不卸载)', async () => {
    const w = makeWorld();
    const r = new WhisperRunner(cfg({ idleUnloadMinutes: 0.002 }), w.runtime); // 120ms
    await r.prepare(); // 无任何 lease(会话已 Esc 的场景)
    await new Promise((res) => setTimeout(res, 300));
    expect(w.procs[0]!.killed).toBe(true);
  });

  it('持有会话 lease:到期不卸载;释放后计数归零才武装并卸载', async () => {
    const w = makeWorld();
    const r = new WhisperRunner(cfg({ idleUnloadMinutes: 0.002 }), w.runtime);
    const release = r.acquireLease();
    await r.prepare();
    await new Promise((res) => setTimeout(res, 300));
    expect(w.procs[0]!.killed).toBe(false); // 会话活跃期间不卸载(v9-② 在途保护同机制)
    release();
    await new Promise((res) => setTimeout(res, 300));
    expect(w.procs[0]!.killed).toBe(true);
    r.dispose();
  });
});

describe('transient 失效策略(评审 v11-④)与 per-call 覆盖(评审 v9-⑦)', () => {
  it('连接层失败 → transient 且失效代际(下次重新 spawn);5xx → transient 但复用 server', async () => {
    const w = makeWorld();
    const r = new WhisperRunner(cfg(), w.runtime);
    // 连接层:fetch 直接抛
    w.inference = async () => { throw new TypeError('fetch failed: socket hang up'); };
    await expect(r.transcribe('x.wav')).rejects.toMatchObject({ kind: 'transient' });
    expect(w.procs[0]!.killed).toBe(true); // 代际已失效
    // 恢复 + 5xx:server 保留
    w.inference = async () => new Response('busy', { status: 503 });
    await expect(r.transcribe('x.wav')).rejects.toMatchObject({ kind: 'transient' });
    expect(w.procs).toHaveLength(2);       // 第二次调用重新 spawn 过一次
    expect(w.procs[1]!.killed).toBe(false); // 5xx 不失效代际
    // 4xx → permanent
    w.inference = async () => new Response('bad', { status: 400 });
    await expect(r.transcribe('x.wav')).rejects.toMatchObject({ kind: 'permanent' });
    r.dispose();
  });

  it('per-call language 覆盖进请求,不污染 cfg;auto 也显式发送(评审 v9-⑦ + 缺省=en bug 修复)', async () => {
    const w = makeWorld();
    let seenLanguage: string | undefined | null;
    w.inference = async (init) => {
      const body = init?.body as FormData;
      seenLanguage = body.get('language') as string | null;
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    };
    const r = new WhisperRunner(cfg({ language: 'auto' }), w.runtime);
    await r.transcribe('x.wav', { language: 'zh' });
    expect(seenLanguage).toBe('zh');
    seenLanguage = undefined;
    // 2026-07-04 spike 实测:language 缺省时 server 默认 en(中文被输出成英文翻译)
    // → auto 必须显式发 'auto'
    await r.transcribe('x.wav');
    expect(seenLanguage).toBe('auto');
    r.dispose();
  });

  it('server translate 任务映射为 translate=true,默认转写不发送该字段', async () => {
    const w = makeWorld();
    const seen: Array<unknown | null> = [];
    w.inference = async (init) => {
      seen.push((init?.body as FormData).get('translate'));
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    };
    const r = new WhisperRunner(cfg(), w.runtime);
    await r.transcribe('x.wav');
    await r.transcribe('x.wav', { task: 'translate', translationTarget: 'en' });
    expect(seen).toEqual([null, 'true']);
    r.dispose();
  });

  it('会话 signal 已 aborted → 直接 cancelled,不 spawn(评审 v3-③)', async () => {
    const w = makeWorld();
    const r = new WhisperRunner(cfg(), w.runtime);
    const ac = new AbortController();
    ac.abort();
    await expect(r.transcribe('x.wav', { signal: ac.signal })).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(w.procs).toHaveLength(0);
  });
});
