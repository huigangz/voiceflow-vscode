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
 * 输出:test-audio/<id>.wav + test-audio/results-<timestamp>.md / .json
 *
 * CER(harness PR5,spec §10.5–§10.6):参考文本与转写都先过 scripts/cer.mjs 的 normalizeForEvaluation
 * (NFKC / 繁→简 / 小写 / 删标点 / 删空白),再按码点算编辑距离;汇总 = 按用例加权的宏平均
 * Σ(w·CER)/Σw(mixed 权重 2,其余 1;silence 参考为空,不参与汇总,单独报是否误出字)。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cer, weightedCer } from './cer.mjs';

// script = 录音时给人看的提示;ref = 实际要念的文本(CER 参考);weight = 汇总权重(0 = 不参与)
const CASES = [
  { id: 'zh', dur: 6, label: '纯中文 5s', weight: 1, script: '今天下午三点我们开个会,讨论一下新版本的发布计划。' },
  { id: 'en', dur: 6, label: '纯英文 5s', weight: 1, script: 'Please review my pull request and merge it before the deadline tomorrow.' },
  { id: 'mixed', dur: 11, label: '中英混合 10s(核心场景,权重最高)', weight: 2, script: '我今天用 React 重构了 login 页面,顺便把 API 的 error handling 也改了一下,然后跑了一遍 unit test,全部通过。' },
  { id: 'jargon', dur: 11, label: '代码术语 10s', weight: 1, script: '这个 React component 要部署到 Kubernetes 集群,记得配 CI/CD pipeline,Docker image 推到 registry,再看一下 GitHub Actions 的 workflow。' },
  { id: 'noise', dur: 11, label: '背景噪音 10s(请先打开音乐/风扇再念)', weight: 1, script: '同 mixed:我今天用 React 重构了 login 页面,顺便把 API 的 error handling 也改了一下。', ref: '我今天用 React 重构了 login 页面,顺便把 API 的 error handling 也改了一下。' },
  { id: 'silence', dur: 6, label: '静音/误触发(什么都不要说)', weight: 0, script: '(保持安静 5 秒,预期:空结果或被幻觉防线拦截)', ref: '' },
].map((c) => ({ ...c, ref: c.ref ?? c.script }));

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
  if (r.status !== 0) return { text: `[转写失败 code=${r.status}] ${(r.stderr || '').slice(-200)}`, ms, failed: true };
  return { text: r.stdout.trim(), ms, failed: false };
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

const results = [];
const cases = only ? CASES.filter((c) => c.id === only) : CASES;
for (const c of cases) {
  const wav = join(OUT, `${c.id}.wav`);
  if (!rerun) await record(c);
  else if (!existsSync(wav)) { console.log(`跳过 ${c.id}(无 ${wav})`); continue; }
  process.stdout.write('⏳ 转写中…');
  const { text, ms, failed } = transcribe(wav);
  // 转写失败不算 CER(错误信息不是转写),汇总里剔除并显式标注
  const score = failed ? { normRef: '', normHyp: '', distance: null, refLen: null, cer: null } : cer(c.ref, text);
  const falseOutput = !failed && c.ref === '' ? score.normHyp !== '' : null;
  const tag = failed ? '转写失败' : falseOutput !== null ? `误出字: ${falseOutput ? '是' : '否'}` : `CER ${pct(score.cer)}`;
  console.log(`\r📝 [${(ms / 1000).toFixed(1)}s,含冷加载] [${tag}] ${text || '(空)'}`);
  results.push({ ...c, text, ms, failed, falseOutput, ...score });
}

const aggregate = weightedCer(results.filter((r) => !r.failed));
const failedIds = results.filter((r) => r.failed).map((r) => r.id);
const aggregateLine = `weighted CER = Σ(w·CER)/Σw = ${pct(aggregate)}` + (failedIds.length ? `(不完整:${failedIds.join(', ')} 转写失败,已剔除)` : '');

// 存档 markdown + json
const stamp = `${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${LANG}`;
const md = [
  `# 转写质量测试 — ${stamp}`,
  `模型: ${MODEL}\n语言: ${LANG}\n形态: whisper-cli(每条含冷加载;产品内 server 形态 warm 更快)\n`,
  `## 汇总\n- ${aggregateLine}\n- 权重: ${results.map((r) => `${r.id}=${r.weight}`).join(', ')}\n- 归一化: NFKC / 繁→简 / 小写 / 删标点 / 删空白(scripts/cer.mjs)`,
  ...results.map((r) =>
    [
      `## ${r.label}`,
      `- 参考原文: ${r.ref || '(空)'}`,
      `- 转写结果: ${r.text || '(空)'}`,
      `- 归一化参考: ${r.normRef || '(空)'}`,
      `- 归一化转写: ${r.normHyp || '(空)'}`,
      r.failed ? '- CER: n/a(转写失败)' : r.falseOutput !== null ? `- 误出字: ${r.falseOutput ? '是' : '否'}` : `- CER: ${pct(r.cer)}(编辑距离 ${r.distance} / ${r.refLen})`,
      `- 耗时: ${(r.ms / 1000).toFixed(1)}s`,
    ].join('\n'),
  ),
].join('\n\n');
const mdPath = join(OUT, `results-${stamp}.md`);
writeFileSync(mdPath, md);
const jsonPath = join(OUT, `results-${stamp}.json`);
writeFileSync(
  jsonPath,
  `${JSON.stringify(
    {
      stamp,
      model: MODEL,
      lang: LANG,
      runtime: 'whisper-cli (cold load per case)',
      weightedCer: aggregate,
      failed: failedIds,
      cases: results.map((r) => ({
        id: r.id,
        weight: r.weight,
        reference: r.ref,
        hypothesis: r.text,
        normalizedReference: r.normRef,
        normalizedHypothesis: r.normHyp,
        distance: r.distance,
        refLen: r.refLen,
        cer: r.cer,
        falseOutput: r.falseOutput,
        failed: r.failed,
        latencyMs: r.ms,
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(`\n${aggregateLine}\n📄 结果已存 ${mdPath}\n   ${jsonPath}`);
