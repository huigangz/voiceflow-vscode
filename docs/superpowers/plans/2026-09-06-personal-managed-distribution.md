# VoiceFlow Personal / Managed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 默认在当前会话串行执行；不自动派遣子代理。

**Goal:** 用同一源码交付身份隔离、组件正确、公司环境可验证的 Personal / Managed Windows x64 安装包。

**Architecture:** 固定的两个发行 profile 驱动 manifest、运行时能力及组件清单。现有录音/转写业务共享，通过少量工厂入口约束副作用；每次在全新目录构建并校验最终 VSIX。

**Tech Stack:** TypeScript、VS Code Extension API、esbuild、Node.js、Vitest、vsce、现有 whisper.cpp / Transformers.js / ONNX Runtime。

---

设计依据：[完整规格](../specs/2026-09-06-personal-managed-distribution-design.md)。本文实现 R1；R2 GPU 与 R3 独立 MT 不包含在 R1 完成声明中。

## 执行约束

- 本次只写文档，下面所有步骤尚未执行。
- 实施前记录 `git status --short`，保留既有未跟踪计划、日志和评审文档。只提交该任务精确路径，不使用 `git add .`。
- 不运行递归删除，不删除目录，不使用通配符删除。新暂存目录不覆盖旧目录。现有 fetch/model 脚本含删除分支，改造到无删除路径前不得直接调用。
- 先做针对性失败测试，再实现，再跑相关回归。真实麦克风测试不混入默认自动化；使用 fake recorder 和合成音频。
- 每任务通过后形成独立提交；不推送、不上架。正式发布前检查 A1–A11，未经验证的项目记录失败或未执行，不能标为通过。

## 文件职责

| 文件 | 责任 |
|---|---|
| 新增 `distribution/profiles.json` | 两个固定发行版身份与能力 |
| 新增 `src/distribution/profile.ts` | 类型化构建 profile 和允许能力查询 |
| 新增 `src/distribution/identity.ts` | 命令、上下文、配置命名空间 |
| 新增 `src/distribution/unsupportedBackend.ts` | Managed 不支持后端的明确错误，供构建别名使用 |
| 新增 `scripts/package-edition.mjs` | 暂存、生成 manifest、打包、调用验证 |
| 新增 `scripts/verify-vsix.mjs` | 实际 VSIX 的身份/文件/哈希校验 |
| 新增 `scripts/package-model.mjs` | 根据现有 ONNX 清单生成模型资源包 |
| 修改 `esbuild.mjs` | edition、输出目录、metafile、Managed 模块裁剪 |
| 修改 `scripts/verify-bin.mjs` | 从发行描述选择精确组件子集 |
| 修改 `scripts/fetch-whisper.mjs`、`scripts/stage-bundled-model.mjs` | 显式目标目录，避免全局暂存和删除 |
| 修改 `src/extension.ts`、`src/ui/*`、`src/stt/modelManager.ts` | 身份、向导、能力检查与模型导入 |
| 修改 `src/stt/engineManager.ts`、`src/translation/sessionPreflight.ts` | 引擎及翻译入口能力检查 |
| 修改 `src/stt/onnxModels.ts` | 导入候选目录与已验证模型根路径兼容 |
| 修改 `src/stt/inprocessEngine.ts`、`src/audio/*Controller.ts`、`src/audio/loopbackRecorder.ts` | 独立的完整性发布前置修复 |
| 修改 `package.json`、`.gitignore`、`README.md` | 命令、暂存忽略和用户文档 |
| 新增 `docs/distribution.md` | 两版安装、模型导入、升级和故障诊断 |

## Task 1：确定发行契约与身份

**Files:** 新增 `distribution/profiles.json`、`src/distribution/profile.ts`、`src/distribution/identity.ts`、`test/distributionProfile.test.ts`；修改 `esbuild.mjs`。

