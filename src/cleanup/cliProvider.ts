/**
 * CLI 增强 provider(F3.5,opt-in)— 纯 Node,可单元测试。
 * 仅当用户在设置显式选择 claude-cli / codex-cli 才启用(D9)。
 *
 * Windows 要点(spec F3.5):
 * - npm 全局安装的 CLI 是 .cmd shim → 经 `cmd.exe /d /s /c` 调用
 * - 强制 UTF-8:`chcp 65001` + 子进程管道按 utf8 读写(文本走 stdin,避免命令行引号/长度问题)
 */
import { spawn } from 'node:child_process';
import {
  LlmProvider,
  PrepareResult,
  ProviderFailureKind,
  ProviderResult,
  TokenUsage,
  wrapTranscript,
} from './llmProvider';

export type CliKind = 'claude-cli' | 'codex-cli';

/** 各 CLI 的非交互调用形态(prompt 作参数,待清理文本走 stdin)。 */
export function buildCliCommandLine(kind: CliKind, instruction: string): string {
  const prompt = instruction.replace(/"/g, '""');
  switch (kind) {
    case 'claude-cli':
      return `claude -p "${prompt}"`;
    case 'codex-cli':
      return `codex exec "${prompt}"`;
  }
}

export function buildCliProbeCommandLine(kind: CliKind): string {
  return kind === 'claude-cli' ? 'where claude' : 'where codex';
}

export type CliExecutionResult =
  | { ok: true; stdout: string; stderr: string }
  | {
      ok: false;
      kind: 'aborted' | 'spawn-error' | 'exit';
      stdout: string;
      stderr: string;
      code?: number | null;
      message?: string;
    };

export type CliCommandRunner = (
  commandLine: string,
  stdinText: string,
  signal: AbortSignal,
) => Promise<CliExecutionResult>;

/**
 * 经 cmd /c 运行命令行,stdin 喂 UTF-8 文本,收 UTF-8 stdout。
 * 导出供单元测试(用 node 回声命令验证 UTF-8 round-trip)。
 */
export function runCliCommand(
  commandLine: string,
  stdinText: string,
  signal: AbortSignal,
): Promise<CliExecutionResult> {
  if (signal.aborted) {
    return Promise.resolve({ ok: false, kind: 'aborted', stdout: '', stderr: '' });
  }
  return new Promise((resolve) => {
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
      resolve({ ok: false, kind: 'aborted', stdout, stderr });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      resolve({
        ok: false,
        kind: signal.aborted ? 'aborted' : 'spawn-error',
        stdout,
        stderr,
        message: String(err),
      });
    });
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) resolve({ ok: false, kind: 'aborted', stdout, stderr });
      else if (code === 0) resolve({ ok: true, stdout, stderr });
      else resolve({ ok: false, kind: 'exit', code, stdout, stderr });
    });
    proc.stdin.end(stdinText, 'utf8');
  });
}

function estimatedUsage(instruction: string, wrappedText: string, output?: string): TokenUsage {
  return {
    inputTokens: instruction.length + wrappedText.length,
    ...(output === undefined ? {} : { outputTokens: output.length }),
    estimate: true,
  };
}

function retryAfterMs(message: string): number | undefined {
  const milliseconds = message.match(/retry(?:-|\s*)after[^\d]*(\d+)\s*ms/i)?.[1];
  if (milliseconds !== undefined) return Number(milliseconds);
  const seconds = message.match(/retry(?:-|\s*)after[^\d]*(\d+)\s*s(?:ec(?:ond)?s?)?/i)?.[1];
  return seconds === undefined ? undefined : Number(seconds) * 1000;
}

function classifyFailure(
  result: Exclude<CliExecutionResult, { ok: true }>,
  signal: AbortSignal,
): { kind: ProviderFailureKind; message: string; retryAfterMs?: number } {
  const message = [result.message, result.stderr].filter(Boolean).join(': ').slice(-500);
  if (signal.aborted || result.kind === 'aborted') return { kind: 'aborted', message };
  if (/(?:\b429\b|quota|rate[ -]?limit|too many requests|usage limit)/i.test(message)) {
    const retry = retryAfterMs(message);
    return { kind: 'rate-limit', message, ...(retry === undefined ? {} : { retryAfterMs: retry }) };
  }
  if (
    /(?:not recognized|command not found|could not find files|cannot find|no such file|ENOENT)/i.test(
      message,
    )
  ) {
    return { kind: 'unavailable', message };
  }
  return { kind: 'error', message };
}

export function createCliProvider(
  kind: CliKind,
  runCommand: CliCommandRunner = runCliCommand,
): LlmProvider {
  return {
    name: kind,
    async prepare(signal): Promise<PrepareResult> {
      if (signal.aborted) return { ok: false, kind: 'aborted' };
      try {
        const result = await runCommand(buildCliProbeCommandLine(kind), '', signal);
        if (signal.aborted) return { ok: false, kind: 'aborted' };
        if (result.ok) return { ok: true };
        const failure = classifyFailure(result, signal);
        return { ok: false, ...failure };
      } catch (error) {
        return {
          ok: false,
          kind: signal.aborted ? 'aborted' : 'error',
          message: String(error),
        };
      }
    },
    async run(instruction, text, signal): Promise<ProviderResult> {
      const wrappedText = wrapTranscript(text);
      const inputUsage = estimatedUsage(instruction, wrappedText);
      if (signal.aborted) return { ok: false, kind: 'aborted', usage: inputUsage };
      try {
        const result = await runCommand(
          buildCliCommandLine(kind, instruction),
          wrappedText,
          signal,
        );
        const usage = estimatedUsage(instruction, wrappedText, result.stdout);
        if (result.ok) return { ok: true, text: result.stdout, usage };
        return { ok: false, ...classifyFailure(result, signal), usage };
      } catch (error) {
        return {
          ok: false,
          kind: signal.aborted ? 'aborted' : 'error',
          usage: inputUsage,
          message: String(error),
        };
      }
    },
  };
}
