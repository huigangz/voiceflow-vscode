/**
 * CLAUDE.md 机械事实校验(harness PR4 §9.8)—— 只查机械事实,不判断语义是否正确。
 *
 * ① 路径引用:行内代码(反引号)里形如仓库路径的引用
 *    - 普通引用 → 必须被 git 跟踪(`git ls-files`:文件本身,或作为目录前缀)。
 *      用 git 而不是 fs.existsSync:本机有、clean clone 没有的文件会造成本机绿 / CI 红。
 *    - 紧跟 `(local-only)` 的引用 → 跳过存在性检查,但必须是 gitignored 且未被跟踪
 *      (防止把真实缺失的仓库文件标成 local-only 逃过检查)。
 * ② src 顶层结构:`<!-- doc-check:src-layout … -->` … `<!-- /doc-check:src-layout -->` 区块里
 *    列出的 `src/…` 条目必须与仓库 src/ 顶层条目**完全相等**(多、少都失败)。
 *
 * 用法:node scripts/verify-doc-structure.mjs [CLAUDE.md]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PATH_EXT = /\.(md|ts|mts|mjs|cjs|js|json|ya?ml|cs)$/;
const LOCAL_ONLY = /^\s*\(local-only\)/;
const LAYOUT_OPEN = /<!--\s*doc-check:src-layout\b/;
const LAYOUT_CLOSE = /<!--\s*\/doc-check:src-layout\s*-->/;

/** 行内代码内容是否像仓库路径:无空白 / glob / 锚点 / 赋值,且含 `/` 或以常见源码文档扩展名结尾。 */
export function isPathLike(code) {
  if (!code || /[\s*?[\]{}#=:<>|"'`(),]/.test(code)) return false;
  if (code.startsWith('-') || code.startsWith('~')) return false;
  if (!/^[A-Za-z0-9._@/-]+$/.test(code)) return false;
  return code.includes('/') || PATH_EXT.test(code);
}

/**
 * 抽取行内代码中的路径引用(跳过 ``` 围栏代码块)。
 * @returns {{ path: string, localOnly: boolean, line: number }[]}
 */
export function extractPathRefs(markdown) {
  const refs = [];
  let fenced = false;
  markdown.split(/\r?\n/).forEach((text, i) => {
    if (/^\s*```/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const code = m[1].trim();
      if (!isPathLike(code)) continue;
      const after = text.slice(m.index + m[0].length);
      refs.push({ path: code.replace(/^\.\//, ''), localOnly: LOCAL_ONLY.test(after), line: i + 1 });
    }
  });
  return refs;
}

/** 路径是否被 git 跟踪:文件本身,或作为目录前缀。 */
export function isTracked(path, tracked) {
  const p = path.replace(/\/+$/, '');
  if (tracked.has(p)) return true;
  const prefix = `${p}/`;
  for (const f of tracked) if (f.startsWith(prefix)) return true;
  return false;
}

/**
 * @param {{ path: string, localOnly: boolean, line: number }[]} refs
 * @param {{ tracked: Set<string>, isIgnored: (path: string) => boolean }} repo
 * @returns {string[]}
 */
export function checkPathRefs(refs, { tracked, isIgnored }) {
  const errors = [];
  for (const r of refs) {
    const where = `L${r.line} \`${r.path}\``;
    if (r.localOnly) {
      if (isTracked(r.path, tracked)) errors.push(`[path] ${where} 标了 (local-only) 却被 git 跟踪 —— 去掉标注`);
      else if (!isIgnored(r.path)) errors.push(`[path] ${where} 标了 (local-only) 但不在 .gitignore 范围内 —— 是缺失的仓库文件?`);
    } else if (!isTracked(r.path, tracked)) {
      errors.push(`[path] ${where} 不在仓库中(git ls-files)—— 修正路径,或确属本地文档则标注 (local-only)`);
    }
  }
  return errors;
}

/**
 * 抽取 src-layout 区块里的 `src/…` 条目。标记缺失 / 不成对 / 重复 → errors。
 * @returns {{ entries: string[], errors: string[] }}
 */
export function extractSrcLayout(markdown) {
  const lines = markdown.split(/\r?\n/);
  const opens = lines.flatMap((l, i) => (LAYOUT_OPEN.test(l) ? [i] : []));
  const closes = lines.flatMap((l, i) => (LAYOUT_CLOSE.test(l) ? [i] : []));
  if (opens.length !== 1 || closes.length !== 1 || closes[0] < opens[0]) {
    return { entries: [], errors: [`[src-layout] 需要恰好一对 doc-check:src-layout 标记(开 ${opens.length} / 闭 ${closes.length})`] };
  }
  const entries = [];
  for (const l of lines.slice(opens[0] + 1, closes[0])) {
    for (const m of l.matchAll(/`(src\/[^`\s]*)`/g)) entries.push(m[1]);
  }
  return { entries, errors: [] };
}

/** 仓库 src/ 顶层条目:目录写成 `src/x/`,文件写成 `src/x.ts`。 */
export function srcTopLevel(trackedFiles) {
  const set = new Set();
  for (const f of trackedFiles) {
    if (!f.startsWith('src/')) continue;
    const rest = f.slice('src/'.length).split('/');
    set.add(rest.length > 1 ? `src/${rest[0]}/` : `src/${rest[0]}`);
  }
  return set;
}

/** @returns {string[]} */
export function checkSrcLayout(entries, trackedFiles) {
  const errors = [];
  const listed = new Set(entries);
  const actual = srcTopLevel(trackedFiles);
  for (const e of entries.filter((e, i) => entries.indexOf(e) !== i)) errors.push(`[src-layout] 重复条目 ${e}`);
  for (const a of [...actual].sort()) if (!listed.has(a)) errors.push(`[src-layout] 仓库有而文档未列: ${a}`);
  for (const l of [...listed].sort()) if (!actual.has(l)) errors.push(`[src-layout] 文档列了而仓库没有: ${l}(目录须以 / 结尾)`);
  return errors;
}

/**
 * 路径是否被 .gitignore 覆盖。**保留尾部 `/`**:目录型规则(如 `worklog/`)在路径不存在时
 * (clean clone / CI)只对带尾斜杠的查询生效;去掉斜杠 → git 不知道它是目录 → 判"未忽略"
 * (本机目录存在所以绿、CI 红 —— PR4 首跑实测)。
 */
export function gitIgnored(root, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---- CLI ----
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const docPath = process.argv[2] ?? 'CLAUDE.md';
  const markdown = readFileSync(resolve(root, docPath), 'utf8');
  const git = (args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
  const tracked = new Set(git(['ls-files', '-z']).split('\0').filter(Boolean));
  const isIgnored = (p) => gitIgnored(root, p);

  const refs = extractPathRefs(markdown);
  const layout = extractSrcLayout(markdown);
  const errors = [...checkPathRefs(refs, { tracked, isIgnored }), ...layout.errors, ...checkSrcLayout(layout.entries, tracked)];
  if (layout.errors.length === 0 && layout.entries.length === 0) errors.push('[src-layout] 区块内没有任何 `src/…` 条目');

  if (errors.length > 0) {
    console.error(`[verify-doc-structure] FAIL —— ${docPath}`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const localOnly = refs.filter((r) => r.localOnly).length;
  console.log(
    `[verify-doc-structure] OK —— ${docPath}:路径引用 ${refs.length} 个(local-only ${localOnly})、src 顶层 ${layout.entries.length} 项与仓库一致`,
  );
}
