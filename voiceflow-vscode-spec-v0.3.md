# VoiceFlow for VS Code — 项目规格与开发计划

> 版本:v0.3(终稿 — Spike 执行规格)
> 日期:2026-07-02
> 状态:**文档评审结束,进入 Phase 0 执行**
> v0.2 → v0.3 变更(5 处小修):S1 补设备/锁屏/reload 测试;S2 固定音频测试集;模型下载提前为 mini-spike;rulesLayer 限定轻清理;新增 fresh-install 产品 gate;Spike 改为串行顺序

---

## 1. 项目概述

一个 VS Code extension,实现 Wispr Flow 式的语音听写:用户按快捷键说话,语音在**本地**转写为文字,经清理后插入当前聚焦的编辑器或终端。

**核心闭环(v0.1 成败标准):**

> 录音 → 本地 whisper → 本地规则清理 → 插入 —— **全程无任何外部依赖,必须稳定**

**增强层(可用则更好,不影响闭环):**

> AI 清理 —— 复用用户已有订阅(Copilot 经 `vscode.lm`;Claude/Codex CLI 为 power-user 选项)

**核心卖点:**

- 语音数据不出本机(本地转写)
- 不需要自建 LLM 服务:AI 清理复用用户已有订阅,作为渐进增强
- 中英双语优化,面向中文开发者(代码注释、commit message、文档、给 AI 的 prompt)

**隐私声明(首启向导 + README 原文):**

> 音频永不离开本机。启用 AI 清理时,**转写文本**会发送给你选择的模型服务(Copilot / Claude / Codex);rules-only 模式下文本也不出本机。

---

## 2. 范围

### 2.1 v0.1 做(In Scope)

- Windows x64(platform-specific VSIX)
- 中文、英文及中英混合听写
- 插入目标:**文本编辑器** 和 **集成终端**
- 清理:本地正则规则层(必备)+ `vscode.lm`(可用则用)+ CLI provider(用户显式选择才启用)
- Toggle 式录音(按一下开始,再按一下结束)
- 模型首次启动下载(含国内镜像)
- 单一内置清理 prompt(default 模式)
- 发布形态:**GitHub Release VSIX preview**(非 Marketplace)

### 2.2 v0.1 不做(Out of Scope)

| 项目 | 原因 | 未来 |
|---|---|---|
| Copilot Chat 输入框插入 | VS Code 无公开 API | 等官方 API |
| macOS / Linux | 聚焦单平台 | v2(架构已兼容) |
| Push-to-talk(按住说话) | Extension API 拿不到 key-up | 长期不做 |
| 流式边说边出字 | whisper streaming 中文效果差 | 观望 |
| 系统级全局听写 | 产品定位已收窄 | 不做 |
| 自定义热词/词典 | 非核心 | v2 |
| 多模型智能推荐/自动切换 | v0.1 用户手动选模型档位 | v2 |
| whisper 二进制后台自动更新 | 供应链与签名复杂,preview 不值得 | v2 |
| Marketplace 完整商业化包装 | 上架材料耗时,先 dogfooding | v0.2/v1.0 |
| Prompt 模板系统(commit / prompt 等模式) | 控制复杂度,v0.1 仅 default | v2 |

---

## 3. 决策清单

### 3.1 已锁定(产品级)

| # | 决策项 | 结论 |
|---|---|---|
| D1 | 快捷键 | `Ctrl+Alt+L`(toggle,可配置);README 注明与 IntelliJ Keymap 冲突 |
| D2 | 插入策略 | 等清理完成后一次性插入 |
| D3 | 产品范围 | 编辑器 + 终端 |
| D5 | 内存策略 | 空闲 10 分钟自动卸载模型(可配置) |
| D7 | 录音首选方案 | Webview + `getUserMedia`;**S1 不稳则切 native helper exe 备用路线** |
| D8 | VAD | `@ricky0123/vad-web`(webview 内);若切 helper exe 路线则改用 onnxruntime 跑 silero |
| D9 | 清理优先级 | ① rules(永远可用)→ ② `vscode.lm`(可用则用)→ ③ CLI(显式配置才启用) |
| D10 | v0.1 成功标准 | **本地听写闭环稳定**;AI 清理为增强,不是 release gate |

### 3.2 待 Spike 后锁定(实现级)

