/**
 * Host 侧帧切分 + 能量 VAD(方案 B 配套,D8 备案)— 纯逻辑,可单元测试。
 * helper exe 只产原始 PCM 流;切帧、isSpeech 标记、时间戳都在这里。
 * 后续可无缝替换为 onnxruntime-node 跑 silero(同样输出 PcmChunk)。
 */
import { PcmChunk, SAMPLE_RATE } from './recorder';

export const FRAME_SAMPLES = 512; // 32ms @ 16kHz

/** Int16 帧的归一化 RMS(0~1)。 */
export function rmsInt16(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]! / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

export class EnergyVad {
  private leftover: Buffer = Buffer.alloc(0);
  private totalSamples = 0;

  constructor(private readonly threshold = 0.01) {}

  /** 喂入任意长度的 s16le 字节流,产出定长帧(时间戳由累计采样数推得,精确)。 */
  push(data: Buffer): PcmChunk[] {
    let buf = this.leftover.length > 0 ? Buffer.concat([this.leftover, data]) : data;
    const frames: PcmChunk[] = [];
    const frameBytes = FRAME_SAMPLES * 2;
    let offset = 0;
    while (buf.length - offset >= frameBytes) {
      // 拷贝出对齐的 Int16Array(Buffer 偏移未必 2 字节对齐)
      const slice = Buffer.from(buf.subarray(offset, offset + frameBytes));
      const pcm = new Int16Array(slice.buffer, slice.byteOffset, FRAME_SAMPLES);
      frames.push({
        pcm,
        isSpeech: rmsInt16(pcm) > this.threshold,
        timeMs: Math.round((this.totalSamples / SAMPLE_RATE) * 1000),
      });
      this.totalSamples += FRAME_SAMPLES;
      offset += frameBytes;
    }
    this.leftover = Buffer.from(buf.subarray(offset));
    return frames;
  }
}
