# VoiceFlow for VS Code

Wispr Flow 式语音听写 VS Code extension(仅 Windows x64):按 `Ctrl+Alt+L` 说话 → **本地** whisper 转写 → 规则 / 可选 LLM 清理(可选翻译)→ 插入编辑器、终端或聚焦的输入框。

**权威来源**:本仓库的代码、测试和本文件。早期设计规格与各阶段 plan 是维护者本地文档(`docs/plans/` (local-only)),不在公开仓库里;agent 实现时以代码与测试为准,不要假设能读到它们。

## 核心原则(不可违背)

1. **本地闭环是成败标准**:录音 → 本地 whisper → 本地规则清理 → 插入,全程无外部依赖,必须稳定。LLM 清理 / 翻译只是增强层,不是 release gate。
2. **隐私**:音频永不离开本机;只有 LLM 清理与翻译到中文时,转写**文本**才发给用户选择的模型(翻译需显式开启 `voiceflow.translate.useLlm`);零遥测。
3. **规则层宁可少改,不可错改**:只做确定性轻清理(中英空格、简繁、全半角标点、去重复空格、去尾部幻觉),不做改写 / 翻译 / 意图猜测。
4. **闭环永不被 LLM 阻塞**:LLM 超时(默认 8s)/ 出错 / 输出为空或被拒 → 直接插入规则层结果。
5. **绝不代执行、代发送**:终端 `sendText(text, false)`,不回车、不转义;聚焦输入框(如 Copilot Chat)只输入文字,Enter 留给用户。

## 运行时拓扑