| # | 决策项 | 候选 | 由谁定 |
|---|---|---|---|
| P1 | whisper 运行形态 | long-running **server 模式** vs per-request **CLI 模式** | S2 同时实测两者。注:CLI 模式对 turbo(1.6GB)每次冷加载大概率不可接受,但对 small/量化版可能可行且架构更简单 |
| P2 | 默认模型档位 | 有独显 → `small` 或 `large-v3-turbo-q5`;无独显 → `base` 或 `small-q5` | S2 实测数据。`large-v3-turbo` 全量版仅作为 power-user 手动选项;preview 默认优先"快、稳、少内存" |
| P3 | 录音最终方案 | Webview vs native helper exe | S1 |

---

## 4. 技术栈

| 层 | 技术 | License |
|---|---|---|
| 语言 | TypeScript 全栈 | — |
| 框架 | VS Code Extension API + esbuild | MIT |
| 录音(首选) | Webview + `getUserMedia`(16kHz 单声道 PCM,postMessage 回传) | Web 标准 |
| 录音(备用) | native helper exe(cpal/Rust 或 C++,stdout 流 PCM) | MIT |
| VAD | `@ricky0123/vad-web`(silero-vad) | ISC / MIT |
| STT | whisper.cpp(Vulkan build;server 或 CLI 形态待 P1) | MIT |
| STT 模型 | Whisper ggml 系列(默认档位待 P2) | MIT |
| 清理 | ① 本地正则 → ② `vscode.lm` → ③ CLI 子进程(opt-in) | — |
| UI | StatusBarItem + QuickPick + Webview(仅录音) | — |
| 存储 | VS Code settings + `globalState` + `globalStorageUri`(模型) | — |
| 分发 | GitHub Release VSIX(`--target win32-x64`) | — |

**开源属性:** 除 LLM 云端服务外全链开源(MIT/ISC),无 GPL 传染,自有代码可闭源。

---

## 5. 系统架构

### 5.1 数据流

```
Ctrl+Alt+L (开始) ── 记录插入目标(editor+cursor/selection 或 terminal 实例)
   │
   ▼
录音层(Webview 或 helper exe,待 P3)
   getUserMedia → vad-web 过滤静音 → PCM chunks → Extension Host 缓冲
   │
Ctrl+Alt+L (结束) / 静音自动结束 / 超时
   │
   ▼
whisper(形态待 P1)
   language=zh|en|auto + initial_prompt(简体带标点引导)
   │  原始转写文本
   ▼
清理管线
   ① 规则层(必跑):中英间距、全半角标点、简繁统一
   ② vscode.lm(有可用模型则跑,超时 8s 放弃)
   ③ CLI provider(仅当用户在设置中显式选择)
   │
   ▼
插入分发器(锁定录音开始时的目标,见 F4)
```

### 5.2 模块划分

```
src/
├── extension.ts            # 入口:命令注册、会话状态机
├── audio/
│   ├── recorder.ts         # 录音抽象接口
│   ├── webviewRecorder.ts  # 方案 A
│   └── helperRecorder.ts   # 方案 B(S1 失败时启用)
├── stt/
│   ├── whisperRunner.ts    # server/CLI 双形态封装(P1 后收敛)
│   └── modelManager.ts     # 下载(断点续传、镜像、SHA 校验)、档位管理
├── cleanup/
│   ├── pipeline.ts         # 编排 + provider 选择
│   ├── rulesLayer.ts       # 正则规则层
│   ├── vscodeLmProvider.ts
│   └── cliProvider.ts      # opt-in;UTF-8、.cmd shim 处理
├── insert/
│   └── dispatcher.ts       # 目标锁定 + 三路径分发
└── ui/
    └── statusBar.ts
```

### 5.3 会话状态机

`idle → recording → transcribing → cleaning → inserting → idle`

- **`Esc` 在任何阶段 = 取消整个会话**(丢弃录音与结果,回 idle),不是只取消当前阶段
- 错误 → 状态栏错误图标(可点击查看 OutputChannel)→ idle

---

## 6. 功能需求

### 6.1 录音(F1)

- F1.1 `Ctrl+Alt+L` 开始,状态栏 🎙 红点 + 计时
- F1.2 再按结束;最大时长默认 120s(可配置)自动结束
- F1.3 VAD 连续静音 ≥ 3s 且已有语音段 → 自动结束(可关闭)
- F1.4 无权限/无设备 → 明确错误提示 + 解决指引;**权限被拒后可重新引导授权**(S1 验证项)

