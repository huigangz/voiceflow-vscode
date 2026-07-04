# VoiceFlow for VS Code(preview)

Wispr Flow 式语音听写:按 `Ctrl+Alt+L` 说话,语音在**本地**转写为文字,经清理后插入当前聚焦的编辑器或集成终端。中英双语优化,面向中文开发者(代码注释、commit message、文档、给 AI 的 prompt)。

> **隐私声明**
> 音频永不离开本机。启用 AI 清理时,**转写文本**会发送给你选择的模型服务(Copilot / Claude / Codex);rules-only 模式下文本也不出本机。
> v0.1 零遥测。

## 快速开始

1. 安装 VSIX(GitHub Release,`win32-x64`)
2. 首次使用:`VoiceFlow: Download / Switch Model` 下载模型(支持断点续传与 hf-mirror 国内镜像;也可手动下载 ggml 模型放入扩展存储的 `models/` 目录)
3. whisper.cpp 二进制:preview 阶段需在设置 `voiceflow.whisper.binaryDir` 指向本机 whisper.cpp(Vulkan build)目录
4. 光标放到编辑器或终端 → `Ctrl+Alt+L` 开始说话 → 再按结束(静音 3s 也会自动结束)→ 文字插入
5. 任何阶段按 `Esc` 取消整个会话

## 行为要点

- 插入目标在**录音开始时**锁定;若结束时原编辑器已关闭 / 光标位置失效 / 终端已退出,文本会复制到剪贴板并提示
- 终端插入**不自动回车、不代执行**——你自己确认后再按 Enter
- 录音超过 30s 时,插入前会弹出确认预览(可在设置关闭)
- AI 清理是增强层:不可用/超时(8s)时自动回落本地规则清理,听写永不被阻塞
- 模型空闲 10 分钟自动卸载省内存(可设 0 常驻)

## 已知限制

- `Ctrl+Alt+L` 与 IntelliJ IDEA Keymap 扩展的默认绑定冲突,可在 Keyboard Shortcuts 中改绑
- 不支持插入 Copilot Chat 输入框(VS Code 无公开 API)
- 仅 Windows x64;macOS/Linux 计划 v2
- 不支持按住说话(push-to-talk);Remote/WSL 支持为验证目标,限制以实测为准
- 流式边说边出字暂不支持

## 主要设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `voiceflow.language` | `zh` | `zh` / `en` / `auto` |
| `voiceflow.model` | `small` | 模型档位(preview 默认待实测收敛) |
| `voiceflow.cleanup.provider` | `auto` | `auto`(rules + Copilot 可用则用)/ `rules-only` / `claude-cli` / `codex-cli` |
| `voiceflow.recording.autoStopSilence` | `3` | 静音自动结束(秒,0=关) |
| `voiceflow.whisper.idleUnload` | `10` | 模型空闲卸载(分钟,0=常驻) |
| `voiceflow.rules.*` | `true` | 各条本地清理规则独立开关 |

完整设置见 VS Code 设置页搜索 "voiceflow"。

## 开源属性

除 LLM 云端服务外全链开源组件(MIT/ISC/Apache-2.0,无 GPL 传染):whisper.cpp、Whisper ggml 模型、@ricky0123/vad-web(silero)、onnxruntime-web、opencc-js。
