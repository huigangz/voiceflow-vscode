# 音频 fixture

提交进仓库的确定性测试音频。本地录音、质量测试样本放在 `test-audio/`(gitignored,不入 git)。

## 来源规则

每个 committed 音频文件必须满足至少一项:

- 合成 / 程序生成
- 明确授权可再分发
- 公有领域或兼容许可

不得使用:开发者个人录音、私人会议录音、用户语音。

这些规则由 `test/audioFixtures.test.ts` 机检:仓库里所有被 git 跟踪的音频文件(wav / mp3 / flac / ogg / opus / m4a / aac / wma / webm)都必须位于本目录,并登记在 `fixtures.json` 中,写明来源、SHA-256、格式(16kHz / mono / PCM16)和语音 / 静音区段。未登记、SHA 不符、格式不符、区段有缝,测试都会失败。

## 文件

| 文件 | 内容 | 来源 | 生成 |
|---|---|---|---|
| `speech-en-tts.wav` | 1.0s 静音 + 英文句 A + 2.0s 静音 + 英文句 B + 1.0s 静音,共 11.66s | 合成:Windows SAPI 5(System.Speech),语音 Microsoft Zira Desktop | `node scripts/gen-audio-fixtures.mjs` |

句子文本、精确区段(样本号)与 SHA 见 `fixtures.json`。静音段为全零样本;语音段是裁掉首尾静音的合成语音。

生成脚本只在 Windows 本机运行,不进 CI:不同 Windows 版本的合成结果字节可能不同,以提交的文件和清单里的 SHA 为准。重新生成后清单会一起更新,需在同一提交里说明原因。

## 用途

- `test/sileroVad.test.ts`:真实 Silero 模型在语音区段判为语音、静音区段判为非语音、语音之后 `reset()` 清空状态。
