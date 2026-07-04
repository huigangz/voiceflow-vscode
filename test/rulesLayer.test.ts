/**
 * S3a gate:轻清理规则全部通过测试集,零错改。
 * 分三组:该改的(正向)/ 不该改的(零错改)/ 开关独立性。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, applyRules } from '../src/cleanup/rulesLayer';

const OFF = {
  convertToSimplified: false,
  spacingCJKLatin: false,
  normalizePunctuation: false,
  collapseSpaces: false,
  stripHallucinations: false,
};

describe('规则层 — 正向清理', () => {
  it('中英之间加空格', () => {
    expect(applyRules('用React写组件', DEFAULT_RULES)).toBe('用 React 写组件');
    expect(applyRules('版本v2发布了', DEFAULT_RULES)).toBe('版本 v2 发布了');
    expect(applyRules('跑CI流程', DEFAULT_RULES)).toBe('跑 CI 流程');
  });

  it('繁体转简体', () => {
    expect(applyRules('這是繁體字測試', DEFAULT_RULES)).toBe('这是繁体字测试');
    expect(applyRules('程式執行完畢', DEFAULT_RULES)).toBe('程式执行完毕');
  });

  it('全角字母数字 → 半角', () => {
    expect(applyRules('版本ABC123', DEFAULT_RULES)).toBe('版本 ABC123');
  });

  it('汉字间半角标点 → 全角', () => {
    expect(applyRules('你好,世界', DEFAULT_RULES)).toBe('你好,世界');
    expect(applyRules('结束了.然后继续', DEFAULT_RULES)).toBe('结束了。然后继续');
    expect(applyRules('是吗?对!', DEFAULT_RULES)).toBe('是吗?对!');
  });

  it('去除重复空格并 trim(保留换行结构)', () => {
    expect(applyRules('hello   world  test', DEFAULT_RULES)).toBe('hello world test');
    expect(applyRules('  第一行  \n  第二行  ', DEFAULT_RULES)).toBe('第一行\n 第二行');
  });

  it('去除尾部幻觉(中英,含标点包裹与叠加)', () => {
    expect(applyRules('今天写了三个模块。谢谢观看', DEFAULT_RULES)).toBe('今天写了三个模块。');
    expect(applyRules('今天写了三个模块。 谢谢观看!', DEFAULT_RULES)).toBe('今天写了三个模块。');
    expect(applyRules('修复了登录 bug。Thanks for watching.', DEFAULT_RULES)).toBe('修复了登录 bug。');
    expect(applyRules('完成部署。谢谢大家。谢谢观看。', DEFAULT_RULES)).toBe('完成部署。');
    // 纯幻觉(静音误触发)→ 空
    expect(applyRules('谢谢观看', DEFAULT_RULES)).toBe('');
    expect(applyRules('字幕由Amara.org社区提供', DEFAULT_RULES)).toBe('');
    // gate 实测真实样本(2026-07-03,S2 冒烟静音输出)
    expect(applyRules('(字幕製作:貝爾)', DEFAULT_RULES)).toBe('');
    expect(applyRules('部署完成了。(字幕製作:貝爾)', DEFAULT_RULES)).toBe('部署完成了。');
  });

  it('中英混合综合场景(核心场景,§9.2 权重最高)', () => {
    expect(applyRules('我用Kubernetes部署了3个service,然后跑CI/CD流程', DEFAULT_RULES)).toBe(
      '我用 Kubernetes 部署了 3 个 service,然后跑 CI/CD 流程',
    );
  });
});

describe('规则层 — 零错改(不该动的绝不动)', () => {
  it('技术术语与代码保真', () => {
    for (const s of [
      'npm install @types/node',
      'git commit -m "fix: bug"',
      'const x = { a: 1, b: [2, 3] };',
      'https://example.com/path?q=1&r=2',
      'C:\\Users\\dev\\project',
      'file.test.ts',
    ]) {
      expect(applyRules(s, DEFAULT_RULES)).toBe(s);
    }
  });

  it('数字小数点/文件扩展名不被转全角(标点归一保护)', () => {
    expect(applyRules('版本是1.5', DEFAULT_RULES)).toBe('版本是 1.5');
    expect(applyRules('打开main.js文件', DEFAULT_RULES)).toBe('打开 main.js 文件');
    expect(applyRules('值是3,141', DEFAULT_RULES)).toBe('值是 3,141');
  });

  it('英文句子的标点不被动', () => {
    expect(applyRules('Hello, world. How are you?', DEFAULT_RULES)).toBe(
      'Hello, world. How are you?',
    );
  });

  it('正文中(非尾部)出现"谢谢观看"字样不被删', () => {
    expect(applyRules('把谢谢观看这四个字加到片尾', DEFAULT_RULES)).toBe(
      '把谢谢观看这四个字加到片尾',
    );
  });

  it('无括号的"字幕制作"合法短语不被删(署名幻觉规则只匹配带括号形态)', () => {
    expect(applyRules('我更新了字幕制作流程', DEFAULT_RULES)).toBe('我更新了字幕制作流程');
  });

  it('已符合规范的中文不变', () => {
    expect(applyRules('今天完成了 API 网关的重构,性能提升了 30%。', DEFAULT_RULES)).toBe(
      '今天完成了 API 网关的重构,性能提升了 30%。',
    );
  });

  it('空输入与纯空白 → 空串', () => {
    expect(applyRules('', DEFAULT_RULES)).toBe('');
    expect(applyRules('   ', DEFAULT_RULES)).toBe('');
  });
});

describe('规则层 — 开关独立性(F3.1 各规则可配置)', () => {
  it('全关 = 仅 trim,内容原样', () => {
    expect(applyRules('用React寫程式,谢谢观看', OFF)).toBe('用React寫程式,谢谢观看');
  });

  it('单开简繁', () => {
    expect(applyRules('寫程式', { ...OFF, convertToSimplified: true })).toBe('写程式');
  });

  it('单开间距', () => {
    expect(applyRules('用React寫', { ...OFF, spacingCJKLatin: true })).toBe('用 React 寫');
  });

  it('单开幻觉去除', () => {
    expect(applyRules('好的。谢谢观看', { ...OFF, stripHallucinations: true })).toBe('好的。');
  });

  it('单开标点归一', () => {
    expect(applyRules('你好,世界', { ...OFF, normalizePunctuation: true })).toBe('你好,世界');
  });
});
