/**
 * inproc-s4:EngineManager 回退链单测(plan v7 §3.1,v4-③/④ v5-②/③/④ v6-① v7-①)。
 * fake 引擎/fake ensure,覆盖:blocked→就绪切换+同 wav 重试一次、需下载分支当次失败+
 * 后台 ensure(single-flight/.catch/状态机/代际 key)、逻辑 lease 迁移不泄漏、
 * 显式模式映射 permanent、记忆持久化与 bin 变更失效、显式 inprocess 前台 ensure。
 */
import { describe, expect, it } from 'vitest';
import { EngineBlockedError, WhisperEngine } from '../src/stt/engine';
import { BlockedMemory, EngineManager, EngineManagerDeps, resolveEngineMode } from '../src/stt/engineManager';
import { InprocessPaths, InprocessTier } from '../src/stt/onnxModels';
import { TranscribeResult, WhisperConfig } from '../src/stt/whisperRunner';

class FakeEngine implements WhisperEngine {
  transcribes: string[] = [];
  prepares = 0;
  activeLeases = 0;
  totalLeases = 0;
  disposed = 0;
  configs: WhisperConfig[] = [];
  /** 行为:'ok' | 'blocked' | 'blocked-once'(第一次 blocked,之后 ok)。 */
  constructor(public behavior: 'ok' | 'blocked' | 'blocked-once' = 'ok', public name = 'engine') {}

  private maybeThrow(): void {
    if (this.behavior === 'blocked' || this.behavior === 'blocked-once') {
      if (this.behavior === 'blocked-once') this.behavior = 'ok';
      throw new EngineBlockedError(`${this.name} blocked by policy`);
    }
  }
  async prepare(): Promise<{ coldStartMs?: number }> {
    this.prepares++;
    this.maybeThrow();
    return { coldStartMs: 1 };
  }
  async transcribe(wavPath: string): Promise<TranscribeResult> {
    this.maybeThrow();
    this.transcribes.push(wavPath);
    return { text: `${this.name}:${wavPath}`, transcribeMs: 1, mode: 'server' };
  }
  async updateConfig(cfg: WhisperConfig): Promise<void> {
    this.configs.push(cfg);
  }
  acquireLease(): () => void {
    this.activeLeases++;
    this.totalLeases++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeLeases--;
      }
    };
  }
  async dispose(): Promise<void> {
    this.disposed++;
  }
}

function memoryStore(): BlockedMemory & { record: { binaryDir: string; binStamp: string } | undefined } {
  const m = {
    record: undefined as { binaryDir: string; binStamp: string } | undefined,
    get: () => m.record,
    set: (r: { binaryDir: string; binStamp: string }) => { m.record = r; },
    clear: () => { m.record = undefined; },
  };
  return m;
}

interface World {
  runner: FakeEngine;
  inproc: FakeEngine;
  deps: EngineManagerDeps;
  memory: ReturnType<typeof memoryStore>;
  ready: boolean;
  ensureCalls: InprocessTier[];
  ensureResult: () => Promise<InprocessPaths>;
  notified: number;
  tier: InprocessTier;
  binStamp: string | undefined;
}

const PATHS: InprocessPaths = { localModelPath: 'X:/models/onnx', modelId: 'o/m', dir: 'X:/models/onnx/o/m' };

function makeWorld(runnerBehavior: 'ok' | 'blocked' | 'blocked-once' = 'ok'): World {
  const w: World = {
    runner: new FakeEngine(runnerBehavior, 'server'),
    inproc: new FakeEngine('ok', 'inproc'),
    memory: memoryStore(),
    ready: true,
    ensureCalls: [],
    ensureResult: async () => PATHS,
    notified: 0,
    tier: 'small-q8',
    binStamp: 'stamp-1',
    deps: undefined as never,
  };
  w.deps = {
    runner: w.runner,
    createInprocess: (cfg) => {
      void w.inproc.updateConfig(cfg);
      return w.inproc;
    },
    ensureInprocessModel: (t) => {
      w.ensureCalls.push(t);
      return w.ensureResult();
    },
    isInprocessReady: async () => (w.ready ? PATHS : undefined),
    serverBinStamp: async () => w.binStamp,
    memory: w.memory,
    notifyFallback: () => { w.notified++; },
    inprocessTier: () => w.tier,
    log: () => {},
  };
  return w;
}

function cfg(overrides: Partial<WhisperConfig> = {}): WhisperConfig {
  return {
    binaryDir: 'X:/bin',
    modelPath: 'X:/m.bin',
    language: 'auto',
    initialPrompt: '',
    mode: 'auto',
    idleUnloadMinutes: 0,
    inprocess: { localModelPath: '', modelId: '', maxResidentMinutes: 30 },
    log: () => {},
    ...overrides,
  };
}