### 6.2 转写(F2)

- F2.1 whisper 懒启动,加载期间状态栏"模型加载中"(**加载时间不计入听写延迟指标**)
- F2.2 语言:`auto`/`zh`/`en`,默认 `zh`
- F2.3 `initial_prompt` 简体带标点引导
- F2.4 空闲 10 分钟卸载(可配置 0=常驻);unload → reload 必须稳定(S2 验证项)
- F2.5 Vulkan 不可用 → CPU 回退 + 首启向导建议低档模型

### 6.3 清理(F3)

- F3.1 规则层必跑,但定位为**轻清理**——只做确定性、低风险规则,不试图替代 LLM:

  | 可以做 | 明确暂缓(不做) |
  |---|---|
  | 中英之间加空格 | 自动改写语气 |
  | 简繁转简体 | 自动翻译 |
  | 常见全角/半角标点归一 | 自动补充代码符号 |
  | 去除重复空格 | 猜测用户意图 |
  | 去除 whisper 常见尾部幻觉(如"谢谢观看") | 大段重排句子 |

  各规则均可配置开关。原则:规则层宁可少改,不可错改。
- F3.2 LLM prompt 要点:只输出结果、不解释、保留技术术语、统一简体;v0.1 仅一个内置 default prompt
- F3.3 Provider 逻辑:`auto` = 规则层 + `vscode.lm`(`selectChatModels` 非空时);CLI 仅当设置显式选 `claude-cli`/`codex-cli`
- F3.4 LLM 超时 8s → 插入规则层结果(闭环永不被 LLM 阻塞)
- F3.5 CLI 子进程:强制 UTF-8(chcp 65001/env),`cmd /c` 处理 `.cmd` shim
- F3.6 首启向导明示隐私声明(见第 1 节)

### 6.4 插入(F4)

目标在**录音开始时锁定**,结束后按下表分发:

| 情况 | 行为 |
|---|---|
| 原 editor 打开,光标/选区未变 | 原位置插入(snippet 转义,不触发补全) |
| 原 editor 打开,光标/选区已变 | 插入**录音开始时记录的** range;若该 range 已因编辑失效 → 状态栏提示 + 复制剪贴板 |
| 原 editor 已关闭 | 复制剪贴板 + 状态栏"已复制" |
| 原 terminal 存活 | `sendText(text, false)` **不自动回车、不转义**;状态栏提示"已写入终端"(语音文本可能构成 shell 命令,绝不代执行) |
| 原 terminal shell 已退出 | 复制剪贴板 + 提示 |
| 焦点从头就不在编辑器/终端 | 复制剪贴板 + 提示 |
| 录音时长 > 30s | 插入前 lightweight 确认(状态栏/QuickPick 预览),可配置关闭 |

### 6.5 首次启动向导(F5)

- F5.1 硬件检测(GPU/Vulkan)→ **展示**推荐档位,用户手动确认(不自动智能切换)
- F5.2 模型下载:进度、断点续传、HF 失败自动切 hf-mirror、SHA 校验
- F5.3 探测 `vscode.lm` 可用性并展示;CLI provider 仅说明如何手动开启
- F5.4 隐私声明 + 引导测试一次听写

---

## 7. 配置项

| Key | 默认值 | 说明 |
|---|---|---|
| `voiceflow.language` | `"zh"` | `zh`/`en`/`auto` |
| `voiceflow.model` | 待 P2 | 档位:`base`/`small`/`small-q5`/`large-v3-turbo-q5`/`large-v3-turbo` |
| `voiceflow.cleanup.provider` | `"auto"` | `auto`(rules+vscode.lm)/`rules-only`/`claude-cli`/`codex-cli` |
| `voiceflow.cleanup.timeout` | `8000` | ms |
| `voiceflow.recording.maxDuration` | `120` | 秒 |
| `voiceflow.recording.autoStopSilence` | `3` | 秒,0=关闭 |
| `voiceflow.recording.confirmThreshold` | `30` | 秒,超过则插入前确认;0=关闭 |
| `voiceflow.whisper.idleUnload` | `10` | 分钟,0=常驻 |
| `voiceflow.rules.convertToSimplified` | `true` | |
| `voiceflow.rules.spacingCJKLatin` | `true` | |

