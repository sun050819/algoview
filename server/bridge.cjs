/**
 * 本地服务（算法视界前端 + 真实执行桥）
 *
 *   GET  /             → 开发态：个人主页；独立分发：算法视界前端
 *   GET  /css|js|assets|case/… → 开发态才有：个人主页与项目过渡页的静态资源
 *   GET  /case/algo/   → 开发态才有：项目过渡页（介绍 / 在线打开 / 下载）
 *   GET  /algo/        → 算法视界前端（dist/）
 *   GET  /health       → { ok, tools: { python, java, c, cpp } }
 *   POST /run          → { lang, code } → { events, output, error, timeMs }
 *
 * 个人主页 / 过渡页的托管被拆到可选的 server/site.cjs：
 * 开发态的完整目录里有它，打包出去的应用（桌面版 / Web 离线包）没有，
 * require 失败 → hasSite=false，只服务 /algo/，不会把个人主页一起分发出去。
 *
 * 为什么必须有这个本地进程：浏览器里没有编译器和调试器，
 * 页面由本服务托管、同源请求 /run，既没有跨域，也不会出现"页面能开但跑不起来"。
 *
 * 只监听 127.0.0.1，不对外网开放。
 * 启动：node server/bridge.cjs（开发态也可双击「启动个人主页.cmd」，仓库版用 start.cmd）
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const runner = require('./runner.cjs');

const PORT = Number(process.env.DSA_BRIDGE_PORT || 5321);
const HOST = '127.0.0.1';
const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const ALGO_DIR = path.join(__dirname, '..', 'dist');

/**
 * 个人主页托管是**可选**的：只有开发态的完整目录里才有 server/site.cjs。
 * 桌面版与 Web 离线包里不带这个文件，require 直接失败 →
 * hasSite 为 false，包内只服务 /algo/，不残留主页逻辑。
 */
let site = null;
try { site = require('./site.cjs'); } catch { site = null; }
const hasSite = !!(site && site.hasSite);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
};

let preflightCache = null;
let preflightAt = 0;
function tools() {
  const now = Date.now();
  if (!preflightCache || now - preflightAt > 5000) {
    preflightCache = runner.preflight();
    preflightAt = now;
  }
  return preflightCache;
}

/** 串行执行：编译/调试都很重，并发只会互相拖慢 */
let queue = Promise.resolve();
function enqueue(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function send(res, code, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/** 把 rootDir 下的 rel 读出来发回去；headOnly 用于下载卡片的 HEAD 探测 */
function serveFile(rootDir, rel, res, headOnly = false) {
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html';   // /case/algo/ → /case/algo/index.html
  const file = path.join(rootDir, path.normalize(rel).replace(/^([/\\])+/, ''));
  // 防目录穿越
  if (file !== rootDir && !file.startsWith(rootDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }
  fs.stat(file, (stErr, st) => {
    if (stErr || !st.isFile()) {
      if (rel === '/index.html' || rel === '/') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        if (!headOnly) res.end(
          '<meta charset="utf-8"><body style="font:15px/1.8 system-ui;padding:48px;background:#0b1220;color:#e8eef8">' +
          '<h2>还没有构建前端页面</h2>' +
          '<p>先在 algoview 目录执行一次 <code style="background:#1e293b;padding:2px 6px;border-radius:4px">npm install</code> 和 ' +
          '<code style="background:#1e293b;padding:2px 6px;border-radius:4px">npm run build</code>，再刷新本页。</p>' +
          '</body>',
        );
        else res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(headOnly ? undefined : '404');
      return;
    }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // HTML 一律不缓存：改完刷新就能看到；图片/字体/打包产物给 1 小时
      'Cache-Control': /\.html?$/i.test(file) || rel === '/' ? 'no-store' : 'max-age=3600',
      'Content-Length': st.size,
    };
    // 安装包是 100MB 量级：用流发，别整块读进内存；顺便强制下载
    const isBig = st.size > 4 * 1024 * 1024;
    if (isBig) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
    res.writeHead(200, headers);
    if (headOnly) { res.end(); return; }
    if (isBig) {
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.end(); return; }
      res.end(buf);
    });
  });
}