describe('回退协议:blocked → 就绪切换 + 同 wav 重试一次(v4-③)', () => {
  it('pipeline 视角一次成功;记忆写入;一次性提示;旧 runner dispose 被 await', async () => {
    const w = makeWorld('blocked');
    const m = new EngineManager(cfg(), w.deps);
    const r = await m.transcribe('seg0.wav');
    expect(r.text).toBe('inproc:seg0.wav'); // 同一 wav 在 inprocess 上重试成功
    expect(w.inproc.transcribes).toEqual(['seg0.wav']);
    expect(w.memory.record).toEqual({ binaryDir: 'X:/bin', binStamp: 'stamp-1' });
    expect(w.notified).toBe(1);
    expect(w.runner.disposed).toBe(1);
    // 后续调用直接走 inprocess(运行期记忆),不再碰 runner
    await m.transcribe('seg1.wav');
    expect(w.inproc.transcribes).toEqual(['seg0.wav', 'seg1.wav']);
    expect(w.notified).toBe(1); // 提示只一次
    await m.dispose();
  });

  it('prepare 抛 blocked 同样回退(segmented warmup 路径)', async () => {
    const w = makeWorld('blocked');
    const m = new EngineManager(cfg(), w.deps);
    const h = await m.prepare();
    expect(h.coldStartMs).toBe(1);
    expect(w.inproc.prepares).toBe(1);
    await m.dispose();
  });
});

describe('需下载分支(v5-②)与 ensure 所有权(v6-①/v7-①)', () => {
  it('当次 permanent 失败(明确文案)+ 后台 ensure 发起;完成后下次会话直接 inprocess', async () => {
    const w = makeWorld('blocked');
    w.ready = false;
    const m = new EngineManager(cfg(), w.deps);
    await expect(m.transcribe('seg0.wav')).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('策略拦截'),
    });
    expect(w.ensureCalls).toEqual(['small-q8']);
    await new Promise((r) => setTimeout(r, 10));
    w.ready = true; // ensure 完成(fake 里由 ready 表达)
    const r = await m.transcribe('seg1.wav'); // blockedThisRun → inprocess
    expect(r.text).toBe('inproc:seg1.wav');
    await m.dispose();
  });

  it('ensure 失败:无未处理 rejection,failed 后下次触发点重试(状态机)', async () => {
    const w = makeWorld('blocked');
    w.ready = false;
    w.ensureResult = async () => { throw new Error('download failed'); };
    const m = new EngineManager(cfg(), w.deps);
    await expect(m.transcribe('a.wav')).rejects.toMatchObject({ kind: 'permanent' });
    await new Promise((r) => setTimeout(r, 10)); // ensure 失败在此 settle —— 不得炸
    expect(w.ensureCalls).toHaveLength(1);
    // 下次触发(仍 blocked 记忆 → resolveMode=inprocess → activateInprocess → 前台 ensure 重试)
    w.ensureResult = async () => PATHS;
    await expect(m.transcribe('b.wav')).resolves.toMatchObject({ text: 'inproc:b.wav' });
    expect(w.ensureCalls).toHaveLength(2); // failed → 重试,非共享旧失败
    await m.dispose();
  });

  it('ensure 代际 key(v7-①):下载中切档位 → 新 flight 不共享旧在途,旧完成不污染新代际', async () => {
    const w = makeWorld('blocked');
    w.ready = false;
    let resolveOld!: (p: InprocessPaths) => void;
    const oldEnsure = new Promise<InprocessPaths>((res) => { resolveOld = res; });
    w.ensureResult = () => oldEnsure;
    const m = new EngineManager(cfg(), w.deps);
    await expect(m.transcribe('a.wav')).rejects.toMatchObject({ kind: 'permanent' }); // 旧档 ensure 在途
    expect(w.ensureCalls).toEqual(['small-q8']);

    // 下载中用户切档位:新触发点必须发起新 ensure(key 不同,不共享旧在途)
    w.tier = 'base-q8' as InprocessTier;
    let rejectNew!: (e: Error) => void;
    w.ensureResult = () => new Promise((_res, rej) => { rejectNew = rej; });
    const second = m.transcribe('b.wav'); // blockedThisRun → inprocess → 前台 ensure(新档)
    await new Promise((r) => setTimeout(r, 10));
    expect(w.ensureCalls).toEqual(['small-q8', 'base-q8']);

    resolveOld(PATHS); // 旧档此刻完成 —— 不得让新档误判 ready
    await new Promise((r) => setTimeout(r, 10));
    rejectNew(new Error('new tier still downloading failed'));
    await expect(second).rejects.toMatchObject({ kind: 'permanent' }); // 新代际以自己的结果为准
    await m.dispose();
  });

  it('preparing 期间重复触发共享同一 promise(single-flight)', async () => {
    const w = makeWorld();
    w.ready = false;
    let resolveEnsure!: (p: InprocessPaths) => void;
    w.ensureResult = () => new Promise((res) => { resolveEnsure = res; });
    const m = new EngineManager(cfg({ mode: 'inprocess' }), w.deps);
    const a = m.transcribe('a.wav');
    await new Promise((r) => setTimeout(r, 10));
    const b = m.transcribe('b.wav');
    await new Promise((r) => setTimeout(r, 10));
    expect(w.ensureCalls).toHaveLength(1); // 共享在途,不重复发起
    resolveEnsure(PATHS);
    w.ready = true;
    await a;
    await b;
    await m.dispose();
  });
});