---

## 8. 非功能需求

### 8.1 延迟指标(5s 中文语音,warm 状态,P50 / P95 分开统计)

| 场景 | v0.1 preview 可接受 (P50) | 理想目标 |
|---|---:|---:|
| GPU + small/base + rules-only | ≤ 3s | ≤ 2s |
| GPU + large-v3-turbo + rules-only | ≤ 5s | ≤ 3s |
| GPU + LLM cleanup | ≤ 8s | ≤ 4s |
| CPU + small + rules-only | ≤ 10s | ≤ 8s |

- **cold start(模型加载)单独统计,不计入端到端延迟**;产品上以"模型加载中"状态呈现
- 内部埋点(仅本地日志,零遥测)拆四段:cold start / warm transcription / cleanup / insert

### 8.2 其他

| 项 | 目标 |
|---|---|
| 空闲内存(模型已卸载) | ≤ 100MB |
| 隐私 | 见第 1 节声明;v0.1 零遥测 |
| Remote/WSL | **验证目标,非承诺**:`extensionKind: ["ui"]` 强制本地运行;远程编辑器/终端插入列入 S4 实测,限制如实写入 README |

---

## 9. Spike 计划与 Go/No-Go Gate(Phase 0)

**执行方式:串行,不并行开 4 个 spike。** 按风险依赖排序,第一阶段目标只有一个:

> 录音 5 秒中文 → whisper → rules 轻清理 → 插入 editor —— 这条闭环通了,项目即成立。

### 9.1 执行顺序

| 序 | Spike | Go 标准 | No-Go 后备案 |
|---|---|---|---|
| 1 | **S1 录音**(Webview) | 120s 录音无丢 chunk、内存不增长;webview 隐藏/切窗口/最小化时录音持续;权限首拒后可恢复;**录音中拔掉/切换麦克风 → 明确失败并回 idle,无半截脏数据;Windows 锁屏/解锁 → 安全取消或恢复;`Reload Window` → 子进程、临时 WAV、状态机全部清理干净,无残留进程**;Remote 场景确认录音与 whisper 均在本地侧 | 立即切 native helper exe 路线,不在 Webview 上硬扛(备案路线需重跑同一组测试) |
| 2 | **S2 whisper + 模型下载 mini-spike** | 见 9.2 固定测试集;warm 转写达标(GPU ≤5s / CPU 回退可用);unload/reload 稳定;server 与 CLI 两形态 × 模型档位组合出数据,收敛 P1/P2。**mini-spike:1.6GB 级文件断点续传、SHA 校验、失败重试、hf-mirror fallback、用户取消、磁盘不足提示、globalStorageUri 路径权限、代理/SSL 拦截环境至少一次实测** | 默认档位降为 small-q5;下载不稳则 v0.1 改为"手动下载 + 导入模型文件"兜底 |
| 3 | **S4a editor 插入** | 最小闭环打通:录音 → whisper → rules → editor 插入;光标漂移场景按 F4 表现 | — (此项必须绿,无备案) |
| 4 | **S3a rules-only 清理** | 轻清理规则全部通过测试集,零错改 | 缩减规则集 |
| 5 | **S3b `vscode.lm` / CLI(增强层)** | 有模型可调用、授权流程可接受、无模型 graceful fallback;CLI 路径 UTF-8/.cmd shim 验证 | `vscode.lm` 不稳则降为实验性开关;CLI 保持 opt-in |
| 6 | **S4b terminal / clipboard / Remote** | 三路径全通;Remote/WSL 实测并记录限制 | Remote 限制写入 README,不阻塞发布 |

### 9.2 S2 固定音频测试集(录制一次,全程复用作回归基准)

| 测试音频 | 用途 |
|---|---|
| 纯中文 5s | 中文标点、简体输出 |
| 纯英文 5s | 英文质量与速度 |
| 中英混合 10s | **核心场景**(权重最高) |
| 代码术语 10s | "React component / Kubernetes / CI/CD" 类术语保真 |
| 背景噪音 10s | VAD + whisper 容错 |
| 静音/误触发 | 防幻觉输出(预期:空结果) |

### 9.3 总 Gate

