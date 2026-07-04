/**
 * whisper-server warm 延迟基准(P1-A no-BLAS 决策 + §8.1 数据)。
 *
 * 与产品同路径:server **启动一次** → 预热一次 → 对固定音频集**重复转写**,
 * 记录 warm 延迟 P50/P95(排除 cold start)。这才是产品实际延迟;
 * quality-test.mjs --rerun 用 CLI 每条冷加载,不可用于本决策。
 *
 * 用法:
 *   node scripts/bench-server.mjs                 # 默认 small 模型,每条 ×5
 *   node scripts/bench-server.mjs --repeat 8 --model <path>
 *
 * 依赖:bin/whisper-server.exe + DLL(npm run build:whisper);test-audio/*.wav。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, openAsBlob } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REPEAT = Number(getArg('--repeat', '5'));
const MODEL = getArg(
  '--model',
  join(process.env.APPDATA, 'Code/User/globalStorage/voiceflow-preview.voiceflow-vscode/models/ggml-small.bin'),
);
const BIN_DIR = getArg('--bin-dir', join(root, 'bin'));
const SERVER = join(BIN_DIR, 'whisper-server.exe');
const AUDIO_DIR = join(root, 'test-audio');
const PROMPT = '以下是简体中文普通话的句子,使用标点符号。';

if (!existsSync(SERVER)) { console.error(`缺 ${SERVER}(先 npm run build:whisper)`); process.exit(1); }
if (!existsSync(MODEL)) { console.error(`缺模型 ${MODEL}`); process.exit(1); }
const clips = existsSync(AUDIO_DIR) ? readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.wav')) : [];
if (clips.length === 0) { console.error(`test-audio/ 无 wav(先 node scripts/quality-test.mjs)`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function transcribe(port, wav) {
  const form = new FormData();
  form.append('file', await openAsBlob(wav), 'audio.wav');
  form.append('response_format', 'json');
  form.append('prompt', PROMPT);
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
  const body = await res.text();
  const ms = Date.now() - t0;
  const text = (JSON.parse(body).text ?? '').trim();
  return { ms, text };
}

const port = await freePort();
console.log(`[bench] model=${MODEL.split(/[\\/]/).pop()} repeat=${REPEAT} clips=${clips.length}`);
const t0 = Date.now();
const proc = spawn(SERVER, ['-m', MODEL, '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
try {
  // 等就绪
  for (;;) {
    if (proc.exitCode !== null) throw new Error('server 启动即退出');
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); break; } catch { await sleep(250); }
  }
  console.log(`[bench] server ready, cold start ${Date.now() - t0}ms(不计入 warm)`);
  await transcribe(port, join(AUDIO_DIR, clips[0])); // 预热

  const all = [];
  for (const clip of clips) {
    const wav = join(AUDIO_DIR, clip);
    const runs = [];
    let firstText = '';
    for (let i = 0; i < REPEAT; i++) {
      const { ms, text } = await transcribe(port, wav);
      runs.push(ms);
      if (i === 0) firstText = text;
    }
    all.push(...runs);
    console.log(`  ${clip.padEnd(14)} warm P50=${pct(runs, 50)}ms P95=${pct(runs, 95)}ms  "${firstText.slice(0, 40)}"`);
  }
  console.log(`\n[bench] 总体 warm  P50=${pct(all, 50)}ms  P95=${pct(all, 95)}ms  (n=${all.length})`);
  console.log('[bench] no-BLAS 决策阈值:P50 ≤ 10000ms 且 P95 ≤ 15000ms + 输出逐字一致/人工判可接受');
} finally {
  proc.kill();
}