describe('逻辑 lease(v5-③)', () => {
  it('切换时旧 backend 全释放、新 backend 补获取;调用方 release 无泄漏', async () => {
    const w = makeWorld('blocked');
    const m = new EngineManager(cfg(), w.deps);
    const r1 = m.acquireLease();
    const r2 = m.acquireLease();
    expect(w.runner.activeLeases).toBe(2);
    await m.transcribe('seg0.wav'); // 触发回退切换
    expect(w.runner.activeLeases).toBe(0); // 旧 backend 全释放
    expect(w.inproc.activeLeases).toBe(2); // 新 backend 按存活逻辑 lease 数补获取
    r1();
    r2();
    r2(); // 幂等
    expect(w.inproc.activeLeases).toBe(0); // 无泄漏
    await m.dispose();
  });
});

describe('显式模式(v5-④/v5-①)', () => {
  it('显式 server:blocked 不回退,对外映射 permanent 带指引;不写记忆不提示', async () => {
    const w = makeWorld('blocked');
    const m = new EngineManager(cfg({ mode: 'server' }), w.deps);
    await expect(m.transcribe('a.wav')).rejects.toMatchObject({
      kind: 'permanent',
      message: expect.stringContaining('inprocess'),
    });
    expect(w.memory.record).toBeUndefined();
    expect(w.notified).toBe(0);
    expect(w.inproc.transcribes).toEqual([]);
    await m.dispose();
  });

  it('显式 inprocess:不预检 server;未就绪先前台 ensure,失败才 permanent', async () => {
    const w = makeWorld();
    w.ready = false;
    w.ensureResult = async () => { throw new Error('no network'); };
    const m = new EngineManager(cfg({ mode: 'inprocess' }), w.deps);
    await expect(m.transcribe('a.wav')).rejects.toMatchObject({ kind: 'permanent' });
    expect(w.runner.transcribes).toEqual([]); // server 从未被碰(v5-①)

    w.ensureResult = async () => PATHS;
    const r = await m.transcribe('b.wav');
    expect(r.text).toBe('inproc:b.wav');
    await m.dispose();
  });
});

describe('resolveEngineMode(记忆持久化 v4-④ + 准入共用)', () => {
  const stamp = (s: string | undefined) => async (): Promise<string | undefined> => s;

  it('bin 缺失 → cli;记忆命中(同 bin 标识)→ inprocess;bin 变更 → 清记忆回 server', async () => {
    const memory = memoryStore();
    expect(await resolveEngineMode({ mode: 'auto', binaryDir: 'X:/bin', serverBinStamp: stamp(undefined), memory })).toBe('cli');
    expect(await resolveEngineMode({ mode: 'auto', binaryDir: 'X:/bin', serverBinStamp: stamp('s1'), memory })).toBe('server');

    memory.set({ binaryDir: 'X:/bin', binStamp: 's1' });
    expect(await resolveEngineMode({ mode: 'auto', binaryDir: 'X:/bin', serverBinStamp: stamp('s1'), memory })).toBe('inprocess');

    // bin 升级(标识变化)→ 失效重探
    expect(await resolveEngineMode({ mode: 'auto', binaryDir: 'X:/bin', serverBinStamp: stamp('s2'), memory })).toBe('server');
    expect(memory.record).toBeUndefined();
  });

  it('显式模式直通', async () => {
    const memory = memoryStore();
    expect(await resolveEngineMode({ mode: 'inprocess', binaryDir: 'X:/bin', serverBinStamp: stamp('s1'), memory })).toBe('inprocess');
    expect(await resolveEngineMode({ mode: 'cli', binaryDir: 'X:/bin', serverBinStamp: stamp('s1'), memory })).toBe('cli');
  });
});

describe('updateConfig(v7-②)', () => {
  it('转发 runner 与已建 inprocess,均被 await', async () => {
    const w = makeWorld('blocked');
    const m = new EngineManager(cfg(), w.deps);
    await m.transcribe('a.wav'); // 建立 inprocess
    const newCfg = cfg({ language: 'zh' });
    await m.updateConfig(newCfg);
    expect(w.runner.configs.at(-1)?.language).toBe('zh');
    expect(w.inproc.configs.at(-1)?.language).toBe('zh');
    await m.dispose();
  });
});
