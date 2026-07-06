/**
 * inproc-s5:sharp 的 esbuild alias 桩。
 * transformers.js 3.8.1 的 node 构建在模块初始化时 require('sharp')(图像链路);
 * VoiceFlow 只用音频——s5 实测桩下全链音频推理正常(transformers 只存引用,音频路径
 * 不触碰),bundle 免带 ~20MB libvips。esbuild.mjs 的 alias 把 'sharp' 指到本模块。
 */
export default function sharpStub(): never {
  throw new Error('sharp stub: image processing is not available in VoiceFlow (audio-only)');
}
