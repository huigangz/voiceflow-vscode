# VoiceFlow for VS Code (preview)

Wispr Flow-style voice dictation: press `Ctrl+Alt+L` and speak — your speech is transcribed to text **locally**, cleaned up, and inserted into the focused editor or integrated terminal. Optimized for English and Chinese (and mixed), aimed at developers writing code comments, commit messages, docs, and prompts for AI.

> **Privacy**
> Audio never leaves your machine. When AI cleanup is enabled, the **transcribed text** is sent to the model service you choose (Copilot / Claude / Codex); in rules-only mode the text also stays on your machine.
> Zero telemetry.

## Quick start

1. Install the VSIX (from the GitHub Release, `win32-x64`). The whisper binaries are bundled — **no manual configuration needed**.
2. On first launch a **setup wizard** appears: confirm the privacy notice → pick a model tier (default `small`) → download the model (resumable, with an hf-mirror fallback for users in China) → try your first dictation. You can reopen it anytime via the `VoiceFlow: Setup Wizard` command, or switch tiers with `VoiceFlow: Download / Switch Model`.
3. Focus an editor or terminal → `Ctrl+Alt+L` to start speaking → press again to stop (3s of silence also auto-stops) → the text is inserted.
4. Press `Esc` at any stage to cancel the whole session.

> **The preview is a CPU build**: it uses a whisper.cpp CPU build; the `small` tier is about 3s end-to-end on a typical dev machine (including AI cleanup). GPU acceleration (Vulkan) is a later release.

## How it behaves

- The insertion target is locked **when recording starts**; if by the end the original editor was closed / the cursor position became invalid / the terminal exited, the text is copied to the clipboard with a notice.
- Terminal insertion **does not press Enter and never executes** — you confirm and press Enter yourself.
- For recordings over 30s, a confirmation preview appears before inserting (can be disabled in settings).
- AI cleanup is an enhancement layer: if it's unavailable or times out (8s), it falls back to local rules cleanup automatically — dictation is never blocked.
- The model unloads after 10 minutes idle to save memory (set to 0 to keep it resident).

## Known limitations

### Smart App Control may block recording

VoiceFlow uses a small local program (`voiceflow-mic.exe`) to capture the microphone. Windows 11's **Smart App Control (SAC)** blocks **unsigned programs without established reputation**, and this preview's recording component is **not yet code-signed**.

- **Symptom**: on a machine with SAC on, the **first** `Ctrl+Alt+L` may report that the recording component was blocked by Smart App Control.
- **Usually temporary**: SAC evaluates unknown programs via Microsoft's Intelligent Security Graph (ISG) — once the same fixed binary has been "seen" and evaluated, it is typically allowed automatically. **Wait a moment and try again** and it usually works. This preview pins a single helper binary (its hash doesn't change across builds) precisely so it can "age in," and reputation improves as downloads accumulate.
- **How to check SAC**: Settings → Privacy & security → Windows Security → App & browser control → Smart App Control.
- **Don't turn SAC off for this**: once disabled it can't be re-enabled without reinstalling Windows. In managed/enterprise environments where it stays blocked, please wait for a future **signed** build.
- The whisper transcription binaries come from whisper.cpp's official release and have reputation, so they are unaffected; only the local capture component is involved.
- The recording component will be code-signed before a wider release to remove this limitation entirely.

### Other

- `Ctrl+Alt+L` conflicts with the default binding of the IntelliJ IDEA Keymap extension — rebind it in Keyboard Shortcuts if needed.
- Inserting into the Copilot Chat input box is not supported (no public VS Code API).
- Windows x64 only; macOS/Linux planned for v2.
- No push-to-talk; Remote/WSL support is a verification target, with limitations documented as tested.
- Streaming (words appearing as you speak) is not supported yet.

## Key settings

| Setting | Default | Description |
|---|---|---|
| `voiceflow.language` | `auto` | Auto-detects Chinese/English (reliable in testing); `zh` translates pure-English speech into Chinese, so only set it manually if auto mis-detects. |
| `voiceflow.model` | `small` | Model tier (CPU build: `small` is balanced and recommended; switch via the wizard). |
| `voiceflow.cleanup.provider` | `auto` | `auto` (rules + Copilot when available) / `rules-only` / `claude-cli` / `codex-cli`. |
| `voiceflow.recording.autoStopSilence` | `3` | Auto-stop on silence (seconds, 0 = off). |
| `voiceflow.whisper.idleUnload` | `10` | Unload the model when idle (minutes, 0 = keep resident). |
| `voiceflow.rules.*` | `true` | Independent toggles for each local cleanup rule. |

For all settings, search "voiceflow" in VS Code settings.

## Open source

VoiceFlow itself is MIT. Third-party components actually distributed in the VSIX (no GPL contamination; see `THIRD-PARTY-NOTICES.md`):

- **whisper.cpp** (v1.9.1 CPU build, MIT) — local transcription binaries
- **Whisper ggml models** (MIT) — downloaded on first run
- **opencc-js** (MIT + Apache-2.0) — Traditional→Simplified Chinese conversion

> The preview uses whisper.cpp's **CPU (no-BLAS)** build and does not include OpenBLAS. `@ricky0123/vad-web` / `onnxruntime-web` are dependencies of the currently-unavailable experimental webview recording path and are **not distributed in the VSIX**.
