/**
 * CLI 增强 provider(F3.5,opt-in)— 纯 Node,可单元测试。
 * 仅当用户在设置显式选择 claude-cli / codex-cli 才启用(D9)。
 *
 * Windows 要点(spec F3.5):
 * - executable + argv 直接传给 spawn,不经 shell 重解析 prompt 中的换行/引号/%VAR%
 * - 子进程管道按 utf8 读写,正文走 stdin
 */
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  LlmProvider,
  PrepareResult,
  ProviderFailureKind,
  ProviderResult,
  TokenUsage,
  wrapTranscript,
} from './llmProvider';

export type CliKind = 'claude-cli' | 'codex-cli';

export interface CliInvocation {
  executable: string;
  args: readonly string[];
}

export interface CliLaunchSpec {
  executable: string;
  prefixArgs: readonly string[];
}

export type CliResolutionResult =
  | { ok: true; launch: CliLaunchSpec }
  | { ok: false; kind: 'unavailable' | 'aborted' | 'error'; message?: string };

export type CliResolver = (
  kind: CliKind,
  signal: AbortSignal,
) => Promise<CliResolutionResult>;

/** Each instruction occupies one argv element; transcript data is carried separately on stdin. */
export function buildCliInvocation(kind: CliKind, instruction: string): CliInvocation {
  switch (kind) {
    case 'claude-cli':
      return { executable: 'claude', args: ['-p', instruction] };
    case 'codex-cli':
      return { executable: 'codex', args: ['exec', instruction] };
  }
}

export function buildCliProbeInvocation(kind: CliKind): CliInvocation {
  return {
    executable: kind === 'claude-cli' ? 'claude' : 'codex',
    args: ['--version'],
  };
}

function invocationForLaunch(launch: CliLaunchSpec, args: readonly string[]): CliInvocation {
  return { executable: launch.executable, args: [...launch.prefixArgs, ...args] };
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
  invocation: CliInvocation,
  stdinText: string,
  signal: AbortSignal,
) => Promise<CliExecutionResult>;

/**
 * Direct executable/argv transport. Node performs Windows argv quoting without a command shell.
 */
export function runCliCommand(
  invocation: CliInvocation,
  stdinText: string,
  signal: AbortSignal,
): Promise<CliExecutionResult> {
  if (signal.aborted) {
    return Promise.resolve({ ok: false, kind: 'aborted', stdout: '', stderr: '' });
  }
  return new Promise((resolve) => {
    const proc = spawn(invocation.executable, [...invocation.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    proc.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    // CLI may launch descendants; cancellation must terminate the whole Windows process tree.
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

/** Resolve Windows npm shims without ever passing caller text through cmd.exe. */
export async function resolveCliLaunch(
  kind: CliKind,
  signal: AbortSignal,
  runCommand: CliCommandRunner = runCliCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<CliResolutionResult> {
  const executable = kind === 'claude-cli' ? 'claude' : 'codex';
  if (signal.aborted) return { ok: false, kind: 'aborted' };
  if (platform !== 'win32') {
    return { ok: true, launch: { executable, prefixArgs: [] } };
  }

  let result: CliExecutionResult;
  try {
    result = await runCommand({ executable: 'where.exe', args: [executable] }, '', signal);
  } catch (error) {
    return {
      ok: false,
      kind: signal.aborted ? 'aborted' : 'error',
      message: String(error),
    };
  }
  if (signal.aborted || (!result.ok && result.kind === 'aborted')) {
    return { ok: false, kind: 'aborted' };
  }
  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind === 'exit' ? 'unavailable' : 'error',
      message: result.message ?? result.stderr,
    };
  }

  const candidates = result.stdout
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
  const native = candidates.find((candidate) => /\.(?:exe|com)$/iu.test(candidate));
  if (native !== undefined) return { ok: true, launch: { executable: native, prefixArgs: [] } };

  for (const candidate of candidates) {
    if (extname(candidate).toLowerCase() !== '.cmd') continue;
    const ps1Path = `${candidate.slice(0, -4)}.ps1`;
    try {
      const ps1 = await readFile(ps1Path, 'utf8');
      const relativeTarget = ps1.match(
        /["']\$basedir[\\/](?<target>[^"'\r\n]+\.[cm]?js)["']\s+\$args/iu,
      )?.groups?.target;
      if (relativeTarget === undefined) continue;
      const targetPath = join(dirname(ps1Path), ...relativeTarget.split(/[\\/]/u));
      await access(targetPath);
      const siblingNode = join(dirname(ps1Path), 'node.exe');
      let nodeExecutable = 'node.exe';
      try {
        await access(siblingNode);
        nodeExecutable = siblingNode;
      } catch {
        // npm's standard fallback is node.exe from PATH.
      }
      return {
        ok: true,
        launch: {
          executable: nodeExecutable,
          prefixArgs: [targetPath],
        },
      };
    } catch {
      // Try the next candidate; unsafe cmd.exe fallback is intentionally forbidden.
    }
  }

  return {
    ok: false,
    kind: 'unavailable',
    message: `No safe executable or PowerShell companion found for ${executable}.`,
  };
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
  resolver: CliResolver = (selectedKind, signal) =>
    resolveCliLaunch(selectedKind, signal, runCommand),
): LlmProvider {
  let launch: CliLaunchSpec | undefined;
  const ensureLaunch = async (signal: AbortSignal): Promise<CliResolutionResult> => {
    if (launch !== undefined) return { ok: true, launch };
    const resolution = await resolver(kind, signal);
    if (resolution.ok) launch = resolution.launch;
    return resolution;
  };
  return {
    name: kind,
    async prepare(signal): Promise<PrepareResult> {
      if (signal.aborted) return { ok: false, kind: 'aborted' };
      try {
        const resolution = await ensureLaunch(signal);
        if (!resolution.ok) return resolution;
        const result = await runCommand(
          invocationForLaunch(resolution.launch, buildCliProbeInvocation(kind).args),
          '',
          signal,
        );
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
        const resolution = await ensureLaunch(signal);
        if (!resolution.ok) return { ...resolution, usage: inputUsage };
        const result = await runCommand(
          invocationForLaunch(resolution.launch, buildCliInvocation(kind, instruction).args),
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
