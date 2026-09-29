/**
 * 打包前环境检查(harness PR1,fail-closed)。挂在 package 与 package-offline.mjs 最前面。
 *
 * ① whisper-server 残留进程:EDH 遗留进程会锁住 bin/,place-helper/fetch-whisper 覆盖时 EIO
 *    (0.3.1 打包实测,worklog release-0.3.1)。
 */
import { execFileSync } from 'node:child_process';

const errors = [];

if (process.platform === 'win32') {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq whisper-server.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const pids = out
    .split(/\r?\n/)
    .filter((l) => l.toLowerCase().startsWith('"whisper-server.exe"'))
    .map((l) => l.split('","')[1]);
  if (pids.length > 0) errors.push(`whisper-server.exe 正在运行(PID ${pids.join(', ')})—— 先关闭 EDH 或结束进程,否则 bin/ 被锁`);
}

if (errors.length > 0) {
  console.error('[prepack-check] FAIL:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('[prepack-check] OK');
