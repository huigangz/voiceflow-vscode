/**
 * P2c:Silero VAD v5(onnx)—— loopback 路径的帧级 VAD(D4 定案:BGM/多声源下
 * energy 原理性失效,Silero 精确切段,0.18ms/帧实测)。
 *
 * - onnxruntime-node 懒加载(create 时 require;activate 不碰 native,与 pvrecorder 同款)
 * - v5 专用:16k 窗 512(== FRAME_SAMPLES)+ 上下文 64;输入名断言,不兼容 legacy
 * - 进出双阈值(0.5 进 / 0.35 出):概率在阈值附近抖动时不闪切,减碎段
 */
import { FrameVad } from './frameVad';

const WINDOW = 512;
const CONTEXT = 64;
const ENTER_THRESHOLD = 0.5;
const EXIT_THRESHOLD = 0.35;

/** onnxruntime-node 的最小结构面(懒 require,不引入编译期依赖)。 */
interface OrtTensor {
  data: Float32Array;
}
interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => unknown;
}

export class SileroVad implements FrameVad {
  private speaking = false;

  private constructor(
    private readonly ort: OrtModule,
    private readonly session: OrtSession,
    private state: unknown,
    private context: Float32Array,
  ) {}

  static async create(modelPath: string): Promise<SileroVad> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ort = require('onnxruntime-node') as OrtModule; // 懒加载:.node 在此一并载入
    const session = await ort.InferenceSession.create(modelPath);
    if (!session.inputNames.includes('state')) {
      throw new Error(
        `silero model at ${modelPath} is not a v5 model (inputs: ${session.inputNames.join(', ')})`,
      );
    }
    return new SileroVad(
      ort,
      session,
      new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]),
      new Float32Array(CONTEXT),
    );
  }

  async process(frame: Int16Array): Promise<boolean> {
    if (frame.length !== WINDOW) throw new Error(`silero frame must be ${WINDOW} samples`);
    const f32 = new Float32Array(CONTEXT + WINDOW);
    f32.set(this.context, 0);
    for (let i = 0; i < WINDOW; i++) f32[CONTEXT + i] = frame[i]! / 32768;

    const out = await this.session.run({
      input: new this.ort.Tensor('float32', f32, [1, CONTEXT + WINDOW]),
      state: this.state,
      sr: new this.ort.Tensor('int64', BigInt64Array.from([16000n]) as never, [1]),
    });
    this.state = out.stateN;
    this.context = f32.subarray(f32.length - CONTEXT).slice();
    const prob = out.output!.data[0]!;

    // 进出双阈值:高于 0.5 进入说话态,低于 0.35 退出;中间维持现状(防闪切)
    if (this.speaking) {
      if (prob < EXIT_THRESHOLD) this.speaking = false;
    } else if (prob > ENTER_THRESHOLD) {
      this.speaking = true;
    }
    return this.speaking;
  }

  reset(): void {
    this.speaking = false;
    this.state = new this.ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT);
  }
}
