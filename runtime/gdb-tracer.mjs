#!/usr/bin/env node
/**
 * gdb-tracer.mjs —— C/C++ 真实运行时轨（GDB/MI 逐步追踪）
 *
 * 用法： 源码经 stdin 传入；环境变量：
 *   DSA_LANG = "c" | "cpp"      （决定编译器 gcc / g++)
 *   DSA_GCC  = gcc/g++ 可执行文件绝对路径（缺省查 PATH）
 *   DSA_GDB  = gdb 可执行文件绝对路径（缺省查 PATH）
 *
 * 流程：写临时源码（系统 temp，无中文路径）→ 编译 -g -O0 → gdb --interpreter=mi2
 *   → skip Windows CRT 文件 → 断点用户文件首个语句行 → -exec-run → 循环 -exec-step
 *   → 每次 *stopped 读帧/局部变量/栈 → 输出 JSONL（与 python/java 轨对齐）：
 *   __EVENTS_START__
 *   {"type":"call","line":N,"fn":"main","vars":{...},"stack":[...]}
 *   {"type":"line","line":N,"fn":"...","vars":{...},"stack":[...]}
 *   {"type":"return",...}
 *   __EVENTS_END__
 *   __OUTPUT_START__  （程序 stdout）
 *   __OUTPUT_END__
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import toolchain from './toolchain.cjs';

const LANG = process.env.DSA_LANG || 'c';
const STEP_LIMIT = parseInt(process.env.DSA_STEPS || '50000', 10);
const TIMEOUT_MS = parseInt(process.env.DSA_TIMEOUT || '30000', 10);

// ---------- 工具链探测（统一逻辑见同目录 toolchain.cjs） ----------
function resolveTool(name) {
  if (process.env.DSA_GCC && (name === 'gcc' || name === 'g++')) return process.env.DSA_GCC;
  if (process.env.DSA_GDB && name === 'gdb') return process.env.DSA_GDB;
  return toolchain.which(name) || name; // 兜底：交给 PATH
}

function findGdb() { return resolveTool('gdb'); }
function findCc() { return LANG === 'cpp' ? resolveTool('g++') : resolveTool('gcc'); }

// ---------- 输出 ----------
let stdout_events = '';
let stdout_output = '';
const print = (s) => { stdout_events += s + '\n'; };
const printOutput = (s) => { stdout_output += s; };
function flushOutput() {
  const out = stdout_output.trim();
  let ev = stdout_events;
  if (!ev.startsWith('__EVENTS_START__')) ev = '__EVENTS_START__\n' + ev;
  if (!ev.includes('__EVENTS_END__')) ev += '__EVENTS_END__\n';
  // 同步写，避免 process.exit 丢异步缓冲
  fs.writeSync(1, ev + '\n__OUTPUT_START__\n' + out + '\n__OUTPUT_END__\n');
}
const DBG = process.env.DSA_DEBUG || '';
const dbg = (s) => { if (DBG) { try { fs.appendFileSync(DBG, s + '\n'); } catch { /* ignore */ } } };

// ---------- 值解析：gdb 值字符串 → JSON ----------
function parseGdbValue(raw) {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  if (s === '') return '';
  // char 数组：{97 'a', 98 'b', 0 '\000'} → "ab"
  if (s.startsWith('{') && /'/.test(s) && s.includes('\\000') === false) {
    const m = s.match(/^\{[\s\S]*\}$/);
    if (m && /^\{\s*\d+\s+'[^']*'(,\s*\d+\s+'[^']*')*\s*\}$/.test(s)) {
      const chars = [...s.matchAll(/(\d+)\s+'([^']*)'/g)].map((x) => x[2]);
      if (chars.every((c) => c.length === 1)) return chars.join('');
    }
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    // 结构体字段形式 {x=1, y=2} / 数组 {1, 2, 3}
    const items = splitTopLevel(inner);
    if (items.length > 0 && /^[A-Za-z_]\w*\s*=/.test(items[0])) {
      // 结构体 → 对象
      const obj = {};
      for (const it of items) {
        const eq = it.indexOf('=');
        if (eq > 0) obj[it.slice(0, eq).trim()] = parseGdbValue(it.slice(eq + 1));
      }
      return obj;
    }
    return items.slice(0, 200).map((it) => parseGdbValue(it));
  }
  if (s.startsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}
