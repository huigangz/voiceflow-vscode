import { beforeAll, describe, expect, it } from 'vitest';
import { requireInCi } from './ciPrereq';

// 测试文件按 CommonJS 编译,静态 import .mjs 会被 tsc 拒绝 → 动态加载(同 packageContract.test.ts)
type Mod = typeof import('../scripts/check-test-skips.mjs', { with: { 'resolution-mode': 'import' } });
let findDisallowedSkips: Mod['findDisallowedSkips'];
let ALLOWED_SKIPS: Mod['ALLOWED_SKIPS'];
beforeAll(async () => {
  ({ findDisallowedSkips, ALLOWED_SKIPS } = await import('../scripts/check-test-skips.mjs'));
});

const t = (status: string, ancestorTitles: string[], title = 'case') => ({ status, ancestorTitles, title });
const report = (files: Record<string, ReturnType<typeof t>[]>) => ({
  testResults: Object.entries(files).map(([name, assertionResults]) => ({
    name: `C:/repo/voiceflow/${name}`,
    assertionResults,
  })),
});

describe('check-test-skips', () => {
  it('全部通过 → 无违规', () => {
    const r = findDisallowedSkips(report({ 'test/a.test.ts': [t('passed', ['A'])] }));
    expect(r).toEqual({ disallowed: [], allowedHits: [], skippedTotal: 0 });
  });

  it('白名单内的硬件 describe 跳过 → 允许', () => {
    const r = findDisallowedSkips(
      report({ 'test/addonRecorder.test.ts': [t('skipped', ['AddonRecorder(真设备)'], 'start')] }),
    );
    expect(r.disallowed).toEqual([]);
    expect(r.allowedHits).toEqual(['test/addonRecorder.test.ts › AddonRecorder(真设备)']);
  });

  it('确定性测试跳过 → 违规并指名(含 pending / todo)', () => {
    const r = findDisallowedSkips(
      report({
        'test/helperRecorder.test.ts': [t('skipped', ['HelperRecorder 数据流 watchdog'], 'device-lost')],
        'test/b.test.ts': [t('pending', ['B']), t('todo', ['B'], 'later')],
      }),
    );
    expect(r.disallowed).toEqual([
      'test/helperRecorder.test.ts › HelperRecorder 数据流 watchdog › device-lost',
      'test/b.test.ts › B › case',
      'test/b.test.ts › B › later',
    ]);
    expect(r.skippedTotal).toBe(3);
  });

  it('白名单按"文件 + 顶层 describe"精确匹配:同名 describe 换了文件不放行', () => {
    const r = findDisallowedSkips(report({ 'test/other.test.ts': [t('skipped', ['AddonRecorder(真设备)'])] }));
    expect(r.disallowed).toHaveLength(1);
  });

  it('Windows 反斜杠路径同样识别', () => {
    const r = findDisallowedSkips({
      testResults: [
        { name: 'D:\\a\\repo\\test\\addonRecorder.test.ts', assertionResults: [t('skipped', ['AddonRecorder(真设备)'])] },
      ],
    });
    expect(r.disallowed).toEqual([]);
  });

  it('每条白名单都写明了原因', () => {
    for (const a of ALLOWED_SKIPS) expect(a.why.length).toBeGreaterThan(5);
  });
});

describe('requireInCi', () => {
  it('本地:缺前置条件返回 false(优雅跳过);CI:抛错', () => {
    const prev = process.env.VOICEFLOW_CI;
    try {
      delete process.env.VOICEFLOW_CI;
      expect(requireInCi(false, 'x')).toBe(false);
      expect(requireInCi(true, 'x')).toBe(true);
      process.env.VOICEFLOW_CI = '1';
      expect(requireInCi(true, 'x')).toBe(true);
      expect(() => requireInCi(false, 'fixture gone')).toThrow('CI prerequisite missing: fixture gone');
    } finally {
      if (prev === undefined) delete process.env.VOICEFLOW_CI;
      else process.env.VOICEFLOW_CI = prev;
    }
  });
});
