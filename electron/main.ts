/**
 * 算法可视化学习平台 · Electron 主进程
 * 职责：窗口创建、自定义协议 app:// 加载 dist、安全基线、文件读写桥、菜单
 */
import { app, BrowserWindow, Menu, protocol, dialog, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { pathToFileURL } from 'url';

const APP_SCHEME = 'app';

/* ---------- 0. 用户数据目录：安装版与绿色版必须分开 ---------- */
/**
 * 默认用户数据目录是 %APPDATA%\<productName>，这里会变成中文的「算法视界」，两个问题：
 *   1. 安装版与绿色版共用同一个目录 → requestSingleInstanceLock 互相顶掉，
 *      后打开的那个会被顶回前一个窗口；
 *   2. 中文目录名没法写进 NSIS 卸载脚本（makensis 按系统代码页解析脚本）。
 * 因此统一成 ASCII 的 AlgoView；绿色版（exe 同级有 portable.marker）再挪到
 * exe 同级 userdata/，真正做到解压即用、不写 AppData，两版可同时开。
 */
function applyUserDataPaths(): void {
  if (!app.isPackaged) return;
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, 'portable.marker'))) {
    let dir = path.join(exeDir, 'userdata');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      // 只读介质（光盘 / 只读U盘）→ 退回临时目录，至少不崩
      dir = path.join(os.tmpdir(), 'AlgoView-portable');
      fs.mkdirSync(dir, { recursive: true });
    }
    app.setPath('userData', dir);
    app.setPath('sessionData', dir);
    return;
  }
  app.setPath('userData', path.join(app.getPath('appData'), 'AlgoView'));
}

applyUserDataPaths();

/* ---------- 1. 注册自定义协议（特权） ---------- */
function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/* ---------- 2. 协议处理器：app://bundle/<file> -> dist/<file> ---------- */
function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
  };
  return map[ext] ?? 'application/octet-stream';
}

function distRoot(): string {
  // electron/out -> 项目根/dist（兼容 dev 与打包后的 asar 内布局）
  return path.join(__dirname, '..', '..', 'dist');
}

function installProtocolHandler(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const root = distRoot();
    const filePath = path.resolve(root, '.' + pathname);
    // 目录穿越防护
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      if (fs.statSync(filePath).isFile()) {
        const body = fs.readFileSync(filePath);
        return new Response(body, {
          headers: { 'content-type': mimeOf(filePath) },
        });
      }
    } catch {
      /* fallthrough -> 404 */
    }
    return new Response('Not Found', { status: 404 });
  });
}

/* ---------- 3. 窗口 ---------- */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: '算法视界',
    backgroundColor: '#1e1e1e',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // ---- 诊断钩子 ----
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error('[renderer]', message, ' @', sourceId, ':', line);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', JSON.stringify(details));
  });

  win.once('ready-to-show', () => win.show());

  // 外部链接一律交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  void win.loadURL(`${APP_SCHEME}://bundle/index.html`);

  // 打开 DevTools 快捷键（开发期）：Ctrl+Shift+I
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });
}

