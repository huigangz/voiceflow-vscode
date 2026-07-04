/**
 * CLI 增强 provider(F3.5,opt-in)— 纯 Node,可单元测试。
 * 仅当用户在设置显式选择 claude-cli / codex-cli 才启用(D9)。
 *
 * Windows 要点(spec F3.5):
 * - npm 全局安装的 CLI 是 .cmd shim → 经 `cmd.exe /d /s /c` 调用
 * - 强制 UTF-8:`chcp 65001` + 子进程管道按 utf8 读写(文本走 stdin,避免命令行引号/长度问题)
 */
import { spawn } from 'node:child_process';
import { CLEANUP_PROMPT, EnhanceProvider, wrapTranscript } from './pipeline';

export type CliKind = 'claude-cli' | 'codex-cli';

/** 各 CLI 的非交互调用形态(prompt 作参数,待清理文本走 stdin)。 */
export function buildCliCommandLine(kind: CliKind): string {
  const prompt = CLEANUP_PROMPT.replace(/"/g, '""');
  switch (kind) {
    case 'claude-cli':
      return `claude -p "${prompt}"`;
    case 'codex-cli':
      return `codex exec "${prompt}"`;
  }
}

/**
 * 经 cmd /c 运行命令行,stdin 喂 UTF-8 文本,收 UTF-8 stdout。
 * 导出供单元测试(用 node 回声命令验证 UTF-8 round-trip)。
 */
export function runCliCommand(
  commandLine: string,
  stdinText: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cmd.exe', ['/d', '/s', '/c', `chcp 65001 >nul && ${commandLine}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    proc.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    // 取消须杀整棵进程树:proc 是 cmd.exe,真正的 CLI 是其子进程,
    // 单杀 cmd 会留孤儿且 stdio 不关闭(close 永不触发)
    const onAbort = () => {
      if (proc.pid !== undefined) {
        spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
      }
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new Error('aborted'));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`CLI 退出码 ${code}: ${stderr.slice(-300)}`));
    });
    proc.stdin.end(stdinText, 'utf8');
  });
}

export function createCliProvider(kind: CliKind): EnhanceProvider {
  return {
    name: kind,
    cleanup: (text, signal) =>
      runCliCommand(buildCliCommandLine(kind), wrapTranscript(text), signal),
  };
}
