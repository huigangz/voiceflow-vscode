/**
 * helper exe 端到端管道测试(真实 spawn bin/voiceflow-mic.exe)。
 * 需要本机有麦克风设备;CI 无设备时跳过(exit 2 视为环境限制)。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { HelperRecorder } from '../src/audio/helperRecorder';
import { PcmChunk, RecorderError } from '../src/audio/recorder';

const EXE = 'bin/voiceflow-mic.exe';
const SILENT = 'test/fixtures/silent-helper.exe';

/**
 * 该 exe 能否真正被本机启动。用于在 CI(无文件)/ Smart App Control 拦截未签名
 * 二进制(spawn UNKNOWN)等环境下**优雅跳过**真实进程测试,而非误报失败 ——
 * SAC 拦截是环境策略,不是录音逻辑缺陷。
 */
function canRun(exe: string): boolean {
  if (!existsSync(exe)) return false;
  const r = spawnSync(exe, [], { input: '', timeout: 3000 }); // stdin EOF → helper 立即退出
  return r.error === undefined; // spawn 失败(app-control/UNKNOWN)→ error 有值 → 跳过
}

describe.skipIf(!canRun(EXE))('HelperRecorder(真实 helper 进程)', () => {
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

// device-lost watchdog:READY 后数据断流 → 判定 device-lost 并 kill 挂起 helper
// (模拟 winmm 设备拔出后静默挂起;不依赖 helper 自己报错)
describe.skipIf(!canRun(SILENT))('HelperRecorder 数据流 watchdog', () => {
  it('READY 后持续无数据 → onError(device-lost),且进程被杀', async () => {
    const rec = new HelperRecorder(SILENT, () => {});
    const err = await new Promise<RecorderError>((resolve, reject) => {
      // start() 会 resolve(收到 READY),device-lost 通过 onError 异步上报
      rec.start({
        onChunk: () => {},
        onSpeechStart: () => {},
        onError: (e) => resolve(e),
      }).catch(reject);
    });
    expect(err.code).toBe('device-lost');
    await rec.stop(); // 已被 watchdog kill,应立即返回不挂起
  }, 10000);
});
