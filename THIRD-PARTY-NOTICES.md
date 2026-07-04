# Third-Party Notices

VoiceFlow for VS Code itself is released under the MIT license (see [LICENSE](LICENSE)).
Third-party components used at build/runtime and their licenses:

## Distributed in the VSIX

| Component | Purpose | License |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) v1.9.1 CPU (no-BLAS) build | Local speech transcription binaries (`bin/`) | MIT |
| Whisper ggml models (OpenAI Whisper weights) | Transcription models (downloaded on first run) | MIT |
| [opencc-js](https://github.com/nk2028/opencc-js) (OpenCC dictionaries) | Traditional→Simplified Chinese conversion | MIT + Apache-2.0 |

Uses the whisper.cpp **CPU (no-BLAS)** build and **does not distribute OpenBLAS** (no BSD-3-Clause obligation).

## Source-only / dev dependencies (not distributed in the VSIX)

| Component | Purpose | License |
|---|---|---|
| [@ricky0123/vad-web](https://github.com/ricky0123/vad) (silero-vad) | Currently-unavailable experimental webview recording path | ISC / MIT |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | Same as above (VAD inference runtime) | MIT |

No GPL contamination anywhere in the chain.
