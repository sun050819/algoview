/**
 * 找一个可用的 Chromium 浏览器跑 CDP 脚本。
 *
 * 顺序：环境变量 CHROME → puppeteer 缓存 → 常见安装位置。
 * 不写死盘符/用户名/版本号，换机器、换版本都不用改代码。
 *
 *   CHROME="<浏览器可执行文件的完整路径>" node scripts/e2e.mjs ...
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WIN = process.platform === 'win32';

function scanFor(dir, fileName, maxDepth = 5) {
  if (!fs.existsSync(dir)) return null;
  const queue = [{ dir, depth: 0 }];
  while (queue.length) {
    const { dir: d, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    if (names.includes(fileName)) return path.join(d, fileName);
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isDirectory()) queue.push({ dir: p, depth: depth + 1 }); } catch { /* ignore */ }
    }
  }
  return null;
}

const CACHE_HINTS = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'puppeteer'),
  path.join(os.homedir(), '.cache', 'puppeteer'),
  path.join(os.homedir(), '.cache', 'ms-playwright'),
].filter(Boolean);

const INSTALL_HINTS = [
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);

/** 返回浏览器可执行文件路径；找不到时抛出带提示的错误 */
export function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;

  const names = WIN ? ['chrome-headless-shell.exe', 'chrome.exe', 'msedge.exe'] : ['chrome-headless-shell', 'chrome'];
  for (const base of CACHE_HINTS) {
    for (const n of names) {
      const hit = scanFor(base, n);
      if (hit) return hit;
    }
  }
  for (const p of INSTALL_HINTS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    '找不到 Chromium 浏览器。装一个 Chrome/Edge，或用环境变量指定：\n' +
    '  CHROME="<浏览器可执行文件路径>" node ' + process.argv[1],
  );
}

export const HEADLESS_ARGS = (port, W, H) => [
  '--headless', `--remote-debugging-port=${port}`, '--hide-scrollbars',
  '--disable-gpu', '--allow-file-access-from-files', '--force-device-scale-factor=1',
  `--window-size=${W},${H}`, 'about:blank',
];
