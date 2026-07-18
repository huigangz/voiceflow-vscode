export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  estimate: boolean;
}

export type ProviderFailureKind = 'rate-limit' | 'unavailable' | 'aborted' | 'error';

export type ProviderResult =
  | { ok: true; text: string; usage: TokenUsage }
  | {
      ok: false;
      kind: ProviderFailureKind;
      usage: TokenUsage;
      message?: string;
      retryAfterMs?: number;
    };

export type PrepareResult =
  | { ok: true; usage?: TokenUsage }
  | {
      ok: false;
      kind: ProviderFailureKind;
      usage?: TokenUsage;
      message?: string;
      retryAfterMs?: number;
    };

export interface LlmProvider {
  name: string;
  prepare(signal: AbortSignal): Promise<PrepareResult>;
  run(instruction: string, text: string, signal: AbortSignal): Promise<ProviderResult>;
}

/** Delimit untrusted transcript data from the caller-owned instruction. */
export function wrapTranscript(text: string): string {
  return `<transcript>\n${text}\n</transcript>`;
}
