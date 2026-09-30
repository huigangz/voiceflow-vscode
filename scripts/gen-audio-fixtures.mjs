/**
 * 生成 test/fixtures/audio/ 下的合成语音 fixture 并回填清单(harness PR5,spec §10.4)。
 *
 * 用法(Windows 本机,需系统自带 SAPI 语音):node scripts/gen-audio-fixtures.mjs
 *
 * 构造:静音 + 句 A + 静音 + 句 B + 静音。每句用 System.Speech 单独合成(16k mono s16),按幅度阈值
 * 裁掉首尾静音,再与精确长度的全零段拼接 —— 所以语音 / 静音区段边界由构造得出,直接写进清单,
 * 测试从清单读区段,不在测试里硬编码时间。
 *
 * 不在 CI 跑:不同 Windows 版本的合成结果字节可能不同。提交的 wav + 清单里的 SHA 是唯一事实,
 * 本脚本只负责"这个文件从哪来"可追溯、可重做。
 * 中间产物写在固定临时目录(同名覆盖,不删除),路径会打印出来。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_DIR, MANIFEST, SAMPLE_RATE, decodeWav, encodeWav, sha256 } from './audioFixtures.mjs';

const VOICE = 'Microsoft Zira Desktop';
const FILE = 'speech-en-tts.wav';
const SENTENCES = [
  'Please review my pull request and merge it before the deadline tomorrow.',
  'The quick brown fox jumps over the lazy dog, then runs back home.',
];
const SILENCE_SEC = [1.0, 2.0, 1.0]; // 前 / 句间 / 后
const TRIM_THRESHOLD = 300; // |s16| 低于此值视为静音(仅用于裁首尾)

const WORK = join(tmpdir(), 'voiceflow-gen-audio-fixtures');
mkdirSync(WORK, { recursive: true });

const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice($env:VF_VOICE)
$s.Rate = 0
$s.SetOutputToWaveFile($env:VF_OUT, $fmt)
$s.Speak($env:VF_TEXT)
$s.SetOutputToNull()
$s.Dispose()
`;

function synth(text, out) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
    env: { ...process.env, VF_VOICE: VOICE, VF_OUT: out, VF_TEXT: text },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`SAPI 合成失败(voice=${VOICE}):${r.stderr || r.stdout}`);
  const wav = decodeWav(readFileSync(out));
  if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    throw new Error(`合成格式不符: ${JSON.stringify({ ...wav, pcm: undefined })}`);
  }
  return wav.pcm;
}

function trim(pcm) {
  let s = 0;
  let e = pcm.length;
  while (s < e && Math.abs(pcm[s]) < TRIM_THRESHOLD) s++;
  while (e > s && Math.abs(pcm[e - 1]) < TRIM_THRESHOLD) e--;
  if (e === s) throw new Error('合成结果全为静音');
  return pcm.slice(s, e);
}

const parts = [];
parts.push({ kind: 'silence', pcm: new Int16Array(Math.round(SILENCE_SEC[0] * SAMPLE_RATE)) });
SENTENCES.forEach((text, i) => {
  const tmp = join(WORK, `sentence-${i}.wav`);
  parts.push({ kind: 'speech', text, pcm: trim(synth(text, tmp)) });
  parts.push({ kind: 'silence', pcm: new Int16Array(Math.round(SILENCE_SEC[i + 1] * SAMPLE_RATE)) });
});

const total = parts.reduce((n, p) => n + p.pcm.length, 0);
const pcm = new Int16Array(total);
const regions = [];
let off = 0;
for (const p of parts) {
  pcm.set(p.pcm, off);
  regions.push({ kind: p.kind, startSample: off, endSample: off + p.pcm.length, ...(p.text ? { text: p.text } : {}) });
  off += p.pcm.length;
}

const wav = encodeWav(pcm);
mkdirSync(FIXTURE_DIR, { recursive: true });
writeFileSync(join(FIXTURE_DIR, FILE), wav);

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { fixtures: [] };
const entry = {
  file: FILE,
  sha256: sha256(wav),
  sampleRate: SAMPLE_RATE,
  channels: 1,
  bitsPerSample: 16,
  source: {
    kind: 'synthetic-tts',
    engine: 'Windows SAPI 5 (System.Speech.Synthesis)',
    voice: VOICE,
    generator: 'scripts/gen-audio-fixtures.mjs',
  },
  regions,
};
manifest.fixtures = [...manifest.fixtures.filter((f) => f.file !== FILE), entry];
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[gen-audio-fixtures] ${FIXTURE_DIR}/${FILE}  ${(total / SAMPLE_RATE).toFixed(2)}s  sha256 ${entry.sha256}`);
for (const r of regions) {
  console.log(`  ${r.kind.padEnd(7)} ${(r.startSample / SAMPLE_RATE).toFixed(2)}–${(r.endSample / SAMPLE_RATE).toFixed(2)}s${r.text ? `  "${r.text}"` : ''}`);
}
console.log(`  中间产物(未删除):${WORK}`);
