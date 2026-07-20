/**
 * inproc-s4:InprocessEngine 单测(fake pipeline,plan v7 §3.3/§3.6/§3.7)。
 * 覆盖:显式/auto 语言路径(task 强制 transcribe)、串行化、取消=废弃结果、
 * 遗留 inflight 拒绝被吞、WAV 先读内存、延迟 dispose、typed error、硬上限 pending-unload、
 * updateConfig 代际。
 */
import { describe, expect, it } from 'vitest';
import { AsrPipelineLike, InprocessEngine, wavToFloat32 } from '../src/stt/inprocessEngine';
import { WhisperConfig } from '../src/stt/whisperRunner';

/** 极简 WAV(16k mono s16le,N 采样全 0)。 */
function buildWav(samples = 16): Buffer {
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const SOT = 50258;
const LANG_ZH = 50260;
const TASK_TRANSCRIBE = 50359;
const TASK_TRANSLATE = 50358;

interface FakeWorld {
  asr: AsrPipelineLike;
  explicitCalls: Array<{ language: string; task: string }>;
  generateCalls: Array<Record<string, unknown>>;
  processorCalls: number;
  loadCount: number;
  disposedModels: number;
  /** 下一次推理挂起,返回 release 函数。 */
  deferNext(): { resolve(): void; reject(e: Error): void };
}

function makeWorld(): FakeWorld {
  let deferred: { promise: Promise<void>; resolve(): void; reject(e: Error): void } | undefined;
  const takeGate = async (): Promise<void> => {
    if (!deferred) return;
    const d = deferred;
    deferred = undefined;
    await d.promise;
  };
  const w: FakeWorld = {
    explicitCalls: [],
    generateCalls: [],
    processorCalls: 0,
    loadCount: 0,
    disposedModels: 0,
    deferNext() {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      deferred = { promise, resolve, reject };
      return { resolve, reject };
    },
    asr: undefined as never,
  };
  const asr = (async (_audio: Float32Array, opts: { language: string; task: 'transcribe' | 'translate' }) => {
    w.explicitCalls.push(opts);
    await takeGate();
    return { text: ` 显式${opts.language} ` };
  }) as AsrPipelineLike;
  asr.processor = async () => {
    w.processorCalls++;
    return { input_features: 'feats' };
  };
  asr.model = {
    generation_config: {
      decoder_start_token_id: SOT,
      task_to_id: { transcribe: TASK_TRANSCRIBE, translate: TASK_TRANSLATE },
      lang_to_id: { '<|zh|>': LANG_ZH },
    },
    async generate(opts: Record<string, unknown>) {
      w.generateCalls.push(opts);
      // 模拟 task 位:构造 logits(translate 更高分),跑注入的 processor,断言强制生效
      const procs = opts['logits_processor'] as Array<(ids: number[][], logits: { data: Float32Array }) => unknown>;
      const logits = { data: new Float32Array(60000).fill(0) };
      logits.data[TASK_TRANSLATE] = 9; // 模型想选 translate(s1-b 地雷形态)
      logits.data[TASK_TRANSCRIBE] = 1;
      procs?.[0]?.([[SOT, LANG_ZH]], logits);
      const chosenTask = logits.data[TASK_TRANSLATE]! > logits.data[TASK_TRANSCRIBE]! ? TASK_TRANSLATE : TASK_TRANSCRIBE;
      await takeGate();
      return { data: [SOT, LANG_ZH, chosenTask, 1234] };
    },
    dispose: async () => { w.disposedModels++; },
  };
  asr.tokenizer = {
    decode(ids: number[], o: { skip_special_tokens: boolean }) {
      if (o.skip_special_tokens) {
        return ids.includes(TASK_TRANSLATE) ? 'TRANSLATED!' : ' 中文文本 ';
      }
      return ids.map((i) => (i === LANG_ZH ? '<|zh|>' : i === SOT ? '<|startoftranscript|>' : `#${i}`)).join('');
    },
  };
  w.asr = asr;
  return w;
}

function cfg(overrides: Partial<WhisperConfig> = {}): WhisperConfig {
  return {
    binaryDir: 'X:/bin',
    modelPath: '',
    language: 'auto',
    initialPrompt: '',
    mode: 'inprocess',
    idleUnloadMinutes: 0,
    inprocess: { localModelPath: 'X:/models/onnx', modelId: 'test/m', maxResidentMinutes: 0 },
    log: () => {},
    ...overrides,
  };
}

function makeEngine(w: FakeWorld, c = cfg()): InprocessEngine {
  return new InprocessEngine(
    c,
    async () => { w.loadCount++; return w.asr; },
    async () => buildWav(),
  );
}

describe('语言路径(s1-b 定案)', () => {
  it('显式 zh:走正常参数路径,task=transcribe', async () => {
    const w = makeWorld();
    const e = makeEngine(w);
    const r = await e.transcribe('a.wav', { language: 'zh' });
    expect(w.explicitCalls).toEqual([{ language: 'zh', task: 'transcribe' }]);
    expect(r.text).toBe('显式zh');
    expect(r.mode).toBe('inprocess');
    await e.dispose();
  });

  it('auto:裸 sot 起 + task 位强制 transcribe(防 translate 地雷)+ 读回语言 token', async () => {
    const w = makeWorld();
    const e = makeEngine(w);
    const r = await e.transcribe('a.wav'); // cfg.language=auto
    expect(w.generateCalls).toHaveLength(1);
    expect(w.generateCalls[0]!['decoder_input_ids']).toEqual([SOT]);
    // fake generate 里 translate 得分更高;processor 强制后必须选 transcribe
    expect(r.text).toBe('中文文本'); // 非 'TRANSLATED!'
    expect(r.detectedLanguage).toBe('zh'); // 归一词汇('zh',经 normalizeDetectedLanguage 锁定)
    await e.dispose();
  });

  it('translate 任务在显式语言与 auto 路径都强制 task=translate', async () => {
    const explicit = makeWorld();
    const explicitEngine = makeEngine(explicit);
    await explicitEngine.transcribe('a.wav', { language: 'zh', task: 'translate', translationTarget: 'en' });
    expect(explicit.explicitCalls).toEqual([{ language: 'zh', task: 'translate' }]);
    await explicitEngine.dispose();

    const auto = makeWorld();
    const autoEngine = makeEngine(auto);
    const result = await autoEngine.transcribe('a.wav', { task: 'translate', translationTarget: 'en' });
    expect(result.text).toBe('TRANSLATED!');
    await autoEngine.dispose();
  });
});

describe('串行化与取消(§3.6)', () => {
  it('单飞推理锁:并发 transcribe 排队,绝不并发调 pipeline', async () => {
    const w = makeWorld();
    const e = makeEngine(w, cfg({ language: 'zh' }));
    const gate = w.deferNext();
    const a = e.transcribe('a.wav', { language: 'zh' });
    await new Promise((r) => setTimeout(r, 20));
    const b = e.transcribe('b.wav', { language: 'zh' });
    await new Promise((r) => setTimeout(r, 20));
    expect(w.explicitCalls).toHaveLength(1); // b 在等 a 的 inflight
    gate.resolve();
    await a;
    await b;
    expect(w.explicitCalls).toHaveLength(2);
    await e.dispose();
  });

  it('取消 = 废弃结果:race 提前返回 cancelled,在途推理跑完不炸;新会话正常', async () => {
    const w = makeWorld();
    const e = makeEngine(w, cfg({ language: 'zh' }));
    const gate = w.deferNext();
    const ac = new AbortController();
    const a = e.transcribe('a.wav', { language: 'zh', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(a).rejects.toMatchObject({ kind: 'cancelled' });
    gate.resolve(); // 在途推理此刻才 settle,结果被丢弃
    const r = await e.transcribe('b.wav', { language: 'zh' }); // 新会话等旧 inflight 后正常
    expect(r.text).toBe('显式zh');
    await e.dispose();
  });

  it('遗留 inflight 拒绝被吞(v4-⑥):取消后在途推理失败不产生未处理 rejection', async () => {
    const w = makeWorld();
    const e = makeEngine(w, cfg({ language: 'zh' }));
    const gate = w.deferNext();
    const ac = new AbortController();
    const a = e.transcribe('a.wav', { language: 'zh', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(a).rejects.toMatchObject({ kind: 'cancelled' });
    gate.reject(new Error('inference blew up after cancel'));
    await new Promise((r) => setTimeout(r, 30)); // 若未吞,vitest 会以 unhandled rejection 失败
    const r = await e.transcribe('b.wav', { language: 'zh' });
    expect(r.text).toBe('显式zh');
    await e.dispose();
  });

  it('会话 signal 已 aborted → 直接 cancelled,不加载不推理', async () => {
    const w = makeWorld();
    const e = makeEngine(w);
    const ac = new AbortController();
    ac.abort();
    await expect(e.transcribe('a.wav', { signal: ac.signal })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(w.loadCount).toBe(0);
    await e.dispose();
  });
});

describe('WAV 先读内存(v4-⑨)与延迟 dispose(v6-③)', () => {
  it('文件在推理开始前读完;取消后管线删文件不影响在途推理', async () => {
    const w = makeWorld();
    let reads = 0;
    let fileDeleted = false;
    const e = new InprocessEngine(
      cfg({ language: 'zh' }),
      async () => w.asr,
      async () => {
        if (fileDeleted) throw new Error('ENOENT: file deleted');
        reads++;
        return buildWav();
      },
    );
    const gate = w.deferNext();
    const ac = new AbortController();
    const a = e.transcribe('a.wav', { language: 'zh', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(1); // 推理前已整读
    ac.abort();
    await expect(a).rejects.toMatchObject({ kind: 'cancelled' });
    fileDeleted = true; // pipeline finally 删 WAV
    gate.resolve(); // 在途推理 settle —— 不再碰文件,无 ENOENT
    await new Promise((r) => setTimeout(r, 20));
    await e.dispose();
  });

  it('dispose 等在途推理 settle 后才释放 pipeline', async () => {
    const w = makeWorld();
    const e = makeEngine(w, cfg({ language: 'zh' }));
    const gate = w.deferNext();
    const ac = new AbortController();
    const a = e.transcribe('a.wav', { language: 'zh', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(a).rejects.toMatchObject({ kind: 'cancelled' });

    let disposeDone = false;
    const d = e.dispose().then(() => { disposeDone = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(disposeDone).toBe(false); // 在途推理未 settle,不得释放
    expect(w.disposedModels).toBe(0);
    gate.resolve();
    await d;
    expect(w.disposedModels).toBe(1);
  });
});

describe('typed error 三分(§3.4)', () => {
  it('加载失败 → permanent;推理异常 → transient', async () => {
    const w = makeWorld();
    const bad = new InprocessEngine(cfg(), async () => { throw new Error('dll load failed'); }, async () => buildWav());
    await expect(bad.transcribe('a.wav', { language: 'zh' })).rejects.toMatchObject({ kind: 'permanent' });
    await bad.dispose();

    const e = makeEngine(w, cfg({ language: 'zh' }));
    const gate = w.deferNext();
    const p = e.transcribe('a.wav', { language: 'zh' });
    gate.reject(new Error('ort session error'));
    await expect(p).rejects.toMatchObject({ kind: 'transient' });
    await e.dispose();
  });

  it('inprocess 配置缺失(模型未确保)→ permanent', async () => {
    const w = makeWorld();
    const e = makeEngine(w, cfg({ inprocess: undefined }));
    await expect(e.transcribe('a.wav', { language: 'zh' })).rejects.toMatchObject({ kind: 'permanent' });
    await e.dispose();
  });
});

describe('卸载(§3.7,v6-④)', () => {
  it('硬上限到点且 lease 在途 → pending-unload,lease 归零后才卸载(idleUnload=0 也生效)', async () => {
    const w = makeWorld();
    const e = makeEngine(
      w,
      cfg({ language: 'zh', idleUnloadMinutes: 0, inprocess: { localModelPath: 'X:/m', modelId: 't/m', maxResidentMinutes: 0.002 } }), // 120ms
    );
    const release = e.acquireLease();
    await e.transcribe('a.wav', { language: 'zh' }); // 触发加载
    await new Promise((r) => setTimeout(r, 250)); // 硬上限已到点
    expect(w.disposedModels).toBe(0); // lease 在途:pending,绝不中途卸
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(w.disposedModels).toBe(1); // 归零即卸(v6-④)
    await e.dispose();
  });

  it('updateConfig 换模型代际 → await 旧释放,下次重加载(v7-②)', async () => {
    const w = makeWorld();
    const e = makeEngine(w, cfg({ language: 'zh' }));
    await e.transcribe('a.wav', { language: 'zh' });
    expect(w.loadCount).toBe(1);
    await e.updateConfig(cfg({ language: 'zh', inprocess: { localModelPath: 'X:/m2', modelId: 't/m2', maxResidentMinutes: 0 } }));
    expect(w.disposedModels).toBe(1); // 旧代际已释放
    await e.transcribe('b.wav', { language: 'zh' });
    expect(w.loadCount).toBe(2); // 新代际重加载
    await e.dispose();
  });
});

describe('wavToFloat32', () => {
  it('标准头解析 + 非 RIFF 拒绝', () => {
    expect(wavToFloat32(buildWav(8))).toHaveLength(8);
    expect(() => wavToFloat32(Buffer.alloc(100))).toThrow(/RIFF/);
  });
});
