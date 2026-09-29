import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

// 测试文件按 CommonJS 编译,静态 import .mjs 会被 tsc 拒绝 → 动态加载(同 packageContract.test.ts)
type Gen = typeof import('../scripts/offlineIgnore.mjs', { with: { 'resolution-mode': 'import' } });
type Contract = typeof import('../scripts/packageContract.mjs', { with: { 'resolution-mode': 'import' } });
let generateOfflineIgnore: Gen['generateOfflineIgnore'];
let effectiveRules: Gen['effectiveRules'];
let ruleDiff: Gen['ruleDiff'];
let checkRuleDiff: Gen['checkRuleDiff'];
let OFFLINE_MARKER: Gen['OFFLINE_MARKER'];
let OFFLINE_RULE: Gen['OFFLINE_RULE'];
let vsixFileName: Contract['vsixFileName'];
beforeAll(async () => {
  ({ generateOfflineIgnore, effectiveRules, ruleDiff, checkRuleDiff, OFFLINE_MARKER, OFFLINE_RULE } = await import(
    '../scripts/offlineIgnore.mjs'
  ));
  ({ vsixFileName } = await import('../scripts/packageContract.mjs'));
});

const realIgnore = () => readFileSync('.vscodeignore', 'utf8');
const sample = (between: string[]) => ['src/**', '# 注释', ...between, '!media/vad/x.onnx', ''].join('\n');

describe('offline ignore 生成(§8.2 v2:单一来源)', () => {
  it('真实 .vscodeignore:差异恰为去掉 offline-model/**,其余规则顺序不变', () => {
    const std = realIgnore();
    const off = generateOfflineIgnore(std);
    expect(ruleDiff(std, off)).toEqual({ removed: [OFFLINE_RULE], added: [] });
    expect(checkRuleDiff(ruleDiff(std, off))).toEqual([]);
    // negation 规则顺序敏感:生成结果 = 原有效规则去掉那一条,顺序逐条相同
    expect(effectiveRules(off)).toEqual(effectiveRules(std).filter((r) => r !== OFFLINE_RULE));
  });

  it('仓库不再跟踪手工维护的 .vscodeignore-offline', () => {
    expect(execFileSync('git', ['ls-files', '.vscodeignore-offline'], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('标记缺失 → 抛错(fail-closed)', () => {
    expect(() => generateOfflineIgnore(sample([OFFLINE_RULE]))).toThrow(/缺少标记/);
  });

  it('标记重复 → 抛错', () => {
    expect(() => generateOfflineIgnore(sample([OFFLINE_MARKER, OFFLINE_RULE, OFFLINE_MARKER, OFFLINE_RULE]))).toThrow(/出现 2 次/);
  });

  it('标记下一行不是 offline-model/**(被挪开 / 规则被改写 / 标记在文件末尾)→ 抛错', () => {
    expect(() => generateOfflineIgnore(sample([OFFLINE_MARKER, 'models/**', OFFLINE_RULE]))).toThrow(/下一行必须是/);
    expect(() => generateOfflineIgnore(sample([OFFLINE_MARKER, 'offline-model/*.bin']))).toThrow(/下一行必须是/);
    expect(() => generateOfflineIgnore(`src/**\n${OFFLINE_MARKER}`)).toThrow(/文件结束/);
  });

  it('标记之外还有涉及 offline-model 的规则 → 抛错(差异会不止一行)', () => {
    expect(() => generateOfflineIgnore(sample([OFFLINE_MARKER, OFFLINE_RULE, 'offline-model/onnx/**']))).toThrow(/标记之外/);
    expect(() => generateOfflineIgnore(sample([OFFLINE_MARKER, OFFLINE_RULE, `  ${OFFLINE_RULE}  `]))).toThrow(/标记之外/);
  });

  it('CRLF 与行首尾空白:按 vsce 的 trim 语义识别', () => {
    const crlf = ['src/**', `  ${OFFLINE_MARKER}`, `${OFFLINE_RULE}  `, 'test/**'].join('\r\n');
    const off = generateOfflineIgnore(crlf);
    expect(effectiveRules(off)).toEqual(['src/**', 'test/**']);
    expect(off).not.toMatch(/\r/);
  });

  it('生成结果带"勿手改"头注释,注释不影响有效规则', () => {
    const off = generateOfflineIgnore(sample([OFFLINE_MARKER, OFFLINE_RULE]));
    expect(off.split('\n')[0]).toMatch(/^# GENERATED/);
    expect(effectiveRules(off)).toEqual(['src/**', '!media/vad/x.onnx']);
  });
});

describe('ruleDiff / checkRuleDiff', () => {
  it('按规则计数比较(重复规则不被合并)', () => {
    expect(ruleDiff('a\na\nb', 'a\nb')).toEqual({ removed: ['a'], added: [] });
    expect(ruleDiff('a', 'a\n# c\n\nz')).toEqual({ removed: [], added: ['z'] });
  });

  it('差异不是恰好去掉 offline-model/** → 违规', () => {
    expect(checkRuleDiff({ removed: [], added: [] })).toHaveLength(1);
    expect(checkRuleDiff({ removed: [OFFLINE_RULE], added: ['x/**'] })).toHaveLength(1);
    expect(checkRuleDiff({ removed: [OFFLINE_RULE, 'src/**'], added: [] })).toHaveLength(1);
    expect(checkRuleDiff({ removed: ['src/**'], added: [] })).toHaveLength(1);
  });
});

describe('package-offline --dry-run(PR 级静态校验)', () => {
  it('文件名只由 package.json 版本推导,ignore 差异断言通过', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const out = execFileSync(process.execPath, ['scripts/package-offline.mjs', '--dry-run'], { encoding: 'utf8' });
    const line = out.split(/\r?\n/).find((l) => l.includes(' → '));
    expect(line?.startsWith(`[package-offline] version ${pkg.version} → `)).toBe(true);
    expect(line?.replace(/\\/g, '/').endsWith(`/${vsixFileName(pkg, 'offline')}`)).toBe(true);
    expect(out).toContain(`去掉 [${OFFLINE_RULE}],新增 []`);
    expect(out).toMatch(/dry-run OK/);
  });
});
