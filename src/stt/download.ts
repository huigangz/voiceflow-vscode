/**
 * 模型下载核心(S2 mini-spike)— 纯 Node,无 vscode 依赖,可单元测试。
 * 覆盖:断点续传(Range + .part)、SHA-256 校验、失败重试、镜像 fallback、
 *      用户取消(AbortSignal)、磁盘空间预检。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export interface DownloadOptions {
  /** 候选 URL,按序尝试(主源失败自动切镜像,F5.2)。 */
  urls: string[];
  destPath: string;
  /** 期望 SHA-256(hex)。undefined = 跳过校验(记录警告由调用方负责)。 */
  expectedSha256?: string;
  /** 每个 URL 的重试次数(网络中断类错误)。 */
  retriesPerUrl?: number;
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void;
}

export class DownloadError extends Error {
  constructor(
    public readonly code: 'cancelled' | 'sha-mismatch' | 'all-sources-failed' | 'disk-full',
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** 磁盘空间预检:目标盘可用空间需 ≥ requiredBytes(含 10% 余量)。 */
export async function checkDiskSpace(destPath: string, requiredBytes: number): Promise<void> {
  // 首次下载时目标目录(甚至 globalStorage 本身)可能不存在,statfs 会 ENOENT —— 先建目录
  await mkdir(dirname(destPath), { recursive: true });
  const fs = await statfs(dirname(destPath));
  const available = fs.bavail * fs.bsize;
  if (available < requiredBytes * 1.1) {
    throw new DownloadError(
      'disk-full',
      `Not enough disk space: need about ${(requiredBytes / 1e9).toFixed(1)}GB, ${(available / 1e9).toFixed(1)}GB available`,
    );
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function partSize(partPath: string): Promise<number> {
  try {
    return (await stat(partPath)).size;
  } catch {
    return 0;
  }
}

/**
 * 下载单个 URL 到 .part 文件,支持 Range 续传。
 * 返回后 .part 为完整文件(未校验)。
 */
async function downloadOne(
  url: string,
  partPath: string,
  opts: DownloadOptions,
): Promise<void> {
  const offset = await partSize(partPath);
  const headers: Record<string, string> = {};
  if (offset > 0) headers['Range'] = `bytes=${offset}-`;

  const res = await fetch(url, { headers, signal: opts.signal, redirect: 'follow' });
  let writeOffset = offset;
  if (res.status === 200) {
    writeOffset = 0; // 服务器不支持 Range(或无 .part),从头下
  } else if (res.status !== 206) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  if (!res.body) throw new Error(`empty body from ${url}`);

  const contentLength = res.headers.get('content-length');
  const total =
    contentLength !== null ? writeOffset + Number(contentLength) : undefined;

  let received = writeOffset;
  const counter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      received += chunk.length;
      opts.onProgress?.(received, total);
      yield chunk;
    }
  };

  await pipeline(
    counter(Readable.fromWeb(res.body as import('stream/web').ReadableStream)),
    createWriteStream(partPath, writeOffset === 0 ? { flags: 'w' } : { flags: 'r+', start: writeOffset }),
  );
}

/**
 * 主入口:多源 + 重试 + 续传 + SHA 校验;成功后 .part → destPath 原子改名。
 */
export async function downloadWithResume(opts: DownloadOptions): Promise<void> {
  const partPath = `${opts.destPath}.part`;
  await mkdir(dirname(opts.destPath), { recursive: true });
  const retries = opts.retriesPerUrl ?? 2;

  let lastErr: unknown;
  for (const url of opts.urls) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (opts.signal?.aborted) throw new DownloadError('cancelled', 'download cancelled by user');
      try {
        await downloadOne(url, partPath, opts);
        if (opts.expectedSha256 !== undefined) {
          const actual = await sha256File(partPath);
          if (actual !== opts.expectedSha256.toLowerCase()) {
            await rm(partPath, { force: true }); // 损坏文件不保留,重下
            throw new DownloadError(
              'sha-mismatch',
              `SHA-256 verification failed: expected ${opts.expectedSha256}, got ${actual} (source ${url})`,
            );
          }
        }
        await rename(partPath, opts.destPath);
        return;
      } catch (err) {
        if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          // 取消:保留 .part 供下次续传
          throw new DownloadError('cancelled', 'download cancelled by user (partial download kept; resumable)');
        }
        lastErr = err;
        // sha-mismatch 换下一个源(同源重试大概率同样损坏)
        if (err instanceof DownloadError && err.code === 'sha-mismatch') break;
      }
    }
  }
  throw new DownloadError('all-sources-failed', `all download sources failed: ${String(lastErr)}`);
}

/**
 * 从 HuggingFace API 动态获取文件的 LFS SHA-256(主源失败自动切镜像)。
 * 返回 undefined = 两源都拿不到(调用方决定是否跳过校验)。
 */
export async function fetchExpectedSha256(
  apiBases: string[],
  repo: string,
  fileName: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (const base of apiBases) {
    try {
      const res = await fetch(`${base}/api/models/${repo}/tree/main`, { signal });
      if (!res.ok) continue;
      const entries = (await res.json()) as Array<{
        path: string;
        lfs?: { oid?: string };
      }>;
      const entry = entries.find((e) => e.path === fileName);
      if (entry?.lfs?.oid) return entry.lfs.oid.toLowerCase();
    } catch {
      // 尝试下一个源
    }
  }
  return undefined;
}