- [ ] 写契约测试：Personal 保留原 ID/namespace；Managed 使用新 ID/namespace；未知 edition 失败；发行能力为只读，设置不能修改。

契约示例（这些导出在本任务实现）：

```ts
export type Edition = 'personal' | 'managed';
export interface DistributionProfile {
  readonly edition: Edition;
  readonly extensionName: string;
  readonly namespace: 'voiceflow' | 'voiceflowManaged';
  readonly allowChildProcesses: boolean;
  readonly allowExternalProviders: boolean;
  readonly allowModelHttp: boolean;
}
// getProfile(edition) 从同一 JSON 描述取值，未知值抛错。
// commandId(profile, suffix) 与 contextKey(profile, suffix)
// 返回 `${profile.namespace}.${suffix}`。
```

```ts
it('managed identity and capability are independent', () => {
  const p = getProfile('managed');
  expect(p.extensionName).toBe('voiceflow-managed');
  expect(commandId(p, 'toggleDictation')).toBe('voiceflowManaged.toggleDictation');
  expect(p.allowChildProcesses).toBe(false);
  expect(p.allowExternalProviders).toBe(false);
  expect(p.allowModelHttp).toBe(false);
  expect(() => getProfile('unknown')).toThrow();
});
```

- [ ] 运行 `npx vitest run test/distributionProfile.test.ts`，确认失败来自尚未实现的契约。
- [ ] 实现上述固定 profile 和命名 helper；esbuild 显式注入所选 profile，不依赖用户设置决定 edition。开发构建显式使用 personal，发行脚本必须传 edition。
- [ ] 重跑该文件及 `npm run typecheck`；预期全部通过。提交本任务精确文件。

## Task 2：隔离 manifest、运行配置和同装行为

**Files:** 修改 `src/extension.ts`、`src/ui/statusBar.ts`、`src/ui/setupWizard.ts`、`src/stt/modelManager.ts`；新增 `test/distributionIdentity.test.ts`；按搜索结果更新其他实际读取设置/调用命令的位置。

- [ ] 用 `rg -n "voiceflow\.|getConfiguration|affectsConfiguration|registerCommand|setContext" src package.json` 枚举真实引用。仅把产品身份引用接到 Task 1 helper，日志文本不批量替换。
- [ ] 写测试：Managed 的 status bar command、录音 context、设置读写和变更监听均使用 Managed namespace；Personal 原名称不变。
- [ ] 写同装测试：fake `vscode.extensions` 同时含两 ID 时 Personal 激活返回前不创建 recorder/engine/provider；Managed 仍可用。监听扩展变化仅提示重载，不在会话中切换。
- [ ] 实现激活优先级检查（Managed 存在且启用时优先）、各自 enabled context 和带 context 的 keybindings。将 profile 注入向导/model manager；不要硬编码第二套业务类。
- [ ] 运行 `npx vitest run test/distributionIdentity.test.ts test/setupWizard.test.ts test/translationStatus.test.ts test/segmentInserterVisibility.test.ts` 及 typecheck；预期无跨 namespace 引用行为。
- [ ] 提交身份隔离；此时不声称依赖已裁剪。

## Task 3：公司版能力边界和外部服务显式授权

**Files:** 修改 `src/extension.ts`、`src/stt/engineManager.ts`、`src/stt/modelManager.ts`、`src/ui/setupWizard.ts`、`src/translation/sessionPreflight.ts`；新增 `test/managedPolicy.test.ts`、`test/personalCleanupConsent.test.ts`。

- [ ] 在现有依赖注入/模拟基础上写参数化测试；监控 server/CLI/helper 工厂、`spawn/execFile`、provider discovery、`fetch`。场景必须包括激活、设置变更、向导、后台 prepare、录音回退和分段 cleanup。

测试输入矩阵：

