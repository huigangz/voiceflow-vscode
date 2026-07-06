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
 *   node scripts/stage-bundled-model.mjs --onnx          # inproc-s5(E4):暂存 inprocess ONNX
 *     目录(offline-model/onnx/onnx-community/whisper-small/,含完成标记;源 = 本机
 *     globalStorage,或 --onnx-from <目录>)。受限网络(公司机)唯一现实交付。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// 评审 v7-①:本脚本**永不删除任何文件**。普通 package 不带模型靠 .vscodeignore 排除
// offline-model/**;offline 打包用 --ignoreFile .vscodeignore-offline。暂存模型留盘复用,
// 需要清理时由用户手动删。
if (argv.includes('--clean')) {
  console.error('[stage-model] --clean 已移除(评审 v7-①:脚本不做自动删除)。暂存模型请手动清理。');
  process.exit(1);
}

// inproc-s5(E4):ONNX 目录暂存分支(与 .bin 正交,--onnx 独立调用)
if (argv.includes('--onnx')) {
  const REPO = ['onnx-community', 'whisper-small']; // 与 src/stt/onnxModels.ts 清单对齐
  const MARKER = '.voiceflow-complete';
  const from =
    getArg('--onnx-from') ??
    join(
      process.env.APPDATA,
      'Code/User/globalStorage/voiceflow-preview.voiceflow-vscode/models/onnx',
      ...REPO,
    );
  if (!existsSync(join(from, MARKER))) {
    console.error(`[stage-model] ONNX 源无完成标记: ${join(from, MARKER)}`);
    console.error('  先在本机 downloadModel 选 inprocess 档下载完成,或 --onnx-from <完整模型目录>。');
    process.exit(1);
  }
  const destDir = join(root, 'offline-model', 'onnx', ...REPO);
  const copyDir = (src, dst) => {
    mkdirSync(dst, { recursive: true });
    let bytes = 0;
    for (const entry of readdirSync(src)) {
      const s = join(src, entry);
      const d = join(dst, entry);
      if (statSync(s).isDirectory()) bytes += copyDir(s, d);
      else {
        copyFileSync(s, d);
        bytes += statSync(s).size;
      }
    }
    return bytes;
  };
  const bytes = copyDir(from, destDir);
  console.log(`[stage-model] onnx small-q8 (${(bytes / 1e6).toFixed(0)}MB, 含完成标记) → offline-model/onnx/${REPO.join('/')}`);
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
