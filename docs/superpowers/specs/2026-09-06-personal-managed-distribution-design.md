# VoiceFlow 个人版与公司版发行设计

日期：2026-09-06

状态：方案二已获用户同意；本文为具体设计，尚未实施。

配套计划：[实施计划](../plans/2026-09-06-personal-managed-distribution.md)

## 1. 目标与决定

同一代码库、同一核心逻辑，生成 Personal 和 Managed 两种 Windows x64 VSIX。按发行版裁剪组件、确定能力上限、生成设置与命令清单，分别分发和更新。不得复制整套业务代码或维护两个长期产品分支。

个人机目标是质量优先、允许 GPU；公司机目标是 CPU 可用、离线可安装、适配应用控制。公司版不是低质量版，也不承诺绕过公司策略。

取舍：统一包加环境向导无法有效裁剪组件；两个独立项目会产生修复不同步。因此采用用户同意的构建双包方案。

## 2. 已核对的现状

| 位置 | 当前行为 | 对分包的影响 |
|---|---|---|
| `package.json` | ID 为 `voiceflow-preview.voiceflow-vscode`；已有 `package`、`package:bundled` | 普通/离线仅区别模型携带，尚无发行版身份 |
| `esbuild.mjs` | 单入口 `src/extension.ts`，单输出 `dist/extension.js` | 需要按发行版传入构建常量和独立输出路径 |
| `vscode:prepublish` | 无条件准备 helper 和 CPU Whisper | 公司版不能继续复用无条件安装链 |
| `.vscodeignore*` | 根目录黑名单式排除 | 新文件可能混入发布包，应以隔离暂存与白名单校验替代 |
| `bin.manifest.json` | 固定 CPU Whisper、helper、loopback 和原生模块哈希 | 校验必须按发行版精确选取组件 |
| `src/ui/setupWizard.ts` | 环境选择后下载模型；公司分支仍探测外部整理服务 | 公司版不能只把默认引擎改成 inprocess |
| `src/stt/engineManager.ts` | server/CLI/inprocess 已有接口和回退 | 保留接口，增加发行版能力约束 |
| `src/stt/modelManager.ts` | 本地模型、内置模型、在线下载与导入 | 公司版缺模型时必须阻止公共下载回退 |
| `scripts/stage-bundled-model.mjs` | 写根目录 `offline-model/`，默认读取旧 ID 存储目录 | 新构建必须显式指定模型源和暂存目标 |
| `src/translation/*` | 主要服务音频翻译；中文翻译依赖外部 LLM | 尚无完整独立文本翻译/本地 MT 安装路径 |

## 3. 分阶段交付

### R1：可实际发布的双版本基础

交付两个轻量程序包、一个公司版 ASR 离线模型资源包；公司版内置同一模型的 VSIX 作为便利交付方式。内置/外置模型不形成第三种产品身份。

R1 个人版延续已验证的 CPU Whisper 和 inprocess 回退，明确显示 CPU。R1 公司版仅提供本地录音转写，默认 inprocess small-q8。两版共享已修复的录音与转写逻辑。

R1 不新增独立 MT 引擎，不把现有音频翻译包装成“仅文本翻译”；不以未验证 GPU 加速作为发布宣传。个人版保留现有可用翻译能力，公司版暂不暴露会调用外部服务的翻译。

### R2：个人版 GPU 质量档

在 R1 的 Personal 组件清单下接入经过验证的 GPU 运行组件，验证驱动兼容、实际设备、显存不足回退和较大模型质量。优先测试用户 RTX 5060 约 8GB 显存；不推断其他个人机也有同等硬件。CPU 保持可用。具体 GPU 后端、二进制版本与哈希由独立验证结果确定，未通过时继续发布 CPU 档，不虚报 GPU 状态。

### R3：按功能安装 ASR / MT / 两者

