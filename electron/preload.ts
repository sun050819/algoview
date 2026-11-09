/**
 * 算法可视化学习平台 · Preload 脚本
 * 安全基线：contextIsolation + sandbox，仅暴露白名单 IPC 桥
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** 打开代码文件（系统对话框）→ { filePath, content } | null */
  openSourceFile: (): Promise<{ filePath: string; content: string } | null> =>
    ipcRenderer.invoke('file:pick-open'),
  /** 另存为代码文件（系统对话框）→ boolean */
  saveSourceFile: (content: string, defaultName?: string): Promise<boolean> =>
    ipcRenderer.invoke('file:save-as', { content, defaultName }),
  /** 应用信息 */
  appInfo: (): Promise<{ version: string; platform: string; electron: string; node: string; chrome: string }> =>
    ipcRenderer.invoke('app:info'),
  /** 真实运行时：在本地 Python 中执行代码并返回追踪事件流（仅桌面版可用） */
  executePython: (code: string): Promise<{
    events: { type: string; line: number; fn: string; vars: Record<string, unknown>; stack: string[]; ret?: unknown }[];
    output: string;
    error: string | null;
    timeMs: number;
  }> => ipcRenderer.invoke('runtime:python', { code }),
  /** 真实运行时：在本地 JDK 中编译执行 Java 并返回追踪事件流（仅桌面版可用） */
  executeJava: (code: string): Promise<{
    events: { type: string; line: number; fn: string; vars: Record<string, unknown>; stack: string[]; ret?: unknown }[];
    output: string;
    error: string | null;
    timeMs: number;
  }> => ipcRenderer.invoke('runtime:java', { code }),
  /** 真实运行时：本地 gcc/gdb 编译单步执行 C 并返回追踪事件流（仅桌面版可用） */
  executeC: (code: string): Promise<{
    events: { type: string; line: number; fn: string; vars: Record<string, unknown>; stack: string[]; ret?: unknown }[];
    output: string;
    error: string | null;
    timeMs: number;
  }> => ipcRenderer.invoke('runtime:c', { code }),
  /** 真实运行时：本地 g++/gdb 编译单步执行 C++ 并返回追踪事件流（仅桌面版可用） */
  executeCpp: (code: string): Promise<{
    events: { type: string; line: number; fn: string; vars: Record<string, unknown>; stack: string[]; ret?: unknown }[];
    output: string;
    error: string | null;
    timeMs: number;
  }> => ipcRenderer.invoke('runtime:cpp', { code }),
  /** 订阅文件打开事件（菜单触发） */
  onFileOpened: (cb: (payload: { filePath: string; content: string }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { filePath: string; content: string }) => cb(payload);
    ipcRenderer.on('file:opened', listener);
    return () => ipcRenderer.removeListener('file:opened', listener);
  },
  /** 订阅保存请求事件（菜单触发） */
  onSaveRequested: (cb: (payload: { filePath: string }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { filePath: string }) => cb(payload);
    ipcRenderer.on('file:request-save', listener);
    return () => ipcRenderer.removeListener('file:request-save', listener);
  },
};

contextBridge.exposeInMainWorld('dsaDesktop', api);

export type DesktopApi = typeof api;
