import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // P2a:pvrecorder 整包 external —— 其内部按平台动态 require .node,不可 bundle;
  // VSIX 经 .vscodeignore 打洞携带最小完整运行时(package.json + dist JS + win-amd64 .node)
  // inproc-s5:transformers.js **打进 bundle**(纯 JS 1.6MB;external+打洞会破坏 vsce
  // 依赖树/需要 nested 桩,两轮实测均为死路);其 require('sharp') 经 alias 指到 1KB 桩
  // (音频链路不触碰 sharp,免带 ~20MB libvips,s5 实测);onnxruntime-node 仍 external
  external: ['vscode', '@picovoice/pvrecorder-node', 'onnxruntime-node'],
  alias: { sharp: './src/stt/sharpStub.ts' },
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