function splitTopLevel(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// 括号配平提取：从 startKey（如 "frame={"）后开始，取到括号闭合的完整块
function extractBalanced(s, startKey) {
  const i = s.indexOf(startKey);
  if (i < 0) return null;
  const j = i + startKey.length - 1; // 指向 startKey 结尾的 { 或 [
  let depth = 0;
  for (let k = j; k < s.length; k++) {
    const c = s[k];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    if (depth === 0) return s.slice(j, k + 1);
  }
  return null;
}

// 反转义 MI 字符串内容（~"..." / ^done,value="..." 内的 \n \t \" \\）
function unescapeMi(s) {
  return s
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r').replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

// 把 MI 字符串（尚未反转义）按其中的 \n 转义切成"原始行"。
// 为什么不在反转义后切：源码回显里可能本身带 \n（printf("a\nb")），
// 反转义后行数就对不上了，行号前缀会被切断。
function splitRawLines(raw) {
  const out = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      if (raw[i + 1] === 'n') { out.push(raw.slice(start, i)); i++; start = i + 1; continue; }
      i++; // 跳过 \\ \\t 之类的转义对
      continue;
    }
  }
  out.push(raw.slice(start));
  return out;
}

// gdb console 噪音判断（横幅 / 断点 / 单步提示 / 源码行等，程序输出不会长这样）
function isGdbNoise(t) {
  if (!t || t === '(gdb)' || t.startsWith('(gdb) ')) return true;
  if (t.startsWith('GNU gdb') || t.startsWith('Copyright (C)')) return true;
  if (t.startsWith('License GPLv3+') || t.startsWith('This is free software')) return true;
  if (t.startsWith('There is NO WARRANTY') || t.startsWith('This GDB was configured')) return true;
  if (t.startsWith('Type "show configuration"') || t.startsWith('For bug reporting instructions')) return true;
  if (t.startsWith('Find the GDB manual') || t.startsWith('For help, type')) return true;
  if (t.startsWith('Type "apropos word"') || t.startsWith('Reading symbols from')) return true;
  if (t.startsWith('<http') || t === 'done.') return true;
  if (t.startsWith('File ') && t.includes('will be skipped')) return true;
  if (t.startsWith('Breakpoint') || t.includes(', main () at ')) return true;
  if (t.startsWith('Single stepping') || t.startsWith('which has no line number')) return true;
  if (t.startsWith('[New Thread') || t.startsWith('[Thread') || t.startsWith('[Inferior')) return true;
  if (t.startsWith('Note: ') || t.startsWith('warning: ')) return true;
  if (t.startsWith('&"') || t.startsWith('@"')) return true;
  if (t.includes('alpc_implv2') || t.includes('Host_Ipc_agent')) return true;
  if (t.includes('tsbx.dll') || t.includes('LiteSandbox')) return true;
  // 停止位置描述：`2  main () at main.cpp:7` / `1, _GLOBAL__sub_I_main () at main.cpp:5`
  // 这一行常和程序输出挤在同一个 ~"..." 里，不剥掉就会出现在"输出"面板
  if (/^\d+\s{2,}\S/.test(t)) return true;
  if (/^\d+[,:]\s*\S+\s*\(\)/.test(t)) return true;
  if (/_GLOBAL__sub_I_|__static_initialization_and_destruction/.test(t)) return true;
  if (/\bat\s+\S+\.(?:c|cc|cpp|cxx|h|hpp):\d+\s*$/.test(t)) return true;
  return false;
}

// ---------- 源码 → 主函数首语句行 ----------
function findMainFirstLine(src) {
  const lines = src.split('\n');
  let braceDepth = 0;
  let inMainBody = false;
  let bodyBraceSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inMainBody) {
      if (/\b(?:int|void|unsigned|long|char|float|double|bool|auto|std::)\b[^;{]*\bmain\s*\(/.test(l)) {
        inMainBody = true;
        const open = l.indexOf('{');
        if (open >= 0) { bodyBraceSeen = true; braceDepth = 1; }
        continue;
      }
      continue;
    }
    for (const ch of l) {
      if (ch === '{') { bodyBraceSeen = true; braceDepth++; }
      else if (ch === '}') braceDepth--;
    }
    if (bodyBraceSeen && braceDepth <= 0) break; // main 结束
    if (bodyBraceSeen && braceDepth >= 1) {
      const trimmed = l.trim();
      if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('#')) {
        return i + 1; // 1-based 行号
      }
    }
  }
  return 1; // 兜底：第 1 行
}

