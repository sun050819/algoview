/**
 * Java 真实运行时轨（轨 B · Java）
 *
 * 走本地 JDK：javac -g 编译 → JDWP 启动目标 JVM（suspend=y）→ JavaTracer
 * （JDI 客户端）逐步追踪 → 统一事件流，渲染层零改动。
 *
 * 支持任意真实 Java 语法：ArrayList、泛型、Collections、增强 for、
 * StringBuilder、字符串 equals、switch 表达式、lambda 等（教学子集之外的）。
 *
 * 仅桌面版可用（依赖 window.dsaDesktop.executeJava 子进程桥）；
 * 浏览器版调用时给出友好提示并建议切回教学模式。
 */
import type { StepEvent } from '../core/events';
import { convertTraceEvents } from './pythonRuntime';
import type { PythonTraceEvent } from './pythonRuntime';
import { runLocal } from './localBridge';

export interface JavaRunResult {
  events: PythonTraceEvent[];
  output: string;
  error: string | null;
  timeMs: number;
}

/**
 * 执行入口：桌面版子进程编译运行真实 Java，返回统一事件流
 * 浏览器版返回友好错误
 */
export async function runJavaReal(code: string): Promise<{ events: StepEvent[]; error: string | null; timeMs?: number }> {
  const res = await runLocal('java', code);
  if (res.error) return { events: [], error: res.error, timeMs: res.timeMs };
  return { events: convertTraceEvents(res.events, res.output), error: null, timeMs: res.timeMs };
}

/** 真实轨支持的提示（界面展示） */
export const JAVA_REAL_NOTES = [
  '真实模式（Java）：调用本地 JDK 编译执行任意真实代码（ArrayList、泛型、Collections、增强 for、lambda、StringBuilder 均可）',
  'JDWP/JDI 逐步追踪 + 变量快照；数组/链表/树/图由启发式识别，识别不了则显示变量表',
  '沙箱：步数/超时/输出上限',
  '运行要求：本机需安装 JDK（javac/java 在 PATH 中）',
];
