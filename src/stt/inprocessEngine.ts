/**
 * inproc-s4:InprocessEngine —— Transformers.js whisper 进程内引擎(plan v7 §3.3/§3.6/§3.7)。
 *
 * 语言方案(s1-b 定案,"原生 auto 单趟"):
 * - language=auto:generate 从裸 [<|startoftranscript|>] 起,模型自吐语言 token,
 *   从输出 ids 读回作 detectedLanguage(零额外 encoder 开销);
 *   **task 位按会话强制 transcribe/translate**(logits processor)——普通转写不强制则模型会在中英混样本上
 *   自选 <|translate|> 把中文译成英文(s1-b 实测地雷,0.2.0 language bug 的 task 版变体)
 * - language=zh/en:走 transformers.js 正常 language/task 参数路径
 *
 * 取消契约(§3.6,评审 ③ 重新设计——ASR 推理不收 AbortSignal):
 * - 单飞推理锁:任一时刻至多一个推理在 pipeline 上;新 transcribe 先 await 遗留 inflight
 *   (**拒绝要吞**,v4-⑥)
 * - 取消 = 废弃结果不中断计算:race(inflight, cancelled) 提前返回,在途推理跑完被丢弃
 * - **WAV 先整读进内存**(v4-⑨):可取消等待之前完成文件 IO,废弃推理不再碰文件
 * - dispose 延迟到 inflight settle(v6-③,异步签名);updateConfig 同(v7-②)
 *
 * 卸载(§3.7):idle lease 语义同 WhisperRunner;硬上限 maxResidentMinutes 到点若
 * lease>0 或 inflight 在途 → pending-unload,等归零 + settle 再卸(v6-④)。
 */
import { readFile } from 'node:fs/promises';
import { WhisperError } from './whisperRunner';
import type {
  TranscribeOptions,
  TranscribeResult,
  WhisperConfig,
} from './whisperRunner';
import type { WhisperEngine } from './engine';
import { configureInprocessEnv } from './onnxModels';

/** transformers.js ASR pipeline 的最小结构面(懒加载 + 测试 fake)。 */
export interface AsrPipelineLike {
  (audio: Float32Array, opts: { language: string; task: 'transcribe' | 'translate' }): Promise<{ text: string }>;
  model: {
    generate(opts: Record<string, unknown>): Promise<{ data?: ArrayLike<number> } | ArrayLike<number>>;
    generation_config: { decoder_start_token_id: number; task_to_id: Record<string, number>; lang_to_id: Record<string, number> };
    dispose?: () => Promise<void>;
  };
  tokenizer: { decode(ids: number[], opts: { skip_special_tokens: boolean }): string };
  processor: (audio: Float32Array) => Promise<Record<string, unknown>>;
}

export type LoadAsrPipeline = (
  localModelPath: string,
  modelId: string,
  log: (line: string) => void,
) => Promise<AsrPipelineLike>;

/** 生产实现:懒 import transformers.js(activate 不碰),env 覆写走唯一入口(评审 ④)。 */
const defaultLoadPipeline: LoadAsrPipeline = async (localModelPath, modelId, log) => {
  const { env, pipeline } = await import('@huggingface/transformers');
  configureInprocessEnv(env as never, localModelPath);
  log(`[inprocess] loading ${modelId} (q8) from ${localModelPath}…`);
  return (await pipeline('automatic-speech-recognition', modelId, {
    dtype: 'q8',
  })) as unknown as AsrPipelineLike;
};

