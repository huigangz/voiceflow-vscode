export const TRANSLATION_PRIVACY_NOTICE_KEY = 'voiceflow.translationPrivacyNoticeSeen';

interface NoticeState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const TRANSLATION_PRIVACY_NOTICE =
  'VoiceFlow translation to Chinese sends transcript text to the selected LLM provider. ' +
  'That text leaves the local transcription pipeline and is processed externally.';

export function maybeShowTranslationPrivacyNotice(
  state: NoticeState,
  show: (message: string) => PromiseLike<unknown>,
): boolean {
  if (state.get<boolean>(TRANSLATION_PRIVACY_NOTICE_KEY)) return false;
  void Promise.resolve(state.update(TRANSLATION_PRIVACY_NOTICE_KEY, true));
  void Promise.resolve(show(TRANSLATION_PRIVACY_NOTICE));
  return true;
}
