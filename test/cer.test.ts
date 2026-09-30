import { beforeAll, describe, expect, it } from 'vitest';

// 测试文件按 CommonJS 编译,静态 import .mjs 会被 tsc 拒绝 → 动态加载(同 packageContract.test.ts)
type Mod = typeof import('../scripts/cer.mjs', { with: { 'resolution-mode': 'import' } });
let normalizeForEvaluation: Mod['normalizeForEvaluation'];
let levenshtein: Mod['levenshtein'];
let cer: Mod['cer'];
let weightedCer: Mod['weightedCer'];
beforeAll(async () => {
  ({ normalizeForEvaluation, levenshtein, cer, weightedCer } = await import('../scripts/cer.mjs'));
});

describe('normalizeForEvaluation', () => {
  it('全角字母 / 数字 / 空格 → 半角(NFKC)', () => {
    expect(normalizeForEvaluation('ＡＰＩ　１２３')).toBe('api123');
  });

  it('繁 → 简', () => {
    expect(normalizeForEvaluation('這個問題')).toBe('这个问题');
  });

  it('小写默认开,可关', () => {
    expect(normalizeForEvaluation('GitHub Actions')).toBe('githubactions');
    expect(normalizeForEvaluation('GitHub Actions', { lowercaseLatin: false })).toBe('GitHubActions');
  });

  it('删除中英文标点,包括 / 与 -', () => {
    expect(normalizeForEvaluation('你好,世界。真的吗?!「好」、《书》')).toBe('你好世界真的吗好书');
    expect(normalizeForEvaluation('CI/CD, e-mail. (ok)!')).toBe('cicdemailok');
  });

  it('保留符号 \\p{S}', () => {
    expect(normalizeForEvaluation('C++ 与 $5 + 1 = 6')).toBe('c++与$5+1=6');
  });

  it('空白与中英间距差异全部抹平', () => {
    const variants = ['用 React 重构', '用React重构', '用  React\t重构\n', ' 用 React 重构 '];
    for (const v of variants) expect(normalizeForEvaluation(v)).toBe('用react重构');
    expect(normalizeForEvaluation('React component')).toBe(normalizeForEvaluation('ReactComponent'));
  });

  it('不去幻觉、不做数字互转(识别错误必须计分)', () => {
    expect(normalizeForEvaluation('好的。谢谢观看')).toBe('好的谢谢观看');
    expect(normalizeForEvaluation('三点')).not.toBe(normalizeForEvaluation('3点'));
  });
});

describe('levenshtein', () => {
  it('基础情况', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', 'ab')).toBe(2);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('今天开会', '今天不开会')).toBe(1);
  });

  it('按码点计:扩展区汉字算 1 个字符', () => {
    expect(levenshtein('𠀀', '')).toBe(1);
    expect(levenshtein('a𠀀b', 'a𠀁b')).toBe(1);
  });
});

describe('cer', () => {
  it('完全一致(仅格式不同)→ 0', () => {
    const r = cer('我今天用 React 重构了 login 页面。', '我今天用react重构了Login頁面');
    expect(r).toMatchObject({ distance: 0, cer: 0 });
  });

  it('参考为空 → cer 为 null(静音用例单独判误出字)', () => {
    expect(cer('', '')).toMatchObject({ refLen: 0, cer: null, normHyp: '' });
    expect(cer('', '谢谢观看。')).toMatchObject({ refLen: 0, cer: null, normHyp: '谢谢观看' });
  });

  it('refLen 按码点', () => {
    expect(cer('𠀀好', '好')).toMatchObject({ refLen: 2, distance: 1, cer: 0.5 });
  });

  // 质量基线 dc2f38a(test-audio/results-2026-07-04-02-24.md)的 jargon 用例,手算:
  // 多出"向"(+1),尾部"再看一下 GitHub Actions 的 workflow"整段漏识(4 + 13 + 1 + 8 = 26)→ 27;
  // 参考归一化后 94 个码点 → CER = 27 / 94
  it('真实样本:jargon 基线', () => {
    const r = cer(
      '这个 React component 要部署到 Kubernetes 集群,记得配 CI/CD pipeline,Docker image 推到 registry,再看一下 GitHub Actions 的 workflow。',
      '这个ReactComponent要部署到Kubernetes向集群,记得配CICD Pipeline,DockerImage,推到Registry。',
    );
    expect(r.normRef).toBe('这个reactcomponent要部署到kubernetes集群记得配cicdpipelinedockerimage推到registry再看一下githubactions的workflow');
    expect(r.normHyp).toBe('这个reactcomponent要部署到kubernetes向集群记得配cicdpipelinedockerimage推到registry');
    expect(r.refLen).toBe(94);
    expect(r.distance).toBe(27);
    expect(r.cer).toBeCloseTo(27 / 94, 10);
  });
});

describe('weightedCer', () => {
  it('Σ(w·CER) / Σw', () => {
    expect(
      weightedCer([
        { cer: 0.1, weight: 1 },
        { cer: 0.4, weight: 2 },
      ]),
    ).toBeCloseTo(0.3, 10);
  });

  it('跳过 cer 为 null 与权重为 0 的用例;全部不可用 → null', () => {
    expect(
      weightedCer([
        { cer: 0.2, weight: 1 },
        { cer: null, weight: 1 },
        { cer: 0.9, weight: 0 },
      ]),
    ).toBeCloseTo(0.2, 10);
    expect(weightedCer([{ cer: null, weight: 1 }])).toBeNull();
    expect(weightedCer([])).toBeNull();
  });
});
