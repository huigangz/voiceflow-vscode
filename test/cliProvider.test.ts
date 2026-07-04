/**
 * F3.5 自动化部分:cmd /c 调用链 + UTF-8 round-trip。
 * (真实 claude/codex CLI 调用属 S3b 人工清单。)
 */
import { describe, expect, it } from 'vitest';
import { buildCliCommandLine, runCliCommand } from '../src/cleanup/cliProvider';

describe('runCliCommand (F3.5 Windows cmd/UTF-8)', () => {
  it('中文经 stdin→stdout round-trip 不乱码(chcp 65001)', async () => {
    // node 回声进程模拟 CLI:stdin 原样回 stdout
    const echo = `node -e "process.stdin.pipe(process.stdout)"`;
    const text = '中英混合 mixed 内容:变量名 userName,标点。';
    const out = await runCliCommand(echo, text, new AbortController().signal);
    expect(out).toBe(text);
  }, 15000);

  it('非零退出码 → 报错并带 stderr', async () => {
    const fail = `node -e "console.error('boom 错误'); process.exit(3)"`;
    await expect(runCliCommand(fail, '', new AbortController().signal)).rejects.toThrow(
      /退出码 3[\s\S]*boom/,
    );
  }, 15000);

  it('abort → kill 子进程并报错', async () => {
    const slow = `node -e "setTimeout(()=>{}, 30000)"`;
    const ac = new AbortController();
    const p = runCliCommand(slow, '', ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow();
  }, 15000);
});

describe('buildCliCommandLine', () => {
  it('claude-cli 用 claude -p,codex-cli 用 codex exec,prompt 引号转义', () => {
    expect(buildCliCommandLine('claude-cli')).toMatch(/^claude -p "/);
    expect(buildCliCommandLine('codex-cli')).toMatch(/^codex exec "/);
    // prompt 内不允许出现裸引号破坏命令行
    for (const cmd of [buildCliCommandLine('claude-cli'), buildCliCommandLine('codex-cli')]) {
      const inner = cmd.slice(cmd.indexOf('"') + 1, cmd.lastIndexOf('"'));
      expect(inner.replace(/""/g, '')).not.toContain('"');
    }
  });
});
