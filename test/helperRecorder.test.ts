/**
 * helper exe 端到端管道测试(真实 spawn bin/voiceflow-mic.exe)。
 * 需要本机有麦克风设备;CI 无设备时跳过(exit 2 视为环境限制)。
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HelperRecorder } from '../src/audio/helperRecorder';
import { PcmChunk, RecorderError } from '../src/audio/recorder';

const EXE = 'bin/voiceflow-mic.exe';

describe.skipIf(!existsSync(EXE))('HelperRecorder(真实 helper 进程)', () => {
  it('start → 收到 PCM 帧 → stop 干净退出', async () => {
    const rec = new HelperRecorder(EXE, () => {});
    const chunks: PcmChunk[] = [];
    try {
      await rec.start({
        onChunk: (c) => chunks.push(c),
        onSpeechStart: () => {},
        onError: (e: RecorderError) => {
          throw e;
        },
      });
    } catch (e) {
      if (e instanceof RecorderError && e.code === 'no-device') return; // CI 无麦克风:跳过
      throw e;
    }
    await new Promise((r) => setTimeout(r, 1200));
    await rec.stop();
    // ≥1s 音频 → 至少 ~30 帧(32ms/帧)
    expect(chunks.length).toBeGreaterThan(20);
    // 时间戳单调递增
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.timeMs).toBeGreaterThan(chunks[i - 1]!.timeMs);
    }
  }, 15000);

  it('exe 路径不存在 → init-failed', async () => {
    const rec = new HelperRecorder('bin/does-not-exist.exe', () => {});
    await expect(
      rec.start({ onChunk: () => {}, onSpeechStart: () => {}, onError: () => {} }),
    ).rejects.toMatchObject({ code: 'init-failed' });
  }, 10000);

  it('dispose 后无残留进程(Reload Window gate)', async () => {
    const rec = new HelperRecorder(EXE, () => {});
    try {
      await rec.start({ onChunk: () => {}, onSpeechStart: () => {}, onError: () => {} });
    } catch (e) {
      if (e instanceof RecorderError && e.code === 'no-device') return;
      throw e;
    }
    rec.dispose();
    await new Promise((r) => setTimeout(r, 500));
    // dispose 后不应再有活动进程(kill 已发出;无法直接断言 PID,靠 stop 不挂起验证)
    await rec.stop(); // 应立即返回
  }, 10000);
});