// ---------- 主流程 ----------
function main(src) {
  const started = Date.now();
  dbg('run: stdin len=' + src.length);
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cc-'));
  dbg('run: tmpdir=' + tmpdir);
  const ext = LANG === 'cpp' ? 'cpp' : 'c';
  const srcPath = path.join(tmpdir, 'main.' + ext);
  const exePath = path.join(tmpdir, 'main.exe');
  try { fs.writeFileSync(srcPath, src, 'utf8'); } catch (e) {
    print('__EVENTS_START__'); print('__EVENTS_END__');
    printOutput('写入源码失败: ' + e);
    process.exit(0);
  }

  const cc = findCc();
  const gdb = findGdb();
  dbg('run: cc=' + cc + ' gdb=' + gdb);

  // 1. 编译（gcc 4.9 默认 C89：需显式标准；C++ 用 gnu++11 兼容教学子集）
  const compileArgs = LANG === 'cpp'
    ? ['-g', '-O0', '-std=gnu++11', '-o', exePath, srcPath]
    : ['-g', '-O0', '-std=gnu99', '-o', exePath, srcPath];
  const cproc = spawn(cc, compileArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let cerr = '';
  cproc.stderr.on('data', (d) => (cerr += d));
  cproc.on('close', (ccode) => {
    dbg('gcc close code=' + ccode);
    if (ccode !== 0) {
      print('__EVENTS_START__'); print('__EVENTS_END__');
      printOutput('编译失败:\n' + cerr.slice(0, 1200));
      dbg('gcc stderr: ' + cerr.slice(0, 1200));
      cleanup();
      flushOutput();
      process.exit(0);
      return;
    }
    traceWithGdb(gdb, exePath, srcPath, src, tmpdir, started);
  });
  cproc.on('error', (e) => {
    print('__EVENTS_START__'); print('__EVENTS_END__');
    printOutput('无法启动编译器 ' + cc + '：' + e.message + '\n请安装 MinGW-w64（含 gcc/g++/gdb）或将工具链加入 PATH。');
    cleanup();
  });
  function cleanup() {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function traceWithGdb(gdb, exePath, srcPath, src, tmpdir, started) {
  const firstLine = findMainFirstLine(src);
  const srcName = path.basename(srcPath);
  let gdbProc;
  try {
    // -q 关掉 gdb 启动横幅：banner 的续行（"and \"show warranty\" for details."）
    // 没有固定前缀，靠字符串匹配过滤不干净，直接从源头禁掉最稳
    gdbProc = spawn(gdb, ['-q', '--interpreter=mi2', exePath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    print('__EVENTS_START__'); print('__EVENTS_END__');
    printOutput('无法启动 gdb：' + e.message);
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(0);
  }

  let buf = '';
  let running = false;
  let steps = 0;
  let finished = false;
  let lastFn = '';
  let lastDepth = 0;
  const callStack = []; // 逻辑调用栈（仅用户函数）
  let lastLine = 0;
  let cmdId = 0;
  // gdb 停在断点时会在 CLI 里多打一行"源码回显"（`2\tint main() {...}`），
  // 格式与程序输出无法区分，所以用上一条 "… in main () at file.c:12" 做前导标记
  let sourceEchoPending = false;
  const cmdPending = new Map();
  const cmdQueue = [];
  function sendCmd(cmd, cb) {
    const id = ++cmdId;
    cmdPending.set(id, cb);
    cmdQueue.push(id);
    gdbProc.stdin.write(cmd + '\n');
  }
  const send = (cmd) => sendCmd(cmd, undefined);
  let timer = setTimeout(() => {
    // 超时：flush 已收集事件并退出
    dbg('TIMEOUT reached');
    finalize();
    try { gdbProc.kill(); } catch { /* ignore */ }
  }, TIMEOUT_MS + 3000);

  gdbProc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    dbg('gdb data chunk: ' + d.toString('utf8').slice(0, 120).replace(/\n/g, '|'));
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      handleLine(line);
      if (finished) break;
    }
  });
  gdbProc.stderr.on('data', () => { /* gdb 无 stderr 输出 */ });
  gdbProc.on('close', () => {
    if (!finished) {
      clearTimeout(timer);
      finalize();
    }
  });
  gdbProc.on('error', (e) => {
    clearTimeout(timer);
    print('__EVENTS_START__'); print('__EVENTS_END__');
    printOutput('无法启动 gdb：' + e.message + '\n请安装 MinGW-w64 或配置 DSA_GDB。');
    finish();
  });

  function handleLine(line) {
    if (line.startsWith('*')) {
      // 异步通知：*running / *stopped
      if (line.startsWith('*stopped')) {
        handleStopped(line);
      } else if (line.startsWith('*running')) {
        // 运行中，等待 stopped
      }
    } else if (line.startsWith('^')) {
      // 命令响应：按发送顺序取回回调
      const id = cmdQueue.shift();
      const cb = cmdPending.get(id);
      cmdPending.delete(id);
      if (cb) cb(line);
    } else if (line.startsWith('=')) {
      // 通知：主线程退出 = 程序结束
      if (line.startsWith('=thread-exited,id="1"')) {
        dbg('main thread exited');
        finalize();
      }
    } else if (line.startsWith('~"')) {
      // console stream：程序 stdout（printf/cout 输出）。gdb 会把"停止位置描述"
      // 和"源码回显"也塞进这个流里，所以必须逐行过噪音表。
      const m = /^~"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) {
        // 按"原始行"处理：gdb 常把 停止位置描述 / 源码回显 / 程序输出 打进同一个 chunk，
        // 逐行判断才能只丢前两者
        const kept = [];
        for (const rl of splitRawLines(m[1])) {
          // 停止位置描述：`1, 0x... in main () at main.cpp:2`
          if (/\bin \S+ \(\) at [^"]*:\d+$/.test(rl)) { sourceEchoPending = true; continue; }
          // 紧跟其后的源码回显：`3\tint main() { ... }`
          if (sourceEchoPending && /^\d+\\t/.test(rl)) { sourceEchoPending = false; continue; }
          const ln = unescapeMi(rl)
            .replace(/&"(?:[^"\\]|\\.)*"/g, '')   // 混进来的 gdb 日志片段
            .replace(/\[Inferior[^\]]*\]/g, '')     // 退出横幅
            .replace(/\[New Thread[^\]]*\]/g, '')
            .replace(/\[Thread[^\]]*\]/g, '');
          if (ln.trim() === '') { kept.push(''); continue; }
          if (isGdbNoise(ln.trim())) continue;
          kept.push(ln);
          sourceEchoPending = false;   // 已经是真正的程序输出了，回显标记作废
        }
        const content = kept
          .join('\n')
          .replace(/^\n+/, '')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/\n+$/, '');
        // 不再看 running：程序最后一行的输出可能和 *stopped 挤在同一个 chunk 里，
        // 用 running 卡会把末尾输出吞掉；噪音已由上面的逐行过滤负责
        if (content.trim() !== '') printOutput(content + '\n');
      }
    } else if (line.startsWith('&"')) {
    } else if (line.startsWith('&"')) {
      // log stream：gdb / 注入的 DLL 自己打的日志（"warning: [TSBX] ..."），
      // 不是程序输出，直接丢弃，避免污染"输出"面板
    } else if (line.startsWith('@"')) {
      // target output stream：程序直接输出，不掺 gdb 消息，原样透传
      const m = /^@"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) printOutput(unescapeMi(m[1]) + '\n');
    } else {
      // 裸行 → 可能是程序输出或 gdb console 噪音；按内容过滤
      const t = line.trim();
      if (running && !isGdbNoise(t)) printOutput(line + '\n');
    }
  }

  function handleStopped(raw) {
    const reason = /reason="([^"]*)"/.exec(raw)?.[1] || '';
    const frameBlock = extractBalanced(raw, 'frame={');
    const frame = frameBlock ? parseFrame(frameBlock.slice(1, -1)) : null;
    if (!frame) {
      if (reason === 'exited' || reason === 'exited-normally' || reason === 'exited-signalled') {
        finalize();
      } else {
        send('-exec-continue');
      }
      return;
    }
    const fn = frame.func || '?';
    const line = frame.line || 0;
    const file = frame.file || '';
    const isUserFile = file.includes(srcName) || file.endsWith('main.' + (LANG === 'cpp' ? 'cpp' : 'c'));

    // 按物理栈深度判定 call/return（不依赖函数名变化——递归时函数名相同但栈加深）
    readDepth((depth) => {
      const isMainEntry = reason === 'breakpoint-hit' && callStack.length === 0;
      if (isMainEntry) {
        callStack.length = 0;
        callStack.push(fn);
        emitEvent({ type: 'call', line: 0, fn, vars: {}, stack: [...callStack] });
      } else if (!isUserFile) {
        // step 误入标准库函数（push_back/cout/printf/endl 等）：depth 增加 → finish 回用户代码
        if (depth > lastDepth) {
          dbg('entered lib frame at depth ' + depth + ', finish back');
          steps++;
          if (steps >= STEP_LIMIT) { finalize(); return; }
          send('-exec-finish');
          return;
        }
        // CRT 帧：main 返回后 → 让程序自然退出（flush cout/printf 缓冲）
        if (callStack.length > 0 && callStack[callStack.length - 1] === 'main') {
          const ret = callStack.pop();
          emitEvent({ type: 'return', line, fn: ret, vars: {}, stack: [...callStack] });
          steps++;
          if (steps >= STEP_LIMIT) { finalize(); return; }
          if (!finished) send('-exec-continue');
          return;
        }
      } else if (depth > lastDepth) {
        // 进入新函数（含递归：函数名相同但栈加深）
        callStack.push(fn);
        emitEvent({ type: 'call', line: 0, fn, vars: {}, stack: [...callStack] });
      } else if (depth < lastDepth) {
        // 返回一层（含递归返回）
        const ret = callStack.pop() || lastFn;
        emitEvent({ type: 'return', line, fn: ret, vars: {}, stack: [...callStack] });
        if (callStack.length === 0 && ret === 'main') {
          steps++;
          if (steps >= STEP_LIMIT) { finalize(); return; }
          if (!finished) send('-exec-continue');
          return;
        }
      }
      lastFn = fn; lastDepth = depth;
      // line 事件（用户文件行，保留每一步中间状态）
      if (isUserFile) {
        readVars(fn, (vars) => {
          // 顶层帧（main）：把容器变量登记进全局监视表
          if (callStack.length <= 1) {
            for (const [n, v] of Object.entries(vars)) {
              if (Array.isArray(v) || (v && typeof v === 'object')) globalNames.add(n);
            }
          }
          emitEvent({ type: 'line', line, fn, vars, stack: [...callStack], gvars: pickGlobals(vars) });
          lastLine = line;
          steps++;
          if (steps >= STEP_LIMIT) { finalize(); return; }
          if (!finished) send('-exec-step');
        });
      } else {
        // 非用户帧：分两种
        // 1) main 刚返回（栈顶仍是 main）→ 记 return main，continue 让程序自然退出（flush 输出）
        // 2) step 误入标准库/外部函数（cout/printf/endl 等无调试信息）→ 直接 continue 跑到底
        //    （此时已到输出阶段，继续 step/next 会在库函数里空转甚至报错；输出由 ~"..." stream 捕获）
        if (callStack.length > 0 && callStack[callStack.length - 1] === 'main') {
          const ret = callStack.pop();
          emitEvent({ type: 'return', line, fn: ret, vars: {}, stack: [...callStack] });
        } else {
          dbg('non-user frame, finish back to user code: ' + fn);
        }
        steps++;
        if (steps >= STEP_LIMIT) { finalize(); return; }
        // 误入库函数（push_back/cout/printf/endl 等）：finish 返回到用户帧，而非 continue 跑到底
        if (!finished) send('-exec-finish');
      }
    });
  }

  function parseFrame(s) {
    const obj = {};
    let depth = 0, cur = '', key = '';
    const strip = (v) => {
      v = v.trim();
      if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1);
      return v;
    };
    const push = () => {
      const eq = cur.indexOf('=');
      if (eq > 0) { obj[cur.slice(0, eq).trim()] = strip(cur.slice(eq + 1)); }
      cur = '';
    };
    for (const ch of s) {
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
      if (ch === ',' && depth === 0) { push(); }
      else cur += ch;
    }
    if (cur.trim()) push();
    return obj;
  }

  function readDepth(cb) {
    sendCmd('-stack-info-depth', (res) => {
      // 注意：MI 响应以字面 ^ 开头，须转义 \^
      const m = /\^done,depth="(\d+)"/.exec(res);
      cb(m ? Number(m[1]) : 0);
    });
  }

  // 容器还原缓存：键 = 函数名:变量名 → 'vec' | 'none'
  // 变量类型在一次运行内不变，所以每个变量只探测一次，避免每步都多打 gdb 命令。
  const containerCache = new Map();

  // ── 全局实时快照 ────────────────────────────────────────────────
  // -stack-list-locals 只返回「当前帧」的变量，main 里那个数组一旦进了
  // 函数就再也读不到，视图上的「全局变量」会永远停在进入函数前的旧值
  // （画布因为优先取栈帧变量是对的，两边就打架了）。
  // 这里把 main 里见过的容器变量记下来，函数内通过引用共享同一块内存，
  // 于是当前帧里的同名容器就是全局的实时值，直接补发成 gvars。
  // 只登记 Array/Object：标量同名极易是另一个函数的局部变量，冒充全局会编错误信息。
  const globalNames = new Set();
  const pickGlobals = (vars) => {
    const out = {};
    for (const n of globalNames) {
      const v = vars[n];
      if (Array.isArray(v) || (v && typeof v === 'object')) out[n] = v;
    }
    return out;
  };

  /** 求值一个表达式。
   *  MI 的 -data-evaluate-expression 只接受「一个」操作数，表达式里带空格
   *  （如 `a.b - a.c`）必须整体加引号，否则 gdb 直接回 usage 错误。 */
  const evalExpr = (expr, cb) =>
    sendCmd('-data-evaluate-expression "' + expr + '"', cb);

  /** vector 的元素个数表达式：两个内部指针相减，gdb 自己算，不执行被调试代码 */
  const vecLenExpr = (nm) => nm + '._M_impl._M_finish - ' + nm + '._M_impl._M_start';

  /** 把 std::vector<T> 这类容器对象还原成真实数组 */
  function resolveContainers(fn, vars, done) {
    const names = Object.keys(vars);
    let i = 0;
    const step = () => {
      if (i >= names.length) { done(); return; }
      const nm = names[i++];
      const key = fn + ':' + nm;
      const known = containerCache.get(key);
      if (known === 'none') { step(); return; }
      if (known === 'vec') { expandVec(nm, key, vars, () => step()); return; }
      // 探测：libstdc++ 的 vector 一定有 _M_finish / _M_start 这对指针。
      // 绝不能用 a.size() 去探测 —— 那会让 gdb 在被调试进程里真实调用函数，
      // 程序正停在单步中间状态时一调就 SIGSEGV，还会污染"输出"面板。
      evalExpr(vecLenExpr(nm), (r) => {
        const v = /\^done,value="((?:[^"\\]|\\.)*)"/.exec(r);
        if (!v) {
          // 取不到值 —— 这个类型没有 _M_impl（string / 普通结构体等），
          // 只有这种情况才可以永久记住"不是容器"。
          containerCache.set(key, 'none');
          step();
          return;
        }
        const n = parseInt(v[1], 10);
        // 变量刚进作用域还没构造时指针是脏值（长度可能是负数或天文数字）：
        // 这只是"这一步还没就绪"，不能据此判定它不是 vector，否则会永久误判。
        if (!Number.isFinite(n) || n < 0 || n > 100000) { step(); return; }
        containerCache.set(key, 'vec');
        expandVec(nm, key, vars, () => step());
      });
    };
    step();
  }

  /** 按 (_M_finish - _M_start) 的长度顺着 _M_start 取出元素，得到真正的数组 */
  function expandVec(nm, key, vars, done) {
    evalExpr(vecLenExpr(nm), (r) => {
      const mv = /\^done,value="((?:[^"\\]|\\.)*)"/.exec(r);
      const n = mv ? parseInt(mv[1], 10) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 100000) { done(); return; }
      if (n === 0) { vars[nm] = []; done(); return; }
      evalExpr('*' + nm + '._M_impl._M_start@' + n, (r2) => {
        const v2 = /\^done,value="((?:[^"\\]|\\.)*)"/.exec(r2);
        if (v2) {
          const arr = parseGdbValue(v2[1]);
          if (Array.isArray(arr)) vars[nm] = arr;
          else if (arr && typeof arr === 'object') vars[nm] = arr;
        }
        done();
      });
    });
  }

  function readVars(fn, cb) {
    // 编译器 / gdb 自己注入的临时量（__for_begin、__PRETTY_FUNCTION__ 等）
    // 不是用户的变量，混进来会变成莫名其妙的卡片，直接丢掉。
    const isInternal = (n) => n.startsWith('__') || n === 'this';
    // 参数与局部变量：-stack-list-arguments 1 + -stack-list-locals 1
    sendCmd('-stack-list-locals 1', (localsRes) => {
      const names = [];
      const m = /\^done,locals=\[([^\]]*)\]/.exec(localsRes);
      if (m && m[1]) {
        for (const item of splitTopLevel(m[1])) {
          const nm = /name="([^"]*)"/.exec(item);
          if (nm && !isInternal(nm[1])) names.push(nm[1]);
        }
      }
      sendCmd('-stack-list-arguments 1 0 0', (argsRes) => {
        const args = {};
        const am = /\^done,stack-args=\[frame=\{level="0",args=\[([^\]]*)\]\}\]/.exec(argsRes);
        if (am && am[1]) {
          for (const item of splitTopLevel(am[1])) {
            const nm = /name="([^"]*)"/.exec(item);
            const vl = /value="((?:[^"\\]|\\.)*)"/.exec(item);
            if (nm && vl && !isInternal(nm[1])) args[nm[1]] = parseGdbValue(vl[1]);
          }
        }
        // 对每个局部变量求值
        let i = 0;
        const vars = { ...args };
        const next = () => {
          if (i >= names.length) { finish(); return; }
          const name = names[i++];
          sendCmd('-data-evaluate-expression ' + name, (valRes) => {
            const v = /\^done,value="((?:[^"\\]|\\.)*)"/.exec(valRes);
            if (v) vars[name] = parseGdbValue(v[1]);
            next();
          });
        };
        // 数组参数退化为指针：用 *name@len 尝试还原数组内容
        const finish = () => {
          // 先把 std::vector / std::string 这类"容器对象"还原成真实数组/字符串，
          // 否则会退化成 {_M_start=0x…, _M_finish=0x…} 这种内部结构，画不出格子。
          resolveContainers(fn, vars, () => finish2());
        };

        const finish2 = () => {
          // 长度推断：① 优先具名长度变量 n/len/length/size/count/N；
          // ② 否则若有一对边界变量（lo/hi、l/r、left/right、begin/end），取 hi-lo+1；
          // ③ 否则不强行展开（避免取到 lo=0 之类截成空数组）。
          let lenKey = Object.keys(vars).find((k) =>
            /^(n|len|length|size|count|N|total)$/.test(k) && typeof vars[k] === 'number');
          if (!lenKey) {
            const nums = Object.entries(vars).filter(([, v]) => typeof v === 'number');
            const findPair = (a, b) => {
              const va = vars[a], vb = vars[b];
              return (typeof va === 'number' && typeof vb === 'number' && vb >= va) ? vb - va + 1 : 0;
            };
            let guessed = 0;
            for (const [a, b] of [['lo','hi'],['l','r'],['left','right'],['begin','end'],['start','stop'],['low','high']]) {
              if (a in vars && b in vars) { guessed = findPair(a, b); if (guessed > 0) break; }
            }
            if (guessed > 0) {
              // 直接算长度，无 lenKey 变量
              const ptrNames = Object.entries(vars)
                .filter(([, v]) => typeof v === 'string' && v.startsWith('0x') && v !== '0x0')
                .map(([k]) => k);
              if (ptrNames.length === 0) { expandStructPtrs(() => cb(vars)); return; }
              let pi = 0;
              const nextPtr = () => {
                if (pi >= ptrNames.length) { expandStructPtrs(() => cb(vars)); return; }
                const pn = ptrNames[pi++];
                sendCmd('-data-evaluate-expression *' + pn + '@' + guessed, (r) => {
                  const v2 = /\^done,value="((?:[^"\\]|\\.)*)"/.exec(r);
                  if (v2 && v2[1].startsWith('{')) vars[pn] = parseGdbValue(v2[1]);
                  nextPtr();
                });
              };
              nextPtr();
              return;
            }
          }
          const ptrNames = Object.entries(vars)
            .filter(([, v]) => typeof v === 'string' && v.startsWith('0x') && v !== '0x0' && lenKey)
            .map(([k]) => k);
          if (!lenKey || ptrNames.length === 0) {
            expandStructPtrs(() => cb(vars));
            return;
          }
          let pi = 0;
          const nextPtr = () => {
            if (pi >= ptrNames.length) { expandStructPtrs(() => cb(vars)); return; }
            const pn = ptrNames[pi++];
            sendCmd('-data-evaluate-expression *' + pn + '@' + vars[lenKey], (r) => {
              const v2 = /\^done,value="((?:[^"\\]|\\.)*)"/.exec(r);
              if (v2 && v2[1].startsWith('{')) vars[pn] = parseGdbValue(v2[1]);
              nextPtr();
            });
          };
          nextPtr();
        };

        // 对结构体指针（链表/树节点）：展开一层，把 head={val,next} 变成可读对象
        const expandStructPtrs = (done) => {
          const addrVars = Object.entries(vars)
            .filter(([, v]) => typeof v === 'string' && v.startsWith('0x') && v !== '0x0' && v.length <= 12);
          if (addrVars.length === 0) { done(); return; }
          let ai = 0;
          const nextAddr = () => {
            if (ai >= addrVars.length) { done(); return; }
            const [an, av] = addrVars[ai++];
            // 跳过已经被数组展开处理的
            if (typeof vars[an] === 'object') { nextAddr(); return; }
            sendCmd('-data-evaluate-expression *' + an, (r) => {
              const v2 = /\^done,value="((?:[^"\\]|\\.)*)"/.exec(r);
              if (v2 && v2[1].startsWith('{')) {
                const obj = parseGdbValue(v2[1]);
                if (obj && typeof obj === 'object') {
                  vars[an] = obj;
                  // 再展开一层 next/left/right（最多一层，避免 gdb 命令爆炸）
                  for (const field of ['next', 'left', 'right']) {
                    if (typeof obj[field] === 'string' && obj[field].startsWith('0x') && obj[field] !== '0x0') {
                      sendCmd('-data-evaluate-expression (*' + an + ').' + field, (r2) => {
                        const v3 = /\^done,value="((?:[^"\\]|\\.)*)"/.exec(r2);
                        if (v3 && v3[1].startsWith('{')) obj[field] = parseGdbValue(v3[1]);
                      });
                    }
                  }
                }
              }
              nextAddr();
            });
          };
          nextAddr();
        };
        next();
      });
    });
  }

  function emitEvent(ev) {
    print(JSON.stringify(ev));
  }
  function finalize() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    // main 最后一步进入 CRT 后程序直接退出：补发 main 的 return 事件
    // （否则 call/return 计数少一个，调用栈面板停留在 main）
    while (callStack.length > 0) {
      const ret = callStack.pop();
      emitEvent({ type: 'return', line: 0, fn: ret, vars: {}, stack: [...callStack] });
    }
    flushOutput();
    try { gdbProc.stdin.write('-gdb-exit\n'); } catch { /* ignore */ }
    try { gdbProc.kill(); } catch { /* ignore */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(0);
  }

  // 启动序列
  send('-interpreter-exec console "skip file crtexe.c"');
  send(`-break-insert ${srcName}:${firstLine}`);
  send('-exec-run');
  running = true;
  // 响应到达后由 handleLine 驱动（^done 会匹配 pending 队列；-exec-run 的 ^running 已忽略）
}

// 异步读 stdin（兼容 pipe 与文件重定向）
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', () => resolve(chunks.join('')));
  });
}

readStdin().then((src) => main(src));
