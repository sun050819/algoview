/**
 * 本机编译/调试工具链定位（C/C++ 用）
 *
 * 目标：不写死任何盘符、用户名、安装路径，换机器、换盘、搬目录都能自己找到。
 *
 * 顺序：
 *   1. 环境变量显式指定：DSA_MINGW_DIR / DSA_GCC / DSA_GDB
 *   2. PATH（where / which）
 *   3. 各固定盘根目录下的"常规安装布局"——Dev-C++、MSYS2、MinGW-w64 装完后的默认相对位置
 *
 * 第 3 步是遍历盘符 + 相对布局，而不是写死 "D:\dev c++\..."：
 * 机器上装在哪块盘都能命中，也不含用户名。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';

/** 各盘根目录下的常见布局（相对路径） */
const LAYOUTS = [
  ['dev c++', 'MinGW64', 'bin'],
  ['dev c++', 'MinGW', 'bin'],
  ['Dev-Cpp', 'MinGW64', 'bin'],
  ['msys64', 'mingw64', 'bin'],
  ['mingw64', 'bin'],
  ['MinGW', 'bin'],
  ['MinGW-w64', 'bin'],
];

/** 候选目录：按优先级排列 */
function hintDirs() {
  const env = process.env;
  const out = [];
  if (env.DSA_MINGW_DIR) out.push(env.DSA_MINGW_DIR);

  const pf = env.ProgramFiles || (env.SystemDrive || 'C:') + path.sep + 'Program Files';
  const pf86 = env['ProgramFiles(x86)'];
  out.push(path.join(pf, 'mingw-w64', 'bin'), path.join(pf, 'mingw64', 'bin'));
  if (pf86) out.push(path.join(pf86, 'mingw-w64', 'bin'));
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'Dev-Cpp', 'MinGW64', 'bin'));

  if (IS_WIN) {
    for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const root = String.fromCharCode(c) + ':\\';
      let exists = false;
      try { exists = fs.existsSync(root); } catch { /* 无此盘 */ }
      if (!exists) continue;
      for (const layout of LAYOUTS) out.push(path.join(root, ...layout));
    }
  }
  return out;
}

/** PATH 优先，其次候选目录；找到返回绝对路径，否则 null */
function which(cmd) {
  const probe = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  if (IS_WIN) {
    for (const dir of hintDirs()) {
      for (const ext of ['.exe', '']) {
        const p = path.join(dir, cmd + ext);
        try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
      }
    }
  }
  return null;
}

module.exports = { hintDirs, which, IS_WIN };
