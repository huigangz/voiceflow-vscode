import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

// 测试文件按 CommonJS 编译,静态 import .mjs 会被 tsc 拒绝 → 动态加载(同 packageContract.test.ts)
type Mod = typeof import('../scripts/verify-doc-structure.mjs', { with: { 'resolution-mode': 'import' } });
let isPathLike: Mod['isPathLike'];
let extractPathRefs: Mod['extractPathRefs'];
let checkPathRefs: Mod['checkPathRefs'];
let extractSrcLayout: Mod['extractSrcLayout'];
let checkSrcLayout: Mod['checkSrcLayout'];
let srcTopLevel: Mod['srcTopLevel'];
let gitIgnored: Mod['gitIgnored'];
beforeAll(async () => {
  ({ isPathLike, extractPathRefs, checkPathRefs, extractSrcLayout, checkSrcLayout, srcTopLevel, gitIgnored } = await import(
    '../scripts/verify-doc-structure.mjs'
  ));
});

const tracked = new Set(['src/extension.ts', 'src/session.ts', 'src/audio/recorder.ts', 'src/stt/engine.ts', 'docs/history.md', 'package.json']);
const ignored = new Set(['docs/plans', 'worklog']);
const repo = { tracked, isIgnored: (p: string) => ignored.has(p.replace(/\/+$/, '')) };

describe('路径引用识别', () => {
  it('像路径的才算:含 / 或源码/文档扩展名;配置键、命令、glob、URL 片段不算', () => {
    for (const p of ['src/audio/', 'docs/history.md', 'package.json', 'bin.manifest.json', '.github/workflows/ci.yml', 'helper/MicCapture.cs']) {
      expect(isPathLike(p), p).toBe(true);
    }
    for (const p of [
      'voiceflow.insert.typeIntoFocusedInput',
      'npm run build',
      'offline-model/**',
      'microsoft/vscode#250568',
      'sendText(text, false)',
      'Ctrl+Alt+L',
      'mode=inprocess',
      'extensionKind: ["ui"]',
      'module-unavailable',
      'voiceflow-audio.node',
    ]) {
      expect(isPathLike(p), p).toBe(false);
    }
  });

  it('抽取行号与 (local-only) 标注;跳过围栏代码块', () => {
    const md = ['见 `docs/plans/` (local-only) 与 `src/session.ts`。', '```', '`src/ghost.ts`', '```', '`worklog/`(local-only)'].join('\n');
    expect(extractPathRefs(md)).toEqual([
      { path: 'docs/plans/', localOnly: true, line: 1 },
      { path: 'src/session.ts', localOnly: false, line: 1 },
      { path: 'worklog/', localOnly: true, line: 5 },
    ]);
  });
});

describe('路径引用校验', () => {
  const ref = (path: string, localOnly = false) => ({ path, localOnly, line: 1 });

  it('跟踪的文件 / 目录前缀通过;不存在的仓库路径失败', () => {
    expect(checkPathRefs([ref('src/audio/'), ref('src/audio'), ref('src/session.ts'), ref('package.json')], repo)).toEqual([]);
    const errs = checkPathRefs([ref('src/ghost.ts'), ref('src/aud/')], repo);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatch(/不在仓库中/);
  });

  it('目录前缀必须按路径段匹配(src/audi 不能借 src/audio/ 通过)', () => {
    expect(checkPathRefs([ref('src/audi')], repo)).toHaveLength(1);
  });

  it('(local-only) 必须是 gitignored 且未跟踪 —— 缺失的仓库文件不能靠标注逃过', () => {
    expect(checkPathRefs([ref('docs/plans/', true), ref('worklog/', true)], repo)).toEqual([]);
    expect(checkPathRefs([ref('docs/nope.md', true)], repo)[0]).toMatch(/不在 \.gitignore 范围内/);
    expect(checkPathRefs([ref('docs/history.md', true)], repo)[0]).toMatch(/却被 git 跟踪/);
  });
});

describe('src 顶层结构', () => {
  const block = (lines: string[]) => ['前文 `src/other/`', '<!-- doc-check:src-layout 注释 -->', ...lines, '<!-- /doc-check:src-layout -->'].join('\n');

  it('只取区块内的 src 条目', () => {
    expect(extractSrcLayout(block(['- `src/audio/` — x', '- `src/session.ts`、`src/stt/`']))).toEqual({
      entries: ['src/audio/', 'src/session.ts', 'src/stt/'],
      errors: [],
    });
  });

  it('标记缺失 / 重复 / 顺序颠倒 → 报错', () => {
    expect(extractSrcLayout('`src/audio/`').errors).toHaveLength(1);
    expect(extractSrcLayout(block([]) + '\n' + block([])).errors).toHaveLength(1);
    expect(extractSrcLayout('<!-- /doc-check:src-layout -->\n<!-- doc-check:src-layout -->').errors).toHaveLength(1);
  });

  it('顶层集合:目录带 /,文件不带', () => {
    expect([...srcTopLevel(tracked)].sort()).toEqual(['src/audio/', 'src/extension.ts', 'src/session.ts', 'src/stt/']);
  });

  it('多列、漏列、目录漏写 /、重复 → 各自报错', () => {
    const exact = ['src/audio/', 'src/extension.ts', 'src/session.ts', 'src/stt/'];
    expect(checkSrcLayout(exact, tracked)).toEqual([]);
    expect(checkSrcLayout(exact.filter((e) => e !== 'src/stt/'), tracked)).toEqual(['[src-layout] 仓库有而文档未列: src/stt/']);
    expect(checkSrcLayout([...exact, 'src/ghost/'], tracked)).toEqual(['[src-layout] 文档列了而仓库没有: src/ghost/(目录须以 / 结尾)']);
    expect(checkSrcLayout(exact.map((e) => (e === 'src/stt/' ? 'src/stt' : e)), tracked)).toHaveLength(2);
    expect(checkSrcLayout([...exact, 'src/audio/'], tracked)).toEqual(['[src-layout] 重复条目 src/audio/']);
  });
});

describe('真实仓库', () => {
  it('回归(PR4 CI 首跑):目录型 ignore 规则对不存在的目录也能判定 —— 必须保留尾部 /', () => {
    // .vscode-test/ 在 .gitignore 里是目录型规则,且平时不存在(与 clean clone 里的 worklog/ 同一处境)
    expect(gitIgnored(process.cwd(), '.vscode-test/')).toBe(true);
    expect(gitIgnored(process.cwd(), 'worklog/')).toBe(true);
    expect(gitIgnored(process.cwd(), 'docs/plans/')).toBe(true);
    expect(gitIgnored(process.cwd(), 'src/')).toBe(false);
  });

  it('CLAUDE.md 通过机械检查(路径引用 + src 顶层结构)', () => {
    const out = execFileSync(process.execPath, ['scripts/verify-doc-structure.mjs'], { encoding: 'utf8' });
    expect(out).toMatch(/OK —— CLAUDE\.md/);
  });
});
