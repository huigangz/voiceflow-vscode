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

- **当前阶段:最小闭环已实测通过(2026-07-03)—— 项目成立**。录音(helper exe)→ 模型下载(small)→ whisper server(CPU/BLAS)→ rules+vscode.lm 清理 → editor 插入全链路在用户机器上验证通过;77 条单元测试绿。**P1(server)/P2(small)/P3(helper exe)全部锁定,语言默认 auto(均为 2026-07-03/04 实测数据驱动)**。**Phase 1 完成 → 0.1.0 preview 已发布(2026-07-04)**:GitHub Release v0.1.0(pre-release,VSIX 5.08MB)。二进制内置零配置(no-BLAS,fail-closed SHA + bin.manifest.json/verify-bin gate)、首启向导(F5)、recorder 配置删除硬编码 helper、README/许可定稿。**Smart App Control**:固定预编译 helper(`prebuilt/voiceflow-mic.exe`,SHA 固定)缓解 SAC 拦截(未签名新哈希初始被拦、ISG 养熟后放行);代码签名为正式发布前彻底修复。fresh-install 产品 gate 仍待手动跑一次。构建:`npm run bin`(place-helper+fetch-whisper+verify-bin)。**Phase 2a 代码完成(2026-07-04)**:PvRecorder 1.2.9 进程内录音(`addonRecorder.ts`,节拍补读 + drain-before-stop,设计依据 worklog p2a1 spike 实测)、`voiceflow.recorder` auto|addon|helper + module-unavailable/blocked-by-policy 回退链、VSIX 打洞(pvrecorder 精确 7 文件)+ bin.manifest nodeAddons SHA gate、`--clean` 已废除(offline 打包改 `--ignoreFile .vscodeignore-offline`)、vad-web 整链移除;94 测试绿、双资产解包 require 实录验证过。**本机人工 gate 全绿(2026-07-04)**:拔设备 Go(read 抛 InvalidStateError ~0.13s,无阻塞)、隐私特征串已回填(`PERMISSION_SIGNATURES=['PvRecorderStatusRuntimeError']`,设备在场为前提)、EDH 四项过(addon 听写/拔设备/Reload/回退链)。**0.2.0 前置仅剩 SAC 机器 fresh-install**(顺带抓 `POLICY_SIGNATURES`)。**Phase 2b 代码完成(2026-07-04,6/6 步)**:VAD 分段出字全链路——`src/segment/`(segmentation/config/pipeline/join)+ SegmentedRecordingController + SegmentInserter(锚定插入终点/WorkspaceEdit/累计兜底/终端 Send-Copy)+ whisperRunner 重写(typed error 三分、prepare single-flight + 代际 key、idle lease、resolveMode、per-call signal/language)+ session `draining` 态 + Esc when 收窄;146 测试绿。**重大 bug 修复(p2b5)**:whisper-server language 缺省=en(非 auto),中文在 server 形态 auto 下曾被输出英文翻译 → 改为始终显式发 language(batch 同受益)。**2b 人工 gate 14/14 全绿(2026-07-04 EDH 实测,含延迟 P50≤3s/P95≤5s 与 Esc 七场景)→ Phase 2b 完成**。**SAC fresh-install 已过(2026-07-04)——2a gate 全绿**。**0.2.0 preview 已发布(2026-07-04)**:GitHub Release v0.2.0(pre-release,标准 5.5MB + offline 431MB 双资产),内容 = 2a + 2b + language 缺省 bug 修复;spec 文档已移出公开仓库(本地保留)。下一步:0.2.x 现场观察 → 0.3.0(删 helper 链、segmented 转默认 D3)。**2c 先行 spike 已完成(2026-07-04,worklog p2cs1-s4)**:结论**技术方向 Go 带条件**——采集+转换+转写链路质量达标(mixed 经 loopback CER 8.1%;`formatConvert.ts` 8 单测入正式代码);**D4 已定案(2026-07-04,p2cs5 对照实验)**:loopback = Silero VAD 并联(silero_vad_v5.onnx 现货 + onnxruntime-node,BGM 下精确切段、0.18ms/帧实时率 178x),mic = energy 不动;SegmentAccumulator 零改动。**Phase 2c 正式实现完成(2026-07-05,p2c1-p2c6,6/6 步)**:自研 `voiceflow-audio.node`(仅 loopback,mic 保持 PvRecorder——scoping 决策 p2c1,统一采集待 D5 签名)+ `formatConvert`/`GapFiller`/`FrameVad`/`SileroVad`(懒加载 onnxruntime,双阈值防抖)+ `LoopbackRecorder`(status 轮询检测设备失效,插既有分段管线零改动)+ "Dictate from System Audio" 命令(首次模态确认、SYS 状态栏、D6=30min 上限 + 禁静音自停)+ 打包链(onnxruntime win-x64 最小运行时 + silero 模型入 VSIX,DirectML 排除省 36MB,VSIX 40.75MB;**双包陷阱:打洞须带嵌套 dist/cjs/package.json**);168 测试绿,解包 ort+silero 推理+addon 加载判决测试过。**gate 实测两轮修复(2026-07-05)**:①系统音频独立 `systemAudio.segmentPause`(默认 0.8s,播音停顿短于口述);②**强制切分 `maxSegmentMs=20s`**(连续解说 67s 无停顿 → 单段膨胀触发 backlog 停采;segmented 双路统一 20s 上限,纯静音满上限丢弃)——全链首验 + SYS 状态栏已过(用户实测,逐段出字)。0.3.0/v2 发布前置 = p2c6 人工 gate 余项(BGM 实战切段、中断/长静默/隐私协议、SAC 加载)。spike 阶段记录:`voiceflow_audio.node`(miniaudio 0.11.25,48k/2ch/f32 与 C# 直采一致,SHA `9E568E69…25CE`,NotSigned);双实现确证 WASAPI loopback 不填充无流间隙 → 正式实现必须自做静音填充。**2c spike 全部完成,立项 Go;转写质量正式 gate 全绿(2026-07-05 用户实测:新闻 CER 1.5% / 会议 3.1% / BGM 11.5%,均 ≤15%)**。唯一遗留:SAC 机器加载实测(p2cs6 清单,D5 输入,非阻塞);D5 SignPath 建议立项即申请。VS Build Tools 已装(14.44 + SDK 26100;排障:杀 4 天僵尸 msiexec 才解 1618)。spike 工具在 spike/(gitignored):loopback 采集 exe、全链 harness(CER 脚本化)。Phase 2 规格:`voiceflow-phase2-roadmap.md`(v12)+ `voiceflow-phase2-review-log.md`。

**Phase 0 技术 gate 完整达成(2026-07-04)**:S1 核心三连全绿(拔设备/Reload 零残留/锁屏解锁,helper watchdog 加固)、S4b terminal/clipboard 五项全过、S4a editor 闭环、S2 质量+延迟达标。§9.3 技术 gate(序 1-3 必绿)满足。剩余非阻塞项:Remote/WSL 验证(限制写 README)、噪音场景 turbo-q5 对比(可选升档)、fresh-install 产品 gate(前置:whisper 二进制内置 VSIX)。**下一步进 Phase 1 产品化**。gate 实测已修的坑见各 worklog"Gate 实测发现"节(首下载 ENOENT、webview 无麦克风→helper、LLM 拒绝防线)
- 每个 step 完成后在 `worklog/` 写一篇日志:做了什么、gate 状态(自动测试结果 + 人工测试清单)、待定决策进展(P1/P2/P3)
- 硬件相关 gate(麦克风、GPU、锁屏、拔设备、Reload Window)无法自动化 → 写成人工测试清单,由用户在 Extension Development Host 中执行
- 构建:`npm run build`(esbuild);测试:`npm test`(vitest);调试:F5 启动 Extension Development Host
- 总 gate:S1/S2/S4a 必须绿;产品 gate = fresh install 后 10 分钟内完成首次听写

## v0.1 明确不做

Copilot Chat 插入、macOS/Linux、push-to-talk、流式出字、全局听写、热词词典、prompt 模板系统、Marketplace 上架(完整表见 spec §2.2)