保持两个发行版，通过模型资源选择功能。前提是完成独立文本翻译入口、MT 模型生命周期和无 ASR 运行测试。公司版只允许本地 MT。R3 单独形成实现规格，不在 R1 植入空 provider 或不可用按钮。

| 选择 | 输入 | 必需能力 |
|---|---|---|
| 仅转写 | 麦克风、系统音频 | 采集 + ASR |
| 仅文本翻译 | 文本 | MT，不加载 ASR、不申请麦克风 |
| 两者 | 音频、文本 | ASR + MT，按需加载 |
| 音频翻译 | 音频 | ASR + MT；不是“仅 MT” |

## 4. R1 发行矩阵

| 项目 | Personal | Managed |
|---|---|---|
| 扩展 ID | 保持 `voiceflow-preview.voiceflow-vscode` | 新建 `voiceflow-preview.voiceflow-managed` |
| 显示名 | VoiceFlow Personal | VoiceFlow Managed |
| 设置前缀 | 保持 `voiceflow` | `voiceflowManaged` |
| 命令/上下文前缀 | 保持 `voiceflow` | `voiceflowManaged` |
| ASR | 已有 CPU server / CLI / inprocess | 仅 inprocess small-q8 |
| 麦克风 | addon，保留既有 helper 回退 | addon；禁止 helper 回退 |
| 系统音频 | 既有 loopback + Silero | 同一 loopback + Silero；原生模块被拦截则解释失败 |
| 整理服务 | 默认 rules-only，用户明确选择后启用外部服务 | 仅 rules-only，不发现/初始化外部 provider |
| 模型来源 | 现有在线下载、本地导入 | 内置包、本地或用户显式选择的 UNC 目录 |
| 模型 HTTP 下载 | 用户发起的现有来源 | R1 禁用，包括自动镜像回退 |
| 程序更新 | 现有公开分发渠道；若上架，沿用原 ID | 独立 ID，仅内部分发固定版本 VSIX |
| 模型缓存 | 原有 globalStorage | 新 ID 的 globalStorage，不隐式共享或搬迁 |

这是首版产品选择，不是对公司允许范围的推断。后续若需要内部 HTTPS 镜像，应另加受控源配置和逐跳重定向验证；R1 用本地/UNC 导入满足离线分发。UNC 是用户授权的模型读取，不等于完全无网络；“纯离线验收”只使用本地磁盘。

已有 Personal 用户的设置保留；对于从旧版继承的 `cleanup.provider=auto`，迁移后在用户明确启用外部处理前按 rules-only 执行。不得把历史自动发现状态当成用户授权。确认状态按扩展 ID 保存。

## 5. 构建与组件隔离

新增一个小型发行描述表 `distribution/profiles.json`，只表达两个固定产品，不建立插件框架。包含 edition、manifest name/displayName、namespace、允许的引擎/录音后端、外部服务和模型 HTTP 下载开关。

新增 `scripts/package-edition.mjs`：读取根 manifest 和 profile → 创建全新暂存目录 → 生成 manifest → 构建 bundle → 按精确白名单复制运行文件 → 可选复制已验证模型 → 调用 vsce → 校验实际 VSIX。

约定：

- 暂存根 `.release-stage/`，每次用唯一子目录；产物在 `artifacts/`。两者加入 `.gitignore`。
- 不修改根 `package.json` 的产品身份、根 `dist/`、根 `bin/` 或根 `offline-model/` 来切换版本。
- 生成 manifest 移除仓库开发脚本和 `vscode:prepublish`，以 `vsce package --no-dependencies --target win32-x64` 打包已准备完整的暂存目录。依赖由白名单显式复制，不靠 vsce 自动遍历依赖树。
- 不复制整个 `node_modules`；沿用当前 PvRecorder / ONNX Runtime 最小运行文件集合，保留必需的嵌套 `package.json` 和许可证。
- Managed 不含 `voiceflow-mic.exe`、`whisper-server.exe`、`whisper-cli.exe`、Whisper/ggml DLL，也不得在启动时下载它们。
- Managed 保留 PvRecorder `.node`、loopback `.node`、ONNX Runtime 及 Silero。原生 DLL 可被公司策略拦截，文档不声称“绝无弹窗”。
- 公司版 bundle 不包含外部 provider 和 helper/Whisper 可执行路径的实现模块；采用构建入口选择/别名到明确报“不支持”的轻量实现，并用 esbuild metafile 校验。共享转换/类型代码可保留。
- 版本号从根 manifest 读取，不硬编码 `0.3.1`；元数据记录 edition、版本、源码 revision、lockfile 哈希、组件哈希和模型清单版本。工作区有未提交实现改动时不得生成正式 release 元数据，开发包标记 dirty。
- 所有新增打包路径不执行删除，也不调用现有脚本的递归删除分支。使用唯一暂存目录，已有同名产物时报错，旧产物留给用户管理。

