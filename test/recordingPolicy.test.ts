import { describe, expect, it } from 'vitest';
import { RecordingPolicy } from '../src/audio/recordingPolicy';

const cfg = { maxDurationMs: 120_000, autoStopSilenceMs: 3_000 };

describe('RecordingPolicy (F1.2/F1.3)', () => {
  it('静音 ≥3s 且已有语音段 → stop-silence', () => {
    const p = new RecordingPolicy(cfg);
    expect(p.onChunk(0, false)).toBe('continue');
    expect(p.onChunk(1000, true)).toBe('continue'); // 语音
    expect(p.onChunk(2000, false)).toBe('continue');
    expect(p.onChunk(3900, false)).toBe('continue'); // 静音 2.9s
    expect(p.onChunk(4000, false)).toBe('stop-silence'); // 静音 3.0s
  });

  it('从未出现语音段 → 静音不触发自动结束(等待用户说话)', () => {
    const p = new RecordingPolicy(cfg);
    for (let t = 0; t <= 30_000; t += 500) {
      expect(p.onChunk(t, false)).toBe('continue');
    }
    expect(p.hasSpeech).toBe(false);
  });

  it('autoStopSilence=0 → 关闭静音自动结束', () => {
    const p = new RecordingPolicy({ ...cfg, autoStopSilenceMs: 0 });
    p.onChunk(0, true);
    for (let t = 500; t <= 60_000; t += 500) {
      expect(p.onChunk(t, false)).toBe('continue');
    }
  });

  it('达到 maxDuration → stop-max-duration(优先于静音)', () => {
    const p = new RecordingPolicy({ maxDurationMs: 5_000, autoStopSilenceMs: 3_000 });
    p.onChunk(0, true);
    expect(p.onChunk(5_000, false)).toBe('stop-max-duration');
  });

  it('语音重新出现会重置静音计时', () => {
    const p = new RecordingPolicy(cfg);
    p.onChunk(0, true);
    p.onChunk(2500, false);
    expect(p.onChunk(2900, true)).toBe('continue'); // 重新说话
    expect(p.onChunk(5800, false)).toBe('continue'); // 距上次语音 2.9s
    expect(p.onChunk(5900, false)).toBe('stop-silence'); // 3.0s
  });
});
