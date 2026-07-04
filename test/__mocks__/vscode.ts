/**
 * 最小 vscode stub —— 让导入了 vscode 的模块能在 vitest 中加载,
 * 以便对其中的纯逻辑(如 recommendTier)做单元测试。
 * 仅覆盖被测模块在**模块顶层**引用到的符号;运行时 API 不在单测范围
 * (vscode 集成行为走 Extension Development Host 人工验证)。
 */
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const window = {};
export const workspace = {};
export const commands = {};
export const env = {};
export class Uri {}
export const ProgressLocation = { Notification: 15 };
export default {};
