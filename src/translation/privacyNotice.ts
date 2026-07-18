export const TRANSLATION_PRIVACY_NOTICE_KEY = 'voiceflow.translationPrivacyNoticeSeen';

interface NoticeState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const claimedNoticeStates = new WeakSet<NoticeState>();

export const TRANSLATION_PRIVACY_NOTICE =
  'VoiceFlow translation to Chinese sends transcript text to the selected LLM provider. ' +
  'That text leaves the local transcription pipeline and is processed externally.';

export function maybeShowTranslationPrivacyNotice(
  state: NoticeState,
  show: (message: string) => PromiseLike<unknown>,
): boolean {
  if (
    state.get<boolean>(TRANSLATION_PRIVACY_NOTICE_KEY) ||
    claimedNoticeStates.has(state)
  ) return false;
  claimedNoticeStates.add(state);
  try {
    void Promise.resolve(state.update(TRANSLATION_PRIVACY_NOTICE_KEY, true)).catch(() => {});
  } catch {
    // The in-process claim still suppresses duplicate notices when persistence is unavailable.
  }
  try {
    void Promise.resolve(show(TRANSLATION_PRIVACY_NOTICE)).catch(() => {});
  } catch {
    // Notice UI failures must not reject translation admission.
  }
  return true;
}
