/**
 * P2c:静音填充纯逻辑 —— WASAPI loopback 在无渲染流时不产生任何数据包
 * (双实现确证,worklog p2cs5/p2cs6),停顿会从字节流"蒸发"。本模块按墙钟记账,
 * 在数据缺口超过阈值时前置补零,重建连续时间线(补出的静音正是 VAD 切段的依据)。
 *
 * 工作在转换后的 16k mono s16 域(converter 之后、VAD 之前)。时钟由调用方注入
 * (可测性;生产传 Date.now())。
 *
 * 记账模型:expected = (now - start) × rate;deficit = expected − 已交付。
 * - deficit > fillThreshold 才补(容忍设备时钟滞后与包突发,防误补)
 * - 补到只剩 targetLag(留余量:迟到的真实数据不会与补零重叠计账)
 * - 数据持续充足时 deficit 稳定在 0 附近,永不补
 */

export interface GapFillerOptions {
  /** 缺口超过此毫秒数才开始补零(默认 300ms;正常包突发/时钟抖动在此之下)。 */
  fillThresholdMs?: number;
  /** 补零后保留的滞后余量(默认 100ms;为迟到的真实数据留位)。 */
  targetLagMs?: number;
}

export class GapFiller {
  private readonly fillThreshold: number;
  private readonly targetLag: number;
  private startMs: number | undefined;
  private delivered = 0; // 已交付样本(真实 + 补零)

  constructor(
    private readonly sampleRate = 16000,
    opts: GapFillerOptions = {},
  ) {
    this.fillThreshold = Math.round(((opts.fillThresholdMs ?? 300) / 1000) * this.sampleRate);
    this.targetLag = Math.round(((opts.targetLagMs ?? 100) / 1000) * this.sampleRate);
  }

  /**
   * 喂入一批转换后的样本(可为空批 —— 轮询无数据时也要调用,静默期靠空批推进补零)。
   * 返回按序交付的块(可能是 [补零块, 数据块]、[数据块]、[补零块] 或 [])。
   */
  push(samples: Int16Array, nowMs: number): Int16Array[] {
    if (this.startMs === undefined) {
      if (samples.length === 0) return []; // 首个真实数据到达才启动时间线
      this.startMs = nowMs;
      // 首批即交付,时间线从首批起点算
      this.delivered = samples.length;
      return [samples];
    }
    const expected = Math.floor(((nowMs - this.startMs) / 1000) * this.sampleRate);
    const out: Int16Array[] = [];
    const deficitAfterData = expected - (this.delivered + samples.length);
    if (deficitAfterData > this.fillThreshold) {
      const zeros = new Int16Array(deficitAfterData - this.targetLag); // 补到只剩余量
      this.delivered += zeros.length;
      out.push(zeros);
    }
    if (samples.length > 0) {
      this.delivered += samples.length;
      out.push(samples);
    }
    return out;
  }

  reset(): void {
    this.startMs = undefined;
    this.delivered = 0;
  }
}
