/**
 * P2c:编译自研 voiceflow-audio.node 并固定到 prebuilt/(与 helper exe 同一
 * "固定预编译 + SHA 锁定"模式:哈希稳定可被 SAC/ISG 养熟,普通构建不重编)。
 * 仅开发机(有 MSVC 工具链)运行;打包用 prebuilt,经 place 脚本入 bin/。
 *
 * 用法:node scripts/build-audio-addon.mjs
 * 完成后:更新 bin.manifest.json nodeAddons 段的 SHA(脚本打印,人工核对后写入)。
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = join(root, 'native', 'voiceflow-audio');
const built = join(addonDir, 'build', 'Release', 'voiceflow_audio.node');
const dest = join(root, 'prebuilt', 'voiceflow-audio.node');

console.log('[build-audio-addon] node-gyp rebuild…');
execSync('npx node-gyp rebuild', { cwd: addonDir, stdio: 'inherit' });
if (!existsSync(built)) {
  console.error(`[build-audio-addon] 构建产物不存在: ${built}`);
  process.exit(1);
}
copyFileSync(built, dest);
const sha = createHash('sha256').update(readFileSync(dest)).digest('hex');
console.log(`[build-audio-addon] prebuilt/voiceflow-audio.node 已更新`);
console.log(`[build-audio-addon] SHA-256: ${sha}`);
console.log('[build-audio-addon] 提醒:同步更新 bin.manifest.json nodeAddons 段(否则 verify-bin fail-closed)');
