# VoiceFlow for VS Code

Wispr Flow 式语音听写 VS Code extension:按 `Ctrl+Alt+L` 说话 → **本地** whisper 转写 → 规则/LLM 清理 → 插入编辑器或终端。

**权威规格:`voiceflow-vscode-spec-v0.3.md`(终稿)。任何实现冲突以 spec 为准。**

## 核心原则(不可违背)

1. **本地闭环是成败标准**:录音 → 本地 whisper → 本地规则清理 → 插入,全程无外部依赖,必须稳定。AI 清理只是增强层,不是 release gate。
2. **隐私**:音频永不离开本机;仅 AI 清理时转写**文本**发给用户选择的模型;零遥测。
3. **规则层宁可少改,不可错改**:只做确定性轻清理(中英空格、简繁、全半角标点、去重复空格、去尾部幻觉),不做改写/翻译/意图猜测。
4. **闭环永不被 LLM 阻塞**:LLM 超时 8s → 直接插入规则层结果。
5. **终端插入绝不代执行**:`sendText(text, false)`,不回车、不转义。

## 技术栈

- TypeScript + VS Code Extension API + esbuild;测试用 vitest(纯逻辑层)
- 录音:**native helper exe(P3 已锁定,2026-07-03)** —— `helper/MicCapture.cs`(C# winmm,系统 csc 编译)→ `bin/voiceflow-mic.exe`,stdout 流 s16le PCM;host 侧 energy VAD(`energyVad.ts`)。Webview+getUserMedia 路线因 upstream 限制 No-Go(webview permissions-policy 禁 microphone,microsoft/vscode#250568),保留为实验开关 `voiceflow.recorder=webview`
- STT:whisper.cpp,**server 形态(P1 已锁定)**,CLI 为二进制缺失时兜底;**默认档位 small(P2 已锁定)**——CPU/BLAS 下 warm ≈1.8s、端到端含 LLM ≈2.7s(2026-07-04 实测);语言默认 **auto**(§9.2 矩阵实测,zh 会把纯英文翻译成中文);Vulkan build 为后续 GPU 升级项(RTX 50 系不兼容官方 cuBLAS 12.4 包)
- 发布:GitHub Release VSIX `--target win32-x64`(非 Marketplace)
- `extensionKind: ["ui"]` 强制本地运行

## 目录结构(spec §5.2)

```
src/
├── extension.ts            # 入口:命令注册、会话状态机
├── audio/recorder.ts       # 录音抽象接口 (+webviewRecorder / helperRecorder)
├── stt/whisperRunner.ts    # server/CLI 双形态封装
├── stt/modelManager.ts     # 下载(断点续传、hf-mirror、SHA 校验)
├── cleanup/pipeline.ts     # rules → vscode.lm → CLI(opt-in)编排
├── cleanup/rulesLayer.ts   # 正则轻清理(全部规则可配置开关)
├── insert/dispatcher.ts    # 录音开始时锁定目标,按 F4 表分发
└── ui/statusBar.ts
media/                      # webview 录音页资源
worklog/                    # 每个 step 完成后的工作日志(含人工 gate 测试清单)
test/                       # vitest 单元测试
```

## 会话状态机

`idle → recording → transcribing → cleaning → inserting → idle`
- `Esc` 任何阶段 = 取消**整个会话**回 idle(非取消当前阶段)
- 错误 → 状态栏错误图标(点击看 OutputChannel)→ idle

## 关键行为速查

- 插入目标在**录音开始时锁定**;分发规则见 spec §6.4 F4 表(光标漂移/编辑器关闭/终端退出 → 剪贴板兜底)
- 录音 >30s 插入前 lightweight 确认(可配置)
- VAD 静音 ≥3s 且已有语音段 → 自动结束;最大录音 120s
- 模型空闲 10 分钟自动卸载(`voiceflow.whisper.idleUnload`,0=常驻)
- cold start(模型加载)不计入延迟指标,单独统计;埋点四段:cold start / warm transcription / cleanup / insert(仅本地日志)
- 配置项全表见 spec §7,前缀 `voiceflow.*`

## 开发流程约定

- **当前阶段:最小闭环已实测通过(2026-07-03)—— 项目成立**。录音(helper exe)→ 模型下载(small)→ whisper server(CPU/BLAS)→ rules+vscode.lm 清理 → editor 插入全链路在用户机器上验证通过;77 条单元测试绿。**P1(server)/P2(small)/P3(helper exe)全部锁定,语言默认 auto(均为 2026-07-03/04 实测数据驱动)**。剩余:S1 核心三连(拔设备/锁屏/Reload 残留)、S4b terminal/Remote 清单、噪音场景 turbo-q5 对比(可选)、fresh-install 产品 gate。gate 实测已修的坑见各 worklog"Gate 实测发现"节(首下载 ENOENT、webview 无麦克风→helper、LLM 拒绝防线)
- 每个 step 完成后在 `worklog/` 写一篇日志:做了什么、gate 状态(自动测试结果 + 人工测试清单)、待定决策进展(P1/P2/P3)
- 硬件相关 gate(麦克风、GPU、锁屏、拔设备、Reload Window)无法自动化 → 写成人工测试清单,由用户在 Extension Development Host 中执行
- 构建:`npm run build`(esbuild);测试:`npm test`(vitest);调试:F5 启动 Extension Development Host
- 总 gate:S1/S2/S4a 必须绿;产品 gate = fresh install 后 10 分钟内完成首次听写

## v0.1 明确不做

Copilot Chat 插入、macOS/Linux、push-to-talk、流式出字、全局听写、热词词典、prompt 模板系统、Marketplace 上架(完整表见 spec §2.2)
