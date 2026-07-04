# VoiceFlow for VS Code(preview)

Wispr Flow 式语音听写:按 `Ctrl+Alt+L` 说话,语音在**本地**转写为文字,经清理后插入当前聚焦的编辑器或集成终端。中英双语优化,面向中文开发者(代码注释、commit message、文档、给 AI 的 prompt)。

> **隐私声明**
> 音频永不离开本机。启用 AI 清理时,**转写文本**会发送给你选择的模型服务(Copilot / Claude / Codex);rules-only 模式下文本也不出本机。
> v0.1 零遥测。

## 快速开始

1. 安装 VSIX(GitHub Release,`win32-x64`)。whisper 二进制已内置,**无需任何手工配置**。
2. 首次启动会弹出**设置向导**:确认隐私声明 → 选模型档位(默认 small)→ 下载模型(断点续传 + hf-mirror 国内镜像)→ 引导第一次听写。也可随时运行命令 `VoiceFlow: Setup Wizard` 重开,或 `VoiceFlow: Download / Switch Model` 换档。
3. 光标放到编辑器或终端 → `Ctrl+Alt+L` 开始说话 → 再按结束(静音 3s 也会自动结束)→ 文字插入。
4. 任何阶段按 `Esc` 取消整个会话。

> **preview 为 CPU 版**:当前使用 whisper.cpp CPU 构建,small 档在普通开发机上端到端约 3 秒(含 AI 清理)。GPU 加速(Vulkan)在后续版本。

## 行为要点

- 插入目标在**录音开始时**锁定;若结束时原编辑器已关闭 / 光标位置失效 / 终端已退出,文本会复制到剪贴板并提示
- 终端插入**不自动回车、不代执行**——你自己确认后再按 Enter
- 录音超过 30s 时,插入前会弹出确认预览(可在设置关闭)
- AI 清理是增强层:不可用/超时(8s)时自动回落本地规则清理,听写永不被阻塞
- 模型空闲 10 分钟自动卸载省内存(可设 0 常驻)

## 已知限制

### Smart App Control(智能应用控制)可能拦截录音

VoiceFlow 用一个小型本地程序(`voiceflow-mic.exe`)采集麦克风。Windows 11 的 **Smart App Control(SAC)** 会拦截**未签名、暂无信誉**的程序,而本 preview 的录音组件**尚未代码签名**。

- **现象**:开启 SAC 的机器上,**首次**按 `Ctrl+Alt+L` 可能提示"录音组件被智能应用控制拦截"。
- **多为暂时性**:SAC 用微软信誉图谱(ISG)评估未知程序 —— 同一个固定二进制被"看到"并评估后通常会**自动放行**。**过一会儿再试**往往即可正常录音;本 preview 固定了单一 helper 二进制(不随构建变哈希),正是为了让它稳定地"养熟"放行,随下载量累积信誉也会改善。
- **判断是否开启 SAC**:设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制。
- **不建议为此关闭 SAC**:一旦关闭需重装系统才能重开。受控/企业环境如持续被拦,请等待后续**已签名**版本。
- whisper 转写二进制来自 whisper.cpp 官方 release、具备信誉,不受影响;仅本地采集组件涉及此限制。
- 正式发布前将对录音组件代码签名以彻底消除此限制。

### 其他

- `Ctrl+Alt+L` 与 IntelliJ IDEA Keymap 扩展的默认绑定冲突,可在 Keyboard Shortcuts 中改绑
- 不支持插入 Copilot Chat 输入框(VS Code 无公开 API)
- 仅 Windows x64;macOS/Linux 计划 v2
- 不支持按住说话(push-to-talk);Remote/WSL 支持为验证目标,限制以实测为准
- 流式边说边出字暂不支持

## 主要设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `voiceflow.language` | `auto` | 自动检测中/英(实测可靠);`zh` 会把纯英文语音翻译成中文,仅在 auto 误检时手动指定 |
| `voiceflow.model` | `small` | 模型档位(CPU 版实测:small 均衡·推荐;向导可换档) |
| `voiceflow.cleanup.provider` | `auto` | `auto`(rules + Copilot 可用则用)/ `rules-only` / `claude-cli` / `codex-cli` |
| `voiceflow.recording.autoStopSilence` | `3` | 静音自动结束(秒,0=关) |
| `voiceflow.whisper.idleUnload` | `10` | 模型空闲卸载(分钟,0=常驻) |
| `voiceflow.rules.*` | `true` | 各条本地清理规则独立开关 |

完整设置见 VS Code 设置页搜索 "voiceflow"。

## 开源属性

VoiceFlow 本体 MIT。VSIX 实际分发的第三方组件(无 GPL 传染,详见 `THIRD-PARTY-NOTICES.md`):

- **whisper.cpp**(v1.9.1 CPU 构建,MIT)—— 本地转写二进制
- **Whisper ggml 模型**(MIT)—— 用户首启下载
- **opencc-js**(MIT + Apache-2.0)—— 繁体转简体

> preview 采用 whisper.cpp 的 **CPU(no-BLAS)** 构建,不含 OpenBLAS。`@ricky0123/vad-web` / `onnxruntime-web` 仅为暂不可用的实验性 webview 录音路线的依赖,**不随 VSIX 分发**。
