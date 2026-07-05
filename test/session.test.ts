import { describe, expect, it } from 'vitest';
import { Session } from '../src/session';

describe('Session 状态机 (spec §5.3)', () => {
  it('正常闭环: idle → recording → transcribing → cleaning → inserting → idle', () => {
    const s = new Session();
    expect(s.state).toBe('idle');
    expect(s.dispatch('start')).toBe(true);
    expect(s.state).toBe('recording');
    expect(s.dispatch('stopRecording')).toBe(true);
    expect(s.state).toBe('transcribing');
    expect(s.dispatch('transcribed')).toBe(true);
    expect(s.state).toBe('cleaning');
    expect(s.dispatch('cleaned')).toBe(true);
    expect(s.state).toBe('inserting');
    expect(s.dispatch('inserted')).toBe(true);
    expect(s.state).toBe('idle');
  });

  it('Esc 在任何非 idle 阶段取消整个会话回 idle', () => {
    for (const stage of [
      ['start'],
      ['start', 'stopRecording'],
      ['start', 'stopRecording', 'transcribed'],
      ['start', 'stopRecording', 'transcribed', 'cleaned'],
    ] as const) {
      const s = new Session();
      for (const e of stage) s.dispatch(e);
      expect(s.dispatch('cancel')).toBe(true);
      expect(s.state).toBe('idle');
    }
  });

  it('error 在任何阶段回 idle', () => {
    const s = new Session();
    s.dispatch('start');
    s.dispatch('stopRecording');
    expect(s.dispatch('error')).toBe(true);
    expect(s.state).toBe('idle');
  });

  it('非法事件被拒绝且状态不变(处理中再按 start 无效)', () => {
    const s = new Session();
    s.dispatch('start');
    s.dispatch('stopRecording'); // transcribing
    expect(s.dispatch('start')).toBe(false);
    expect(s.state).toBe('transcribing');
    // idle 时 cancel 无效
    const s2 = new Session();
    expect(s2.dispatch('cancel')).toBe(false);
    expect(s2.state).toBe('idle');
  });

  it('P2b segmented 主线: idle → recording → draining → idle', () => {
    const s = new Session();
    s.dispatch('start');
    expect(s.dispatch('drainStart')).toBe(true);
    expect(s.state).toBe('draining');
    expect(s.active).toBe(true); // drain 期间 Esc keybinding 仍生效
    expect(s.dispatch('drained')).toBe(true);
    expect(s.state).toBe('idle');
  });

  it('P2b draining 中 Esc / error 回 idle;batch 路径不受 drainStart 影响', () => {
    for (const evt of ['cancel', 'error'] as const) {
      const s = new Session();
      s.dispatch('start');
      s.dispatch('drainStart');
      expect(s.dispatch(evt)).toBe(true);
      expect(s.state).toBe('idle');
    }
    // batch:transcribing 阶段 drainStart 非法
    const s = new Session();
    s.dispatch('start');
    s.dispatch('stopRecording');
    expect(s.dispatch('drainStart')).toBe(false);
    expect(s.state).toBe('transcribing');
  });

  it('active 与 transition 监听器', () => {
    const s = new Session();
    const seen: string[] = [];
    s.onTransition((next, prev) => seen.push(`${prev}>${next}`));
    expect(s.active).toBe(false);
    s.dispatch('start');
    expect(s.active).toBe(true);
    s.dispatch('cancel');
    expect(s.active).toBe(false);
    expect(seen).toEqual(['idle>recording', 'recording>idle']);
  });
});
