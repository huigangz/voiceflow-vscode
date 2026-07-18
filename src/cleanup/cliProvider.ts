/**
 * CLI 增强 provider(F3.5,opt-in)— 纯 Node,可单元测试。
 * 仅当用户在设置显式选择 claude-cli / codex-cli 才启用(D9)。
 *
 * Windows 要点(spec F3.5):
 * - executable + argv 直接传给 spawn,不经 shell 重解析 prompt 中的换行/引号/%VAR%
 * - 子进程管道按 utf8 读写,正文走 stdin
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  cwd?: string;
}

export interface CliExecutionContext {
  neutralDirectory: string;
  claudeMcpConfigPath: string;
}

export function createCliExecutionContext(globalStoragePath: string): CliExecutionContext {
  const neutralDirectory = join(globalStoragePath, 'cli-neutral');
  return {
    neutralDirectory,
    claudeMcpConfigPath: join(neutralDirectory, 'empty-mcp.json'),
  };
}

async function ensureExecutionContext(context: CliExecutionContext): Promise<void> {
  await mkdir(context.neutralDirectory, { recursive: true });
  await writeFile(context.claudeMcpConfigPath, '{"mcpServers":{}}', 'utf8');
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

function codexSafeExecArgs(context: CliExecutionContext): string[] {
  return [
    'exec',
    '--strict-config',
    // Transcript text is untrusted prompt data; disable shell reads that prompt injection could trigger.
    '--disable',
    'shell_tool',
    // Avoid collecting a local shell-environment snapshot for a provider that must not use shell access.
    '--disable',
    'shell_snapshot',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '-C',
    context.neutralDirectory,
  ];
}

/** Each instruction occupies one argv element; transcript data is carried separately on stdin. */
export function buildCliInvocation(
  kind: CliKind,
  instruction: string,
  context: CliExecutionContext,
): CliInvocation {
  switch (kind) {
    case 'claude-cli':
      return {
        executable: 'claude',
        args: [
          '--print',
          '--safe-mode',
          '--tools',
          '',
          '--no-session-persistence',
          '--strict-mcp-config',
          '--mcp-config',
          context.claudeMcpConfigPath,
          '--no-chrome',
          instruction,
        ],
        cwd: context.neutralDirectory,
      };
    case 'codex-cli':
      return {
        executable: 'codex',
        args: [
          ...codexSafeExecArgs(context),
          instruction,
        ],
        cwd: context.neutralDirectory,
      };
  }
}

export function buildCliProbeInvocation(
  kind: CliKind,
  context: CliExecutionContext,
): CliInvocation {
  if (kind === 'codex-cli') {
    return {
      executable: 'codex',
      // `--help` validates the complete local parser surface without sending a model request.
      args: [...codexSafeExecArgs(context), '--help'],
      cwd: context.neutralDirectory,
    };
  }
  return {
    executable: 'claude',
    args: ['--version'],
    cwd: context.neutralDirectory,
  };
}

function invocationForLaunch(launch: CliLaunchSpec, invocation: CliInvocation): CliInvocation {
  return {
    executable: launch.executable,
    args: [...launch.prefixArgs, ...invocation.args],
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
  };
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

function killDirectChild(proc: ReturnType<typeof spawn>): void {
  try {
    proc.kill('SIGKILL');
  } catch {
    // The process may already have exited.
  }
}

function terminateProcessTree(proc: ReturnType<typeof spawn>): Promise<void> {
  if (process.platform !== 'win32' || proc.pid === undefined) {
    killDirectChild(proc);
    return Promise.resolve();
  }
  return new Promise((resolveTermination) => {
    let settled = false;
    const finish = (taskkillSucceeded: boolean) => {
      if (settled) return;
      settled = true;
      if (!taskkillSucceeded) killDirectChild(proc);
      resolveTermination();
    };
    try {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => finish(false));
      killer.once('close', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

const NPM_PS1_NODE_STATEMENT =
  /^\s*(?:\$input\s*\|\s*)?&\s+"(?:\$basedir[\\/]node\$exe|node\$exe)"\s+"\$basedir[\\/](?<target>[^"'\r\n]+\.[cm]?js)"\s+\$args\s*$/iu;

async function safeNpmShimTarget(ps1Path: string): Promise<string | undefined> {
  const statements = (await readFile(ps1Path, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.match(NPM_PS1_NODE_STATEMENT)?.groups?.target)
    .filter((target): target is string => target !== undefined);
  const firstStatement = statements[0];
  if (firstStatement === undefined) return undefined;

  const base = await realpath(dirname(ps1Path));
  const targets = new Set<string>();
  for (const statement of statements) {
    if (isAbsolute(statement)) return undefined;
    const segments = statement.split(/[\\/]/u);
    if (segments.includes('..')) return undefined;
    const target = await realpath(resolve(base, ...segments));
    const fromBase = relative(base, target);
    if (fromBase === '..' || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
      return undefined;
    }
    targets.add(process.platform === 'win32' ? target.toLowerCase() : target);
  }
  if (targets.size !== 1) return undefined;
  return await realpath(resolve(base, ...firstStatement.split(/[\\/]/u)));
}

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
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    proc.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const finish = (result: CliExecutionResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    // CLI may launch descendants; cancellation must terminate the whole Windows process tree.
    const onAbort = () => {
      void terminateProcessTree(proc).then(() => {
        finish({ ok: false, kind: 'aborted', stdout, stderr });
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (err) => {
      if (signal.aborted) return;
      finish({
        ok: false,
        kind: 'spawn-error',
        stdout,
        stderr,
        message: String(err),
      });
    });
    proc.on('close', (code) => {
      if (signal.aborted) return;
      if (code === 0) finish({ ok: true, stdout, stderr });
      else finish({ ok: false, kind: 'exit', code, stdout, stderr });
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
      const targetPath = await safeNpmShimTarget(ps1Path);
      if (targetPath === undefined) continue;
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
  context: CliExecutionContext,
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
        await ensureExecutionContext(context);
        const resolution = await ensureLaunch(signal);
        if (!resolution.ok) return resolution;
        const result = await runCommand(
          invocationForLaunch(resolution.launch, buildCliProbeInvocation(kind, context)),
          '',
          signal,
        );
        if (signal.aborted) return { ok: false, kind: 'aborted' };
        if (result.ok) return { ok: true };
        const failure = classifyFailure(result, signal);
        if (kind === 'codex-cli' && failure.kind !== 'aborted') {
          return {
            ok: false,
            kind: 'unavailable',
            message: `Codex CLI cannot enforce the required shell_tool/shell_snapshot-disabled invocation: ${failure.message}`,
          };
        }
        return { ok: false, ...failure };
      } catch (error) {
        if (kind === 'codex-cli' && !signal.aborted) {
          return {
            ok: false,
            kind: 'unavailable',
            message: `Codex CLI cannot enforce the required shell_tool/shell_snapshot-disabled invocation: ${String(error)}`,
          };
        }
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
        await ensureExecutionContext(context);
        const resolution = await ensureLaunch(signal);
        if (!resolution.ok) return { ...resolution, usage: inputUsage };
        const result = await runCommand(
          invocationForLaunch(resolution.launch, buildCliInvocation(kind, instruction, context)),
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
