import { describe, expect, it } from 'vitest';
import { recommendTier } from '../src/ui/setupWizard';

describe('recommendTier (F5.1 档位推荐,纯函数)', () => {
  it('< 8GB 内存 → small-q5(量化省内存)', () => {
    expect(recommendTier(4 * 1e9)).toBe('small-q5');
    expect(recommendTier(7.5 * 1e9)).toBe('small-q5');
  });

  it('>= 8GB → small(均衡默认)', () => {
    expect(recommendTier(8 * 1e9)).toBe('small');
    expect(recommendTier(16 * 1e9)).toBe('small');
    expect(recommendTier(64 * 1e9)).toBe('small');
  });

  it('推荐档位始终是已定义的档位', () => {
    for (const mem of [2, 8, 32].map((g) => g * 1e9)) {
      expect(['base', 'small', 'small-q5', 'large-v3-turbo-q5', 'large-v3-turbo']).toContain(
        recommendTier(mem),
      );
    }
  });
});
