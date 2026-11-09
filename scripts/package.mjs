/**
 * 生成过渡页「下载」区的三个产物（全程离线，只用本机已有缓存）
 *
 *   AlgoView-Setup-1.0.0.exe      NSIS 安装版
 *   AlgoView-Portable-1.0.0.zip   免安装绿色版（解压双击 AlgoView.exe）
 *   AlgoView-Web-Offline.zip      Web 离线包（需 Node 18+，双击 启动服务.cmd）
 *
 * 前置：npm run build / npm run desktop:compile 已执行；
 *      release/win-unpacked/ 里已有 Electron 运行时（第一次运行时本脚本会
 *      从 electron 的本地缓存 zip 自动解压）。
 *
 * 用法：npm run dist
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 个人主页根目录：从本脚本向上找"同时有 index.html 和 case/"的那一层。
 * 不写死目录名/层级，所以整套目录改名或搬走后仍能定位下载区。
 * 单独分发（把本仓库单独 clone 出去）时找不到，返回 null，产物落到本仓库的 artifacts/。
 */
function findSiteDir(start) {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    dir = path.dirname(dir);
    if (fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'case'))) return dir;
  }
  return null;
}
const SITE = findSiteDir(ROOT);
const REL = path.join(ROOT, 'release');
const WIN = path.join(REL, 'win-unpacked');
const APP = path.join(WIN, 'resources', 'app');
const WEB = path.join(REL, 'web-offline', 'AlgoView-Web-Offline');
/** 有个人主页就写进它的下载目录；单独 clone 时写进本仓库 artifacts/ */
const OUT = SITE ? path.join(SITE, 'case', 'algo', 'downloads') : path.join(ROOT, 'artifacts');
const INSTALLER_NSI = path.join(ROOT, 'build', 'installer.nsi');
const LOCAL = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');

const log = (s) => console.log('  ' + s);
const need = (p, msg) => { if (!fs.existsSync(p)) { console.error('缺少 ' + (msg || p)); process.exit(1); } };

/** 在缓存目录里按文件名找工具，避免把绝对路径写死 */
function findTool(baseDir, fileName) {
  if (!fs.existsSync(baseDir)) return null;
  const queue = [{ dir: baseDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 4) continue;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    if (names.includes(fileName)) return path.join(dir, fileName);
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isDirectory()) queue.push({ dir: p, depth: depth + 1 }); } catch { /* ignore */ }
    }
  }
  return null;
}
const BUILDER_CACHE = path.join(LOCAL, 'electron-builder', 'Cache');
const ELECTRON_CACHE = path.join(LOCAL, 'electron', 'Cache');
const Z7 = findTool(BUILDER_CACHE, '7za.exe');
const NSIS = findTool(BUILDER_CACHE, 'makensis.exe');

need(path.join(ROOT, 'dist', 'index.html'), 'dist/index.html —— 先跑 npm run build');
need(path.join(ROOT, 'electron', 'out', 'main.cjs'), 'electron/out/main.cjs —— 先跑 npm run desktop:compile');
if (!Z7 || !NSIS) { console.error('找不到本机 7za / makensis 缓存，无法离线打包'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
log('7za     ' + Z7);
log('makensis ' + NSIS);

/** 递归复制目录（先清目标，避免上次的嵌套副本残留） */
function sync(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

/* ── 1. Electron 运行时 ─────────────────────────────── */
if (!fs.existsSync(path.join(WIN, 'AlgoView.exe'))) {
  let zip = null;
  if (fs.existsSync(ELECTRON_CACHE)) {
    for (const d of fs.readdirSync(ELECTRON_CACHE)) {
      const p = path.join(ELECTRON_CACHE, d);
      try {
        const f = fs.readdirSync(p).find((n) => /^electron-v.*-win32-x64\.zip$/.test(n));
        if (f) { zip = path.join(p, f); break; }
      } catch { /* ignore */ }
    }
  }
  if (!zip) { console.error('找不到 electron-v*-win32-x64.zip 缓存，无法离线打包'); process.exit(1); }
  log('解压 Electron 运行时（第一次会比较久）…');
  fs.mkdirSync(WIN, { recursive: true });
  execFileSync(Z7, ['x', zip, '-o' + WIN, '-y'], { stdio: 'ignore' });
  const exe = path.join(WIN, 'electron.exe');
  if (fs.existsSync(exe)) fs.renameSync(exe, path.join(WIN, 'AlgoView.exe'));
}
need(path.join(WIN, 'AlgoView.exe'), 'release/win-unpacked/AlgoView.exe');

/* ── 2. 组装 resources/app 与 resources/runtime ─────── */
log('同步前端 / 追踪器 / 执行引擎 → resources/app');
fs.mkdirSync(APP, { recursive: true });
sync(path.join(ROOT, 'dist'), path.join(APP, 'dist'));
sync(path.join(ROOT, 'server'), path.join(APP, 'server'));
sync(path.join(ROOT, 'runtime'), path.join(APP, 'runtime'));
sync(path.join(ROOT, 'electron', 'out'), path.join(APP, 'electron', 'out'));
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
  name: 'algoview', productName: '算法视界', version: '1.0.0', private: true,
  main: 'electron/out/main.cjs',
}) + '\n');
sync(path.join(ROOT, 'runtime'), path.join(WIN, 'resources', 'runtime'));  // app.isPackaged 走这里
log('桌面目录就绪');

