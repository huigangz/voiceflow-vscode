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

/**
 * Keep one preflight generation across asynchronous admission and recorder startup.
 * Cancellation abandons admission before capture; a resource produced late is disposed exactly once.
 */
export async function runCancellableStartup<A, R>(
  preflight: SessionPreflight,
  admit: (signal: AbortSignal) => Promise<A>,
  start: (admission: A, signal: AbortSignal) => Promise<R>,
  disposeLate: (resource: R) => void,
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
  });
  if (!result.started && resource !== undefined) dispose(resource);
  return result;
}

/** Owns one session-level preflight generation; cancelling abandons the wait, not shared startup. */
export class SessionPreflight {
  private generation = 0;
  private current: AbortController | undefined;

  constructor(private readonly session: Session) {}

  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<SessionPreflightResult<T>> {
    if (!this.session.dispatch('prepare')) return { started: false, reason: 'busy' };
    const generation = ++this.generation;
    const controller = new AbortController();
    this.current = controller;
    const cancelled = new Promise<{ kind: 'cancelled' }>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
    });
    const pending = work(controller.signal).then((value) => ({ kind: 'value' as const, value }));
    try {
      const result = await Promise.race([pending, cancelled]);
      if (
        result.kind === 'cancelled' ||
        generation !== this.generation ||
        this.session.state !== 'preparing'
      ) {
        return { started: false, reason: 'cancelled' };
      }
      this.current = undefined;
      this.session.dispatch('start');
      return { started: true, value: result.value };
    } catch (error) {
      if (generation === this.generation && this.session.state === 'preparing') {
        this.current = undefined;
        this.session.dispatch('error');
      }
      throw error;
    }
  }

  cancel(): boolean {
    if (this.session.state !== 'preparing') return false;
    this.generation++;
    this.current?.abort();
    this.current = undefined;
    return this.session.dispatch('cancel');
  }
}
