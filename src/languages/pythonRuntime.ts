/**
 * Python 真实运行时轨（轨 B）
 *
 * 走本地 Python 解释器 + sys.settrace 追踪，把"任意真实 Python 代码"
 * （f-string、切片、lambda、集合、标准库等教学子集之外的语法）也变成
 * 统一事件流，渲染层零改动。
 *
 * 仅桌面版可用（依赖 window.dsaDesktop.executePython 子进程桥）；
 * 浏览器版调用时给出友好提示并建议切回教学模式。
 */
import type { StepEvent } from '../core/events';
import type { V } from '../core/value';
import { runLocal, hasDesktop as hasDesktopEnv } from './localBridge';

/** Python tracer 输出的原始追踪事件 */
export interface PythonTraceEvent {
  type: 'call' | 'line' | 'return';
  line: number;
  fn: string;
  vars: Record<string, unknown>;
  stack: string[];
  /** 模块级全局变量的实时快照（Java/C 追踪器用同一个字段名） */
  gvars?: Record<string, unknown>;
  ret?: unknown;
}

export interface PythonRunResult {
  events: PythonTraceEvent[];
  output: string;
  error: string | null;
  timeMs: number;
}

/** 声明桌面桥类型（window.dsaDesktop 由 preload 注入） */
declare global {
  interface Window {
    dsaDesktop?: {
      executePython: (code: string) => Promise<PythonRunResult>;
      executeJava?: (code: string) => Promise<{
        events: PythonTraceEvent[];
        output: string;
        error: string | null;
        timeMs: number;
      }>;
      executeC?: (code: string) => Promise<{
        events: PythonTraceEvent[];
        output: string;
        error: string | null;
        timeMs: number;
      }>;
      executeCpp?: (code: string) => Promise<{
        events: PythonTraceEvent[];
        output: string;
        error: string | null;
        timeMs: number;
      }>;
    };
  }
}

export function isDesktopEnv(): boolean {
  return hasDesktopEnv();
}

/** 把原始追踪事件转换为统一 StepEvent */
export function convertTraceEvents(traces: PythonTraceEvent[], output: string): StepEvent[] {
  const events: StepEvent[] = [];
  let step = 0;
  let prevVars: Record<string, unknown> = {};
  let prevGlobals: Record<string, unknown> = {};

  const push = (ev: Omit<StepEvent, 'step'>) => {
    events.push({ ...ev, step: step++ } as StepEvent);
  };

  for (const t of traces) {
    const isTop = t.stack.length <= 1;

    // 全局快照先落地：递归期间函数内看到的是同一份对象，
    // 不刷全局的话画面会停在进入函数前的旧值。
    // 顶层帧的 f_locals 就是 f_globals，此时交给下面的 vars 处理即可。
    if (t.gvars && !isTop) {
      for (const [name, value] of Object.entries(t.gvars)) {
        const prev = prevGlobals[name];
        if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(value)) continue;
        push({
          type: 'variable',
          line: t.line || 0,
          name,
          value: value as V,
          scope: 'global',
          desc: `变量 ${name} 更新`,
        });
      }
      prevGlobals = t.gvars;
    } else if (t.gvars) {
      prevGlobals = t.gvars;
    }

    if (t.type === 'call') {
      const args = Object.entries(t.vars)
        .slice(0, 12)
        .map(([name, value]) => ({ name, value: value as V }));
      push({
        type: 'call',
        line: t.line || 0,
        fn: t.fn,
        args,
        desc: `调用函数 ${t.fn}(${args.map((a) => a.name).join(', ')})`,
      });
      prevVars = {};
    } else if (t.type === 'return') {
      push({ type: 'return', line: t.line || 0, fn: t.fn, desc: `${t.fn}() 返回` });
      prevVars = {};
    } else {
      // line 事件：行说明 + 变更变量
      push({ type: 'comment', line: t.line, desc: `执行 ${t.fn}() 第 ${t.line} 行` });
      for (const [name, value] of Object.entries(t.vars)) {
        const prev = prevVars[name];
        if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(value)) continue;
        push({
          type: 'variable',
          line: t.line,
          name,
          value: value as V,
          scope: isTop ? 'global' : t.fn,
          desc: `变量 ${name} 更新`,
        });
      }
    }
    prevVars = t.vars;
  }

  // print 输出追加为 print 事件
  if (output && output.trim().length > 0) {
    for (const line of output.split('\n')) {
      if (line.trim() !== '') push({ type: 'print', line: 0, text: line, desc: '程序输出' });
    }
  }
  return events;
}

/**
 * 执行入口：桌面版子进程运行真实 Python，返回统一事件流
 * 浏览器版返回友好错误
 */
export async function runPythonReal(code: string): Promise<{ events: StepEvent[]; error: string | null; timeMs?: number }> {
  const res = await runLocal('python', code);
  if (res.error) return { events: [], error: res.error, timeMs: res.timeMs };
  return { events: convertTraceEvents(res.events, res.output), error: null, timeMs: res.timeMs };
}

/** 真实轨支持的提示（界面展示） */
export const PYTHON_REAL_NOTES = [
  '真实模式：调用本地 Python 解释器执行任意真实代码（f-string、lambda、切片、集合、标准库、类继承均可）',
  '逐行追踪 + 变量快照；数组/链表/树/图由启发式识别，识别不了则显示变量表',
  '沙箱：步数/超时/输出上限，禁用文件与网络等危险内建',
];