/* ── 3. Web 离线包内容 ─────────────────────────────── */
fs.mkdirSync(WEB, { recursive: true });
sync(path.join(ROOT, 'dist'), path.join(WEB, 'dist'));
sync(path.join(ROOT, 'server'), path.join(WEB, 'server'));
sync(path.join(ROOT, 'runtime'), path.join(WEB, 'runtime'));
fs.writeFileSync(path.join(WEB, 'package.json'), '{"name":"algoview-web-offline","version":"1.0.0","private":true}\n');
fs.writeFileSync(path.join(WEB, '启动服务.cmd'), [
  '@echo off', 'setlocal', 'cd /d "%~dp0"', 'title AlgoView - Local Service', '',
  'where node >nul 2>nul', 'if errorlevel 1 goto NONODE', '',
  'if not exist "dist\\index.html" goto NOBUILD', '',
  'echo   Server: http://127.0.0.1:5321/', 'echo   Keep this window open while using the app.', 'echo.',
  'node server\\bridge.cjs', 'echo.', 'pause >nul', 'exit /b 0', '',
  ':NONODE', 'echo   [x] Node.js 18+ not found. Install it from https://nodejs.org', 'echo.', 'pause', 'exit /b 1', '',
  ':NOBUILD', 'echo   [x] dist\\index.html is missing. The package is incomplete.', 'echo.', 'pause', 'exit /b 1', '',
].join('\r\n'));
fs.writeFileSync(path.join(WEB, 'README.md'), [
  '# 算法视界 AlgoView · Web 离线包 v1.0.0', '',
  '无需 npm install、无需联网。已包含构建好的前端、本地服务与三套追踪器。', '',
  '## 启动', '1. 安装 Node.js 18+；2. 双击 `启动服务.cmd` 并保持窗口开着；',
  '3. 浏览器打开 http://127.0.0.1:5321/ 。', '',
  '本包不含个人主页与过渡页，所以根路径会直接落到算法视界应用。', '',
  '## 语言工具链（按需）',
  '- Python 3.8+ / JDK 8+（`javac`、`java` 在 PATH）/ MinGW-w64（`gcc`、`g++`、`gdb`）。',
  '- 启动窗口会打印四种语言是否就绪；缺哪个只影响那一门。', '',
  '服务只监听 127.0.0.1:5321，代码在本机执行，不上传。',
].join('\n'));

/* ── 4. 三个产物 ───────────────────────────────────── */
function zip(outFile, cwd) {
  const target = path.join(OUT, outFile);
  execFileSync(Z7, ['a', '-tzip', '-mx=3', '-y', target, './*'], { cwd, stdio: 'ignore' });
  log(outFile + '  ' + (fs.statSync(target).size / 1048576).toFixed(1) + ' MB');
}
log('打包 Web 离线包…');
zip('AlgoView-Web-Offline.zip', WEB);
log('打包绿色版（367MB，稍等）…');
zip('AlgoView-Portable-1.0.0.zip', WIN);
log('生成 NSIS 安装包（LZMA 压缩最慢，约 6 分钟）…');
need(INSTALLER_NSI, 'build/installer.nsi');
// NSIS 用系统代码页读脚本，命令行里的中文路径会被读坏：
// 把脚本临时复制到 release/ 再以它为工作目录运行，脚本里的相对路径就都成立，
// 全程不传任何绝对路径。
const nsiTemp = path.join(REL, 'installer.nsi');
fs.copyFileSync(INSTALLER_NSI, nsiTemp);
try {
  execFileSync(NSIS, ['installer.nsi'], { cwd: REL, stdio: 'inherit' });
} finally {
  fs.rmSync(nsiTemp, { force: true });
}
const setup = path.join(REL, 'AlgoView-Setup-1.0.0.exe');
need(setup, 'NSIS 输出');
fs.copyFileSync(setup, path.join(OUT, 'AlgoView-Setup-1.0.0.exe'));
log('AlgoView-Setup-1.0.0.exe  ' + (fs.statSync(setup).size / 1048576).toFixed(1) + ' MB');

console.log('\n完成 → ' + OUT);
