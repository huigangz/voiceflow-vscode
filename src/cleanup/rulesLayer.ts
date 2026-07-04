/**
 * 规则轻清理层(F3.1)— 纯逻辑,可单元测试。
 *
 * 边界(spec 明确):只做确定性、低风险规则 —— 中英空格 / 简繁转简 /
 * 全半角标点归一 / 去重复空格 / 去尾部幻觉。
 * 不做:改写语气、翻译、补代码符号、猜意图、大段重排。
 * 原则:**宁可少改,不可错改**。各规则可配置开关。
 */
// opencc-js 的类型声明仅暴露 ESM 入口,与本项目 CJS 输出冲突;
// 运行时其 CJS 入口正常(esbuild 按 require 条件打包),此处显式 require 并自声明最小类型。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpenCC = require('opencc-js') as {
  Converter(opts: { from: string; to: string }): (s: string) => string;
};

export interface RulesConfig {
  convertToSimplified: boolean;
  spacingCJKLatin: boolean;
  normalizePunctuation: boolean;
  collapseSpaces: boolean;
  stripHallucinations: boolean;
}

export const DEFAULT_RULES: RulesConfig = {
  convertToSimplified: true,
  spacingCJKLatin: true,
  normalizePunctuation: true,
  collapseSpaces: true,
  stripHallucinations: true,
};

// ---------- 尾部幻觉(whisper 静音段经典产物;仅尾部整句匹配,防错杀) ----------
const TAIL_HALLUCINATIONS = [
  '谢谢观看', '感谢观看', '谢谢大家', '感谢收看', '谢谢收看',
  '请订阅', '点赞订阅', '记得订阅', '请不吝点赞订阅转发',
  '字幕由Amara.org社区提供', '字幕由 Amara.org 社区提供', '由Amara.org社区提供的字幕',
  '未经许可不得转载',
  'Thank you for watching', 'Thanks for watching', 'Please subscribe',
  'Subtitles by the Amara.org community',
];

// 带括号的字幕组署名类幻觉,如 "(字幕製作:貝爾)"(gate 实测样本,2026-07-03)。
// 仅匹配整体带括号的形态,防误杀正文中"字幕制作流程"这类合法短语。
const TAIL_HALLUCINATION_PATTERNS = [/[((]字幕[^))\n]{0,24}[))]$/u];

function stripTailHallucinations(text: string): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    const trimmed = out.replace(/[\s。,.!!??~]+$/u, '');
    for (const phrase of TAIL_HALLUCINATIONS) {
      if (trimmed.toLowerCase().endsWith(phrase.toLowerCase())) {
        out = trimmed.slice(0, trimmed.length - phrase.length);
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (const re of TAIL_HALLUCINATION_PATTERNS) {
        if (re.test(trimmed)) {
          out = trimmed.replace(re, '');
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

// ---------- 简繁 ----------
let t2s: ((s: string) => string) | undefined;
function convertToSimplified(text: string): string {
  const conv = t2s ?? (t2s = OpenCC.Converter({ from: 't', to: 'cn' }));
  return conv(text);
}

// ---------- 全半角标点归一(保守子集) ----------
const HAN = '\\p{Script=Han}';
// 半角标点紧跟汉字、且后面是汉字/空白/结尾 → 转全角(保护 "1.5"、"a.js" 等)
const HALF_TO_FULL: Array<[RegExp, string]> = [
  [new RegExp(`(?<=${HAN}),(?=${HAN}|\\s|$)`, 'gu'), ','],
  [new RegExp(`(?<=${HAN})\\.(?=${HAN}|\\s|$)`, 'gu'), '。'],
  [new RegExp(`(?<=${HAN})\\?(?=${HAN}|\\s|$)`, 'gu'), '?'],
  [new RegExp(`(?<=${HAN})!(?=${HAN}|\\s|$)`, 'gu'), '!'],
  [new RegExp(`(?<=${HAN});(?=${HAN}|\\s|$)`, 'gu'), ';'],
  [new RegExp(`(?<=${HAN}):(?=${HAN}|\\s|$)`, 'gu'), ':'],
];

function normalizePunctuation(text: string): string {
  // 全角字母/数字 → 半角(确定性安全);全角空格 → 半角空格
  let out = text.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  out = out.replace(/　/g, ' ');
  for (const [re, rep] of HALF_TO_FULL) {
    out = out.replace(re, rep);
  }
  return out;
}

// ---------- 中英间距 ----------
const SPACING_RULES: Array<[RegExp, string]> = [
  [new RegExp(`(${HAN})([A-Za-z0-9])`, 'gu'), '$1 $2'],
  [new RegExp(`([A-Za-z0-9])(${HAN})`, 'gu'), '$1 $2'],
];

function spacingCJKLatin(text: string): string {
  let out = text;
  for (const [re, rep] of SPACING_RULES) {
    out = out.replace(re, rep);
  }
  return out;
}

// ---------- 重复空格 ----------
function collapseSpaces(text: string): string {
  // 仅折叠行内连续空格/Tab,保留换行结构
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// ---------- 主入口 ----------
export function applyRules(text: string, cfg: RulesConfig = DEFAULT_RULES): string {
  let out = text.trim();
  if (out.length === 0) return out;
  if (cfg.stripHallucinations) out = stripTailHallucinations(out);
  if (cfg.convertToSimplified) out = convertToSimplified(out);
  if (cfg.normalizePunctuation) out = normalizePunctuation(out);
  if (cfg.spacingCJKLatin) out = spacingCJKLatin(out);
  if (cfg.collapseSpaces) out = collapseSpaces(out);
  return out.trim();
}
