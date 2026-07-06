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

## Restricted / offline networks

If your environment blocks downloading model files (e.g. from HuggingFace), you have three options — the whisper binaries are already bundled, so the model is the only thing that would otherwise be fetched:

1. **Offline VSIX** — download the `…-offline.vsix` from the release. The `small` model is bundled inside; installing it needs **zero downloads**.
2. **Import a model file** — obtain a `ggml-*.bin` through an approved channel, then run **`VoiceFlow: Import Model File…`** and select it. It's copied into place and set as current (the file can even be renamed — you'll be asked which tier it is).
3. **Internal mirror / share** — set `voiceflow.model.sourceUrl` to your organization's source, and the extension fetches from there instead of HuggingFace:
   - an **https base URL** (e.g. `https://intranet/whisper-models`) — the model filename is appended;
   - or a **local/UNC folder** (e.g. `\\server\share\models` or `D:\models`) — copied from directly.

You can also manually place a `ggml-*.bin` in `%APPDATA%\Code\User\globalStorage\voiceflow-preview.voiceflow-vscode\models\` — it's detected automatically with no download.

## What's new in 0.2.0

- **In-process recording by default**: the microphone is now captured via a native module (PvRecorder) loaded inside VS Code — faster start, no helper process to spawn. If the native module can't load (e.g. blocked by app-control policy), VoiceFlow **falls back to the helper exe automatically** (`voiceflow.recorder` controls this).
- **Segmented dictation (opt-in)**: set `voiceflow.output.mode` to `segmented` — pause ~1.5s while speaking and the finished sentence is transcribed and inserted while you keep talking. Editor targets insert per segment; terminal targets confirm once (Send / Copy) at the end. Already-inserted text is final — Esc keeps it and discards only unfinished segments.
- **Language auto-detection fix**: in server mode, "auto" previously fell back to the server's default (**English**) — Chinese speech could come out as an English translation. Auto is now passed explicitly and detects correctly.

## System-audio dictation (experimental)

Run **"VoiceFlow: Dictate from System Audio"** from the command palette to transcribe what your computer is playing (a video, a meeting, a podcast) instead of the microphone. Sessions are always segmented (sentences appear as the audio plays), voice detection uses a local Silero neural VAD (robust to background music), and the session runs up to `voiceflow.systemAudio.maxDuration` (default 30 minutes — stop anytime with `Ctrl+Alt+L` or Esc).

**Privacy**: this captures **all sound your computer plays, from every app** — you get a one-time confirmation before the first session, and the status bar shows a distinct `SYS` indicator the whole time. Like microphone dictation, audio is processed entirely on your machine and temporary files are deleted immediately after transcription.

## How it behaves

- The insertion target is locked **when recording starts**; if by the end the original editor was closed / the cursor position became invalid / the terminal exited, the text is copied to the clipboard with a notice.
- Terminal insertion **does not press Enter and never executes** — you confirm and press Enter yourself.
- For recordings over 30s, a confirmation preview appears before inserting (can be disabled in settings).
- AI cleanup is an enhancement layer: if it's unavailable or times out (8s), it falls back to local rules cleanup automatically — dictation is never blocked.
- The model unloads after 10 minutes idle to save memory (set to 0 to keep it resident).

## Known limitations

### Smart App Control may block recording

Since 0.2.0 the microphone is captured by an in-process native module (`pv_recorder.node`, shipped unmodified from the official PvRecorder npm package — its hash is shared globally, so it generally has ISG reputation and passed our SAC fresh-install test). If it is ever blocked or fails to load, VoiceFlow falls back to a small helper program (`voiceflow-mic.exe`), which is **not yet code-signed** — Windows 11's **Smart App Control (SAC)** blocks **unsigned programs without established reputation**.

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
| `voiceflow.recorder` | `auto` | Recording backend: in-process native recorder with automatic helper fallback / `addon` / `helper`. |
| `voiceflow.output.mode` | `batch` | `segmented` = cut a segment at each speech pause and insert incrementally. |
| `voiceflow.output.segmentPause` | `1.5` | Segmented mode: silence (seconds) that cuts a segment; must stay below `autoStopSilence`. |
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
- **@picovoice/pvrecorder-node** (1.2.9, Apache-2.0) — in-process microphone capture (Windows x64 `pv_recorder.node`)

> The preview uses whisper.cpp's **CPU (no-BLAS)** build and does not include OpenBLAS.