- **技术 gate**:序 1–3(S1、S2、editor 插入)必须绿;序 5 的 LLM 与序 6 的 Remote 允许带限制进入 v0.1
- **产品 gate(release 前验收)**:在一台普通 Windows 开发机上,**fresh install 后 10 分钟内**完成模型下载、权限授权、第一次 editor 听写插入

---

## 10. 里程碑(双轨,任选其一)

### 轨道 A:全职(约 5 周)

| 周 | 交付物 |
|---|---|
| W1 | 按 9.1 顺序执行 spike(独立小仓库,不写正式架构),**含模型下载 mini-spike** + P1/P2/P3 决策收敛 |
| W2 | 最小闭环:录音 → WAV → whisper → editor 插入 |
| W3 | 状态机、取消、错误处理、terminal 插入、规则轻清理层 |
| W4 | modelManager 产品化(spike 代码整理)、配置项、provider 探测、首启向导 |
| W5 | dogfooding、README(含隐私与限制说明)、**跑一次 fresh-install 10 分钟产品 gate**、GitHub Release 0.1.0 preview |

### 轨道 B:业余时间(约 8–10 周)

| 阶段 | 时间 | 目标 |
|---|---|---|
| Phase 0 | 1–2 周 | 按 9.1 顺序 spike(含模型下载 mini-spike)+ 决策收敛 |
| Phase 1 | 2 周 | editor-only 最小闭环 |
| Phase 2 | 2 周 | 规则轻清理 + terminal + 状态机 + 取消/错误 |
| Phase 3 | 2 周 | modelManager 产品化 + 设置 + 首启向导 |
| Phase 4 | 1–2 周 | dogfooding + 打包 + fresh-install 产品 gate + GitHub Release preview |

Marketplace 上架(图标、demo GIF、中英 README、隐私与二进制许可说明)列为 preview 之后的独立里程碑。

---

## 11. 遗留开放问题(不阻塞 Spike)

1. 扩展名称与 publisher ID(Marketplace 阶段前定)
2. 终端特殊字符是否需要转义白名单 → 已由 F4 决策覆盖("不转义 + 不代执行 + 提示"起步,dogfooding 观察)
3. `Esc` 取消与编辑器既有绑定的冲突(Phase 1 验证,必要时改用 `when` 子句限定)

---

## 附录 B:v0.2 → v0.3 变更摘要(终稿小修)

1. S1 新增三个 gate 测试:录音中设备拔出/切换、Windows 锁屏/解锁、`Reload Window` 后无残留
2. S2 引入 6 条固定音频测试集(中英混合 + 技术术语为最高权重),作为长期回归基准
3. 模型下载(F5.2)提前为 Phase 0 的 mini-spike,覆盖断点续传/校验/镜像/取消/磁盘/代理场景;不稳则以"手动导入模型"兜底
4. rulesLayer 明确限定为轻清理,给出"可以做/明确不做"边界,原则:宁可少改,不可错改
5. 新增产品 gate:fresh install 后 10 分钟内完成首次听写
6. Spike 从并行改为 9.1 的串行顺序,第一阶段唯一目标 = editor 最小闭环

## 附录 A:v0.1 → v0.2 变更摘要

1. 状态改为"核心方向锁定,实现方案 Spike 后锁定";决策表拆分为已锁定(D)与待定(P)
2. v0.1 成功标准改为**本地听写闭环稳定**;LLM 清理降级为增强层,CLI provider 改为 opt-in
3. 录音方案明确 native helper exe 备用路线;S1 gate 细化(120s/最小化/权限恢复)
4. 默认模型不再锁定 large-v3-turbo,档位由 S2 数据决定;全量 turbo 降为手动选项
5. 统一 whisper 形态命名:server vs CLI 作为待定项 P1,S2 双形态实测
6. F4 插入行为补齐安全阀:光标漂移、terminal shell 退出、>30s 确认、Esc 取消整个会话
7. 终端插入策略:不转义、不代执行、状态栏提示
8. 延迟指标分 cold/warm、rules/LLM,P50/P95;cold start 不计入端到端
9. 里程碑改双轨(全职 5 周 / 业余 8–10 周);发布形态从 Marketplace 改为 GitHub Release preview
10. 隐私文案精确化:音频不出本机,AI 清理时转写文本出本机
11. Remote/WSL 从承诺降级为验证目标
