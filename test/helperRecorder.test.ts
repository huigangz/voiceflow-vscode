/**
 * helper exe 端到端管道测试(真实 spawn bin/voiceflow-mic.exe)。
 * 需要本机有麦克风设备;CI 无设备时跳过(exit 2 视为环境限制)。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { HelperRecorder } from '../src/audio/helperRecorder';
import { PcmChunk, RecorderError } from '../src/audio/recorder';
import { requireInCi } from './ciPrereq';

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

// 纯逻辑:不依赖任何 exe,无条件运行(PR2 前被误套在需要真实 helper 的 describe 里,CI 无 bin/ 时跟着被跳过)
describe('HelperRecorder 启动失败', () => {
  it('exe 路径不存在 → init-failed', async () => {
    const rec = new HelperRecorder('bin/does-not-exist.exe', () => {});
    await expect(
      rec.start({ onChunk: () => {}, onSpeechStart: () => {}, onError: () => {} }),
    ).rejects.toMatchObject({ code: 'init-failed' });
  }, 10000);
});

// 硬件:真实麦克风 —— 允许跳过(登记于 scripts/check-test-skips.mjs 白名单)
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
/**
 * silent-helper 专用探测。它模拟挂起的 helper(发 READY 后 Sleep 30s、不退出),所以不能沿用 canRun 的
 * "stdin EOF 后退出"判据 —— 那样必然 ETIMEDOUT → 判为不可运行 → 测试永远跳过(harness PR2 发现:
 * 自 d057a85 起该 watchdog 测试在任何机器上都没真正跑过)。正确判据:短时间内发出 READY。
 * 被 app-control 拦截(spawn 报错,或受管机上启动后零输出直接退出)时仍判不可运行。
 *
 * 新编译的 exe 首次启动可能很慢(SAC/Defender 对新哈希做信誉检查,实测 >1.5s),固定短超时会误判。
 * 所以用一个小 node 包装进程:见到 READY 立即杀掉 helper 并退出 0(通常 ~100ms),最长等 10s。
 */
function silentHelperRuns(): boolean {
  if (!existsSync(SILENT)) return false;
  const probe = `
    const cp = require('node:child_process').spawn(${JSON.stringify(SILENT)}, [], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    cp.on('error', () => process.exit(2));
    cp.on('exit', () => process.exit(err.includes('READY') ? 0 : 3));
    cp.stderr.on('data', (d) => { err += d; if (err.includes('READY')) { cp.kill(); process.exit(0); } });`;
  const r = spawnSync(process.execPath, ['-e', probe], { timeout: 10_000 });
  return r.status === 0;
}

// 确定性:silent-helper 由 npm run build:fixtures 编译,不依赖硬件 → CI 缺失即失败
describe.skipIf(!requireInCi(silentHelperRuns(), `${SILENT} 不可运行(先 npm run build:fixtures)`))('HelperRecorder 数据流 watchdog', () => {
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