```ts
const forbiddenManagedRequests = [
  { key: 'whisper.mode', value: 'server' },
  { key: 'whisper.mode', value: 'cli' },
  { key: 'recorder', value: 'helper' },
  { key: 'cleanup.provider', value: 'auto' },
  { key: 'cleanup.provider', value: 'claude-cli' },
  { key: 'cleanup.provider', value: 'codex-cli' },
  { key: 'translate.target', value: 'zh' },
];
// 每个输入：不调用相应副作用；返回可解释的拒绝结果。
// 单独覆盖 translate.target=en：Managed R1 不暴露翻译功能，不能误当转写成功。
```

- [ ] 先运行两个新增测试文件确认失败，再实现能力约束：Managed 固定 inprocess、addon-only、rules-only，不探测不允许的后端。设置变化时取消/拒绝新会话，不把转写结果冒充翻译。
- [ ] Personal 新安装默认 rules-only；旧用户 `auto` 但无明确授权记录时也按 rules-only。显式选择外部服务后写本版 globalState 授权；撤回授权在下一次外部调用前生效。不要只改 manifest 默认值。
- [ ] 向导移除 Managed 的 `createVscodeLmProvider` 调用及“自动增强”文案；明确原生模块可能无法加载，禁止 helper 回退。
- [ ] 运行 `npx vitest run test/managedPolicy.test.ts test/personalCleanupConsent.test.ts test/engineManager.test.ts test/engineBlocked.test.ts test/setupWizard.test.ts test/translationSession.test.ts test/translationPrivacy.test.ts` 和 typecheck；预期 Managed spies 为零，Personal 显式授权路径保留。
- [ ] 提交运行时边界。

## Task 4：离线模型导入与资源包

**Files:** 修改 `src/stt/modelManager.ts`、`src/stt/onnxModels.ts`、`scripts/stage-bundled-model.mjs`；新增 `scripts/package-model.mjs`、`test/managedModelImport.test.ts`、`test/modelResourceManifest.test.ts`。

- [ ] 写测试：完整模型导入、缺 tokenizer、任一文件哈希错误、完成标记伪造、取消、磁盘不足、旧模型已存在。使用合成小文件和测试清单，不下载真实权重。
- [ ] Managed 缺模型测试替换 fetch 为“调用即失败”；验证激活和 ensure 只提示导入，连公共模型清单探测都不发生。
- [ ] 实现“新候选目录 → 按当前清单逐文件校验 → 提交活动模型根路径”的导入事务，复用现有 `resolveInprocessPaths`。失败保持旧路径和状态，候选目录保留，不清理。将原有自动删除后重下的恢复路径从 Managed 调用链排除。
- [ ] `package-model.mjs` 从现有 ONNX 清单生成资源包文件集合与模型清单哈希；接受显式 `--from`、`--output`，没有默认私人 globalStorage 源；输出存在则拒绝覆盖。
- [ ] `stage-bundled-model.mjs` 增加显式目标目录；新发行流程只调用显式源/目标模式。offline VSIX 和资源 ZIP 使用同一清单，不把 Personal 的 `.bin` 模型混入 Managed。
- [ ] 运行 `npx vitest run test/managedModelImport.test.ts test/modelResourceManifest.test.ts test/modelManager.test.ts test/onnxModels.test.ts test/inprocessNoNetwork.test.ts`。预先检查涉及测试的临时文件操作，改用不删除的隔离测试路径；预期所有失败保持已安装模型，fetch 零调用。
- [ ] 提交离线资源路径。实际大模型打包留到 Task 7 的显式已验证输入。

## Task 5：隔离暂存、组件裁剪和最终包校验

**Files:** 新增 `scripts/package-edition.mjs`、`scripts/verify-vsix.mjs`、`src/distribution/unsupportedBackend.ts`、`test/distributionPackage.test.ts`；修改 `esbuild.mjs`、`scripts/verify-bin.mjs`、`scripts/fetch-whisper.mjs`、`package.json`、`.gitignore`。

