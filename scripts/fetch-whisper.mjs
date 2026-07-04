/**
 * 获取 whisper.cpp 预编译二进制到 bin/(可复现,供应链 fail-closed)。
 *
 * 流程:读 bin.manifest.json → 下载归档 → **解压前强制校验 archive SHA-256** →
 *       不匹配立即 abort(非零退出,绝不解压) → 解压 → 提取 manifest 中
 *       source=="whisper" 的文件到 bin/ → 逐文件复验 SHA-256。
 *
 * 缓存的归档复用前也复验(损坏/被篡改即重下)。绝不采用"取不到 SHA 就跳过"策略。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'bin.manifest.json'), 'utf8'));
const src = manifest.whisperSource;
const binDir = join(root, 'bin');
const workDir = join(tmpdir(), 'voiceflow-fetch-whisper');
const archivePath = join(workDir, src.archive);

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function die(msg) {
  console.error(`\n[fetch-whisper] FATAL: ${msg}`);
  process.exit(1);
}

async function download(url, dest) {
  console.log(`[fetch-whisper] downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`HTTP ${res.status} 下载失败`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(dest, buf);
}

async function ensureArchive() {
  // 缓存复用前复验;损坏/篡改即重下
  if (existsSync(archivePath)) {
    if (sha256(archivePath) === src.archiveSha256) {
      console.log('[fetch-whisper] 复用已缓存归档(SHA 校验通过)');
      return;
    }
    console.log('[fetch-whisper] 缓存归档 SHA 不符,重新下载');
    rmSync(archivePath, { force: true });
  }
  await download(src.url, archivePath);
  // **解压前强制校验:fail-closed**
  const actual = sha256(archivePath);
  if (actual !== src.archiveSha256) {
    rmSync(archivePath, { force: true });
    die(
      `归档 SHA-256 不匹配 —— 供应链校验失败,绝不解压。\n` +
        `  期望: ${src.archiveSha256}\n  实际: ${actual}`,
    );
  }
  console.log('[fetch-whisper] 归档 SHA-256 校验通过');
}

function extract() {
  const outDir = join(workDir, 'extracted');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // 用 PowerShell Expand-Archive(Windows 自带,零依赖)
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${archivePath}' -DestinationPath '${outDir}' -Force`],
    { stdio: 'inherit' },
  );
  return join(outDir, 'Release'); // whisper 归档内二进制在 Release/ 下
}

function main() {
  mkdirSync(binDir, { recursive: true });
  const wantFiles = Object.entries(manifest.files).filter(([, m]) => m.source === 'whisper');

  const releaseDir = extract();
  let copied = 0;
  for (const [name, meta] of wantFiles) {
    const from = join(releaseDir, name);
    if (!existsSync(from)) die(`归档缺少预期文件 ${name}`);
    const to = join(binDir, name);
    cpSync(from, to);
    const actual = sha256(to);
    if (actual !== meta.sha256) {
      die(`提取文件 ${name} SHA-256 不匹配\n  期望 ${meta.sha256}\n  实际 ${actual}`);
    }
    if (statSync(to).size === 0) die(`提取文件 ${name} 为空`);
    copied++;
  }
  console.log(`[fetch-whisper] OK: ${copied} 个 whisper 文件已就位并逐一 SHA 校验通过 → ${binDir}`);
  console.log('[fetch-whisper] 提示:voiceflow-mic.exe 由 npm run build:helper(拷贝 prebuilt/)放置');
}

await ensureArchive();
main();