/** WAV(16k mono s16le,自家管线产物)→ Float32Array。找 data chunk,不硬编码 44 偏移。 */
export function wavToFloat32(buf: Buffer): Float32Array {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new WhisperError('permanent', 'invalid wav: not RIFF');
  }
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(Math.min(size, buf.length - off - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new WhisperError('permanent', 'invalid wav: data chunk not found');
}

interface Loaded {
  asr: AsrPipelineLike;
  key: string;
  coldStartMs: number;
}

export class InprocessEngine implements WhisperEngine {
  private loaded: { key: string; promise: Promise<Loaded> } | undefined;
  private inflight: Promise<unknown> | undefined;
  private leases = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private residentTimer: NodeJS.Timeout | undefined;
  private pendingUnload = false; // v6-④:硬上限到点但 lease/inflight 在途
  private disposed = false;

  constructor(
    private cfg: WhisperConfig,
    private readonly loadPipeline: LoadAsrPipeline = defaultLoadPipeline,
    private readonly readWav: (p: string) => Promise<Buffer> = (p) => readFile(p),
  ) {}

  private generationKey(): string {
    return `${this.cfg.inprocess?.localModelPath}|${this.cfg.inprocess?.modelId}|q8`;
  }

  /** v7-②:等旧代际释放后返回;身份未变只更新 cfg。 */
  async updateConfig(cfg: WhisperConfig): Promise<void> {
    const oldKey = this.generationKey();
    this.cfg = cfg;
    if (this.generationKey() !== oldKey) await this.unload('config generation changed');
  }

  acquireLease(): () => void {
    this.leases++;
    this.clearIdleTimer();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases--;
      this.maybeUnloadAfterUse();
    };
  }

  /** single-flight 加载(prepare 语义同 runner:失败清空可重试;不收 session signal)。 */
  prepare(): Promise<{ coldStartMs?: number }> {
    return this.ensureLoaded().then((l) => ({ coldStartMs: l.coldStartMs }));
  }

  private ensureLoaded(): Promise<Loaded> {
    if (this.disposed) return Promise.reject(new WhisperError('permanent', 'engine disposed'));
    const inproc = this.cfg.inprocess;
    if (!inproc) {
      return Promise.reject(new WhisperError('permanent', 'inprocess config missing (model not ensured)'));
    }
    const key = this.generationKey();
    if (this.loaded?.key === key) return this.loaded.promise;

    const t0 = Date.now();
    this.cfg.onColdStart?.(true);
    const promise = this.loadPipeline(inproc.localModelPath, inproc.modelId, this.cfg.log)
      .then((asr) => {
        const coldStartMs = Date.now() - t0;
        this.cfg.log(`[inprocess] model ready, cold start ${coldStartMs}ms`);
        this.armResidentCap();
        this.armIdleIfIdle();
        return { asr, key, coldStartMs };
      })
      .catch((e: unknown) => {
        if (this.loaded?.promise === promise) this.loaded = undefined; // 失败清空可重试
        // 加载失败 = permanent(§3.4:模型/运行时坏,重试无意义)
        throw e instanceof WhisperError
          ? e
          : new WhisperError('permanent', `inprocess 模型加载失败:${String((e as Error)?.message ?? e)}`);
      })
      .finally(() => this.cfg.onColdStart?.(false));
    this.loaded = { key, promise };
    return promise;
  }

  async transcribe(wavPath: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    const releaseLease = this.acquireLease();
    try {
      this.throwIfAborted(opts.signal);
      // v4-⑨:先整读 WAV 进内存——之后管线随时可删文件,废弃的在途推理不碰文件
      const audio = wavToFloat32(await this.readWav(wavPath));
      this.throwIfAborted(opts.signal);

      const { asr, coldStartMs } = await this.raceWithSignal(this.ensureLoaded(), opts.signal);
      this.throwIfAborted(opts.signal);

      // §3.6 单飞推理锁:遗留 inflight 先等 settle(拒绝要吞,v4-⑥)
      while (this.inflight) {
        const prior = this.inflight;
        await prior.catch(() => {});
        if (this.inflight === prior) this.inflight = undefined;
        this.throwIfAborted(opts.signal);
      }

      const language = opts.language ?? this.cfg.language;
      const t0 = Date.now();
      const run = this.runInference(asr, audio, language, opts.task ?? 'transcribe');
      const inflightRef = run.catch(() => {}); // 创建即挂 catch(v4-⑥,防 unhandledRejection)
      this.inflight = inflightRef;
      // 收尾钩子挂在 inflightRef(永不拒绝)上——挂在 run.finally 上会派生一条无人观察的拒绝链
      void inflightRef.then(() => {
        // 引用比对:只清自己那份,绝不清后继会话的新 inflight
        if (this.inflight === inflightRef) this.inflight = undefined;
        this.maybeUnloadAfterUse();
      });
      // 取消 = 废弃结果不中断计算(§3.6):race 提前返回,推理后台跑完由锁/延迟 dispose 兜住
      const result = await this.raceWithSignal(run, opts.signal);
      const transcribeMs = Date.now() - t0;
      this.cfg.log(`[inprocess] transcribe ${transcribeMs}ms → ${result.text.length} chars`);
      return { ...result, coldStartMs, transcribeMs, mode: 'inprocess' };
    } finally {
      releaseLease();
    }
  }

  /** 推理本体:auto = 原生单趟 + task 强制;显式 = 正常参数路径。异常 → transient(重试一次由管线做)。 */
  private async runInference(
    asr: AsrPipelineLike,
    audio: Float32Array,
    language: 'zh' | 'en' | 'auto',
    task: 'transcribe' | 'translate',
  ): Promise<{ text: string; detectedLanguage?: string }> {
    try {
      if (language !== 'auto') {
        const out = await asr(audio, { language, task });
        return { text: out.text.trim() };
      }
      // 原生 auto 单趟(s1-b):裸 sot 起,读回语言 token;task 位按会话强制(普通转写防 translate 地雷)
      const g = asr.model.generation_config;
      const taskId = g.task_to_id[task];
      const forceTask = (
        input_ids: ArrayLike<number>[],
        logits: { data: Float32Array | number[] },
      ): unknown => {
        if (input_ids[0] !== undefined && (input_ids[0] as ArrayLike<number>).length === 2) {
          const d = logits.data as Float32Array;
          const keep = d[taskId!]!;
          d.fill(-Infinity);
          d[taskId!] = keep;
        }
        return logits;
      };
      const feats = await asr.processor(audio);
      const out = await asr.model.generate({
        ...feats,
        decoder_input_ids: [g.decoder_start_token_id],
        logits_processor: [forceTask],
      });
      const raw = (out as { data?: ArrayLike<number> }).data ?? (out as ArrayLike<number>);
      const ids = Array.from(raw as ArrayLike<number>).map(Number);
      const text = asr.tokenizer.decode(ids, { skip_special_tokens: true }).trim();
      // 输出形如 <|startoftranscript|><|zh|><|transcribe|>…:第二个 token 是语言
      const langTok = asr.tokenizer.decode([ids[1]!], { skip_special_tokens: false });
      const detected = /^<\|([a-z]{2,3})\|>$/.exec(langTok)?.[1];
      return { text, detectedLanguage: detected };
    } catch (e) {
      if (e instanceof WhisperError) throw e;
      // 推理异常 = transient(§3.4:偶发,重试一次)
      throw new WhisperError('transient', `inprocess 推理失败:${String((e as Error)?.message ?? e)}`);
    }
  }

  // ---------- 卸载(§3.7)----------

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdleIfIdle(): void {
    this.clearIdleTimer();
    if (this.leases > 0 || this.cfg.idleUnloadMinutes <= 0 || !this.loaded) return;
    this.idleTimer = setTimeout(
      () => void this.unload(`idle ${this.cfg.idleUnloadMinutes}min`),
      this.cfg.idleUnloadMinutes * 60_000,
    );
  }

  /** §3.7 硬上限:idleUnload=0(用户要常驻)也生效;0=真常驻。 */
  private armResidentCap(): void {
    if (this.residentTimer !== undefined) return;
    const minutes = this.cfg.inprocess?.maxResidentMinutes ?? 30;
    if (minutes <= 0) return;
    this.residentTimer = setTimeout(() => {
      this.residentTimer = undefined;
      if (this.leases > 0 || this.inflight) {
        // v6-④:绝不在会话/推理中直接 dispose → pending,等归零 + settle
        this.pendingUnload = true;
        this.cfg.log('[inprocess] resident cap reached — pending unload (active use)');
      } else {
        void this.unload(`resident cap ${minutes}min`);
      }
    }, minutes * 60_000);
  }

  /** lease 归零 / inflight settle 后的统一收口:pending-unload 执行,否则武装 idle。 */
  private maybeUnloadAfterUse(): void {
    if (this.pendingUnload && this.leases === 0 && !this.inflight) {
      this.pendingUnload = false;
      void this.unload('resident cap (deferred)');
      return;
    }
    if (this.leases === 0) this.armIdleIfIdle();
  }

  /** 卸载 = 延迟协议(§3.6):等 inflight settle 才释放 pipeline(native 推理中 free 模型会崩)。 */
  private async unload(reason: string): Promise<void> {
    const current = this.loaded;
    this.loaded = undefined; // 立即失效代际:后续调用重新加载
    this.clearIdleTimer();
    if (this.residentTimer !== undefined) {
      clearTimeout(this.residentTimer);
      this.residentTimer = undefined;
    }
    this.pendingUnload = false;
    if (!current) return;
    this.cfg.log(`[inprocess] unloading (${reason})`);
    while (this.inflight) {
      const prior = this.inflight;
      await prior.catch(() => {});
      if (this.inflight === prior) this.inflight = undefined;
    }
    try {
      const l = await current.promise.catch(() => undefined);
      await l?.asr.model.dispose?.();
    } catch {
      /* 释放失败不阻断 */
    }
  }

  /** v6-③:异步 dispose,等在途推理 settle。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.unload('dispose');
  }

  // ---------- 工具 ----------

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new WhisperError('cancelled', 'cancelled by session');
  }

  private async raceWithSignal<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return p;
    this.throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        p.catch(() => {}); // 废弃结果:后台推理继续,settle 由 inflight 收口
        reject(new WhisperError('cancelled', 'cancelled while waiting'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }
}
