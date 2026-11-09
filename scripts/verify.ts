/**
 * 核心链路验证（Node 环境，真实执行）
 *
 * 验证的是产品实际跑的那条路：
 *   本机编译器/解释器真实执行 → 事件流 → 逐步重放 → 可视化模型
 *
 * 用法：npm run verify
 */

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { emptyReplayState, applyEvent } from '../src/core/events';
import type { StepEvent, ReplayState } from '../src/core/events';
import { buildModel } from '../src/visualizer/model';
import { convertTraceEvents } from '../src/languages/pythonRuntime';

// npm script 的工作目录恒为项目根；产物 verify.mjs 放在 .cache/ 里，
// 所以不能用 import.meta.url 去推根目录，否则会指到 .cache/runtime。
const root = path.resolve(process.cwd());
const runtimeDir = path.join(root, 'runtime');
if (!fs.existsSync(path.join(runtimeDir, 'python-tracer.py'))) {
  throw new Error('请在项目根目录执行 npm run verify（找不到 runtime/）');
}

const mod = await import(pathToFileURL(path.join(root, 'server', 'runner.cjs')).href);
const run: (lang: string, code: string, runtimeDir: string) =>
  Promise<{ events: StepEvent[]; output: string; error: string | null; timeMs: number }> =
  (mod as any).run ?? (mod as any).default.run;

let pass = 0;
let fail = 0;
const ok = (msg: string) => { console.log('OK   ' + msg); pass++; };
const bad = (msg: string) => { console.log('FAIL ' + msg); fail++; };

function replayAll(events: StepEvent[]): ReplayState {
  const s = emptyReplayState();
  for (const e of events) applyEvent(s, e);
  return s;
}

/* ---------- 1. 四语言真实执行 + 可视化结构识别 ---------- */

interface Case {
  lang: 'python' | 'java' | 'c' | 'cpp';
  name: string;
  code: string;
  /** 期望：至少出现一张这类卡片 */
  expect: 'array' | 'tree' | 'list' | 'graph';
}

const CASES: Case[] = [
  {
    lang: 'python',
    name: '快排 + 数组',
    expect: 'array',
    code: `def qs(a, lo, hi):
    if lo >= hi:
        return
    p = a[hi]
    i = lo
    for j in range(lo, hi):
        if a[j] < p:
            a[i], a[j] = a[j], a[i]
            i += 1
    a[i], a[hi] = a[hi], a[i]
    qs(a, lo, i - 1)
    qs(a, i + 1, hi)

arr = [7, 2, 9, 4, 1]
qs(arr, 0, len(arr) - 1)
print("sorted:", arr)
`,
  },
  {
    lang: 'java',
    name: '二叉搜索树',
    expect: 'tree',
    code: `class Node {
    int v; Node l, r;
    Node(int v) { this.v = v; }
}
public class Main {
    static Node ins(Node t, int v) {
        if (t == null) return new Node(v);
        if (v < t.v) t.l = ins(t.l, v);
        else t.r = ins(t.r, v);
        return t;
    }
    public static void main(String[] a) {
        int[] d = {50, 30, 70, 20};
        Node root = null;
        for (int v : d) root = ins(root, v);
        System.out.println("ok");
    }
}
`,
  },
  {
    lang: 'cpp',
    name: 'vector 快排',
    expect: 'array',
    code: `#include <iostream>
#include <vector>
using namespace std;
void qs(vector<int>& a, int lo, int hi) {
    if (lo >= hi) return;
    int p = a[hi], i = lo;
    for (int j = lo; j < hi; j++) if (a[j] < p) { swap(a[i], a[j]); i++; }
    swap(a[i], a[hi]);
    qs(a, lo, i - 1); qs(a, i + 1, hi);
}
int main() {
    vector<int> a = {7, 2, 9, 4, 1};
    qs(a, 0, a.size() - 1);
    cout << "sorted:";
    for (int x : a) cout << " " << x;
    cout << endl;
    return 0;
}
`,
  },
  {
    lang: 'c',
    name: '递归 + 数组',
    expect: 'array',
    code: `#include <stdio.h>
int fib(int n) { if (n <= 1) return n; return fib(n - 1) + fib(n - 2); }
int main(void) {
    int a[6], i;
    for (i = 0; i < 6; i++) a[i] = fib(i);
    for (i = 0; i < 6; i++) printf("%d ", a[i]);
    printf("\\n");
    return 0;
}
`,
  },
];

for (const c of CASES) {
  try {
    const res = await run(c.lang, c.code, runtimeDir);
    if (res.error) { bad(`[${c.lang}] ${c.name}: ${res.error.slice(0, 120)}`); continue; }
    if (res.events.length === 0) { bad(`[${c.lang}] ${c.name}: 事件流为空`); continue; }

    // 追踪器给的是原始 call/line/return 事件，先过统一转换器
    const events = convertTraceEvents(res.events as any, res.output);
    if (events.length === 0) { bad(`[${c.lang}] ${c.name}: 转换后事件流为空`); continue; }

    const state = replayAll(events);
    const model = buildModel(state);
    const counts = {
      array: model.arrays.length,
      tree: model.trees.length,
      list: model.lists.length,
      graph: model.graphs.length,
    };
    if (counts[c.expect] === 0) {
      bad(`[${c.lang}] ${c.name}: 没有识别出 ${c.expect}（${JSON.stringify(counts)}）`);
      continue;
    }
    // 数组必须真的带数字，不能是脏指针字符串
    if (c.expect === 'array') {
      const arr = model.arrays[0];
      if (!arr.items.every((x) => typeof x === 'number')) {
        bad(`[${c.lang}] ${c.name}: 数组元素不是数字 → ${JSON.stringify(arr.items).slice(0, 80)}`);
        continue;
      }
    }
    ok(`[${c.lang}] ${c.name}: ${res.events.length} 步 | ${JSON.stringify(counts)} | ${res.timeMs}ms`);
  } catch (e) {
    bad(`[${c.lang}] ${c.name}: 异常 ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ---------- 2. 回放确定性：同一事件流重放两次必须一致 ---------- */

if (CASES.length > 0) {
  const res = await run(CASES[1].lang, CASES[1].code, runtimeDir);
  if (!res.error && res.events.length > 0) {
    const a = JSON.stringify(replayAll(convertTraceEvents(res.events as any, res.output)).globals);
    const b = JSON.stringify(replayAll(convertTraceEvents(res.events as any, res.output)).globals);
    if (a === b) ok('回放确定性：两次重放状态完全一致');
    else bad('回放确定性：两次重放状态不一致');
  } else {
    bad('回放确定性：无法取得事件流');
  }
}

/* ---------- 3. 错误透传：语法错误必须原样报出来 ---------- */

{
  const res = await run('python', 'def f():\nreturn 1\n', runtimeDir);
  if (res.error && /IndentationError|SyntaxError|行|line/i.test(res.error)) {
    ok('错误透传：Python 语法错误已上报 → ' + res.error.split('\n')[0].slice(0, 60));
  } else {
    bad('错误透传：语法错误未被上报');
  }
}

/* ---------- 4. 空输入不应打到编译器 ---------- */

{
  const res = await run('python', '   \n\n', runtimeDir);
  if (res.error) ok('空输入：直接给出提示，不调用编译器');
  else bad('空输入：应当报错提示');
}

/* ---------- 汇总 ---------- */

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
