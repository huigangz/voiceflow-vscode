/**
 * VSIX 产物校验 gate(harness PR1,fail-closed)—— 对**实际打出的 .vsix** 断言内容。
 *
 * 用法:node scripts/verify-package.mjs --variant standard|offline [path/to.vsix]
 *   variant 必须显式给出(不按尺寸猜);省略路径时按 package.json name+version 推导默认文件名。
 *
 * 校验:条目契约(根目录白名单 / 目录精确集合 / 必需文件 / variant 分支,见 packageContract.mjs)
 *       + 版本一致性(仓库 package.json == VSIX 内 package.json == 文件名)
 *       + 尺寸预算 + 产物内 SHA-256(bin / nodeAddons / runtimeAssets 对照 bin.manifest.json;
 *       offline 另含 whisper 模型 + ONNX 模型 7 文件)+ require 冒烟(解出 node_modules 真正加载打洞包)。
 *
 * 不挂 vscode:prepublish:那一步在 vsce 打包过程中执行,VSIX 尚不存在。
 * 列条目用 Windows 自带 bsdtar(System32\tar.exe 能读 zip);Git Bash 的 GNU tar 读不了 zip,
 * 所以显式指定路径而非依赖 PATH。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEntries, checkSize, checkVersion, hashExpectations, smokeScript, vsixFileName } from './packageContract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'bin.manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const vi = argv.indexOf('--variant');
const variant = vi >= 0 ? argv[vi + 1] : undefined;
if (variant !== 'standard' && variant !== 'offline') {
  console.error('[verify-package] FATAL: 必须指定 --variant standard|offline');
  process.exit(1);
}
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== vi + 1);
const vsix = resolve(positional[0] ?? join(root, vsixFileName(pkg, variant)));
if (!existsSync(vsix)) {
  console.error(`[verify-package] FATAL: 找不到 ${vsix}`);
  process.exit(1);
}

const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const tar = (args, opts = {}) => execFileSync(TAR, args, { maxBuffer: 1024 * 1024 * 1024, ...opts });

const entries = tar(['-tf', vsix], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const errors = [];

errors.push(...checkEntries({ entries, variant, manifest }));

let innerVersion = '(unreadable)';
try {
  innerVersion = JSON.parse(tar(['-xOf', vsix, 'extension/package.json'], { encoding: 'utf8' })).version;
} catch (e) {
  errors.push(`[version] 读取 VSIX 内 package.json 失败: ${e.message}`);
}
errors.push(...checkVersion({ repoVersion: pkg.version, innerVersion, fileName: basename(vsix), variant }));

const bytes = statSync(vsix).size;
errors.push(...checkSize({ bytes, variant }));

// 产物内 SHA:证明进包的就是 manifest 固定的那份(source integrity 之外的 artifact composition)
const entrySet = new Set(entries);
let hashed = 0;
for (const [rel, expected] of hashExpectations(manifest, variant)) {
  const name = `extension/${rel}`;
  if (!entrySet.has(name)) continue; // 缺失已由 checkEntries 报告
  const actual = createHash('sha256').update(tar(['-xOf', vsix, name])).digest('hex');
  hashed++;
  if (actual !== expected) {
    const hint = rel.endsWith('.voiceflow-complete') ? '(完成标记内容与当前模型清单不一致:空/过期标记 → 运行时判内置模型不可用)' : '';
    errors.push(`[sha256] ${rel} 不匹配${hint}\n      期望 ${expected}\n      实际 ${actual}`);
  }
}

// require 冒烟:只解出 node_modules,真正加载打洞包(证明闭包可加载,而不只是清单里的文件都在)。
// 解包目录按 VSIX 内容 SHA 寻址:同一产物重复验证 → 同一目录覆盖解包(内容相同,无残留歧义);
// 脚本不做任何删除(用户规则:禁止递归删除目录),路径打印出来由用户自行清理。
// 该目录上层无 node_modules,require 无法逃逸到仓库依赖。
let smoke = 'skipped(条目契约已失败)';
let smokeDir = '';
if (errors.length === 0) {
  const vsixSha = await new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(vsix).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
  smokeDir = join(tmpdir(), 'voiceflow-verify-package', vsixSha.slice(0, 16));
  try {
    mkdirSync(smokeDir, { recursive: true });
    tar(['-xf', vsix, '-C', smokeDir, 'extension/node_modules']);
    const extRoot = join(smokeDir, 'extension').replace(/\\/g, '/');
    smoke = execFileSync(process.execPath, ['-e', smokeScript(extRoot)], { cwd: smokeDir, encoding: 'utf8' }).trim();
  } catch (e) {
    smoke = 'FAIL';
    errors.push(`[smoke] 解包后 require 打洞包失败:\n      ${String(e.stderr || e.message).trim().split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const summary = `${basename(vsix)} | variant=${variant} | ${entries.length} 条目 | ${(bytes / 1024 / 1024).toFixed(2)}MB | SHA 校验 ${hashed} 项 | ${smoke}`;
const smokeNote = smokeDir ? `\n  冒烟解包目录(保留,按需手动清理): ${smokeDir}` : '';
if (errors.length > 0) {
  console.error(`[verify-package] FAIL —— ${summary}${smokeNote}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`[verify-package] PASS —— ${summary}${smokeNote}`);
