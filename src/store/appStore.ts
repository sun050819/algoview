/**
 * 全局状态（Zustand）
 *
 * 执行管线：本地真实运行 → 事件流 → 前进/后退/跳转 = 从初始状态重放事件
 * 事件流是唯一事实源，保证回放状态与首次执行严格一致。
 */

import { create } from 'zustand';
import type { StepEvent, ReplayState } from '../core/events';
import { emptyReplayState, applyEvent } from '../core/events';
import { LangId } from '../languages';
import { runPythonReal } from '../languages/pythonRuntime';
import { runJavaReal } from '../languages/javaRuntime';
import { runCReal, runCppReal } from '../languages/ccRuntime';

export type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'compiling';

interface AppState {
  lang: LangId;
  code: string;
  theme: 'dark' | 'light';
  // 运行状态
  events: StepEvent[];
  currentStep: number;
  maxStep: number;
  runStatus: RunStatus;
  errorMsg: string | null;
  playing: boolean;
  speed: number; // 0.1 - 5
  // 当前步的可视化状态（由事件重放得到）
  replay: ReplayState;
  // 方法
  setLang: (l: LangId) => void;
  setCode: (c: string) => void;
  setTheme: (t: 'dark' | 'light') => void;
  setSpeed: (s: number) => void;
  run: () => void;
  stepForward: () => void;
  stepBack: () => void;
  play: () => void;
  pause: () => void;
  reset: () => void;
  seekTo: (step: number) => void;
}

const DEFAULT_LANG: LangId = 'python';

let tickAcc = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;

export const useApp = create<AppState>((set, get) => {
  const replayTo = (target: number, events: StepEvent[]) => {
    const state = emptyReplayState();
    const n = Math.max(0, Math.min(target, events.length));
    for (let i = 0; i < n; i++) applyEvent(state, events[i]);
    return { state, n };
  };

  const stopTicker = () => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    tickAcc = 0;
  };

  const startTicker = () => {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      const s = useApp.getState();
      if (!s.playing || s.currentStep >= s.maxStep) {
        if (s.playing && s.currentStep >= s.maxStep) {
          stopTicker();
          set({ playing: false });
        }
        return;
      }
      tickAcc += s.speed * 0.25;
      let steps = 0;
      while (tickAcc >= 1 && steps < 4) {
        tickAcc -= 1;
        steps++;
      }
      if (steps > 0) {
        const target = Math.min(s.currentStep + steps, s.maxStep);
        // 增量推进：从当前 replay state 继续 apply，避免每次从头重放 O(n²)
        const state = s.replay;
        for (let i = s.currentStep; i < target; i++) applyEvent(state, s.events[i]);
        set({ currentStep: target, replay: { ...state } });
      }
    }, 100);
  };

  return {
    lang: DEFAULT_LANG,
    code: '',
    theme: 'dark',
    events: [],
    currentStep: 0,
    maxStep: 0,
    runStatus: 'idle',
    errorMsg: null,
    playing: false,
    speed: 1,
    replay: emptyReplayState(),

    setLang: (l) => {
      stopTicker();
      // 真实执行不依赖任何预置示例：切语言只换语法高亮，编辑器保持空白
      set({ lang: l, code: '', events: [], currentStep: 0, maxStep: 0, runStatus: 'idle', errorMsg: null, replay: emptyReplayState(), playing: false });
    },

    setCode: (c) => {
      set({ code: c, runStatus: 'idle', events: [], currentStep: 0, maxStep: 0, errorMsg: null, replay: emptyReplayState(), playing: false });
      stopTicker();
    },

    setTheme: (t) => set({ theme: t }),
    setSpeed: (s) => set({ speed: s }),

    run: () => {
      const { lang, code } = get();
      stopTicker();
      set({ runStatus: 'compiling', errorMsg: null, playing: false });
      // 让编译状态先渲染，再执行
      setTimeout(async () => {
        try {
          // 唯一执行路径：本机解释器 / 编译器真实执行 + 逐步追踪
          const res =
            lang === 'python'
              ? await runPythonReal(code)
              : lang === 'java'
                ? await runJavaReal(code)
                : lang === 'c'
                  ? await runCReal(code)
                  : await runCppReal(code);
          if (res.error) {
            set({
              runStatus: 'error',
              errorMsg: res.error,
              events: [],
              maxStep: 0,
              currentStep: 0,
              replay: emptyReplayState(),
            });
            return;
          }
          const events = res.events;
          set({
            events,
            maxStep: events.length,
            currentStep: 0,
            replay: emptyReplayState(),
            runStatus: 'done',
          });
          if (events.length > 0) {
            set({ playing: true });
            startTicker();
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          set({ runStatus: 'error', errorMsg: msg, events: [], maxStep: 0, currentStep: 0, replay: emptyReplayState() });
        }
      }, 30);
    },

    stepForward: () => {
      const s = get();
      if (s.currentStep >= s.maxStep) return;
      stopTicker();
      const target = s.currentStep + 1;
      const { state, n } = replayTo(target, s.events);
      set({ currentStep: n, replay: state, playing: false });
    },

    stepBack: () => {
      const s = get();
      if (s.currentStep <= 0) return;
      stopTicker();
      const target = s.currentStep - 1;
      const { state, n } = replayTo(target, s.events);
      set({ currentStep: n, replay: state, playing: false });
    },

    play: () => {
      const s = get();
      if (s.currentStep >= s.maxStep) return;
      set({ playing: true });
      startTicker();
    },

    pause: () => {
      stopTicker();
      set({ playing: false });
    },

    reset: () => {
      stopTicker();
      set({ currentStep: 0, replay: emptyReplayState(), playing: false, runStatus: 'idle' });
    },

    seekTo: (step) => {
      const s = get();
      stopTicker();
      const target = Math.max(0, Math.min(step, s.maxStep));
      const { state, n } = replayTo(target, s.events);
      set({ currentStep: n, replay: state, playing: false });
    },
  };
});
