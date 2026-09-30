/**
 * 评测用 CER(harness PR5,spec §10.5 / §10.6)。
 *
 * 测的是识别准确度,不是格式准确度:参考与转写都先过 normalizeForEvaluation,再按 Unicode 码点算编辑距离。
 * 归一化与产品规则层(src/cleanup/rulesLayer.ts)刻意分开:规则层是给用户看的格式化(加中英空格、
 * 转全角标点、去尾部幻觉),这里是把格式差异全部抹平。幻觉必须计入错误,所以这里不去幻觉。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OpenCC = require('opencc-js');

let t2s;

/**
 * 顺序固定(spec §10.7 D):
 * 1. NFKC —— 全角字母 / 数字 / 空格 / 兼容字符 → 半角
 * 2. 繁 → 简(opencc t → cn,与规则层同配置)
 * 3. 小写(可关)
 * 4. 删除标点 \p{P}(含中文标点、`/`、`-`);保留符号 \p{S}(`C++` 的 `+`)
 * 5. 删除全部空白(空白差异与中英间距差异一并抹平)
 * 不做:去幻觉、数字 / 中文数字互转、语气词删除、任何改写。
 * @param {string} text
 * @param {{ lowercaseLatin?: boolean }} [opts]
 */
export function normalizeForEvaluation(text, { lowercaseLatin = true } = {}) {
  t2s ??= OpenCC.Converter({ from: 't', to: 'cn' });
  let out = text.normalize('NFKC');
  out = t2s(out);
  if (lowercaseLatin) out = out.toLowerCase();
  return out.replace(/\p{P}/gu, '').replace(/\s/gu, '');
}

/** 按 Unicode 码点的 Levenshtein 距离(扩展区汉字算 1 个字符)。 */
export function levenshtein(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/**
 * CER = Levenshtein(归一化参考, 归一化转写) / 归一化参考长度(码点)。
 * 参考归一化后为空(静音用例)→ cer = null,由调用方单独判"是否误出字"。
 */
export function cer(reference, hypothesis, opts) {
  const normRef = normalizeForEvaluation(reference, opts);
  const normHyp = normalizeForEvaluation(hypothesis, opts);
  const distance = levenshtein(normRef, normHyp);
  const refLen = Array.from(normRef).length;
  return { normRef, normHyp, distance, refLen, cer: refLen === 0 ? null : distance / refLen };
}

/**
 * 按用例加权的宏平均:Σ(wᵢ·CERᵢ) / Σwᵢ;cer 为 null 或权重为 0 的用例不参与。无可用用例 → null。
 * @param {{ cer: number | null, weight: number }[]} cases
 */
export function weightedCer(cases) {
  let num = 0;
  let den = 0;
  for (const c of cases) {
    if (c.cer === null || !(c.weight > 0)) continue;
    num += c.weight * c.cer;
    den += c.weight;
  }
  return den === 0 ? null : num / den;
}
