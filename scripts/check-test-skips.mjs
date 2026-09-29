/**
 * CI 跳过白名单检查(harness PR2,fail-closed)。
 *
 * 原则:Hardware unavailable may skip. Deterministic prerequisite missing must fail.
 * test/ciPrereq.ts 的 requireInCi 只能管到已经改造过的测试;以后新写一个 skipIf 照样可能在 CI 里
 * 悄悄跳过。所以 CI 再读一遍 vitest JSON 报告:凡是被跳过的用例,其所在 describe 必须登记在下面的
 * 硬件白名单里,否则失败。
 *
 * 用法:node scripts/check-test-skips.mjs <vitest-json-report>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 允许在 CI 跳过的 describe(文件 + 顶层 describe 标题精确匹配)。只登记真实硬件 / 非可再分发数据。
 * 新增条目必须写明为什么无法在 CI 构造。
 */
export const ALLOWED_SKIPS = [
  { file: 'test/addonRecorder.test.ts', describe: 'AddonRecorder(真设备)', why: '真实麦克风设备(CI runner 无音频输入)' },
  { file: 'test/helperRecorder.test.ts', describe: 'HelperRecorder(真实 helper 进程)', why: '真实麦克风 + bin/voiceflow-mic.exe(test job 不打包 bin/)' },
  {
    file: 'test/sileroVad.test.ts',
    describe: 'SileroVad(真模型 + 本地语音样本)',
    why: 'test-audio/ 含个人录音不入 git;harness PR5 换成可再分发 fixture 后删除本条',
  },
];

const SKIPPED = new Set(['skipped', 'pending', 'todo', 'disabled']);

function relPath(p) {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/test/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/**
 * @param {object} report vitest JSON 报告
 * @param {typeof ALLOWED_SKIPS} [allowed]
 * @returns {{ disallowed: string[], allowedHits: string[], skippedTotal: number }}
 */
export function findDisallowedSkips(report, allowed = ALLOWED_SKIPS) {
  const disallowed = [];
  const allowedHits = new Set();
  let skippedTotal = 0;
  for (const file of report.testResults ?? []) {
    const rel = relPath(file.name);
    for (const t of file.assertionResults ?? []) {
      if (!SKIPPED.has(t.status)) continue;
      skippedTotal++;
      const top = t.ancestorTitles?.[0] ?? '';
      const rule = allowed.find((a) => a.file === rel && a.describe === top);
      if (rule) allowedHits.add(`${rule.file} › ${rule.describe}`);
      else disallowed.push(`${rel} › ${[...(t.ancestorTitles ?? []), t.title].join(' › ')}`);
    }
  }
  return { disallowed, allowedHits: [...allowedHits], skippedTotal };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('[check-test-skips] FATAL: 用法 node scripts/check-test-skips.mjs <vitest-json-report>');
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const { disallowed, allowedHits, skippedTotal } = findDisallowedSkips(report);
  const total = report.numTotalTests ?? '?';
  if (disallowed.length > 0) {
    console.error(`[check-test-skips] FAIL —— ${disallowed.length} 个跳过不在硬件白名单内(确定性测试不许在 CI 里悄悄跳过):`);
    for (const d of disallowed) console.error(`  - ${d}`);
    console.error('  处理:补齐前置条件(见 test/ciPrereq.ts),或确属硬件/不可再分发数据时登记到 ALLOWED_SKIPS 并写明原因。');
    process.exit(1);
  }
  console.log(`[check-test-skips] OK —— ${total} 个用例,跳过 ${skippedTotal} 个,全部属于白名单:`);
  for (const h of allowedHits) console.log(`  · ${h}`);
}
