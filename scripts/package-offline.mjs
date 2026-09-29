/**
 * 打 offline VSIX(harness PR3,fail-closed)—— 取代 package:bundled 里手写的长命令。
 *
 * 用法:
 *   node scripts/package-offline.mjs            # 打包 + verify-package --variant offline
 *   node scripts/package-offline.mjs --dry-run  # 只做静态校验(PR CI):文件名推导 + ignore 生成与差异断言
 *   node scripts/package-offline.mjs --out-dir <dir>  # 产物写到 <dir>(默认仓库根;文件名仍由版本推导)
 *
 * 流程:ignore 生成(由 .vscodeignore 派生,差异恰为 offline-model/**)→ prepack-check
 *       → 暂存模型预检(逐文件 SHA + 完成标记内容 + 无清单外文件;模型由 stage-bundled-model
 *       或 fetch-offline-models 放置)→ vsce package --ignoreFile <生成文件> -o <文件名>
 *       → verify-package --variant offline。
 * 版本号只从 package.json 读(§8.3);生成的 ignore 写到 %TEMP%(覆盖写,不进仓库、不删除任何文件)。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuleDiff, generateOfflineIgnore, ruleDiff } from './offlineIgnore.mjs';
import { OFFLINE_ONNX, offlineMarkerContent, offlineModelFiles, vsixFileName } from './packageContract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const outDirArg = argv.indexOf('--out-dir') >= 0 ? argv[argv.indexOf('--out-dir') + 1] : undefined;
const log = (m) => console.log(`[package-offline] ${m}`);
const die = (m) => {
  console.error(`[package-offline] FAIL: ${m}`);
  process.exit(1);
};

/** 子步骤失败 → 带步骤名退出(子进程自己的输出已经 inherit 打印过)。 */
const run = (script, args) => {
  try {
    execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  } catch (e) {
    die(`${relative(root, script)} 失败(exit ${e.status ?? '?'})`);
  }
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outName = vsixFileName(pkg, 'offline');
if (argv.includes('--out-dir') && !outDirArg) die('--out-dir 需要一个目录参数');
const outPath = join(outDirArg ? resolve(outDirArg) : root, outName);

const standardIgnore = readFileSync(join(root, '.vscodeignore'), 'utf8');
let offlineIgnore;
try {
  offlineIgnore = generateOfflineIgnore(standardIgnore);
} catch (e) {
  die(e.message);
}
const diff = ruleDiff(standardIgnore, offlineIgnore);
const diffErrors = checkRuleDiff(diff);
if (diffErrors.length > 0) die(diffErrors.join('; '));

log(`version ${pkg.version} → ${outPath}`);
log(`ignore 差异(standard → offline):去掉 [${diff.removed.join(', ')}],新增 [${diff.added.join(', ')}]`);
if (dryRun) {
  log('dry-run OK(未打包、未检查模型)');
  process.exit(0);
}

run(join(root, 'scripts', 'prepack-check.mjs'), []);

// 暂存模型预检:594MB 打包 + 解包校验之前先 fail-fast(verify-package 仍会对产物再验一遍)
const sha256File = (p) =>
  new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
const problems = [];
const expected = offlineModelFiles();
for (const f of expected) {
  const p = join(root, f.path);
  if (!existsSync(p)) problems.push(`缺失 ${f.path}`);
  else if ((await sha256File(p)) !== f.sha256) problems.push(`SHA 不匹配 ${f.path}`);
}
const markerRel = OFFLINE_ONNX.dir + OFFLINE_ONNX.marker;
const markerPath = join(root, markerRel);
if (!existsSync(markerPath)) problems.push(`缺失 ${markerRel}`);
else if (readFileSync(markerPath, 'utf8') !== offlineMarkerContent()) problems.push(`完成标记内容与清单不一致 ${markerRel}`);
const allowed = new Set([...expected.map((f) => f.path), markerRel]);
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(root, p).replace(/\\/g, '/')];
  });
if (existsSync(join(root, 'offline-model'))) {
  for (const f of walk(join(root, 'offline-model'))) if (!allowed.has(f)) problems.push(`清单外文件 ${f}(会被打进包)`);
}
if (problems.length > 0) {
  die(
    `offline-model/ 暂存不合格:\n  - ${problems.join('\n  - ')}\n` +
      '  先运行 npm run fetch-offline-models(按钉死 revision 下载并校验),或改用 npm run package:bundled(从本机 globalStorage 暂存后打包)。',
  );
}
log(`暂存模型预检通过(${expected.length} 个文件 SHA + 完成标记)`);

mkdirSync(dirname(outPath), { recursive: true });
const ignoreDir = join(tmpdir(), 'voiceflow-package-offline');
mkdirSync(ignoreDir, { recursive: true });
const ignorePath = join(ignoreDir, '.vscodeignore-offline');
writeFileSync(ignorePath, offlineIgnore);
log(`生成的 ignore: ${ignorePath}`);

run(join(root, 'node_modules', '@vscode', 'vsce', 'vsce'), ['package', '--target', 'win32-x64', '--ignoreFile', ignorePath, '-o', outPath]);
run(join(root, 'scripts', 'verify-package.mjs'), ['--variant', 'offline', outPath]);
