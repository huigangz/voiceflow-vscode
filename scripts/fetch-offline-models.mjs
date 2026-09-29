/**
 * 按钉死的 HF revision 下载 offline 包内置模型到 offline-model/(harness PR3,fail-closed)。
 * release workflow 用;本机也可用(替代从 globalStorage 复制的 stage-bundled-model)。
 *
 * 用法:
 *   node scripts/fetch-offline-models.mjs                      # 下载 / 复用 → offline-model/
 *   node scripts/fetch-offline-models.mjs --base https://hf-mirror.com
 *   node scripts/fetch-offline-models.mjs --cache-key          # 打印 actions/cache 用的 key(按全部 SHA 派生)
 *
 * 清单与 SHA 的唯一来源 = packageContract.mjs(OFFLINE_WHISPER / OFFLINE_ONNX,后者与
 * src/stt/onnxModels.ts 单测交叉校验)。每个文件:
 *   - 已存在且 SHA 正确 → 复用(缓存命中也照样校验);
 *   - 已存在但 SHA 不对 → 失败,**不覆盖**(交人工处理);
 *   - 不存在 → 下载到 `<file>.partial`(覆盖写)→ 校验 SHA → 原子 rename;SHA 不符则失败,.partial 留在原处。
 * ONNX 全部就位后写完成标记,内容 = offlineMarkerContent()(与运行时逐字一致)。
 * 本脚本不删除任何文件。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { OFFLINE_ONNX, offlineMarkerContent, offlineModelFiles } from './packageContract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getArg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = (m) => console.log(`[fetch-offline-models] ${m}`);
const die = (m) => {
  console.error(`[fetch-offline-models] FAIL: ${m}`);
  process.exit(1);
};

const files = offlineModelFiles();

if (argv.includes('--cache-key')) {
  const digest = createHash('sha256').update(files.map((f) => `${f.path}=${f.sha256}`).join('\n')).digest('hex');
  console.log(`offline-models-${digest.slice(0, 16)}`);
  process.exit(0);
}

const base = (getArg('--base') ?? 'https://huggingface.co').replace(/\/+$/, '');
const sha256File = (p) =>
  new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
const mb = (n) => `${(n / 1e6).toFixed(1)}MB`;

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`);
  const h = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      h.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(dest));
  return { sha256: h.digest('hex'), bytes };
}

let reused = 0;
let fetched = 0;
for (const f of files) {
  const dest = join(root, f.path);
  if (existsSync(dest)) {
    const actual = await sha256File(dest);
    if (actual !== f.sha256) {
      die(`${f.path} 已存在但 SHA 不符(不覆盖,请人工检查/移走后重跑)\n  期望 ${f.sha256}\n  实际 ${actual}`);
    }
    log(`复用 ${f.path}(${mb(statSync(dest).size)},SHA ok)`);
    reused++;
    continue;
  }
  const url = `${base}/${f.repo}/resolve/${f.revision}/${f.repoPath}`;
  const partial = `${dest}.partial`;
  mkdirSync(dirname(dest), { recursive: true });
  log(`下载 ${url}`);
  const t0 = Date.now();
  let got;
  try {
    got = await download(url, partial);
  } catch (e) {
    die(`${f.path} 下载失败: ${e.message}`);
  }
  if (got.sha256 !== f.sha256) {
    die(`${f.path} 下载内容 SHA 不符(供应链校验失败,未采用;${partial} 留存待查)\n  期望 ${f.sha256}\n  实际 ${got.sha256}`);
  }
  renameSync(partial, dest);
  log(`  ✓ ${f.path}(${mb(got.bytes)},${((Date.now() - t0) / 1000).toFixed(1)}s,SHA ok)`);
  fetched++;
}

const markerPath = join(root, OFFLINE_ONNX.dir, OFFLINE_ONNX.marker);
const marker = offlineMarkerContent();
if (!existsSync(markerPath) || readFileSync(markerPath, 'utf8') !== marker) {
  writeFileSync(markerPath, marker);
  log(`写完成标记 ${OFFLINE_ONNX.dir}${OFFLINE_ONNX.marker}`);
}
log(`OK:${files.length} 个模型文件就位(复用 ${reused},下载 ${fetched}),均已 SHA 校验`);
