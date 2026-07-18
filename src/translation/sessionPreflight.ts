import type { EnhanceProvider } from '../cleanup/pipeline';
import type { RulesConfig } from '../cleanup/rulesLayer';
import type { Session } from '../session';
import type { EngineCapabilities } from '../stt/engineManager';
import type { TranscribeOptions, WhisperLanguage } from '../stt/whisperRunner';

export type TranslationTarget = 'off' | 'zh' | 'en';

export interface TranslationSessionSnapshot {
  readonly target: TranslationTarget;
  readonly sourceHint: WhisperLanguage;
  readonly useLlm: boolean;
  readonly provider: EnhanceProvider | undefined;
  readonly timeoutMs: number;
  readonly rules: Readonly<RulesConfig>;
}

export function createTranslationSessionSnapshot(
  input: Omit<TranslationSessionSnapshot, 'rules'> & { rules: RulesConfig },
): TranslationSessionSnapshot {
  return Object.freeze({ ...input, rules: Object.freeze({ ...input.rules }) });
}

export function transcribeOptionsForSession(snapshot: TranslationSessionSnapshot): TranscribeOptions {
  return snapshot.target === 'en' ? { task: 'translate', translationTarget: 'en' } : {};
}

/** Translation sessions keep Whisper on the frozen source hint and never adopt a detected-language lock. */
export function languageHintForSession(
  snapshot: TranslationSessionSnapshot,
  lockedLanguage: 'zh' | 'en' | undefined,
): WhisperLanguage | undefined {
  return snapshot.target === 'off' ? lockedLanguage : snapshot.sourceHint;
}

export class TranslationUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationUnsupportedError';
  }
}

export async function validateTranslationSnapshot(
  snapshot: TranslationSessionSnapshot,
  engine: { resolveCapabilities(): Promise<EngineCapabilities> },
  signal: AbortSignal,
): Promise<void> {
  if (snapshot.target === 'off') return;
  if (snapshot.target === 'zh') {
    throw new TranslationUnsupportedError('Translation to Chinese is not available in this build.');
  }
  if (signal.aborted) return;
  const capabilities = await engine.resolveCapabilities();
  if (signal.aborted) return;
  if (!capabilities.canTranslateToEn) {
    throw new TranslationUnsupportedError(
      `The current model (${capabilities.model}) does not support local translation to English. Choose a small model tier.`,
    );
  }
}

export type SessionPreflightResult<T> =
  | { started: true; value: T }
  | { started: false; reason: 'busy' | 'cancelled' };

export interface SessionPreflightOptions {
  commitImmediately?: boolean;
  onCancel?: () => void;
}

/** Owns a controller that may be replaced by a fallback while startup is still in flight. */
export class MutableStartupResource<T> {
  private resource: T | undefined;
  private disposed = false;

  constructor(private readonly disposeResource: (resource: T) => void) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  replace(resource: T): boolean {
    if (this.disposed) {
      this.disposeResource(resource);
      return false;
    }
    if (this.resource === resource) return true;
    const previous = this.resource;
    this.resource = resource;
    if (previous !== undefined) this.disposeResource(previous);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const resource = this.resource;
    this.resource = undefined;
    if (resource !== undefined) this.disposeResource(resource);
  }
}

class StartupCancelledError extends Error {
  constructor() {
    super('startup cancelled');
    this.name = 'StartupCancelledError';
  }
}

interface StartCancellableFallbackOptions<T extends { start(): Promise<void> }> {
  signal: AbortSignal;
  owner: MutableStartupResource<T>;
  createPrimary(): T;
  createFallback(): T;
  shouldFallback(error: unknown): boolean;
  onFallback?(error: unknown): void;
}

/** Start a replaceable controller without allowing fallback creation to escape cancellation. */
export async function startCancellableFallback<T extends { start(): Promise<void> }>(
  options: StartCancellableFallbackOptions<T>,
): Promise<T> {
  const { signal, owner } = options;
  const ensureActive = (): void => {
    if (signal.aborted || owner.isDisposed) throw new StartupCancelledError();
  };
  const start = async (resource: T): Promise<T> => {
    if (!owner.replace(resource)) throw new StartupCancelledError();
    await resource.start();
    ensureActive();
    return resource;
  };

  ensureActive();
  try {
    return await start(options.createPrimary());
  } catch (error) {
    if (signal.aborted || owner.isDisposed) {
      owner.dispose();
      throw new StartupCancelledError();
    }
    if (!options.shouldFallback(error)) {
      owner.dispose();
      throw error;
    }
    ensureActive();
    try {
      const fallback = options.createFallback();
      options.onFallback?.(error);
      const result = await start(fallback);
      return result;
    } catch (fallbackError) {
      owner.dispose();
      throw fallbackError;
    }
  }
}

/**
 * Keep one preflight generation across asynchronous admission and recorder startup.
 * Cancellation abandons admission before capture; a resource produced late is disposed exactly once.
 */
export async function runCancellableStartup<A, R>(
  preflight: SessionPreflight,
  admit: (signal: AbortSignal) => Promise<A>,
  start: (admission: A, signal: AbortSignal) => Promise<R>,
  disposeLate: (resource: R) => void,
  options: SessionPreflightOptions = {},
): Promise<SessionPreflightResult<R>> {
  let resource: R | undefined;
  let disposed = false;
  const dispose = (value: R): void => {
    if (disposed) return;
    disposed = true;
    disposeLate(value);
  };
  const result = await preflight.run(async (signal) => {
    const admission = await admit(signal);
    if (signal.aborted) throw new Error('startup cancelled after admission');
    resource = await start(admission, signal);
    if (signal.aborted) {
      dispose(resource);
      throw new Error('startup cancelled after recorder start');
    }
    return resource;
  }, options);
  if (!result.started && resource !== undefined) dispose(resource);
  return result;
}

/** Owns one session-level startup generation; cancellation may remain armed after an early UI commit. */
export class SessionPreflight {
  private generation = 0;
  private current: { controller: AbortController; onCancel: (() => void) | undefined } | undefined;

  constructor(private readonly session: Session) {}

  async run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: SessionPreflightOptions = {},
  ): Promise<SessionPreflightResult<T>> {
    if (!this.session.dispatch('prepare')) return { started: false, reason: 'busy' };
    const generation = ++this.generation;
    const controller = new AbortController();
    this.current = { controller, onCancel: options.onCancel };
    if (options.commitImmediately) this.session.dispatch('start');
    const cancelled = new Promise<{ kind: 'cancelled' }>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
    });
    const pending = work(controller.signal).then((value) => ({ kind: 'value' as const, value }));
    try {
      const result = await Promise.race([pending, cancelled]);
      if (
        result.kind === 'cancelled' ||
        generation !== this.generation ||
        this.session.state !== (options.commitImmediately ? 'recording' : 'preparing')
      ) {
        return { started: false, reason: 'cancelled' };
      }
      this.current = undefined;
      if (!options.commitImmediately) this.session.dispatch('start');
      return { started: true, value: result.value };
    } catch (error) {
      if (
        generation === this.generation &&
        this.session.state === (options.commitImmediately ? 'recording' : 'preparing')
      ) {
        this.current = undefined;
        this.session.dispatch('error');
      }
      throw error;
    }
  }

  cancel(): boolean {
    const current = this.current;
    if (!current) return false;
    this.generation++;
    this.current = undefined;
    current.controller.abort();
    current.onCancel?.();
    return this.session.dispatch('cancel');
  }
}
