/* 四语言执行引擎冒烟测试（不经过浏览器）
   用法：在项目根目录执行 npm run test:engine */
'use strict';
const runner = require('../server/runner.cjs');
const path = require('node:path');

const RUNTIME = path.join(__dirname, '..', 'runtime');

const PY = `
def qs(a, lo, hi):
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

arr = [5, 2, 9, 1, 7]
qs(arr, 0, 4)
print("sorted:", arr)
`;

const JAVA = `
class Node {
    int v;
    Node l, r;
    Node(int v) { this.v = v; }
}

public class Main {
    static Node insert(Node root, int v) {
        if (root == null) return new Node(v);
        if (v < root.v) root.l = insert(root.l, v);
        else root.r = insert(root.r, v);
        return root;
    }
    static int depth(Node n) {
        if (n == null) return 0;
        int a = depth(n.l);
        int b = depth(n.r);
        return (a > b ? a : b) + 1;
    }
    public static void main(String[] args) {
        Node root = null;
        int[] data = {5, 2, 9, 1, 7};
        for (int x : data) root = insert(root, x);
        System.out.println("depth=" + depth(root));
    }
}
`;

const CPP = `
#include <iostream>
using namespace std;

void qs(int a[], int lo, int hi) {
    if (lo >= hi) return;
    int p = a[hi], i = lo;
    for (int j = lo; j < hi; j++) {
        if (a[j] < p) { int t = a[i]; a[i] = a[j]; a[j] = t; i++; }
    }
    int t = a[i]; a[i] = a[hi]; a[hi] = t;
    qs(a, lo, i - 1);
    qs(a, i + 1, hi);
}

int main() {
    int arr[5] = {5, 2, 9, 1, 7};
    qs(arr, 0, 4);
    for (int i = 0; i < 5; i++) cout << arr[i] << " ";
    cout << endl;
    return 0;
}
`;

const C = `
#include <stdio.h>

int fib(int n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
}

int main() {
    int r = fib(6);
    printf("fib(6)=%d\\n", r);
    return 0;
}
`;

(async () => {
  const cases = [
    ['python', PY],
    ['java', JAVA],
    ['cpp', CPP],
    ['c', C],
  ];
  for (const [lang, code] of cases) {
    const t0 = Date.now();
    const r = await runner.run(lang, code, RUNTIME);
    const kinds = {};
    for (const e of r.events) kinds[e.type] = (kinds[e.type] || 0) + 1;
    console.log('\n══ ' + lang.toUpperCase() + ' ══');
    console.log('  耗时', Date.now() - t0, 'ms | 事件', r.events.length, '|', JSON.stringify(kinds));
    console.log('  output:', JSON.stringify((r.output || '').slice(0, 160)));
    console.log('  error :', r.error ? String(r.error).slice(0, 300) : 'null');
    const calls = r.events.filter((e) => e.type === 'call').map((e) => e.fn);
    const rets = r.events.filter((e) => e.type === 'return').map((e) => e.fn);
    console.log('  call:', calls.slice(0, 8).join('>'), '| return:', rets.length);
    const last = r.events.filter((e) => e.type === 'line').slice(-1)[0];
    if (last) console.log('  末条 line 变量:', JSON.stringify(last.vars).slice(0, 220));
  }
})();
