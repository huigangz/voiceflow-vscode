import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // P2a:pvrecorder 整包 external —— 其内部按平台动态 require .node,不可 bundle;
  // VSIX 经 .vscodeignore 打洞携带最小完整运行时(package.json + dist JS + win-amd64 .node)
  external: ['vscode', '@picovoice/pvrecorder-node'],
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
