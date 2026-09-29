/**
 * harness PR2:确定性前置条件在 CI 里不许"缺了就跳过"。
 *
 * 原则:硬件不可用可以 skip;可构造的确定性前置条件缺失必须 fail。
 * - 本地开发:缺前置条件 → 返回 false,测试照旧优雅跳过(开发者便利)。
 * - CI(VOICEFLOW_CI=1):缺前置条件 → 在收集阶段直接抛错,整个测试文件失败并说明原因。
 *
 * 只用于确定性前置条件(fixture exe、随 git 提交的模型、npm 依赖);
 * 真麦克风 / 真设备这类硬件条件不要走这里,而是登记到 scripts/check-test-skips.mjs 的白名单。
 */
export function requireInCi(available: boolean, reason: string): boolean {
  if (!available && process.env.VOICEFLOW_CI === '1') {
    throw new Error(`CI prerequisite missing: ${reason}`);
  }
  return available;
}