产物命名：

```text
voiceflow-personal-win32-x64-<version>.vsix
voiceflow-managed-win32-x64-<version>.vsix
voiceflow-managed-win32-x64-<version>-offline.vsix
voiceflow-asr-small-q8-<modelManifestHash>.zip
release-manifest.json
```

offline VSIX 与轻量 Managed VSIX 的 ID、版本、运行代码一致，差异仅为已校验模型资源。

## 6. 运行时能力与配置

构建常量选定发行版；运行时显示 edition、实际引擎和实际计算设备。未知/缺失发行版参数使发行构建失败，开发构建显式使用 Personal。

权限顺序：发行能力上限 → 已安装资源 → 用户偏好 → 会话配置。Managed 中即使用户在本版 namespace 写入 `whisper.mode=server`、`recorder=helper`、`cleanup.provider=auto` 或外部翻译配置，也不能触发进程/服务发现/网络。返回明确的不支持提示，不静默切换成另一种输出任务。

限制必须覆盖首次激活、向导、命令、设置变更、模型恢复、后台预热、录音自动回退、批量/分段清理与翻译预检。界面隐藏只是展示，不是唯一约束。

不使用全局 monkey patch 拦截 Node API；在现有工厂和外部副作用入口进行能力检查，并在测试中用 spy 验证未调用。

## 7. 身份、共存和迁移

VS Code 的产品身份由 `publisher.name` 决定，因此文件名不同不足以隔离更新。Personal 保留原 ID，避免打断现有用户；Managed 新 ID 单独分发。

增加 `src/distribution/identity.ts` 集中提供 namespace、命令 ID、context key 和配置读取。manifest 的 commands、keybindings、configuration 及运行时代码从同一 profile 派生，禁止任意字符串替换整个 bundle。检查 `statusBar`、`sessionActive`、设置监听和命令调用，防止残留跨版引用。

两版安装到同一 VS Code profile 时，Managed 优先，Personal 不初始化录音/引擎/外部服务，也不注册听写快捷键对应的可用上下文；显示一次提示说明需禁用 Managed 并重载才能使用 Personal。各自 keybindings 增加 edition-specific enabled context。Managed 卸载或禁用后提示重载，不在正在录音时自动切换。此规则避免双录音、双插入和公司版环境中意外启动个人版处理。

不读取另一扩展的私有 globalState 或移动其缓存。切换发行版通过新向导显式导入本地模型；仅接受新版本清单验证通过的资源。Personal 旧命令和配置继续兼容，Managed 使用独立名称，不同步复制旧外部服务授权。

## 8. 安装和离线模型

VSIX 安装本身不是 MSI 自定义安装器；环境/模型选择位于首次运行向导。

Personal 向导：介绍实际 CPU 能力 → 选 ASR 模型 → 完成模型准备 → 可选外部整理授权 → 完成。R2 后显示经验证的 GPU 能力。

Managed 向导：说明本地处理与原生依赖 → 检查内置/已安装模型 → 若缺失，选择本地模型目录或解压后的资源目录 → 验证全部文件 → 准备引擎 → 完成。不得调用 `createVscodeLmProvider` 或展示自动开启外部整理文案。取消/失败不标记 completed，不破坏已可用模型。

