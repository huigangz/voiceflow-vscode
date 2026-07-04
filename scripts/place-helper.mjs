/**
 * 把**固定的**预编译 helper(prebuilt/voiceflow-mic.exe)放入 bin/。
 *
 * 为什么固定而非每次重编译:Windows Smart App Control 按哈希评估未签名程序,
 * 新哈希初始被拦、经 ISG 评估后"养熟"放行。每次 csc 重编译都产生新哈希 →
 * 重新被拦。固定同一二进制 → 哈希稳定 → 养熟一次长期可用,且可在 manifest
 * 固定其 SHA-256(可复现)。
 *
 * helper 源码变更时才用 `npm run build:helper:compile` 重新编译 prebuilt/,
 * 并 commit + 重新养熟(会短暂再被 SAC 拦,直到 ISG 重新评估)。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'prebuilt', 'voiceflow-mic.exe');
const dstDir = join(root, 'bin');
const dst = join(dstDir, 'voiceflow-mic.exe');

if (!existsSync(src)) {
  console.error(`[place-helper] FATAL: 缺 ${src}(用 npm run build:helper:compile 生成并 commit)`);
  process.exit(1);
}
mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);
console.log('[place-helper] prebuilt/voiceflow-mic.exe → bin/(固定哈希,不重编译)');
