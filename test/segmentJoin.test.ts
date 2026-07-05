/** P2b-5:段间拼接纯逻辑单测(2b gate 自动项:拼接——中文不加分隔、英文段间补空格)。 */
import { describe, expect, it } from 'vitest';
import { advanceLineChar, joinAll, joinSegment, needsSpaceBetween } from '../src/segment/join';

describe('段间拼接', () => {
  it('英↔英补空格;中↔中、中↔英、英↔中不加', () => {
    expect(joinSegment('hello world', 'next part')).toBe(' next part');
    expect(joinSegment('版本 v2', 'ok')).toBe(' ok'); // 尾字符 2(词字符)↔ o
    expect(joinSegment('今天开会。', '明天发布。')).toBe('明天发布。');
    expect(joinSegment('today ok', '明天发布')).toBe('明天发布');
    expect(joinSegment('今天开会', 'tomorrow ship')).toBe('tomorrow ship');
  });

  it('标点收尾不补空格;空段安全', () => {
    expect(joinSegment('done.', 'next')).toBe('next'); // 句点后 whisper 文本自带边界
    expect(joinSegment('', 'x')).toBe('x');
    expect(joinSegment('x', '')).toBe('');
    expect(needsSpaceBetween('', 'a')).toBe(false);
  });

  it('joinAll 多段累计(兜底 flush 的拼接口径与逐段插入一致)', () => {
    expect(joinAll(['hello', 'world', '你好', 'again'])).toBe('hello world你好again');
    expect(joinAll([])).toBe('');
  });
});

describe('advanceLineChar 插入终点推进', () => {
  it('单行:列右移文本长度', () => {
    expect(advanceLineChar(3, 5, 'abc')).toEqual({ line: 3, character: 8 });
  });
  it('多行:行进、列取末行长度', () => {
    expect(advanceLineChar(3, 5, 'ab\ncd\nefg')).toEqual({ line: 5, character: 3 });
    expect(advanceLineChar(0, 10, 'x\n')).toEqual({ line: 1, character: 0 });
  });
});