/**
 * 路由：/algo/* 归算法视界，其余归个人主页。
 * 下面这两个站点的资源都用相对路径引用（css/… 、./assets/…），
 * 所以只要目录挂对，不需要给前端配 base。
 */
function routeStatic(pathname, res, headOnly = false) {
  // 带子路径的页面必须带斜杠，否则页内相对资源会解析到上一级去
  if (pathname === '/algo' || pathname === '/case/algo') {
    res.writeHead(301, { Location: pathname + '/' });
    res.end();
    return;
  }
  if (pathname.startsWith('/algo/')) {
    const rel = pathname.slice('/algo'.length) || '/';
    serveFile(ALGO_DIR, rel, res, headOnly);
    return;
  }
  // 主页根目录不存在（算法视界被单独分发）时，退回自带页面
  if (!hasSite) {
    serveFile(ALGO_DIR, pathname === '/' ? '/index.html' : pathname, res, headOnly);
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    serveFile(site.SITE_DIR, '/index.html', res, headOnly);
    return;
  }
  if (site.SITE_ALLOW.test(pathname)) {
    serveFile(site.SITE_DIR, pathname, res, headOnly);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  // HEAD 也要给：过渡页靠 HEAD /health 探活，只认 GET 会误判成"服务没起来"
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
    send(res, 200, { ok: true, service: 'dsa-bridge', port: PORT, tools: tools() });
    return;
  }

  // HEAD 要给过渡页用：它靠 HEAD 探测安装包是否存在，再决定按钮能不能点
  if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/run')) {
    routeStatic(decodeURIComponent(url.pathname), res, req.method === 'HEAD');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/run') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      send(res, 400, { events: [], output: '', error: '请求解析失败：' + e.message, timeMs: 0 });
      return;
    }
    const lang = String(payload?.lang || '');
    const code = String(payload?.code ?? '');
    const started = Date.now();
    try {
      const result = await enqueue(() => runner.run(lang, code, RUNTIME_DIR));
      console.log(`[run] ${lang} ${code.length}B → ${result.events.length} 事件 / ${Date.now() - started}ms${result.error ? ' / ERROR: ' + result.error.slice(0, 80) : ''}`);
      send(res, 200, result);
    } catch (e) {
      send(res, 500, { events: [], output: '', error: '执行异常：' + (e && e.message ? e.message : String(e)), timeMs: Date.now() - started });
    }
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用 —— 服务可能已经在运行了。`);
    console.error(`如果确实需要换端口，设置环境变量 DSA_BRIDGE_PORT。\n`);
  } else {
    console.error('本地执行服务启动失败：', e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const t = tools();
  const mark = (x) => (x.ok ? '✓' : '✗');
  const base = `http://${HOST}:${PORT}`;
  console.log('');
  console.log(hasSite ? '  个人主页 · 已就绪' : '  算法视界 · 已就绪');
  console.log('');
  if (hasSite) {
    console.log(`  个人主页   ${base}/`);
    console.log(`  项目介绍   ${base}/case/algo/`);
  }
  console.log(`  算法视界   ${base}/algo/`);
  console.log('');
  console.log(`  ${mark(t.python)} Python   ${t.python.path || '未检测到 python'}`);
  console.log(`  ${mark(t.java)} Java     ${t.java.ok ? t.java.javac : '未找到 javac / java'}`);
  console.log(`  ${mark(t.c)} C        ${t.c.ok ? t.c.gcc : '未找到 gcc / gdb'}`);
  console.log(`  ${mark(t.cpp)} C++      ${t.cpp.ok ? t.cpp.gpp : '未找到 g++ / gdb'}`);
  console.log('');
  console.log('  浏览器会自己打开；如果没有，手动访问上面的地址。');
  console.log('  保持这个窗口开着（它同时提供页面和执行能力），按 Ctrl+C 退出。');
  console.log('');

  // 自动打开浏览器（设置 DSA_NO_OPEN=1 可关闭）
  if (!process.env.DSA_NO_OPEN) {
    exec(`start "" "${base}/"`, { windowsHide: true }, () => {});
  }
});
