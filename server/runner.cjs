/**
 * 本地真实执行引擎（纯 Node，不依赖 Electron）
 *
 * 与 electron/main.ts 里的三条 runtime 逻辑同源，但彻底解耦：
 *   - Python : python runtime/python-tracer.py（sys.settrace）
 *   - Java   : javac -g → JDWP JVM → JavaTracer（JDI）
 *   - C/C++  : gcc/g++ -g -O0 → gdb-tracer.mjs（GDB/MI2）
 *
 * 同时被两个宿主复用：
 *   1. 桌面版（Electron 主进程）——如果想统一，可直接 require 本文件
 *   2. 浏览器版的本地执行服务 server/bridge.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PY_TIMEOUT_MS = 15000;
const JAVA_TIMEOUT_MS = 20000;
const CC_TIMEOUT_MS = 40000;

/* ────────────────────────── 工具链探测 ────────────────────────── */
// 统一由 runtime/toolchain.cjs 负责：显式环境变量 → PATH → 各盘常规布局。
// 这里不写任何盘符/用户名，换机器和搬目录都不需要改代码。
const toolchain = require('../runtime/toolchain.cjs');

function whichSync(cmd) {
  return toolchain.which(cmd);
}

/** 报告本机可用的执行能力，供 UI 显示"引擎就绪"状态 */
function preflight() {
  const py = whichSync('python') || whichSync('python3');
  const javac = whichSync('javac');
  const java = whichSync('java');
  const gcc = whichSync('gcc');
  const gpp = whichSync('g++');
  const gdb = whichSync('gdb');
  return {
    python: { ok: !!py, path: py },
    java: { ok: !!(javac && java), javac, java },
    c: { ok: !!(gcc && gdb), gcc, gdb },
    cpp: { ok: !!(gpp && gdb), gpp, gdb },
  };
}

/* ────────────────────────── 公共解析 ────────────────────────── */

function sliceBetween(text, startMark, endMark) {
  const a = text.indexOf(startMark);
  if (a < 0) return '';
  const b = text.indexOf(endMark, a + startMark.length);
  if (b < 0) return '';
  return text.slice(a + startMark.length, b);
}

function parseEventLines(body) {
  const events = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.type === 'string') events.push(obj);
    } catch { /* 跳过损坏行 */ }
  }
  return events;
}

/* ────────────────────────── Python ────────────────────────── */

function runPython(code, runtimeDir) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tp = path.join(runtimeDir, 'python-tracer.py');
    if (!fs.existsSync(tp)) {
      resolve({ events: [], output: '', error: '缺少 runtime/python-tracer.py', timeMs: 0 });
      return;
    }
    const py = whichSync('python') || whichSync('python3') || 'python';
    let child;
    try {
      child = spawn(py, [tp], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8:replace' },
      });
    } catch (err) {
      resolve({ events: [], output: '', error: '无法启动 Python：' + String(err), timeMs: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, PY_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ events: [], output: '', error: '无法启动 Python：' + err.message, timeMs: Date.now() - started });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      let error = null;
      const errLine = stdout.split('\n').find((l) => l.startsWith('__ERROR__'));
      if (errLine) error = errLine.slice('__ERROR__'.length).trim();
      const events = parseEventLines(sliceBetween(stdout, '__EVENTS_START__', '__EVENTS_END__'));
      const output = sliceBetween(stdout, '__OUTPUT_START__', '__OUTPUT_END__');
      if (!error && stderr.trim()) error = stderr.trim().slice(0, 800);
      if (!error && exitCode !== 0 && events.length === 0) error = `Python 进程退出（代码 ${exitCode}）`;
      resolve({ events, output, error, timeMs: Date.now() - started });
    });
    try { child.stdin.write(code); child.stdin.end(); } catch { /* ignore */ }
  });
}

/* ────────────────────────── Java ────────────────────────── */

