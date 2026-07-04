# Third-Party Notices

VoiceFlow for VS Code 本体以 MIT 协议发布(见 [LICENSE](LICENSE))。
构建/运行时使用的第三方组件及其许可:

## 随 VSIX 分发

| 组件 | 用途 | License |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) v1.9.1 CPU(no-BLAS)构建 | 本地语音转写二进制(`bin/`) | MIT |
| Whisper ggml 模型(OpenAI Whisper 权重) | 转写模型(用户首启下载) | MIT |
| [opencc-js](https://github.com/nk2028/opencc-js)(OpenCC 词典) | 繁体转简体 | MIT + Apache-2.0 |

采用 whisper.cpp **CPU(no-BLAS)** 构建,**不分发 OpenBLAS**(无 BSD-3-Clause 义务)。

## 仅源码 / 开发依赖(不随 VSIX 分发)

| 组件 | 用途 | License |
|---|---|---|
| [@ricky0123/vad-web](https://github.com/ricky0123/vad)(silero-vad) | 暂不可用的实验性 webview 录音路线 | ISC / MIT |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 同上(VAD 推理运行时) | MIT |

全链无 GPL 传染。
