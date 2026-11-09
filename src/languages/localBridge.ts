/**
 * 本地执行通道（真实运行的唯一入口）
 *
 * 浏览器没有编译器，所以"真实运行"必须落到本机进程上。两条可用通道：
 *   1. 桌面版（Electron）：preload 注入的 window.dsaDesktop，走 IPC
 *   2. 浏览器版：本地执行服务 server/bridge.cjs（127.0.0.1:5321），走 HTTP
 *
 * 两者返回结构一致，上层（appStore）不需要关心用的是哪条。
 */
import type { PythonTraceEvent } from './pythonRuntime';

export type LangKey = 'python' | 'java' | 'c' | 'cpp';

export interface EngineResult {
  events: PythonTraceEvent[];
  output: string;
  error: string | null;
  timeMs: number;
}

export interface EngineStatus {
  ok: boolean;
  channel: 'desktop' | 'bridge' | 'none';
  tools?: {
    python?: { ok: boolean; path?: string | null };
    java?: { ok: boolean };
    c?: { ok: boolean };
    cpp?: { ok: boolean };
  };
  message: string;
}

/**
 * 本地执行服务地址。
 * 页面本身就是这个服务托管的（/algo/），所以优先跟随当前源——换端口、换机器都不用改代码；
 * 只有从 file:// 直接打开时没有源可用，才退回默认端口。
 * 需要自定义时：地址栏加 ?bridge=http://127.0.0.1:5399
 */
function bridgeOrigin(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:5321';
  const param = new URLSearchParams(window.location.search).get('bridge');
  if (param) return param.replace(/\/+$/, '');
  const { protocol, origin } = window.location;
  if (protocol === 'http:' || protocol === 'https:') return origin;
  return 'http://127.0.0.1:5321';
}

const MISSING_BRIDGE_HINT =
  '本地执行服务没连上。真实运行需要它：双击个人主页目录里的「启动个人主页.cmd」' +
  '（或本应用目录里的「start.cmd」），保持窗口开着，再点运行。';

function desktop() {
  return typeof window !== 'undefined' ? window.dsaDesktop : undefined;
}

export function hasDesktop(): boolean {
  return !!desktop();
}

/** 探测可用通道；结果缓存 4s，避免每次运行都多一次请求 */
let cached: { at: number; status: EngineStatus } | null = null;

export async function engineStatus(force = false): Promise<EngineStatus> {
  const now = Date.now();
  if (!force && cached && now - cached.at < 4000) return cached.status;

  let status: EngineStatus;
  if (hasDesktop()) {
    status = { ok: true, channel: 'desktop', message: '桌面版 · 本地运行时已就绪' };
  } else {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1600);
      const res = await fetch(`${bridgeOrigin()}/health`, { signal: ctl.signal });
      clearTimeout(t);
      const json = await res.json();
      status = {
        ok: !!json?.ok,
        channel: 'bridge',
        tools: json?.tools,
        message: '浏览器版 · 已连接本地执行服务',
      };
    } catch {
      status = { ok: false, channel: 'none', message: MISSING_BRIDGE_HINT };
    }
  }
  cached = { at: now, status };
  return status;
}

/** 只清缓存，不改状态（切换语言/重试时用） */
export function invalidateEngineStatus() {
  cached = null;
}

export async function runLocal(lang: LangKey, code: string): Promise<EngineResult> {
  if (!code.trim()) {
    return { events: [], output: '', error: '编辑器是空的 —— 先写点代码再运行', timeMs: 0 };
  }

  const api = desktop();
  if (api) {
    const fn =
      lang === 'python' ? api.executePython
        : lang === 'java' ? api.executeJava
          : lang === 'c' ? api.executeC
            : api.executeCpp;
    if (!fn) {
      return { events: [], output: '', error: `桌面版未提供 ${lang.toUpperCase()} 运行通道，请更新客户端`, timeMs: 0 };
    }
    try {
      return await fn(code);
    } catch (e) {
      return { events: [], output: '', error: '桌面运行时调用失败：' + (e instanceof Error ? e.message : String(e)), timeMs: 0 };
    }
  }

  try {
    const res = await fetch(`${bridgeOrigin()}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, code }),
    });
    if (!res.ok) {
      return { events: [], output: '', error: `本地执行服务返回 ${res.status}`, timeMs: 0 };
    }
    const json = (await res.json()) as EngineResult;
    return {
      events: Array.isArray(json.events) ? json.events : [],
      output: json.output ?? '',
      error: json.error ?? null,
      timeMs: json.timeMs ?? 0,
    };
  } catch {
    return { events: [], output: '', error: MISSING_BRIDGE_HINT, timeMs: 0 };
  }
}
