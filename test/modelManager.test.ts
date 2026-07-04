import { describe, expect, it } from 'vitest';
import { ModelManager } from '../src/stt/modelManager';

// Constructor only stores its args; tierFromFileName uses the static MODELS table.
const mgr = new ModelManager({} as never, () => {});

describe('tierFromFileName (D: import tier inference)', () => {
  it('matches canonical ggml filenames to tiers', () => {
    expect(mgr.tierFromFileName('ggml-small.bin')).toBe('small');
    expect(mgr.tierFromFileName('ggml-base.bin')).toBe('base');
    expect(mgr.tierFromFileName('ggml-small-q5_1.bin')).toBe('small-q5');
    expect(mgr.tierFromFileName('ggml-large-v3-turbo-q5_0.bin')).toBe('large-v3-turbo-q5');
    expect(mgr.tierFromFileName('ggml-large-v3-turbo.bin')).toBe('large-v3-turbo');
  });

  it('strips directory components and is case-insensitive', () => {
    expect(mgr.tierFromFileName('C:\\models\\GGML-SMALL.BIN')).toBe('small');
    expect(mgr.tierFromFileName('/mnt/share/ggml-base.bin')).toBe('base');
  });

  it('returns undefined for unrecognized names (caller then asks the tier)', () => {
    expect(mgr.tierFromFileName('my-renamed-model.bin')).toBeUndefined();
    expect(mgr.tierFromFileName('ggml-medium.bin')).toBeUndefined();
  });
});