- [ ] 写 manifest/文件清单测试：同版 identity 一致、Managed 禁止 EXE/Whisper DLL、轻量包不带模型、offline 仅带清单模型、未知文件拒绝。合成 ZIP 内含 `extension/debug.log`、`.worktrees/`、WAV 或嵌套 VSIX 时必须失败。
- [ ] 实现新暂存生成，禁止根目录整体复制。生成 manifest 移除仓库 scripts；配置、命令和 keybindings 按 profile 生成；只复制白名单文件和许可证。
- [ ] Managed 构建将 helper、Whisper runner、外部 provider 的运行实现映射到明确 unsupported 的模块，保留必须的共享常量/类型。若共享常量迫使带入实现，只提取该常量到小文件，不重构整个 STT 层。检查 metafile 不含这些运行实现。
- [ ] 改造二进制准备支持显式目标、唯一解压目录和按 profile 检查。Managed 不执行 Whisper/helper 下载步骤。所有新路径不调用 `rm/rmSync`；缓存哈希错误时生成新缓存文件，不能自动删除旧文件。
- [ ] 打包器调用本地 vsce 的已解析 CLI 路径，使用 `execFile` 参数数组；`cwd` 指向暂存目录，参数为 `package --no-dependencies --target win32-x64 --out <绝对路径>`。成功后立即将同一路径交给 verify，禁止扫描“最近一个包”。
- [ ] verifier 读取实际 ZIP 的 manifest 与条目，用 edition、组件清单和 optional 模型清单校验；输出全部违规，失败 exit 1。检验路径穿越、非白名单文件、关键嵌套 `package.json`、许可证和各文件哈希。包体积作为报告，不按大小猜 edition。
- [ ] 新增以下 npm scripts；这些是目标命令，当前仓库尚不存在：

```json
{
  "package:personal": "node scripts/package-edition.mjs --edition personal",
  "package:managed": "node scripts/package-edition.mjs --edition managed",
  "package:managed:offline": "node scripts/package-edition.mjs --edition managed --bundled-model",
  "verify-vsix": "node scripts/verify-vsix.mjs"
}
```

- [ ] 保留原 `package` 作为 Personal 命令别名；旧 `package:bundled` 明确报迁移说明和新命令，不继续打混合模型包。根 `vscode:prepublish` 只做开发编译，准备运行组件统一由新发行脚本负责。
- [ ] `npx vitest run test/distributionPackage.test.ts test/distributionProfile.test.ts`、typecheck 通过后，以小型 fixture 执行 Personal→Managed→Personal 暂存验证。比较根 manifest/bin/dist 哈希，预期不变。
- [ ] 提交构建/验证链。

## Task 6：公司版正式发布的完整性前置修复

**Files:** 修改 `src/stt/inprocessEngine.ts`、`src/audio/loopbackRecorder.ts`、`src/audio/recordingController.ts`、`src/audio/segmentedRecordingController.ts`；扩展 `test/inprocessEngine.test.ts`、`test/loopbackRecorder.test.ts`；新增 `test/recordingController.test.ts`、`test/segmentedRecordingController.test.ts`。

- [ ] 长录音先复现：合成 45/120 秒输入，把不同标记放在 35 秒及录音末段；spy 验证所有样本进入块推理。显式语言与 auto 两条路径都覆盖。
- [ ] 基于现有模型窗口实现分块和边界合并；不得仅截短用户录音来令测试通过。取消在块间检查；返回全部块结果。模型真实质量和重复控制通过 Task 7 已校对音频验证。
- [ ] 停止竞争先复现：第一帧 VAD 用 deferred Promise 阻塞，调用 stop，记录 active VAD 数和 stop 返回后的事件数。

关键断言：

```ts
expect(maxConcurrentVadCalls).toBe(1);
expect(eventsAfterStopResolved).toBe(0);
expect(emittedFrameIds).toEqual(inputFrameIdsBeforeStop);
```