**麦克风录音**(`voiceflow.recorder` = auto | addon | helper)
- auto(默认)= PvRecorder 进程内录音(`src/audio/addonRecorder.ts`)。模块加载失败或被策略拦截(`module-unavailable` / `blocked-by-policy`)→ 当次回退 helper exe,并在本次运行期记住。
- helper = 预编译的 `prebuilt/voiceflow-mic.exe`(源码 `helper/MicCapture.cs`,SHA 固定;打包时放进 bin/),stdout 流 s16le PCM。
- 麦克风 VAD = host 侧 energy VAD(`src/audio/energyVad.ts`)。WebviewRecorder 源码保留但运行时不可达(webview 禁麦克风,microsoft/vscode#250568)。

**系统音频**("Dictate from System Audio",experimental)
- 自研 `voiceflow-audio.node`(WASAPI loopback,预编译在 `prebuilt/`,源码 `native/voiceflow-audio/`)→ 格式转换 → 静音补齐 → Silero VAD(`media/vad/silero_vad_v5.onnx` + onnxruntime-node)→ 分段管线。
- 单次上限 30 分钟(`voiceflow.systemAudio.maxDuration`),不因静音自停。

**转写(STT)**:`EngineManager`(`src/stt/engineManager.ts`)是引擎选择与回退的唯一归属,调用方只见 `WhisperEngine` 接口。
- server:whisper.cpp `whisper-server.exe`(默认主路径,常驻 + 空闲卸载);cli:server 二进制缺失时兜底。
- inprocess:ONNX(transformers.js 打进 bundle + onnxruntime-node,模型 small-q8)。setup wizard 选"受管机"直接写 `mode=inprocess`,零弹窗。
- 应用控制策略拦截 exe(受管机):
  - auto 模式 → 按二进制标识持久记住"被拦",之后直接走 inprocess。ONNX 模型**已就绪** → 切 inprocess,同一段音频重试一次;**未就绪** → 本次听写明确失败(不静默等下载),后台准备模型;准备成功后下次听写可用,准备失败则在下次触发时重试。
  - 显式 server / cli 模式 → 不回退,报错并提示改用 inprocess。
- 默认档位 small,语言默认 auto;**始终显式传 language**(whisper-server 缺省是 en,会把中文译成英文)。
- 模型下载:HF + hf-mirror,断点续传,SHA fail-closed(`voiceflow.model.sourceUrl` 可指内网 / 本地目录)。offline VSIX 内置 whisper small + ONNX small-q8。

**清理与翻译**
- 清理:规则层必跑 → 增强层(vscode.lm;claude-cli / codex-cli 须显式选择)。
- 翻译(`voiceflow.translate.target` = off | en | zh):en = 本地 Whisper translate(turbo 模型不支持);zh = LLM 翻译,需 `voiceflow.translate.useLlm`,首次有隐私提示;失败 → 规则层处理后的原文,连续失败会话内熔断。

**插入**(`src/insert/`)
- 目标在**录音开始时锁定**:editor / terminal / focused-input / none。光标漂移、编辑器关闭、终端退出 → 剪贴板兜底。
- focused-input(聚焦的非编辑器输入框,如 Copilot Chat):`voiceflow.insert.typeIntoFocusedInput` 控制,**默认关**(关 = 只进剪贴板)。开启时用 `type` 命令注入;若检测到文字实际落进了编辑器,自动撤销并留在剪贴板。
- 输出模式 `voiceflow.output.mode`:batch(默认,录完一次插入)/ segmented(每个停顿切一段增量插入;单段强制上限 20s)。segmented 下终端不逐段发送,结束时确认 Send / Copy。
- 录音 >30s 插入前轻量确认(可配置)。

## 源码结构

<!-- doc-check:src-layout(scripts/verify-doc-structure.mjs 校验:此处列出的 src 顶层条目必须与仓库完全一致) -->
- `src/extension.ts` — 入口:命令注册、会话编排、配置监听
- `src/session.ts` — 会话状态机(纯逻辑)
- `src/audio/` — 麦克风 / 系统音频采集、VAD、录音控制器
- `src/stt/` — 引擎接口、EngineManager、server/cli 封装、inprocess 引擎、模型下载与管理
- `src/segment/` — 分段切分、分段转写管线、段拼接
- `src/cleanup/` — 规则层、LLM provider(vscode.lm / CLI)、清理管线
- `src/translation/` — 翻译管线、会话预检、熔断、用量统计、隐私提示
- `src/insert/` — 目标锁定与分发、分段插入
- `src/ui/` — 状态栏、setup wizard
<!-- /doc-check:src-layout -->

其他:`test/`(vitest;提交的音频只能放 `test/fixtures/audio/`,只允许合成 / 可再分发来源,登记在 `test/fixtures/audio/fixtures.json` 并由测试机检,规则见 `test/fixtures/audio/README.md`;本地录音放 `test-audio/` (local-only))、`scripts/`(构建 / 打包 / 校验脚本)、`bin.manifest.json`(二进制与运行时资产的 SHA 清单)、`.github/workflows/`(CI 与 release)。

## 会话状态机(`src/session.ts`)

- batch:`idle → preparing → recording → transcribing → cleaning → inserting → idle`
- segmented:`idle → preparing → recording → draining → idle`(draining = 录音已停,剩余段仍在转写 / 插入)
- `Esc` 任何阶段 = 取消**整个会话**回 idle(非取消当前阶段);keybinding 的 when 条件避开补全、重命名、查找等控件。
- 错误 → 状态栏错误图标(点击看 OutputChannel)→ idle。

## 关键行为 invariant

- VAD 静音 ≥3s 且已有语音 → 自动结束;麦克风最大录音 120s。
- 模型空闲 10 分钟卸载(`voiceflow.whisper.idleUnload`,0 = 常驻);inprocess 另有驻留上限(`voiceflow.inprocess.maxResidentMinutes`,默认 30)。推理进行中或会话中不卸载。
- cold start(模型加载)不计入延迟指标,单独统计;埋点四段:cold start / warm transcription / cleanup / insert,仅写本地日志。
- 打包:standard VSIX 永不带模型;offline VSIX 的 ignore 由 `.vscodeignore` 生成(`scripts/package-offline.mjs`);两种包都由 `scripts/verify-package.mjs` 对**实际产物**按契约校验(白名单、精确集合、SHA、require 冒烟)。
- 配置项全表见 `package.json` 的 `contributes.configuration`,前缀 `voiceflow.*`。

## 开发命令

- 技术栈:TypeScript + VS Code Extension API(`engines.vscode` ^1.90),esbuild 打包,vitest 测逻辑层及部分集成路径(真实 Silero 模型、可运行时的 helper 进程、打包契约);原生部分见上文(PvRecorder、`voiceflow-audio.node`、onnxruntime-node、whisper.cpp 预编译二进制)。
- 构建 `npm run build`(esbuild);类型检查 `npm run typecheck`;测试 `npm test`(vitest);调试:F5 启动 Extension Development Host(EDH)。
- CI 同款测试 `npm run test:ci`(先 `npm run build:fixtures`;`VOICEFLOW_CI=1` 时确定性前置条件缺失即失败,跳过必须在硬件白名单里)。
- 二进制 `npm run bin`(place-helper + fetch-whisper + verify-bin)。
- 打包 `npm run package`(standard);`npm run package:offline`(先 `npm run fetch-offline-models` 按钉死 revision 拉模型),`npm run package:bundled`(从本机 globalStorage 暂存模型后打 offline)。
- 文档结构检查 `npm run verify-docs`(也在 `npm test` 里跑)。
- 转写质量 / CER:`node scripts/quality-test.mjs`(本地,需麦克风;`--rerun` 用已有录音重跑),结果写 `test-audio/` (local-only);归一化与 CER 定义在 `scripts/cer.mjs`。
- 发版:手动触发 `.github/workflows/release.yml` 产出两个 VSIX + SHA256SUMS(artifact),核对后**由人**创建 GitHub Release(pre-release,非 Marketplace)。版本号只改 `package.json`。

## 改动同步清单

PR 改到下列任何一项,同一 PR 内核对并更新本文件:
- 录音拓扑(recorder 选择 / 回退、系统音频链路)
- STT 引擎与路由(EngineManager、模式、回退、模型)
- `src/` 顶层结构(`npm run verify-docs` 会机检)
- 用户可见能力(新目标、新模式、新配置、隐私相关行为)
- 打包 / 发布拓扑(VSIX 内容、ignore、workflow)

## 人工 gate

硬件、VS Code 生命周期、Windows 策略、真实音频、插入 UX、安装发布这些无法自动化 → 清单在 `docs/manual-gates.md`。**CI 绿 ≠ 人工 gate 已过**;涉及这些行为的改动与每次发版前由人在 EDH / 真机执行。每个 step 完成后在 `worklog/` (local-only) 写日志:做了什么、自动测试结果、人工清单与结果。

## 当前不做

macOS / Linux、push-to-talk、流式出字(segmented 是按停顿分段,不是逐字流式)、全局听写(VS Code 外)、热词词典、prompt 模板系统、Marketplace 上架、Remote / WSL 支持(`extensionKind: ["ui"]` 强制本地运行)。

## 历史

各阶段的决策、实测数据与发版记录见 `docs/history.md`(从旧版本文件原文迁出)。
