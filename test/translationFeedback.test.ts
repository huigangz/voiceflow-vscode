import { describe, expect, it } from 'vitest';
import { TranslationSessionFeedback } from '../src/translation/feedback';

describe('translation fallback feedback', () => {
  it.each(['timeout', 'error', 'empty', 'rejected'] as const)(
    'states that %s inserted the original while suppressing same-category toast storms',
    (outcome) => {
      const feedback = new TranslationSessionFeedback();
      const first = feedback.notificationFor({ text: 'source', outcome });
      expect(first).toMatch(new RegExp(`translation ${outcome}.*inserted original`, 'i'));
      expect(feedback.notificationFor({ text: 'source 2', outcome })).toBeUndefined();
    },
  );

  it('notifies circuit degradation once and stays quiet for later circuit-open segments', () => {
    const feedback = new TranslationSessionFeedback();
    expect(feedback.notificationFor({ text: 'source', outcome: 'circuit-open' }))
      .toMatch(/LLM.*unavailable|slow.*subsequent.*original/i);
    expect(feedback.notificationFor({ text: 'source 2', outcome: 'circuit-open' })).toBeUndefined();
  });

  it.each(['translated', 'identity'] as const)('does not notify for %s', (outcome) => {
    expect(new TranslationSessionFeedback().notificationFor({ text: 'ok', outcome })).toBeUndefined();
  });
});
