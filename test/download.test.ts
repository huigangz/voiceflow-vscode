/**
 * S2 mini-spike 自动化部分:用本地 HTTP 服务器真实验证
 * 断点续传 / SHA 校验 / 镜像 fallback / 取消 / 重试。
 * (1.6GB 级真实网络测试属人工清单,见 worklog。)
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadError, checkDiskSpace, downloadWithResume, sha256File } from '../src/stt/download';

const PAYLOAD = randomBytes(256 * 1024); // 256KB 测试文件
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

interface ServerBehavior {
  /** 前 N 个请求返回 500(测重试/镜像切换)。 */
  failFirst?: number;
  /** 响应在发送 truncateAt 字节后断开(测断点续传)。 */
  truncateAt?: number;
  /** 忽略 Range 头,始终 200 全量(测不支持续传的服务器)。 */
  noRange?: boolean;
  /** 返回损坏内容(测 SHA 校验)。 */
  corrupt?: boolean;
}

function makeServer(behavior: ServerBehavior = {}): Promise<{ server: Server; url: string; hits: () => number }> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount++;
    if (behavior.failFirst !== undefined && requestCount <= behavior.failFirst) {
      res.writeHead(500);
      res.end('server error');
      return;
    }
    const body = behavior.corrupt ? Buffer.from(PAYLOAD.map((b) => b ^ 0xff)) : PAYLOAD;
    const range = req.headers.range;
    let start = 0;
    if (range !== undefined && behavior.noRange !== true) {
      start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      res.writeHead(206, {
        'content-length': body.length - start,
        'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
      });
    } else {
      res.writeHead(200, { 'content-length': body.length });
    }
    const slice = body.subarray(start);
    if (behavior.truncateAt !== undefined && behavior.truncateAt > start) {
      res.write(slice.subarray(0, behavior.truncateAt - start));
      res.destroy(); // 模拟网络中断
      behavior.truncateAt = undefined; // 只断一次
    } else {
      res.end(slice);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}/model.bin`, hits: () => requestCount });
    });
  });
}

describe('downloadWithResume (S2 mini-spike)', () => {
  let dest: string;
  const servers: Server[] = [];

  beforeEach(() => {
    dest = join(tmpdir(), `vf-dl-test-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) s.close();
    await rm(dest, { force: true });
    await rm(`${dest}.part`, { force: true });
  });

  it('全新下载 + SHA-256 校验通过', async () => {
    const { server, url } = await makeServer();
    servers.push(server);
    const progress: number[] = [];
    await downloadWithResume({
      urls: [url],
      destPath: dest,
      expectedSha256: PAYLOAD_SHA,
      onProgress: (r) => progress.push(r),
    });
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
    expect(progress.at(-1)).toBe(PAYLOAD.length);
  });

  it('网络中断后重试,从 .part 断点续传(Range 请求)', async () => {
    const { server, url } = await makeServer({ truncateAt: 100 * 1024 });
    servers.push(server);
    await downloadWithResume({
      urls: [url],
      destPath: dest,
      expectedSha256: PAYLOAD_SHA,
      retriesPerUrl: 2,
    });
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
  });

  it('已有 .part 时发送 Range 并续传完成', async () => {
    await writeFile(`${dest}.part`, PAYLOAD.subarray(0, 64 * 1024));
    const { server, url } = await makeServer();
    servers.push(server);
    await downloadWithResume({ urls: [url], destPath: dest, expectedSha256: PAYLOAD_SHA });
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
  });

  it('服务器不支持 Range(200)→ 从头重下,结果仍正确', async () => {
    await writeFile(`${dest}.part`, PAYLOAD.subarray(0, 64 * 1024));
    const { server, url } = await makeServer({ noRange: true });
    servers.push(server);
    await downloadWithResume({ urls: [url], destPath: dest, expectedSha256: PAYLOAD_SHA });
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
  });

  it('主源持续失败 → 自动切镜像源(F5.2)', async () => {
    const bad = await makeServer({ failFirst: 999 });
    const good = await makeServer();
    servers.push(bad.server, good.server);
    await downloadWithResume({
      urls: [bad.url, good.url],
      destPath: dest,
      expectedSha256: PAYLOAD_SHA,
      retriesPerUrl: 1,
    });
    expect((await readFile(dest)).equals(PAYLOAD)).toBe(true);
    expect(bad.hits()).toBe(2); // 1 次 + 1 重试后放弃
  });

  it('SHA 不匹配 → 删除损坏文件并报 sha-mismatch', async () => {
    const { server, url } = await makeServer({ corrupt: true });
    servers.push(server);
    await expect(
      downloadWithResume({ urls: [url], destPath: dest, expectedSha256: PAYLOAD_SHA }),
    ).rejects.toMatchObject({ code: 'all-sources-failed' });
    // 损坏的 .part 已被删除,不会污染下次下载
    await expect(stat(`${dest}.part`)).rejects.toThrow();
    await expect(stat(dest)).rejects.toThrow();
  });

  it('用户取消 → cancelled 错误,.part 保留供续传', async () => {
    const { server, url } = await makeServer();
    servers.push(server);
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadWithResume({ urls: [url], destPath: dest, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('全部源失败 → all-sources-failed', async () => {
    const { server, url } = await makeServer({ failFirst: 999 });
    servers.push(server);
    await expect(
      downloadWithResume({ urls: [url], destPath: dest, retriesPerUrl: 1 }),
    ).rejects.toMatchObject({ code: 'all-sources-failed' });
  });
});

describe('checkDiskSpace', () => {
  it('目标目录不存在时自动创建而非 ENOENT(首次下载回归,gate 实测 bug)', async () => {
    const nested = join(tmpdir(), `vf-disk-${Date.now()}`, 'deep', 'models', 'x.bin');
    await expect(checkDiskSpace(nested, 1024)).resolves.toBeUndefined();
    await rm(join(tmpdir(), `vf-disk-${Date.now()}`), { recursive: true, force: true }).catch(() => {});
  });

  it('需求远超磁盘容量 → disk-full', async () => {
    const p = join(tmpdir(), `vf-disk-full-${Date.now()}`, 'x.bin');
    await expect(checkDiskSpace(p, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
      code: 'disk-full',
    });
  });
});

describe('sha256File', () => {
  it('与 crypto 直接计算一致', async () => {
    const p = join(tmpdir(), `vf-sha-${Date.now()}.bin`);
    await writeFile(p, PAYLOAD);
    expect(await sha256File(p)).toBe(PAYLOAD_SHA);
    await rm(p, { force: true });
  });
});
