/**
 * 提交进仓库的音频 fixture:WAV 读写 + 清单(test/fixtures/audio/fixtures.json)校验(harness PR5)。
 *
 * 规则(spec §10.3):committed 音频只允许合成 / 明确授权再分发 / 公有领域;禁止个人录音、会议录音、用户语音。
 * README 只是说明,真正的防线是这里的机检:仓库里每个音频文件都必须登记在清单里,并写明来源、SHA、区段。
 * 被 test/audioFixtures.test.ts(守卫)、test/sileroVad.test.ts(读 PCM + 区段)、
 * scripts/gen-audio-fixtures.mjs(生成)共用。
 */
import { createHash } from 'node:crypto';

export const FIXTURE_DIR = 'test/fixtures/audio';
export const MANIFEST = `${FIXTURE_DIR}/fixtures.json`;
export const SAMPLE_RATE = 16000;

/** git 跟踪的这些扩展名一律视为音频,必须登记。 */
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'webm'];

/** source.kind → 必填字段。 */
export const SOURCE_KINDS = {
  'synthetic-tts': ['engine', 'voice', 'generator'],
  'synthetic-procedural': ['generator'],
  licensed: ['license', 'url'],
};

/** 16-bit PCM WAV 头(44 字节)+ 数据。 */
export function encodeWav(pcm, sampleRate = SAMPLE_RATE) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * 按 chunk 解析 WAV(SAPI 等工具产出的头不一定是 44 字节)。
 * @returns {{ format: number, channels: number, sampleRate: number, bitsPerSample: number, pcm: Int16Array }}
 */
export function decodeWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }
  let fmt;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = buf.toString('ascii', o, o + 4);
    const len = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk 出现在 fmt chunk 之前');
      if (body + len > buf.length) throw new Error('data chunk 越界');
      // 拷贝一份:Int16Array 要求 2 字节对齐
      const bytes = buf.subarray(body, body + len);
      const pcm = new Int16Array(Math.floor(len / 2));
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
      return { ...fmt, pcm };
    }
    o = body + len + (len & 1);
  }
  throw new Error('缺少 data chunk');
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isAudioPath(p) {
  const m = /\.([^./]+)$/.exec(p);
  return !!m && AUDIO_EXTENSIONS.includes(m[1].toLowerCase());
}

/**
 * 仓库里被跟踪、却不在清单里的音频文件(个人录音被 `git add -f` 等)。
 * @param {string[]} trackedFiles git ls-files 输出(正斜杠)
 * @param {{ fixtures: { file: string }[] }} manifest
 */
export function findUnregisteredAudio(trackedFiles, manifest) {
  const registered = new Set(manifest.fixtures.map((f) => `${FIXTURE_DIR}/${f.file}`));
  const errors = [];
  for (const p of trackedFiles) {
    if (!isAudioPath(p)) continue;
    if (!p.startsWith(`${FIXTURE_DIR}/`)) errors.push(`音频文件不在 ${FIXTURE_DIR}/ 下: ${p}`);
    else if (!registered.has(p)) errors.push(`音频文件未登记在 ${MANIFEST}: ${p}`);
  }
  return errors;
}

/**
 * 校验一条清单记录与其文件内容。
 * @param {object} entry 清单记录
 * @param {Buffer} buf 文件内容
 * @returns {string[]} 错误列表
 */
export function checkFixtureEntry(entry, buf) {
  const errors = [];
  const at = (m) => errors.push(`${entry.file}: ${m}`);

  const required = SOURCE_KINDS[entry.source?.kind];
  if (!required) at(`source.kind 非法: ${entry.source?.kind}(允许 ${Object.keys(SOURCE_KINDS).join(' / ')})`);
  else for (const k of required) if (!entry.source[k]) at(`source.${k} 缺失(${entry.source.kind} 必填)`);

  const actual = sha256(buf);
  if (entry.sha256 !== actual) at(`SHA 不符:清单 ${entry.sha256},实际 ${actual}`);

  let wav;
  try {
    wav = decodeWav(buf);
  } catch (e) {
    at(`WAV 解析失败: ${e.message}`);
    return errors;
  }
  if (wav.format !== 1 || wav.channels !== 1 || wav.sampleRate !== SAMPLE_RATE || wav.bitsPerSample !== 16) {
    at(`格式须为 PCM / mono / ${SAMPLE_RATE}Hz / 16bit,实际 format=${wav.format} ch=${wav.channels} sr=${wav.sampleRate} bits=${wav.bitsPerSample}`);
  }
  // 清单里记录的格式必须与文件头一致(README 要求登记格式;登记值不能是摆设)
  for (const k of ['sampleRate', 'channels', 'bitsPerSample']) {
    if (entry[k] !== wav[k]) at(`清单 ${k}=${entry[k]} 与文件头 ${wav[k]} 不符`);
  }

  const regions = entry.regions ?? [];
  if (regions.length === 0) at('regions 为空');
  let cursor = 0;
  for (const [i, r] of regions.entries()) {
    if (r.kind !== 'speech' && r.kind !== 'silence') at(`regions[${i}].kind 非法: ${r.kind}`);
    if (r.startSample !== cursor) at(`regions[${i}] 未与上一段首尾相接:start=${r.startSample},期望 ${cursor}`);
    if (!(r.endSample > r.startSample)) at(`regions[${i}] 长度非正`);
    cursor = r.endSample;
  }
  if (regions.length > 0 && cursor !== wav.pcm.length) at(`regions 未恰好覆盖 data:止于 ${cursor},data 共 ${wav.pcm.length} 样本`);
  return errors;
}