- [ ] 让 stop 等待在途 tick 后再排空；stop 的并发调用共享完成 Promise。dispose/cancel 继续保证旧代事件不再交付，不能等待一个永不释放的测试 gate。
- [ ] 控制器统一“请求停止”和“停止完成”语义：手动/静音停止接受已经采集的尾帧但不再触发 policy；max-duration 按明确采样边界截止，不无限冲刷超过上限。分别测试 finish、auto-stop、cancel、error。
- [ ] 运行 `npx vitest run test/inprocessEngine.test.ts test/loopbackRecorder.test.ts test/recordingController.test.ts test/segmentedRecordingController.test.ts test/recordingPolicy.test.ts test/segmentPipeline.test.ts` 及 typecheck。ASR 与录音修复分别提交，方便独立审查。

## Task 7：真实产物、升级路径与交付文档

**Files:** 修改 `README.md`；新增 `docs/distribution.md`；产物写入 gitignored `artifacts/`。

- [ ] 从明确指定、已校验的运行组件和模型目录构建：

```powershell
npm run package:personal
npm run package:managed
# 以下源目录由实施者替换为用户提供或已验证的实际绝对路径。
# 不提供源目录时命令应清楚失败，不自行寻找用户的私人缓存。
npm run package:managed:offline -- --model-source C:\VoiceFlowReleaseInputs\whisper-small-q8
```

- [ ] 每个打包命令自动运行最终 VSIX 校验；保存 edition、版本、revision、条目数、大小和 SHA-256 报告。额外手动检查 vsix manifest 身份与关键运行库，不把测试素材复制到发布目录。
- [ ] 在独立 VS Code user-data/profile 依次安装轻量 Managed + 本地模型、offline Managed、Personal。无管理员权限测试；以 fake/阻断方式先覆盖副作用，再在允许的公司测试机验证真实原生模块加载。
- [ ] 按规格 A1–A11 逐项记录实际结果。真实音频至少包含 45 秒、120 秒、英语、日语和中文，末段含人工校对标记；标记完整率必须 100%，不能只验证 WAV 长度。
- [ ] 验证同装只启用 Managed 听写；禁用后重载恢复 Personal。验证 Personal 旧设置与缓存保留、Managed 不继承外部授权；Managed 升级/回滚不读取不匹配模型。
- [ ] 文档说明：两版选型、CPU 首版事实、原生模块限制、本地/UNC 区别、模型资源包解压导入、更新 ID、同装规则、故障定位。列出 GPU 和独立 MT 尚不在 R1。
- [ ] 仅在全部门槛通过时标记 R1 可发布；本任务不执行远程发布。提交源代码/文档，不提交 VSIX、权重或录音。

## 需求到任务的追踪

| 规格要求 | 实施任务 | 验收 |
|---|---|---|
| 双 ID、设置/命令隔离、同装行为 | 1、2 | A1、A8、A9、A10 |
| 运行时公司策略、外部整理授权 | 3 | A3、A4、A7、A9 |
| 离线资源、事务导入、不自动联网 | 4 | A4、A5、A6 |
| 组件裁剪、独立暂存、最终包守卫 | 5 | A1、A2、A5 |
| 长录音及停止完整性 | 6 | A11 |
| 真实环境和升级文档 | 7 | 全部 A1–A11 |

## 后续阶段入口

- R2 在 R1 的 Personal 组件描述下单独验证 GPU，不修改 Managed 默认能力；必须提交真实 backend 日志、显存峰值、冷/热延迟和对照转写结果后再选默认模型。
- R3 先实现不依赖录音的文本 MT 服务和命令，再允许向导选择 ASR/MT/both；仅 MT 测试应证明不构造 recorder、不加载 ASR、不下载 ASR 模型。公司版依然禁止外部 provider，缺本地 MT 时不显示可完成的安装选项。

这两个入口用于保留整体产品方向；不把尚未细化的 R2/R3 算入本计划已完成范围。
