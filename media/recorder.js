/**
 * VoiceFlow 录音 webview(S1 spike)。
 *
 * 双模式:
 *  - vad 模式(首选,D8):@ricky0123/vad-web(silero)本地资产加载;
 *    onFrameProcessed 回传全部帧 + isSpeech 标记,静音判定由 extension host 决策。
 *  - energy 模式(降级):VAD 资产加载失败时,getUserMedia + AudioWorklet
 *    + 能量门限,保证本地闭环不死(F1.3 自动结束仍可用,精度略降)。
 *
 * 消息协议(与 webviewRecorder.ts 对应):
 *  ext → webview: {type:'start'} | {type:'stop'}
 *  webview → ext: {type:'ready'} | {type:'started', mode} | {type:'chunk', b64, isSpeech, tMs}
 *                 | {type:'speech-start'} | {type:'stopped'} | {type:'error', code, message}
 */
/* global acquireVsCodeApi, vad, ort */
(function () {
  const vscode = acquireVsCodeApi();
  const assetBase = document.body.dataset.assetBase; // .../media/vad/
  const statusEl = document.getElementById('status');

  let mode = null; // 'vad' | 'energy'
  let micVad = null;
  let energyCtx = null; // { audioCtx, stream, node }
  let startedAt = 0;
  let stopping = false;

  function post(msg) {
    vscode.postMessage(msg);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function tMs() {
    return Math.round(performance.now() - startedAt);
  }

  /** Float32 [-1,1] → Int16 → base64 */
  function f32ToB64(f32) {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    let bin = '';
    const bytes = new Uint8Array(i16.buffer);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function classifyError(e) {
    const name = (e && e.name) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'permission-denied';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'no-device';
    }
    return 'init-failed';
  }

  function fail(code, e) {
    post({ type: 'error', code, message: String((e && e.message) || e) });
    setStatus('错误: ' + code);
  }

  /** 设备拔出/切换 → 明确失败,不产生半截脏数据(S1 gate)。 */
  function watchTrack(stream) {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (!stopping) fail('device-lost', new Error('audio track ended (device removed or switched)'));
      });
    }
  }

  // ---------- vad 模式 ----------
  async function startVad() {
    micVad = await vad.MicVAD.new({
      model: 'v5',
      baseAssetPath: assetBase,
      onnxWASMBasePath: assetBase,
      processorType: 'auto',
      startOnLoad: false,
      onSpeechRealStart: () => post({ type: 'speech-start' }),
      onFrameProcessed: (probs, frame) => {
        if (stopping) return;
        post({
          type: 'chunk',
          b64: f32ToB64(frame),
          isSpeech: probs.isSpeech > 0.5,
          tMs: tMs(),
        });
      },
      onSpeechStart: () => {},
      onVADMisfire: () => {},
      onSpeechEnd: () => {},
    });
    // MicVAD 内部持有 stream;通过其 options.getStream 包装拿不到实例,
    // 设备拔出由 ondevicechange + AudioContext 状态兜底检测。
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    await micVad.start();
    if (micVad.errored) throw new Error('MicVAD errored: ' + micVad.errored);
    // v0.0.30: micVad._stream 可访问(内部字段,失败不致命)
    try {
      if (micVad._stream) watchTrack(micVad._stream);
    } catch (_) { /* 非致命 */ }
  }

  async function onDeviceChange() {
    if (stopping || mode !== 'vad') return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((d) => d.kind === 'audioinput')) {
        fail('device-lost', new Error('all audio input devices removed'));
      }
    } catch (_) { /* 忽略枚举失败 */ }
  }

  // ---------- energy 降级模式 ----------
  const ENERGY_THRESHOLD = 0.01; // RMS 门限(经验值,S1 实测校准)

  async function startEnergy() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    watchTrack(stream);
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const workletCode = `
      class PcmCapture extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch) this.port.postMessage(ch.slice(0));
          return true;
        }
      }
      registerProcessor('pcm-capture', PcmCapture);
    `;
    const url = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
    await audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioCtx, 'pcm-capture');
    let speechAnnounced = false;
    node.port.onmessage = (ev) => {
      if (stopping) return;
      const f32 = ev.data;
      let sum = 0;
      for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
      const rms = Math.sqrt(sum / f32.length);
      const isSpeech = rms > ENERGY_THRESHOLD;
      if (isSpeech && !speechAnnounced) {
        speechAnnounced = true;
        post({ type: 'speech-start' });
      }
      post({ type: 'chunk', b64: f32ToB64(f32), isSpeech, tMs: tMs() });
    };
    src.connect(node);
    energyCtx = { audioCtx, stream, node };
  }

  // ---------- 生命周期 ----------
  async function start() {
    stopping = false;
    startedAt = performance.now();
    try {
      if (typeof vad !== 'undefined' && typeof ort !== 'undefined') {
        try {
          ort.env.wasm.numThreads = 1; // webview 无 COOP/COEP,禁多线程避免告警
          await startVad();
          mode = 'vad';
        } catch (e) {
          // VAD 初始化失败:权限/设备错误直接上报,其余降级 energy
          const code = classifyError(e);
          if (code === 'permission-denied' || code === 'no-device') throw e;
          console.warn('[voiceflow] VAD init failed, falling back to energy mode', e);
          await startEnergy();
          mode = 'energy';
        }
      } else {
        await startEnergy();
        mode = 'energy';
      }
      setStatus('录音中 (' + mode + ')');
      post({ type: 'started', mode });
    } catch (e) {
      fail(classifyError(e), e);
    }
  }

  async function stop() {
    stopping = true;
    try {
      if (micVad) {
        await micVad.destroy();
        micVad = null;
        navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      }
      if (energyCtx) {
        energyCtx.node.disconnect();
        for (const t of energyCtx.stream.getTracks()) t.stop();
        await energyCtx.audioCtx.close();
        energyCtx = null;
      }
    } catch (e) {
      console.warn('[voiceflow] stop cleanup error', e);
    }
    setStatus('已停止');
    post({ type: 'stopped' });
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'start') void start();
    else if (msg.type === 'stop') void stop();
  });

  post({ type: 'ready' });
  setStatus('就绪,等待开始');
})();