/* ---------- 4. 中文菜单 ---------- */
function installMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开代码文件…',
          accelerator: 'CmdOrCtrl+O',
          click: (_mi, win) => {
            if (!win) return;
            void openSourceFile(win);
          },
        },
        {
          label: '保存代码文件…',
          accelerator: 'CmdOrCtrl+S',
          click: (_mi, win) => {
            if (!win) return;
            void saveSourceFile(win);
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const, label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: '算法视界',
              detail:
                '版本 ' + app.getVersion() + '\n支持语言：Python / Java / C / C++\n' +
                '全部调用本机真实编译器与调试器逐步追踪（Python settrace / Java JDI / C·C++ GDB-MI）。',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 5. 文件读写桥（IPC，渲染进程经 preload 调用） ---------- */
const SOURCE_EXT: Record<string, string[]> = {
  python: ['.py'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp'],
  java: ['.java'],
};

async function openSourceFile(win: BrowserWindow): Promise<void> {
  const res = await dialog.showOpenDialog(win, {
    title: '打开代码文件',
    properties: ['openFile'],
    filters: [
      { name: '源代码', extensions: ['py', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'java', 'txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) return;
  const filePath = res.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    win.webContents.send('file:opened', { filePath, content });
  } catch (err) {
    void dialog.showErrorBox('打开失败', String(err));
  }
}

async function saveSourceFile(win: BrowserWindow): Promise<void> {
  const ext = path.extname(win.webContents.getURL()).split('.').pop() ?? '';
  const res = await dialog.showSaveDialog(win, {
    title: '保存代码文件',
    defaultPath: 'code.' + (ext || 'txt'),
    filters: [{ name: '源代码', extensions: ['py', 'c', 'cpp', 'java', 'txt'] }],
  });
  if (res.canceled || !res.filePath) return;
  win.webContents.send('file:request-save', { filePath: res.filePath });
}

ipcMain.handle('file:pick-open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: '打开代码文件',
    properties: ['openFile'],
    filters: [
      { name: '源代码', extensions: ['py', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'java', 'txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { filePath, content };
  } catch (err) {
    void dialog.showErrorBox('打开失败', String(err));
    return null;
  }
});

ipcMain.handle('file:save-as', async (event, payload: { content: string; defaultName?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const res = await dialog.showSaveDialog(win, {
    title: '保存代码文件',
    defaultPath: payload.defaultName ?? 'code.txt',
    filters: [{ name: '源代码', extensions: ['py', 'c', 'cpp', 'java', 'txt'] }],
  });
  if (res.canceled || !res.filePath) return false;
  try {
    fs.writeFileSync(res.filePath, payload.content, 'utf8');
    return true;
  } catch (err) {
    void dialog.showErrorBox('保存失败', String(err));
    return false;
  }
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
}));

/* ---------- 6. 真实运行时轨：Python sys.settrace 追踪 ---------- */
import { spawn } from 'child_process';

const PY_TIMEOUT_MS = 15000;

interface PythonTraceEvent {
  type: 'call' | 'line' | 'return';
  line: number;
  fn: string;
  vars: Record<string, unknown>;
  stack: string[];
  ret?: unknown;
}

interface PythonRunResult {
  events: PythonTraceEvent[];
  output: string;
  error: string | null;
  timeMs: number;
}

function tracerPath(): string {
  if (app.isPackaged) {
    // 打包后：extraResources 复制到 resources/runtime/
    return path.join(process.resourcesPath, 'runtime', 'python-tracer.py');
  }
  // 开发期：electron/out -> 项目根/runtime/
  return path.join(__dirname, '..', '..', 'runtime', 'python-tracer.py');
}

function parseTracerOutput(stdout: string, stderr: string, exitCode: number | null): PythonRunResult {
  const events: PythonTraceEvent[] = [];
  let output = '';
  let error: string | null = null;

  // 错误标记优先
  const errLine = stdout.split('\n').find((l) => l.startsWith('__ERROR__'));
  if (errLine) error = errLine.slice('__ERROR__'.length).trim();

  const evStart = stdout.indexOf('__EVENTS_START__');
  const evEnd = stdout.indexOf('__EVENTS_END__');
  if (evStart >= 0 && evEnd > evStart) {
    const body = stdout.slice(evStart + '__EVENTS_START__'.length, evEnd);
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as PythonTraceEvent;
        if (obj && typeof obj.type === 'string') events.push(obj);
      } catch {
        /* 跳过解析失败行 */
      }
    }
  }
  const outStart = stdout.indexOf('__OUTPUT_START__');
  const outEnd = stdout.indexOf('__OUTPUT_END__');
  if (outStart >= 0 && outEnd > outStart) {
    output = stdout.slice(outStart + '__OUTPUT_START__'.length, outEnd);
  }

  if (!error && stderr.trim()) error = stderr.trim().slice(0, 500);
  if (!error && exitCode !== 0 && events.length === 0) error = `Python 进程退出（代码 ${exitCode}）`;

  return { events, output, error, timeMs: 0 };
}

function runPythonTracer(code: string): Promise<PythonRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tp = tracerPath();
    let child;
    try {
      child = spawn('python', [tp], {
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
    const timer = setTimeout(() => {
      child.kill();
    }, PY_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ events: [], output: '', error: '无法启动 Python：' + err.message, timeMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const r = parseTracerOutput(stdout, stderr, code);
      r.timeMs = Date.now() - started;
      resolve(r);
    });
    child.stdin.write(code);
    child.stdin.end();
  });
}

ipcMain.handle('runtime:python', async (_e, payload: { code: string }): Promise<PythonRunResult> => {
  if (typeof payload?.code !== 'string' || payload.code.length > 200000) {
    return { events: [], output: '', error: '代码为空或超过长度上限（200KB）', timeMs: 0 };
  }
  return await runPythonTracer(payload.code);
});

/* ---------- 6. Java 真实运行时轨（JDWP + JDI 逐步追踪） ---------- */
import * as os from 'os';

const JAVA_TIMEOUT_MS = 20000;

interface JavaRunResult {
  events: PythonTraceEvent[]; // 与 Python 轨同构
  output: string;
  error: string | null;
  timeMs: number;
}

function javaRuntimeDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtime');
  }
  return path.join(__dirname, '..', '..', 'runtime');
}

function extractJavaClasses(code: string): { file: string; main: string; filters: string[] } {
  const classNames = [
    ...code.matchAll(/(?:public\s+|abstract\s+|final\s+)?class\s+(\w+)/g),
  ].map((m) => m[1]);
  const uniq = [...new Set(classNames)];
  if (uniq.length === 0) return { file: 'Main.java', main: 'Main', filters: ['Main'] };
  // 主类：含 main 方法者优先。从 main 方法位置向前找最近的 class 声明，
  // 避免惰性正则跨类匹配（多文件时把不含 main 的辅助类误判为主类）。
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

function runJavaTracer(code: string): Promise<JavaRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (events: PythonTraceEvent[], output: string, error: string | null) =>
      resolve({ events, output, error, timeMs: Date.now() - started });

    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-java-'));
    let timer: NodeJS.Timeout | undefined;
    const killAll = () => {
      if (timer) clearTimeout(timer);
      for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
    };
    const children: ReturnType<typeof spawn>[] = [];

    const { file, main, filters } = extractJavaClasses(code);
    const srcPath = path.join(tmpdir, file);
    const outPath = path.join(tmpdir, 'out.txt');
    try { fs.writeFileSync(srcPath, code, 'utf8'); } catch (err) {
      done([], '', '写入源码失败：' + String(err)); return;
    }

    // 1. javac -g 编译（局部变量可见性依赖调试信息；UTF-8 源码避免中文注释乱码）
    const javac = spawn('javac', ['-g', '-encoding', 'UTF-8', '-d', tmpdir, srcPath], { windowsHide: true });
    children.push(javac);
    let jerr = '';
    javac.stderr.on('data', (d) => (jerr += d));
    javac.on('close', (javacCode) => {
      if (javacCode !== 0) {
        done([], '', '编译失败：\n' + jerr.slice(0, 1200));
        return;
      }
      // 2. 启动目标 JVM（JDWP，suspend=y，随机端口）；stdout 与 stderr 均收集，
      //    JDWP "Listening..." 消息在 Windows 上可能走 stdout 或 stderr，两端都解析端口。
      const jvm = spawn(
        'java',
        [
          '-Dfile.encoding=UTF-8',
          '-Dstdout.encoding=UTF-8',
          '-Dstderr.encoding=UTF-8',
          '-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=0',
          '-cp', tmpdir, main,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.push(jvm);
      let jvmErr = '';
      let stdoutBuf = '';
      let port = 0;
      const parsePort = (chunk: string) => {
        const m = chunk.match(/address:\s*(\d+)/);
        if (m && !port) port = parseInt(m[1], 10);
      };
      jvm.stdout.on('data', (d) => { stdoutBuf += d; parsePort(String(d)); });
      jvm.stderr.on('data', (d) => { jvmErr += d; parsePort(String(d)); });
      jvm.on('close', (jvmCode) => {
        // 目标先退出（如运行期异常）而无 tracer 结果
        if (port === 0) {
          done([], cleanOut(stdoutBuf), 'Java 运行失败：' + jvmErr.trim().slice(0, 500) + (jvmCode !== null ? `（退出码 ${jvmCode}）` : ''));
          cleanup();
        } else {
          // 程序自然结束后补写输出文件（tracer 已驱动 done）
          try { fs.writeFileSync(outPath, cleanOut(stdoutBuf), 'utf8'); } catch { /* ignore */ }
        }
      });
      // 3. 等待 JDWP 端口就绪，再启动 JavaTracer attach 逐步追踪
      const waitPort = (deadline: number): Promise<number> =>
        port
          ? Promise.resolve(port)
          : new Promise((r) => {
              if (Date.now() > deadline) return r(0);
              setTimeout(() => waitPort(deadline).then(r), 80);
            });
      void waitPort(Date.now() + 8000).then((readyPort) => {
        if (!readyPort) {
          done([], safeRead(outPath), '无法获取 JDWP 调试端口：' + jvmErr.trim().slice(0, 500));
          cleanup();
          return;
        }
        const tracer = spawn('java', ['-cp', javaRuntimeDir(), 'JavaTracer', String(readyPort), '50000', '8000', filters.join(',')], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(tracer);
        let tstdout = '';
        tracer.stdout.on('data', (d) => (tstdout += d));
        tracer.on('close', () => {
          const parsed = parseJavaTracerOutput(tstdout);
          done(parsed.events, parsed.output ?? cleanOut(stdoutBuf), parsed.error);
          cleanup();
        });
      });
      // 4. 总超时兜底
      timer = setTimeout(() => {
        killAll();
        done([], safeRead(outPath), 'Java 执行超时（20s）');
      }, JAVA_TIMEOUT_MS);
    });

    function safeRead(p: string): string {
      try { return fs.readFileSync(p, 'utf8').slice(0, 200000); } catch { return ''; }
    }
    // 过滤 JDWP "Listening..." 等调试杂音，只留程序输出
    function cleanOut(buf: string): string {
      return buf
        .split('\n')
        .filter((l) => !/Listening for transport dt_socket/.test(l))
        .join('\n')
        .trim()
        .slice(0, 200000);
    }
    function cleanup() {
      killAll();
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

function parseJavaTracerOutput(stdout: string): { events: PythonTraceEvent[]; output?: string; error: string | null } {
  const events: PythonTraceEvent[] = [];
  const evStart = stdout.indexOf('__EVENTS_START__');
  const evEnd = stdout.indexOf('__EVENTS_END__');
  if (evStart >= 0 && evEnd > evStart) {
    const body = stdout.slice(evStart + '__EVENTS_START__'.length, evEnd);
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as PythonTraceEvent;
        if (obj && typeof obj.type === 'string') events.push(obj);
      } catch { /* skip */ }
    }
  }
  if (events.length === 0 && evStart < 0) {
    return { events, error: 'JavaTracer 未产出事件：' + stdout.slice(0, 300) };
  }
  return { events, error: null };
}

ipcMain.handle('runtime:java', async (_e, payload: { code: string }): Promise<JavaRunResult> => {
  if (typeof payload?.code !== 'string' || payload.code.length > 200000) {
    return { events: [], output: '', error: '代码为空或超过长度上限（200KB）', timeMs: 0 };
  }
  return await runJavaTracer(payload.code);
});

/* ---------- 6b. C / C++ 真实轨（gdb-tracer.mjs，GDB/MI 单步） ---------- */
const CC_TIMEOUT_MS = 40000;

interface CCRunResult {
  events: PythonTraceEvent[];
  output: string;
  error: string | null;
  timeMs: number;
}

function ccRuntimeDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtime');
  }
  return path.join(__dirname, '..', '..', 'runtime');
}

function runCCTracer(code: string, lang: 'c' | 'cpp'): Promise<CCRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (events: PythonTraceEvent[], output: string, error: string | null) =>
      resolve({ events, output, error, timeMs: Date.now() - started });

    const tracerPath = path.join(ccRuntimeDir(), 'gdb-tracer.mjs');
    if (!fs.existsSync(tracerPath)) {
      done([], '', '缺少 runtime/gdb-tracer.mjs（打包时未分发？）');
      return;
    }
    // 用 Electron 自带的 Node 运行时执行追踪器（ELECTRON_RUN_AS_NODE），不依赖系统 node
    const tracer = spawn(process.execPath, [tracerPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSA_LANG: lang },
    });
    let tstdout = '';
    tracer.stdout.on('data', (d) => (tstdout += d));
    let timer: NodeJS.Timeout | undefined;
    tracer.on('close', () => {
      if (timer) clearTimeout(timer);
      const parsed = parseCCTracerOutput(tstdout);
      done(parsed.events, parsed.output ?? '', parsed.error);
    });
    tracer.on('error', (e) => {
      if (timer) clearTimeout(timer);
      done([], '', '启动 gdb 追踪器失败：' + e.message);
    });
    try { tracer.stdin.write(code, 'utf8'); tracer.stdin.end(); } catch { /* ignore */ }
    timer = setTimeout(() => {
      try { tracer.kill(); } catch { /* ignore */ }
      done([], '', 'C/C++ 执行超时（20s）：请检查是否死循环或工具链未就绪');
    }, CC_TIMEOUT_MS);
  });
}

