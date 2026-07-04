/**
 * 拷贝 webview 运行时资产到 media/vad/(打包进 VSIX;不入 git)。
 * 来源:@ricky0123/vad-web + onnxruntime-web(其依赖)。
 */
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'media', 'vad');
mkdirSync(dest, { recursive: true });

const vadDist = join(root, 'node_modules', '@ricky0123', 'vad-web', 'dist');
const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist');

const files = [
  [join(vadDist, 'bundle.min.js'), 'bundle.min.js'],
  [join(vadDist, 'vad.worklet.bundle.min.js'), 'vad.worklet.bundle.min.js'],
  [join(vadDist, 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
  [join(vadDist, 'silero_vad_legacy.onnx'), 'silero_vad_legacy.onnx'],
  [join(ortDist, 'ort.min.js'), 'ort.min.js'],
  [join(ortDist, 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
  [join(ortDist, 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
];

for (const [src, name] of files) {
  cpSync(src, join(dest, name));
  console.log(`copied ${name}`);
}