离线模型资源包使用 `onnxModels.ts` 现有文件/大小/SHA-256 清单作为权威来源，包含 tokenizer、配置及所需 ONNX 文件；完成标记不能代替文件哈希校验。ZIP 由用户解压后通过目录导入，R1 不新增运行时 ZIP 解压器。

导入前检查空间，导入到新的候选目录，校验成功后才提交活动路径和完成状态；旧版本保留，不自动删除。损坏、缺文件、目录不可读和磁盘不足均保留原模型，禁止偷偷在线修复。缓存路径调整必须兼容 `resolveInprocessPaths`，通过 model manager 传入选定根路径，禁止新增第二套模型路径推导。

## 9. 首次正式发布的前置质量门槛

分包不会修复转写缺陷，以下条件必须在公司版正式发布前满足：

1. inprocess 在 45 秒和 120 秒输入上处理全部音频，末段标记可被识别；不得仍仅处理前 30 秒。
2. loopback 停止等待在途处理，VAD 无并发调用；`stop()` 返回后无新音频帧。
3. 手动结束/自动结束的尾部处理有明确截止语义和回归用例。

这些修复与分包隔离提交，以便审查和回归；可先完成双包开发产物，但不得把未通过的构建标为正式可用。

## 10. 验收矩阵

| ID | 条件 | 必须观察到的结果 |
|---|---|---|
| A1 | 同一 revision 依次构建 Personal、Managed、Personal | 根文件不变；每个包 edition/ID/依赖集合正确，无串包 |
| A2 | 解包三个 VSIX | 无源码、测试音频、日志、工作树、计划或密钥文件；关键运行文件/许可证齐全 |
| A3 | Managed 设置强行指定 server/helper/外部整理/中文外部翻译 | 无 spawn、exec、provider 发现或网络调用，明确提示 |
| A4 | Managed 在无模型且断网环境激活、打开向导、执行转写 | 提示导入；不尝试 HF、镜像或外部模型 |
| A5 | 本地资源包和 offline VSIX | 全文件哈希通过；本地模型转写成功；无模型下载 |
| A6 | 模型损坏/导入取消/空间不足 | 原模型仍可用，setup 不误置 completed，无在线修复 |
| A7 | 非管理员公司机，禁止 child process | inprocess + 可加载 addon 转写成功；addon 被阻止时清楚报错，无 helper 回退 |
| A8 | 两版同装、禁用 Managed 后重载 | 同装仅 Managed 可录音；重载后 Personal 恢复，设置/状态互不污染 |
| A9 | Personal 从现有版本升级 | 原模型/命令可用；继承 auto 不自动向外部服务发文本 |
| A10 | 新旧 Managed 版本升级/回滚 | 不被 Personal 更新覆盖；只使用匹配模型清单，不破坏旧资源 |
| A11 | 长录音与停止竞争回归 | 满足第 9 节三项完整性门槛 |

测试中的“零网络/零子进程”指 VoiceFlow 发起的调用，不替 VS Code、其他扩展或公司设备管理软件作承诺。真实硬件测试使用明确授权的测试音频，不把用户录音放入 VSIX。

## 11. 范围与后续

本设计不新增多说话人识别、全套音频编辑器、云管理平台、管理员策略服务器、跨平台发行或第二套模型管理框架。GPU 和独立 MT 分别遵循 R2/R3，R1 不制造不可用的功能选项。

现有 `PLAN-vsix-release-guard.md` 的白名单思路纳入本方案，但不沿用按包大小猜版本、选最新产物验证、固定两版同一必需二进制集合等规则。输入必须显式指定 edition、模型携带方式和 VSIX 路径。其他既有计划不改写。

参考：[VS Code 扩展身份](https://code.visualstudio.com/api/references/extension-manifest)、[VSIX 打包与发布](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。
