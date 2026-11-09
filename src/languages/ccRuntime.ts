/**
 * C / C++ 真实运行时轨（轨 B · C / C++）
 *
 * 走本地 MinGW 工具链：gcc/g++ -g -O0 编译 → gdb MI2 逐步追踪
 * （runtime/gdb-tracer.mjs）→ 统一事件流，渲染层零改动。
 *
 * 支持任意真实 C/C++ 语法（指针、结构体、递归、库函数等），
 * 数组/指针参数自动还原为数组内容供可视化。
 *
 * 仅桌面版可用（依赖 window.dsaDesktop.executeC / executeCpp 子进程桥）；
 * 浏览器版走本地执行服务，执行的是同一条 GDB 追踪链路。
 *
 * 运行要求：本机需安装 MinGW-w64 工具链（gcc/g++/gdb）。优先用 PATH；
 * 没进 PATH 时，runtime/toolchain.cjs 会按各盘常规安装布局自动探测，
 * 也可以用 DSA_MINGW_DIR / DSA_GCC / DSA_GDB 显式指定。
 */
import type { StepEvent } from '../core/events';
import { convertTraceEvents } from './pythonRuntime';
import type { PythonTraceEvent } from './pythonRuntime';
import { runLocal } from './localBridge';

export interface CCRunResult {
  events: PythonTraceEvent[];
  output: string;
  error: string | null;
  timeMs: number;
}

/**
 * 执行入口：桌面版子进程编译运行真实 C/C++，返回统一事件流
 * 浏览器版返回友好错误
 */
export async function runCReal(code: string): Promise<{ events: StepEvent[]; error: string | null; timeMs?: number }> {
  const res = await runLocal('c', code);
  if (res.error) return { events: [], error: res.error, timeMs: res.timeMs };
  return { events: convertTraceEvents(res.events, res.output), error: null, timeMs: res.timeMs };
}

export async function runCppReal(code: string): Promise<{ events: StepEvent[]; error: string | null; timeMs?: number }> {
  const res = await runLocal('cpp', code);
  if (res.error) return { events: [], error: res.error, timeMs: res.timeMs };
  return { events: convertTraceEvents(res.events, res.output), error: null, timeMs: res.timeMs };
}

/** 真实轨支持的提示（界面展示） */
export const CC_REAL_NOTES = [
  '真实模式（C/C++）：调用本地 MinGW 工具链编译执行任意真实代码（指针、结构体、递归、库函数均可）',
  'gdb MI 逐步追踪 + 变量快照；数组参数自动还原数组内容，链表/树由启发式识别，识别不了则显示变量表',
  '沙箱：步数/超时/输出上限',
  '运行要求：本机需安装 MinGW-w64（gcc/g++/gdb），Dev-C++ 自带的 MinGW64 也可直接使用',
];
