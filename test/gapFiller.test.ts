/** P2c-2:GapFiller 静音填充纯逻辑单测 + FrameVad 适配层。 */
import { describe, expect, it } from 'vitest';
import { GapFiller } from '../src/audio/gapFiller';
import { EnergyFrameVad } from '../src/audio/frameVad';

const RATE = 16000;
const data = (n: number, v = 100): Int16Array => new Int16Array(n).fill(v);
const total = (chunks: Int16Array[]): number => chunks.reduce((a, c) => a + c.length, 0);

describe('GapFiller', () => {
  it('首批真实数据启动时间线,原样交付;启动前空批不产出', () => {
    const g = new GapFiller(RATE);
    expect(g.push(new Int16Array(0), 1000)).toEqual([]);
    const out = g.push(data(1600), 5000); // 启动
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(1600);
  });

  it('数据持续充足 → 永不补零', () => {
    const g = new GapFiller(RATE);
    let now = 0;
    g.push(data(1600), now); // 100ms 批
    for (let i = 1; i <= 20; i++) {
      now += 100;
      const out = g.push(data(1600), now);
      expect(out).toHaveLength(1); // 只有数据块
    }
  });

  it('数据断流 → 空批推进补零(超阈值才补,补到留余量),恢复后不重复补', () => {
    const g = new GapFiller(RATE); // 阈值 300ms,余量 100ms
    g.push(data(1600), 0);
    // 100ms/批 空批推进:200ms 时缺口 ~200ms < 300ms 阈值 → 不补
    expect(g.push(new Int16Array(0), 200)).toEqual([]);
    // 500ms:缺口 500-100(已交付换算 100ms)=400ms > 300ms → 补到剩 100ms 余量
    const out1 = g.push(new Int16Array(0), 500);
    expect(out1).toHaveLength(1);
    const filled1 = out1[0]!.length;
    expect(filled1).toBeGreaterThan(0);
    expect(filled1).toBeLessThanOrEqual(((500 - 100) / 1000) * RATE); // 不超过缺口
    expect(out1[0]!.every((v) => v === 0)).toBe(true);
    // 静默继续:1000ms 再补增量
    const out2 = g.push(new Int16Array(0), 1000);
    const filled2 = total(out2);
    // 总交付 ≈ (1000ms - 余量) 换算样本
    const delivered = 1600 + filled1 + filled2;
    expect(Math.abs(delivered - ((1000 - 100) / 1000) * RATE)).toBeLessThanOrEqual(160); // ±10ms
    // 数据恢复:恰好补足余量窗口的真实数据 → 不再补零
    const out3 = g.push(data(1600), 1100);
    expect(out3).toHaveLength(1); // 只有数据块,无补零
  });

  it('轻微抖动(缺口 < 阈值)不触发补零', () => {
    const g = new GapFiller(RATE);
    g.push(data(1600), 0);
    // 设备时钟略慢:每 100ms 只来 95ms 数据,缺口缓慢累积但单次 < 阈值
    let now = 0;
    for (let i = 0; i < 5; i++) {
      now += 100;
      const out = g.push(data(1520), now);
      expect(out).toHaveLength(1);
    }
  });

  it('reset 后时间线重新启动', () => {
    const g = new GapFiller(RATE);
    g.push(data(1600), 0);
    g.reset();
    expect(g.push(new Int16Array(0), 5000)).toEqual([]); // 未启动
    const out = g.push(data(800), 6000);
    expect(out).toHaveLength(1); // 重新首批,无补零
  });
});

describe('EnergyFrameVad', () => {
  it('阈值语义与 energyVad 一致(异步包装)', async () => {
    const vad = new EnergyFrameVad();
    await expect(vad.process(new Int16Array(512).fill(5000))).resolves.toBe(true);
    await expect(vad.process(new Int16Array(512))).resolves.toBe(false);
  });
});
