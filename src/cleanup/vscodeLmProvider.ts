/** vscode.lm provider with VS Code calls kept behind a small injected boundary. */
import * as vscode from 'vscode';
import {
  LlmProvider,
  PrepareResult,
  ProviderFailureKind,
  ProviderResult,
  TokenUsage,
  wrapTranscript,
} from './llmProvider';

export interface VscodeLmModel {
  vendor: string;
  family: string;
  countTokens(value: unknown, token?: unknown): PromiseLike<number>;
  sendRequest(
    messages: readonly unknown[],
    options: unknown,
    token: unknown,
  ): PromiseLike<{ text: AsyncIterable<string> }>;
}

interface VscodeCancellation {
  token: unknown;
  cancel(): void;
  dispose(): void;
}

export interface VscodeLmApi {
  selectChatModels(): PromiseLike<VscodeLmModel[]>;
  canSendRequest(model: VscodeLmModel): boolean | undefined;
  userMessage(text: string): unknown;
  createCancellation(): VscodeCancellation;
}

interface NormalizedFailure {
  kind: ProviderFailureKind;
  message: string;
  retryAfterMs?: number;
}

function selectPreferred(models: VscodeLmModel[]): VscodeLmModel | undefined {
  return models.find((model) => /mini|haiku|flash|lite/i.test(model.family)) ?? models[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numericProperty(value: unknown, property: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function normalizeLanguageModelFailure(error: unknown, signal: AbortSignal): NormalizedFailure {
  const message = errorMessage(error);
  const code =
    typeof error === 'object' && error !== null
      ? String((error as Record<string, unknown>).code ?? '')
      : '';
  const combined = `${code} ${message}`;
  const retry = numericProperty(error, 'retryAfterMs');
  if (signal.aborted || /cancel(?:led|ed|ation)/i.test(combined)) {
    return { kind: 'aborted', message };
  }
  if (/(?:\b429\b|quota|rate[ -]?limit|too many requests|usage limit)/i.test(combined)) {
    return { kind: 'rate-limit', message, ...(retry === undefined ? {} : { retryAfterMs: retry }) };
  }
  if (/(?:NoPermissions|Blocked|NotFound|unavailable|no model|access denied)/i.test(combined)) {
    return { kind: 'unavailable', message };
  }
  return { kind: 'error', message };
}

async function requestMessages(
  model: VscodeLmModel,
  messages: readonly unknown[],
  signal: AbortSignal,
  api: VscodeLmApi,
): Promise<ProviderResult> {
  const cancellation = api.createCancellation();
  const onAbort = () => cancellation.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  let inputTokens = 0;
  let countedInput = false;
  const usage = (): TokenUsage => ({
    ...(countedInput ? { inputTokens } : {}),
    estimate: false,
  });
  try {
    if (signal.aborted) return { ok: false, kind: 'aborted', usage: usage() };
    for (const message of messages) {
      inputTokens += await model.countTokens(message, cancellation.token);
      countedInput = true;
    }
    const response = await model.sendRequest(messages, {}, cancellation.token);
    let text = '';
    for await (const fragment of response.text) text += fragment;
    if (signal.aborted) return { ok: false, kind: 'aborted', usage: usage() };
    const outputTokens = await model.countTokens(text, cancellation.token);
    return { ok: true, text, usage: { inputTokens, outputTokens, estimate: false } };
  } catch (error) {
    return { ok: false, ...normalizeLanguageModelFailure(error, signal), usage: usage() };
  } finally {
    signal.removeEventListener('abort', onAbort);
    cancellation.dispose();
  }
}

export async function createVscodeLmProviderWithApi(
  api: VscodeLmApi,
  log: (line: string) => void,
): Promise<LlmProvider | undefined> {
  let currentModel: VscodeLmModel | undefined;
  try {
    currentModel = selectPreferred(await api.selectChatModels());
  } catch (error) {
    log(`[cleanup] vscode.lm 探测失败:${String(error)}`);
    return undefined;
  }
  if (currentModel === undefined) {
    log('[cleanup] vscode.lm 无可用模型(未装 Copilot 或未登录),rules-only');
    return undefined;
  }
  log(`[cleanup] vscode.lm 使用 ${currentModel.vendor}/${currentModel.family}`);

  return {
    get name(): string {
      return `vscode.lm(${currentModel?.family ?? 'unavailable'})`;
    },
    async prepare(signal): Promise<PrepareResult> {
      if (signal.aborted) return { ok: false, kind: 'aborted' };
      try {
        currentModel = selectPreferred(await api.selectChatModels());
        if (signal.aborted) return { ok: false, kind: 'aborted' };
        if (currentModel === undefined) {
          return { ok: false, kind: 'unavailable', message: 'No vscode.lm model is available.' };
        }
        const access = api.canSendRequest(currentModel);
        if (access === true) return { ok: true };
        if (access === false) {
          return {
            ok: false,
            kind: 'unavailable',
            message: 'VS Code has not granted access to this language model.',
          };
        }
        const ping = await requestMessages(
          currentModel,
          [api.userMessage('Reply with OK only.')],
          signal,
          api,
        );
        if (ping.ok) return { ok: true, usage: ping.usage };
        return {
          ok: false,
          kind: ping.kind,
          usage: ping.usage,
          ...(ping.message === undefined ? {} : { message: ping.message }),
          ...(ping.retryAfterMs === undefined ? {} : { retryAfterMs: ping.retryAfterMs }),
        };
      } catch (error) {
        return { ok: false, ...normalizeLanguageModelFailure(error, signal) };
      }
    },
    async run(instruction, text, signal): Promise<ProviderResult> {
      if (currentModel === undefined) {
        return {
          ok: false,
          kind: signal.aborted ? 'aborted' : 'unavailable',
          usage: { estimate: false },
          message: 'No vscode.lm model is available.',
        };
      }
      try {
        return await requestMessages(
          currentModel,
          [api.userMessage(instruction), api.userMessage(wrapTranscript(text))],
          signal,
          api,
        );
      } catch (error) {
        return {
          ok: false,
          ...normalizeLanguageModelFailure(error, signal),
          usage: { estimate: false },
        };
      }
    },
  };
}

export function createVscodeLmProvider(
  log: (line: string) => void,
  accessInformation: vscode.LanguageModelAccessInformation,
): Promise<LlmProvider | undefined> {
  return createVscodeLmProviderWithApi(
    {
      selectChatModels: async () => vscode.lm.selectChatModels(),
      canSendRequest: (model) =>
        accessInformation.canSendRequest(model as unknown as vscode.LanguageModelChat),
      userMessage: (text) => vscode.LanguageModelChatMessage.User(text),
      createCancellation: () => {
        const source = new vscode.CancellationTokenSource();
        return {
          token: source.token,
          cancel: () => source.cancel(),
          dispose: () => source.dispose(),
        };
      },
    },
    log,
  );
}
