/**
 * S2 转写质量测试(spec §9.2 固定音频测试集)。
 *
 * 用法(在你自己的终端里跑,需要麦克风):
 *   node scripts/quality-test.mjs            # 引导录制全部 6 条 + 逐条转写
 *   node scripts/quality-test.mjs mixed      # 只录某一条(id 见 CASES)
 *   node scripts/quality-test.mjs --rerun    # 不重录,用已有 test-audio/*.wav 重跑转写
 *                                            #(换模型/语言后回归对比用)
 *   可选:--model <path> --lang zh|en|auto(默认 zh,产品默认值)
 *
 * 输出:test-audio/<id>.wav + test-audio/results-<timestamp>.md
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CASES = [
  { id: 'zh', dur: 6, label: '纯中文 5s', script: '今天下午三点我们开个会,讨论一下新版本的发布计划。' },
  { id: 'en', dur: 6, label: '纯英文 5s', script: 'Please review my pull request and merge it before the deadline tomorrow.' },
  { id: 'mixed', dur: 11, label: '中英混合 10s(核心场景,权重最高)', script: '我今天用 React 重构了 login 页面,顺便把 API 的 error handling 也改了一下,然后跑了一遍 unit test,全部通过。' },
  { id: 'jargon', dur: 11, label: '代码术语 10s', script: '这个 React component 要部署到 Kubernetes 集群,记得配 CI/CD pipeline,Docker image 推到 registry,再看一下 GitHub Actions 的 workflow。' },
  { id: 'noise', dur: 11, label: '背景噪音 10s(请先打开音乐/风扇再念)', script: '同 mixed:我今天用 React 重构了 login 页面,顺便把 API 的 error handling 也改了一下。' },
  { id: 'silence', dur: 6, label: '静音/误触发(什么都不要说)', script: '(保持安静 5 秒,预期:空结果或被幻觉防线拦截)' },
];

const args = process.argv.slice(2);
const rerun = args.includes('--rerun');
const langIdx = args.indexOf('--lang');
const LANG = langIdx >= 0 ? args[langIdx + 1] : 'zh';
const modelIdx = args.indexOf('--model');
const MODEL =
  modelIdx >= 0
    ? args[modelIdx + 1]
    : join(
        process.env.APPDATA,
        'Code/User/globalStorage/voiceflow-preview.voiceflow-vscode/models/ggml-small.bin',
      );
const only = args.find((a) => !a.startsWith('--') && CASES.some((c) => c.id === a));
const MIC = 'bin/voiceflow-mic.exe';
const WHISPER = 'bin/whisper-cli.exe';
const OUT = 'test-audio';
const PROMPT = '以下是简体中文普通话的句子,使用标点符号。';

if (!existsSync(MODEL)) { console.error(`模型不存在: ${MODEL}(用 --model 指定)`); process.exit(1); }
if (!existsSync(WHISPER)) { console.error(`缺 ${WHISPER}`); process.exit(1); }
mkdirSync(OUT, { recursive: true });

function wavHeader(pcmLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcmLen, 40);
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record(c) {
  console.log(`\n━━━ ${c.label} ━━━`);
  console.log(`请念:${c.script}`);
  for (const n of [3, 2, 1]) { process.stdout.write(`  ${n}…`); await sleep(1000); }
  const chunks = [];
  const p = spawn(MIC);
  p.stdout.on('data', (b) => chunks.push(b));
  // 等麦克风真正就绪再提示开口,否则开头吞字(2026-07-04 实测:吞掉"今天下午")
  await new Promise((r) => p.stderr.on('data', (d) => d.toString().includes('READY') && r()));
  console.log('\n🎙 录音中,请开始…');
  setTimeout(() => p.stdin.end(), c.dur * 1000);
  await new Promise((r) => p.on('close', r));
  const pcm = Buffer.concat(chunks);
  const wav = join(OUT, `${c.id}.wav`);
  writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]));
  console.log(`✔ 已存 ${wav}(${(pcm.length / 32000).toFixed(1)}s)`);
  return wav;
}

function transcribe(wav) {
  const t0 = Date.now();
  const r = spawnSync(WHISPER, ['-m', MODEL, '-f', wav, '-l', LANG, '--prompt', PROMPT, '-nt', '-np'],
    { encoding: 'utf8' });
  const ms = Date.now() - t0;
  if (r.status !== 0) return { text: `[转写失败 code=${r.status}] ${(r.stderr || '').slice(-200)}`, ms };
  return { text: r.stdout.trim(), ms };
}

const results = [];
const cases = only ? CASES.filter((c) => c.id === only) : CASES;
for (const c of cases) {
  const wav = join(OUT, `${c.id}.wav`);
  if (!rerun) await record(c);
  else if (!existsSync(wav)) { console.log(`跳过 ${c.id}(无 ${wav})`); continue; }
  process.stdout.write('⏳ 转写中…');
  const { text, ms } = transcribe(wav);
  console.log(`\r📝 [${(ms / 1000).toFixed(1)}s,含冷加载] ${text || '(空)'}`);
  results.push({ ...c, text, ms });
}

// 存档 markdown
const stamp = `${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${LANG}`;
const md = [
  `# 转写质量测试 — ${stamp}`,
  `模型: ${MODEL}\n语言: ${LANG}\n形态: whisper-cli(每条含冷加载;产品内 server 形态 warm 更快)\n`,
  ...results.map((r) => `## ${r.label}\n- 参考原文: ${r.script}\n- 转写结果: ${r.text || '(空)'}\n- 耗时: ${(r.ms / 1000).toFixed(1)}s`),
].join('\n\n');
const mdPath = join(OUT, `results-${stamp}.md`);
writeFileSync(mdPath, md);
console.log(`\n📄 结果已存 ${mdPath}\n对照参考原文自查:术语是否保真、标点是否合理、简繁是否正确、静音是否为空。`);
