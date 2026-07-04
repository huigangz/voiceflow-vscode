/**
 * 会话状态机(spec §5.3)— 纯逻辑,不依赖 vscode,可单元测试。
 *
 *   idle → recording → transcribing → cleaning → inserting → idle
 *
 * - cancel(Esc)在任何非 idle 阶段 = 取消整个会话,回 idle
 * - error 在任何阶段 → idle(由调用方展示状态栏错误)
 */

export type SessionState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'cleaning'
  | 'inserting';

export type SessionEvent =
  | 'start'        // Ctrl+Alt+L,仅 idle 时有效
  | 'stopRecording'// Ctrl+Alt+L 再按 / VAD 静音 / 超时
  | 'transcribed'
  | 'cleaned'
  | 'inserted'
  | 'cancel'       // Esc:任何阶段取消整个会话
  | 'error';

const TRANSITIONS: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  idle: { start: 'recording' },
  recording: { stopRecording: 'transcribing', cancel: 'idle', error: 'idle' },
  transcribing: { transcribed: 'cleaning', cancel: 'idle', error: 'idle' },
  cleaning: { cleaned: 'inserting', cancel: 'idle', error: 'idle' },
  inserting: { inserted: 'idle', cancel: 'idle', error: 'idle' },
};

export class Session {
  private _state: SessionState = 'idle';
  private listeners: Array<(s: SessionState, prev: SessionState) => void> = [];

  get state(): SessionState {
    return this._state;
  }

  get active(): boolean {
    return this._state !== 'idle';
  }

  onTransition(fn: (s: SessionState, prev: SessionState) => void): void {
    this.listeners.push(fn);
  }

  /** 尝试转移;非法事件返回 false 并保持原状态(如 transcribing 阶段再按 start)。 */
  dispatch(event: SessionEvent): boolean {
    const next = TRANSITIONS[this._state][event];
    if (next === undefined) return false;
    const prev = this._state;
    this._state = next;
    for (const fn of this.listeners) fn(next, prev);
    return true;
  }
}
