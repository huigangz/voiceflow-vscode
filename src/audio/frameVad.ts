/**
 * P2c:帧级 VAD 抽象 —— energy(mic 路径现状)与 Silero(loopback 路径,D4 定案)
 * 统一到异步接口;SegmentAccumulator/管线只见 PcmChunk.isSpeech,零改动。
 */
import { rmsInt16 } from './energyVad';

export interface FrameVad {
  /** 一帧 512 采样 @16k → 是否语音(实现可有内部状态)。 */
  process(frame: Int16Array): Promise<boolean>;
  reset(): void;
}

/** energy 阈值 VAD(与 energyVad.ts 同阈值语义,异步包装)。 */
export class EnergyFrameVad implements FrameVad {
  constructor(private readonly threshold = 0.01) {}
  process(frame: Int16Array): Promise<boolean> {
    return Promise.resolve(rmsInt16(frame) > this.threshold);
  }
  reset(): void {
    /* 无状态 */
  }
}
