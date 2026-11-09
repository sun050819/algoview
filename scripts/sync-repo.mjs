/**
 * 把工作副本（algoview/）里"必须两边一致"的源码同步到发布仓库（../github/algoview/）。
 *
 * 为什么需要它：应用有两份目录 ——
 *   algoview/         开发副本，额外带 server/site.cjs（顺便托管个人主页）
 *   github/algoview/  发布仓库，独立分发，不含个人主页相关的一切
 * 手改两边必然漂移（之前 server/bridge.cjs 就有三份不同版本）。
 * 这里把"共享的源码"单向覆盖过去，KEEP 里的文件属于各自目录的定制，永不覆盖。
 *
 * 用法：
 *   node scripts/sync-repo.mjs            只比对，列出会变动的文件
 *   node scripts/sync-repo.mjs --write    真正写入
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..', 'github', 'algoview');
const WRITE = process.argv.includes('--write');

/** 两边共享的源码/配置（目录或文件，相对路径） */
const SHARED = [
  'runtime',
  'server',
  'src',
  'electron',
  'build',
  'scripts',
  'public',
  'index.html',
  'start.cmd',
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
];

/** 各自定制或生成物，绝不覆盖 */
const KEEP = new Set([
  'README.md',                       // 仓库版另有面向开源读者的写法
  'docs',                            // 仓库自带的截图目录
  'LICENSE',
  '.editorconfig',
  '.gitattributes',
  'server/site.cjs',                 // 只有开发副本有：托管个人主页
  'src/languages/localBridge.ts',    // 提示文案按"仓库 / 离线包"措辞
  'scripts/verify-links.mjs',        // 本地站点专用
]);
/** 生成物目录（任何层级出现都跳过） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'out', '.cache', 'artifacts', '.git']);

if (!fs.existsSync(REPO)) {
  console.error('找不到发布仓库目录：' + REPO);
  process.exit(1);
}

const rootPosix = ROOT.split(path.sep).join('/');
const copies = [];

function walk(abs, rel) {
  if (KEEP.has(rel) || SKIP_DIRS.has(path.basename(abs))) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), rel + '/' + name);
    return;
  }
  const target = path.join(REPO, rel);
  if (!fs.existsSync(target) || !fs.readFileSync(abs).equals(fs.readFileSync(target))) copies.push(rel);
}

for (const rel of SHARED) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) walk(abs, rel);
}

if (copies.length === 0) {
  console.log('已一致，无需同步。（KEEP 里的文件按设计不参与比对）');
  process.exit(0);
}

console.log((WRITE ? '写入 ' : '将变动 ') + copies.length + ' 个文件：');
for (const rel of copies) console.log('  ' + rel);

if (WRITE) {
  for (const rel of copies) {
    const from = path.join(ROOT, rel);
    const to = path.join(REPO, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  console.log('\n完成。下一步：');
  console.log('  git -C "' + REPO + '" add -A');
  console.log('  git -C "' + REPO + '" commit -m "sync: …"');
} else {
  console.log('\n加 --write 才会真正写入。');
}
console.log('\n（工作副本根：' + rootPosix + '）');
