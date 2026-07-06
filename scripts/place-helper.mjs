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
const dstDir = join(root, 'bin');
mkdirSync(dstDir, { recursive: true });

// P2c:自研 voiceflow-audio.node 同一模式(固定预编译 + SHA 锁定;重编译走
// scripts/build-audio-addon.mjs 并同步 manifest SHA)
const PREBUILT = ['voiceflow-mic.exe', 'voiceflow-audio.node'];
for (const name of PREBUILT) {
  const src = join(root, 'prebuilt', name);
  if (!existsSync(src)) {
    console.error(`[place-helper] FATAL: 缺 ${src}(mic: build:helper:compile;audio: build-audio-addon.mjs)`);
    process.exit(1);
  }
  copyFileSync(src, join(dstDir, name));
  console.log(`[place-helper] prebuilt/${name} → bin/(固定哈希,不重编译)`);
}
