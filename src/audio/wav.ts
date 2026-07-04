/**
 * WAV 编码(16-bit PCM 单声道)— 纯逻辑,可单元测试。
 * whisper.cpp 接受标准 RIFF/WAVE 16kHz mono s16le。
 */

export function encodeWavPcm16(chunks: Int16Array[], sampleRate: number): Buffer {
  const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
  const dataBytes = totalSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      buf.writeInt16LE(c[i]!, offset);
      offset += 2;
    }
  }
  return buf;
}

/** base64(webview postMessage 传输格式)→ Int16Array。 */
export function base64ToInt16(b64: string): Int16Array {
  const raw = Buffer.from(b64, 'base64');
  return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
}