function parseCCTracerOutput(stdout: string): { events: PythonTraceEvent[]; output?: string; error: string | null } {
  const events: PythonTraceEvent[] = [];
  const evStart = stdout.indexOf('__EVENTS_START__');
  const evEnd = stdout.indexOf('__EVENTS_END__');
  const outStart = stdout.indexOf('__OUTPUT_START__');
  const outEnd = stdout.indexOf('__OUTPUT_END__');
  let output: string | undefined;
  if (outStart >= 0 && outEnd > outStart) {
    output = stdout.slice(outStart + '__OUTPUT_START__'.length, outEnd).trim();
  }
  if (evStart >= 0 && evEnd > evStart) {
    const body = stdout.slice(evStart + '__EVENTS_START__'.length, evEnd);
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as PythonTraceEvent;
        if (obj && typeof obj.type === 'string') events.push(obj);
      } catch { /* skip malformed */ }
    }
  }
  // 无事件且无输出 → 编译/运行期失败信息
  const error = events.length === 0 && !output
    ? (stdout.slice(0, 1200) || '未产出事件（检查 MinGW/gcc/gdb 工具链）')
    : null;
  return { events, output, error };
}

ipcMain.handle('runtime:c', async (_e, payload: { code: string }): Promise<CCRunResult> => {
  if (typeof payload?.code !== 'string' || payload.code.length > 200000) {
    return { events: [], output: '', error: '代码为空或超过长度上限（200KB）', timeMs: 0 };
  }
  return await runCCTracer(payload.code, 'c');
});

ipcMain.handle('runtime:cpp', async (_e, payload: { code: string }): Promise<CCRunResult> => {
  if (typeof payload?.code !== 'string' || payload.code.length > 200000) {
    return { events: [], output: '', error: '代码为空或超过长度上限（200KB）', timeMs: 0 };
  }
  return await runCCTracer(payload.code, 'cpp');
});

/* ---------- 7. 生命周期 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerPrivilegedSchemes();

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    installProtocolHandler();
    installMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