function extractJavaClasses(code) {
  const classNames = [...code.matchAll(/(?:public\s+|abstract\s+|final\s+)?class\s+(\w+)/g)].map((m) => m[1]);
  const uniq = [...new Set(classNames)];
  if (uniq.length === 0) return { file: 'Main.java', main: 'Main', filters: ['Main'] };
  let main = uniq[0];
  const mainIdx = code.search(/static\s+void\s+main\s*\(/);
  if (mainIdx >= 0) {
    const before = code.slice(0, mainIdx);
    let lastClass = '';
    for (const m of before.matchAll(/class\s+(\w+)/g)) lastClass = m[1];
    if (lastClass && uniq.includes(lastClass)) main = lastClass;
  }
  const pub = code.match(/public\s+class\s+(\w+)/);
  const file = pub ? pub[1] + '.java' : 'Main.java';
  return { file, main, filters: uniq };
}

function runJava(code, runtimeDir) {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (events, output, error) => resolve({ events, output, error, timeMs: Date.now() - started });

    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-java-'));
    const children = [];
    let timer;

    const safeRead = (p) => { try { return fs.readFileSync(p, 'utf8').slice(0, 200000); } catch { return ''; } };
    const cleanOut = (buf) => buf.split('\n').filter((l) => !/Listening for transport dt_socket/.test(l)).join('\n').trim().slice(0, 200000);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
    };

    const { file, main, filters } = extractJavaClasses(code);
    const srcPath = path.join(tmpdir, file);
    const outPath = path.join(tmpdir, 'out.txt');
    try { fs.writeFileSync(srcPath, code, 'utf8'); } catch (err) { done([], '', '写入源码失败：' + String(err)); return; }

    const javac = whichSync('javac') || 'javac';
    const java = whichSync('java') || 'java';

    const compile = spawn(javac, ['-g', '-encoding', 'UTF-8', '-d', tmpdir, srcPath], { windowsHide: true });
    children.push(compile);
    let jerr = '';
    compile.stderr.on('data', (d) => { jerr += d; });
    compile.on('error', (e) => { done([], '', '无法启动 javac：' + e.message); cleanup(); });
    compile.on('close', (javacCode) => {
      if (javacCode !== 0) { done([], '', '编译失败：\n' + jerr.slice(0, 1500)); cleanup(); return; }

      const jvm = spawn(java, [
        '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
        '-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=0',
        '-cp', tmpdir, main,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(jvm);

      let jvmErr = '';
      let stdoutBuf = '';
      let port = 0;
      const parsePort = (chunk) => {
        const m = chunk.match(/address:\s*(\d+)/);
        if (m && !port) port = parseInt(m[1], 10);
      };
      jvm.stdout.on('data', (d) => { stdoutBuf += d; parsePort(String(d)); });
      jvm.stderr.on('data', (d) => { jvmErr += d; parsePort(String(d)); });
      jvm.on('error', (e) => { done([], '', '无法启动 java：' + e.message); cleanup(); });
      jvm.on('close', (jvmCode) => {
        if (port === 0) {
          done([], cleanOut(stdoutBuf), 'Java 运行失败：' + jvmErr.trim().slice(0, 500) + (jvmCode !== null ? `（退出码 ${jvmCode}）` : ''));
          cleanup();
        } else {
          try { fs.writeFileSync(outPath, cleanOut(stdoutBuf), 'utf8'); } catch { /* ignore */ }
        }
      });

      const waitPort = (deadline) => (port
        ? Promise.resolve(port)
        : new Promise((r) => {
          if (Date.now() > deadline) return r(0);
          setTimeout(() => waitPort(deadline).then(r), 80);
        }));

      void waitPort(Date.now() + 8000).then((readyPort) => {
        if (!readyPort) {
          done([], safeRead(outPath), '无法获取 JDWP 调试端口：' + jvmErr.trim().slice(0, 500));
          cleanup();
          return;
        }
        const tracer = spawn(java, ['-cp', runtimeDir, 'JavaTracer', String(readyPort), '50000', '8000', filters.join(',')], {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(tracer);
        let tstdout = '';
        let terr = '';
        tracer.stdout.on('data', (d) => { tstdout += d; });
        tracer.stderr.on('data', (d) => { terr += d; });
        tracer.on('error', (e) => { done([], safeRead(outPath), '无法启动 JavaTracer：' + e.message); cleanup(); });
        tracer.on('close', () => {
          const events = parseEventLines(sliceBetween(tstdout, '__EVENTS_START__', '__EVENTS_END__'));
          const hasStart = tstdout.indexOf('__EVENTS_START__') >= 0;
          let error = null;
          if (!hasStart) error = 'JavaTracer 未产出事件：' + (terr || tstdout).slice(0, 400);
          else if (events.length === 0) error = '未捕获到执行步骤（检查代码是否真的执行了 main）';
          done(events, safeRead(outPath) || cleanOut(stdoutBuf), error);
          cleanup();
        });
      });

      timer = setTimeout(() => {
        for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
        done([], safeRead(outPath), 'Java 执行超时（20s）：请检查是否死循环');
        cleanup();
      }, JAVA_TIMEOUT_MS);
    });
  });
}

/* ────────────────────────── C / C++ ────────────────────────── */

function runCC(code, lang, runtimeDir) {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (events, output, error) => resolve({ events, output, error, timeMs: Date.now() - started });
    const tracerPath = path.join(runtimeDir, 'gdb-tracer.mjs');
    if (!fs.existsSync(tracerPath)) { done([], '', '缺少 runtime/gdb-tracer.mjs'); return; }

    const tracer = spawn(process.execPath, [tracerPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSA_LANG: lang },
    });
    let tstdout = '';
    let terr = '';
    let timer;
    tracer.stdout.on('data', (d) => { tstdout += d; });
    tracer.stderr.on('data', (d) => { terr += d; });
    tracer.on('close', () => {
      if (timer) clearTimeout(timer);
      const events = parseEventLines(sliceBetween(tstdout, '__EVENTS_START__', '__EVENTS_END__'));
      const output = sliceBetween(tstdout, '__OUTPUT_START__', '__OUTPUT_END__').trim();
      let error = null;
      if (events.length === 0 && !output) {
        error = (terr || tstdout).slice(0, 1200) || '未产出事件（检查 gcc/gdb 工具链）';
      }
      done(events, output, error);
    });
    tracer.on('error', (e) => {
      if (timer) clearTimeout(timer);
      done([], '', '启动 gdb 追踪器失败：' + e.message);
    });
    try { tracer.stdin.write(code, 'utf8'); tracer.stdin.end(); } catch { /* ignore */ }
    timer = setTimeout(() => {
      try { tracer.kill(); } catch { /* ignore */ }
      done([], '', 'C/C++ 执行超时（40s）：请检查是否死循环');
    }, CC_TIMEOUT_MS);
  });
}

/* ────────────────────────── 统一入口 ────────────────────────── */

async function run(lang, code, runtimeDir) {
  if (typeof code !== 'string') return { events: [], output: '', error: '代码不能为空', timeMs: 0 };
  if (code.length > 200000) return { events: [], output: '', error: '代码超过长度上限（200KB）', timeMs: 0 };
  if (!code.trim()) return { events: [], output: '', error: '编辑器是空的 —— 先写点代码再运行', timeMs: 0 };
  switch (lang) {
    case 'python': return runPython(code, runtimeDir);
    case 'java': return runJava(code, runtimeDir);
    case 'c': return runCC(code, 'c', runtimeDir);
    case 'cpp': return runCC(code, 'cpp', runtimeDir);
    default: return { events: [], output: '', error: '不支持的语言：' + lang, timeMs: 0 };
  }
}

module.exports = { run, preflight, whichSync, PY_TIMEOUT_MS, JAVA_TIMEOUT_MS, CC_TIMEOUT_MS };
