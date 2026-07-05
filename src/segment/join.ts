/**
 * P2b:段间拼接纯逻辑(质量防线:中文不加分隔、英文段间补空格)+ 插入终点推进。
 * 不依赖 vscode,可单测。
 */

/** 词字符(latin/数字):两段交界两侧都是词字符才补空格;CJK 侧不加。 */
const WORD_CHAR = /[A-Za-z0-9]/;

/** 段间是否需要补空格(复用规则层"中英之间才留白"的精神:英↔英才补,中文侧不加)。 */
export function needsSpaceBetween(prevTail: string, nextHead: string): boolean {
  if (prevTail.length === 0 || nextHead.length === 0) return false;
  return WORD_CHAR.test(prevTail) && WORD_CHAR.test(nextHead);
}

/** 把下一段接到上一段之后(返回带必要空格前缀的下一段文本)。 */
export function joinSegment(prevText: string, nextText: string): string {
  if (prevText.length === 0) return nextText;
  const tail = prevText[prevText.length - 1]!;
  const head = nextText[0] ?? '';
  return needsSpaceBetween(tail, head) ? ` ${nextText}` : nextText;
}

/** 多段一次性拼接(累计兜底 flush 用)。 */
export function joinAll(parts: string[]): string {
  let out = '';
  for (const p of parts) out += joinSegment(out, p);
  return out;
}

/** 插入 text 后的终点坐标(0 基行/列;与 vscode.Position 语义一致,纯逻辑可测)。 */
export function advanceLineChar(
  line: number,
  character: number,
  text: string,
): { line: number; character: number } {
  const lines = text.split('\n');
  if (lines.length === 1) return { line, character: character + text.length };
  return { line: line + lines.length - 1, character: lines[lines.length - 1]!.length };
}
