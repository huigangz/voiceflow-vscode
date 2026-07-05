/**
 * bin/ 分层校验 gate(打包前,fail-closed)。
 *
 * ① 文件名集合与 bin.manifest.json **完全相等**(多/缺任一即失败;
 *    未知文件交人工排查,不自动删 —— 符合安全规则)。
 * ② source=="whisper" 的文件:逐一校验 SHA-256。
 * ③ voiceflow-mic.exe(verify=="format"):只校验 存在 + 非空 + PE 头(MZ)。
 *    (.NET Framework csc.exe 无 /deterministic,重编译哈希会变 → 不固定 SHA。)
 * ④ P2a:manifest.nodeAddons —— node_modules 内 native addon 逐一校验 存在 + SHA-256
 *    (fail-closed:pin 升级未同步更新 manifest、包被篡改/损坏都在打包前拦下)。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'bin.manifest.json'), 'utf8'));
const binDir = join(root, 'bin');

const errors = [];
const expected = new Set(Object.keys(manifest.files));

// ① 精确集合
if (!existsSync(binDir)) {
  console.error('[verify-bin] FATAL: bin/ 不存在(先 npm run build:helper && build:whisper)');
  process.exit(1);
}
const actual = new Set(readdirSync(binDir).filter((f) => statSync(join(binDir, f)).isFile()));
for (const f of expected) if (!actual.has(f)) errors.push(`缺少文件: ${f}`);
for (const f of actual) if (!expected.has(f)) errors.push(`未知文件(交人工排查,勿自动删): ${f}`);

// ②③ 分层内容校验(仅对集合已匹配的文件)
for (const [name, meta] of Object.entries(manifest.files)) {
  const p = join(binDir, name);
  if (!existsSync(p)) continue; // 已在 ① 报缺失
  const size = statSync(p).size;
  if (size === 0) {
    errors.push(`文件为空: ${name}`);
    continue;
  }
  if (meta.verify === 'format') {
    // PE 格式:前两字节 'MZ'
    const head = readFileSync(p).subarray(0, 2);
    if (!(head[0] === 0x4d && head[1] === 0x5a)) errors.push(`${name} 非 PE 格式(缺 MZ 头)`);
  } else if (meta.sha256) {
    const h = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (h !== meta.sha256) errors.push(`${name} SHA-256 不匹配\n    期望 ${meta.sha256}\n    实际 ${h}`);
  } else {
    errors.push(`${name} manifest 未定义校验方式(sha256 或 verify:format)`);
  }
}

// ④ P2a:nodeAddons 校验(路径相对仓库根)
const addonCount = Object.keys(manifest.nodeAddons ?? {}).length;
for (const [relPath, meta] of Object.entries(manifest.nodeAddons ?? {})) {
  const p = join(root, relPath);
  if (!existsSync(p)) {
    errors.push(`nodeAddon 缺失: ${relPath}(先 npm install)`);
    continue;
  }
  const h = createHash('sha256').update(readFileSync(p)).digest('hex');
  if (h !== meta.sha256) {
    errors.push(`nodeAddon SHA-256 不匹配: ${relPath}\n    期望 ${meta.sha256}\n    实际 ${h}\n    (pin 升级需同步更新 manifest;否则疑似篡改/损坏)`);
  }
}

if (errors.length > 0) {
  console.error(`[verify-bin] FAIL —— 与 manifest 不符(${errors.length} 项):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`[verify-bin] OK: bin/ ${expected.size} 文件 + nodeAddons ${addonCount} 项,SHA/格式校验全部通过`);
