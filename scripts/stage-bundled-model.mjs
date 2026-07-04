/**
 * 把一个 whisper 模型 .bin 暂存到 offline-model/(供 offline VSIX 打包内置,B 方案)。
 *
 * offline-model/ 是 gitignored 且**不被 .vscodeignore 排除** —— 仅当被本脚本填充时
 * 才随 VSIX 打包;普通 `npm run package` 不受影响(该目录为空)。
 *
 * 用法:
 *   node scripts/stage-bundled-model.mjs                 # tier=small,从本机 globalStorage 复制
 *   node scripts/stage-bundled-model.mjs --tier small-q5
 *   node scripts/stage-bundled-model.mjs --from <path>   # 从指定 .bin 复制(合规渠道拿到的文件)
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// --clean:打包后清空暂存目录,使普通 npm run package 不会误打包大模型
if (argv.includes('--clean')) {
  const dir = join(root, 'offline-model');
  rmSync(dir, { recursive: true, force: true });
  console.log('[stage-model] 已清空 offline-model/(普通 package 不受影响)');
  process.exit(0);
}

// 档位 → 文件名(与 modelManager.MODELS 对齐)
const FILES = {
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  'small-q5': 'ggml-small-q5_1.bin',
  'large-v3-turbo-q5': 'ggml-large-v3-turbo-q5_0.bin',
  'large-v3-turbo': 'ggml-large-v3-turbo.bin',
};

const tier = getArg('--tier') ?? 'small';
const fileName = FILES[tier];
if (!fileName) { console.error(`未知档位 ${tier}(可选:${Object.keys(FILES).join(', ')})`); process.exit(1); }

const from =
  getArg('--from') ??
  join(process.env.APPDATA, 'Code/User/globalStorage/voiceflow-preview.voiceflow-vscode/models', fileName);

if (!existsSync(from)) {
  console.error(`[stage-model] 源模型不存在: ${from}`);
  console.error('  用 --from <path> 指定合规渠道拿到的 .bin,或先在本机下载好该档位模型。');
  process.exit(1);
}
const size = statSync(from).size;
if (size < 50_000_000) {
  console.error(`[stage-model] 源文件过小(${(size / 1e6).toFixed(0)}MB),疑似不是完整模型: ${from}`);
  process.exit(1);
}

const destDir = join(root, 'offline-model');
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, fileName);
copyFileSync(from, dest);
console.log(`[stage-model] ${tier} (${(size / 1e6).toFixed(0)}MB) → offline-model/${fileName}`);
console.log('[stage-model] 现在可 npm run package:bundled 打包 offline VSIX');
