/**
 * 可视化模型：从回放状态（ReplayState）自动识别数据结构
 *
 * 识别规则（跨语言统一）：
 *  - 数组变量（V[]）→ 数组格子序列
 *  - 二维数字数组 → 图（邻接矩阵）
 *  - 元素为数组的数组 → 图（邻接表）
 *  - 字典（plain object）→ 哈希表卡片
 *  - 含 next/prev 字段的对象链 → 链表（从全局根变量开始沿指针遍历）
 *  - 含 left/right 字段的对象 → 二叉树（从 root 开始）
 */

import type { ReplayState, ObjectV } from '../core/events';
import { V, isRef } from '../core/value';

export interface ArrayBand {
  kind: 'array';
  name: string;
  items: V[];
  /** 下标指针标注（i / j / lo / hi / mid …），用于在格子上方画出游标 */
  marks: PointerMark[];
  /** 同一份数据的其他叫法（Python 的 arr 传进函数变成 a），只画一张卡片 */
  alias?: string[];
}

export interface PointerMark {
  name: string;
  index: number;
}

export interface DictBand {
  kind: 'dict';
  name: string;
  entries: { key: string; value: V }[];
}

export interface ListNode {
  id: number;
  value: V;
  typeName: string;
  nextId: number | null;
  prevId: number | null;
}
export interface ListBand {
  kind: 'list';
  name: string;
  nodes: ListNode[];
  isCircular: boolean;
}

export interface TreeNodeInfo {
  id: number;
  value: V;
  leftId: number | null;
  rightId: number | null;
  typeName: string;
}
export interface TreeBand {
  kind: 'tree';
  name: string;
  rootId: number;
  nodes: Map<number, TreeNodeInfo>;
  order: number[];
}

export interface GraphBand {
  kind: 'graph';
  name: string;
  size: number;
  directed: boolean;
  /** 邻接权重矩阵（null 表示无边） */
  weights: (number | null)[][];
  /** 已提取的边 [from, to, weight] */
  edges: [number, number, number | null][];
}

export interface VisualModel {
  arrays: ArrayBand[];
  lists: ListBand[];
  trees: TreeBand[];
  graphs: GraphBand[];
  dicts: DictBand[];
}

export function emptyModel(): VisualModel {
  return { arrays: [], lists: [], trees: [], graphs: [], dicts: [] };
}

const INF_THRESHOLD = 9999;

export function buildModel(state: ReplayState): VisualModel {
  const model = emptyModel();
  const { globals, objects } = state;
  const topFrame = state.frames[state.frames.length - 1];

  // 收集整数变量，用来给数组格子标"指针"（i / j / lo / hi / mid …）
  const numericVars: Record<string, number> = {};
  const collectNum = (src: Record<string, V> | undefined) => {
    if (!src) return;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'number' && Number.isInteger(v)) numericVars[k] = v;
    }
  };
  collectNum(globals);
  if (topFrame) { collectNum(topFrame.args); collectNum(topFrame.locals); }

  // 只认典型的游标名，且必须落在数组范围内 —— 避免把 n/size 这类计数也标上去
  const POINTER_NAME = /^(i|j|k|m|p|q|ii|jj|lo|hi|mid|left|right|low|high|begin|end|start|stop|first|last|pos|idx|cur|curr|slow|fast|from|to|li|ri|si|ei|pivotIdx|minIdx|maxIdx)$/;
  const pointerMarks = (len: number): PointerMark[] => {
    const out: PointerMark[] = [];
    for (const [name, v] of Object.entries(numericVars)) {
      if (POINTER_NAME.test(name) && v >= 0 && v < len) out.push({ name, index: v });
    }
    out.sort((a, b) => a.index - b.index);
    return out.slice(0, 6);
  };

  // 1) 数组 / 图 / 字典
  //    变量来源优先级：当前栈帧的 args → locals → 全局。
  //    同名时必须用栈帧里的那份：C++ 的 vector<int>& 参数、Python 的形参
  //    都是同一个对象，而全局变量的快照往往停留在上一次顶层执行，是过期值。
  const scopeVars: Record<string, V> = {};
  const frameNames = new Set<string>();
  if (topFrame) {
    for (const [k, v] of Object.entries(topFrame.args)) { scopeVars[k] = v; frameNames.add(k); }
    for (const [k, v] of Object.entries(topFrame.locals)) { scopeVars[k] = v; frameNames.add(k); }
  }
  for (const [k, v] of Object.entries(globals)) if (!(k in scopeVars)) scopeVars[k] = v;
  const seenBand = new Set<string>();

  for (const [name, val] of Object.entries(scopeVars)) {
    // 编译器/gdb 注入的临时量（__for_begin 等）不是用户变量，不参与可视化
    if (name.startsWith('__')) continue;
    if (Array.isArray(val)) {
      // 空数组（如 Java 的 args、还没 push 的容器）不该占一条空 band
      if (val.length === 0) continue;
      if (seenBand.has('a:' + name)) continue;
      seenBand.add('a:' + name);
      // 邻接矩阵：元素全部为数字
      if (val.length > 0 && val.every((x) => Array.isArray(x) && (x as V[]).length > 0 && (x as V[]).every((y) => typeof y === 'number'))) {
        const m = val as V[][];
        const size = m.length;
        const weights: (number | null)[][] = [];
        const edges: [number, number, number | null][] = [];
        for (let i = 0; i < size; i++) {
          weights.push([]);
          for (let j = 0; j < size; j++) {
            const w = m[i][j];
            const nw = typeof w === 'number' && w > 0 && w < INF_THRESHOLD ? w : null;
            weights[i].push(nw);
          }
        }
        for (let i = 0; i < size; i++) {
          for (let j = 0; j < size; j++) {
            const w = weights[i][j];
            if (w !== null) edges.push([i, j, w]);
          }
        }
        const directed = !isSymmetric(weights);
        model.graphs.push({ kind: 'graph', name, size, directed, weights, edges });
        continue;
      }
      // 邻接表：元素为数组
      if (val.length > 0 && val.every((x) => Array.isArray(x))) {
        const adj = val as V[][];
        const size = adj.length;
        const weights: (number | null)[][] = [];
        const edges: [number, number, number | null][] = [];
        for (let i = 0; i < size; i++) {
          weights.push(new Array(size).fill(null));
          for (const nb of adj[i]) {
            if (typeof nb === 'number' && nb >= 0 && nb < size) {
              weights[i][nb] = 1;
              edges.push([i, nb, 1]);
            }
          }
        }
        model.graphs.push({ kind: 'graph', name, size, directed: true, weights, edges });
        continue;
      }
      model.arrays.push({ kind: 'array', name, items: val, marks: pointerMarks(val.length) });
    } else if (typeof val === 'object' && val !== null && !isRef(val)) {
      const entries = Object.entries(val as Record<string, V>).map(([k, v]) => ({ key: k, value: v }));
      if (entries.length > 0) model.dicts.push({ kind: 'dict', name, entries });
    }
  }

  // 1.5) 真实轨兜底：裸嵌套 JSON（未走 isRef 注册，如 JavaTNode{v,l,r}）→ 直接画树/链表
  const plainVisited = new Set<number>();
  const plainIdMap = new WeakMap<object, number>();
  let plainSeq = 1;
  const pid = (o: object): number => {
    let id = plainIdMap.get(o);
    if (id === undefined) { id = -(plainSeq++); plainIdMap.set(o, id); }
    return id;
  };
  const TREE_L = ['left', 'l', 'leftChild', 'lc'];
  const TREE_R = ['right', 'r', 'rightChild', 'rc'];
  const pickTreeChild = (o: Record<string, unknown>, keys: string[]): unknown => {
    for (const k of keys) if (k in o) return o[k];
    return undefined;
  };
  const mainScalar = (o: Record<string, unknown>): V => {
    for (const k of ['v', 'val', 'value', 'data', 'key']) if (k in o) return o[k] as V;
    for (const [k, v] of Object.entries(o)) {
      if (!TREE_L.concat(TREE_R, ['next', 'prev']).includes(k)) return v as V;
    }
    return null;
  };
  const buildPlainTree = (root: Record<string, unknown>, name: string) => {
    const nodes = new Map<number, TreeNodeInfo>();
    const order: number[] = [];
    const stack: [unknown][] = [[root]];
    let guard = 0;
    while (stack.length > 0 && guard < 500) {
      guard++;
      const [cur] = stack.pop()!;
      if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) continue;
      const co = cur as Record<string, unknown>;
      const id = pid(co);
      if (plainVisited.has(id)) continue;
      plainVisited.add(id);
      const l = pickTreeChild(co, TREE_L);
      const r = pickTreeChild(co, TREE_R);
      nodes.set(id, {
        id,
        value: mainScalar(co),
        leftId: typeof l === 'object' && l !== null && !Array.isArray(l) ? pid(l) : null,
        rightId: typeof r === 'object' && r !== null && !Array.isArray(r) ? pid(r) : null,
        typeName: 'node',
      });
      order.push(id);
      if (typeof r === 'object' && r !== null && !Array.isArray(r)) stack.push([r]);
      if (typeof l === 'object' && l !== null && !Array.isArray(l)) stack.push([l]);
    }
    if (order.length > 0) model.trees.push({ kind: 'tree', name, rootId: pid(root), nodes, order });
  };
  const buildPlainList = (root: Record<string, unknown>, name: string) => {
    const nodes: ListNode[] = [];
    let cur: unknown = root;
    let guard = 0;
    while (typeof cur === 'object' && cur !== null && !Array.isArray(cur) && guard < 300) {
      guard++;
      const co = cur as Record<string, unknown>;
      const id = pid(co);
      if (plainVisited.has(id)) break;
      plainVisited.add(id);
      const next = co.next;
      const prev = co.prev;
      nodes.push({
        id,
        value: mainScalar(co),
        typeName: 'node',
        nextId: typeof next === 'object' && next !== null && !Array.isArray(next) ? pid(next) : null,
        prevId: typeof prev === 'object' && prev !== null && !Array.isArray(prev) ? pid(prev) : null,
      });
      cur = next;
    }
    if (nodes.length > 0) {
      const isCircular = !!nodes[nodes.length - 1] && nodes[nodes.length - 1].nextId === pid(root as object);
      model.lists.push({ kind: 'list', name, nodes, isCircular });
    }
  };
  const plainRoots: [string, Record<string, unknown>][] = [];
  const collectPlainRoot = (name: string, v: V) => {
    if (typeof v !== 'object' || v === null || isRef(v) || Array.isArray(v)) return;
    plainRoots.push([name, v as Record<string, unknown>]);
  };
  for (const [n, v] of Object.entries(globals)) collectPlainRoot(n, v);
  for (const f of state.frames) {
    for (const [n, v] of Object.entries(f.locals)) collectPlainRoot(n, v);
    for (const [n, v] of Object.entries(f.args)) collectPlainRoot(n, v);
  }
  for (const [name, o] of plainRoots) {
    if (plainVisited.has(pid(o))) continue;
    const hasTree = TREE_L.some((k) => k in o) || TREE_R.some((k) => k in o);
    const hasList = 'next' in o || 'prev' in o;
    if (hasTree && !hasList) buildPlainTree(o, name);
    else if (hasList) buildPlainList(o, name);
  }

  // 2) 链表 / 树：从所有可达根对象出发（全局变量 + 各栈帧局部变量）
  const visited = new Set<number>();
  const refVars: [string, { ref: 'obj'; id: number }][] = [];
  for (const [name, ref] of Object.entries(globals)) {
    if (isRef(ref)) refVars.push([name, ref]);
  }
  for (const f of state.frames) {
    for (const [name, v] of Object.entries(f.locals)) if (isRef(v)) refVars.push([name, v]);
    for (const [name, v] of Object.entries(f.args)) if (isRef(v)) refVars.push([name, v]);
  }
  for (const [name, ref] of refVars) {
    if (visited.has(ref.id)) continue;
    const obj = objects.get(ref.id);
    if (!obj) continue;
    const fields = Object.keys(obj.fields);
    const hasNext = fields.includes('next') || fields.includes('prev');
    const hasChild = fields.includes('left') || fields.includes('right') || fields.includes('l') || fields.includes('r')
      || fields.includes('leftChild') || fields.includes('rightChild');
    if (hasNext) {
      const band = buildListBand(ref.id, objects, visited);
      if (band && band.nodes.length > 0) model.lists.push({ kind: 'list', name, ...band });
    } else if (hasChild) {
      const band = buildTreeBand(ref.id, objects, visited);
      if (band && band.order.length > 0) model.trees.push({ kind: 'tree', name, ...band });
    }
  }

  // 3) 兜底：函数已返回、根引用丢失时，从"未被任何对象字段引用的对象"找根
  //    （被引用的对象一定是其他对象的子节点；未被引用的对象是链/树的根）
  if (model.lists.length === 0 && model.trees.length === 0) {
    const referenced = new Set<number>();
    for (const [, obj] of objects) {
      for (const f of Object.values(obj.fields)) {
        if (isRef(f)) referenced.add(f.id);
      }
    }
    for (const id of objects.keys()) {
      if (referenced.has(id) || visited.has(id)) continue;
      const obj = objects.get(id);
      if (!obj) continue;
      const fields = Object.keys(obj.fields);
      if (fields.includes('next')) {
        const band = buildListBand(id, objects, visited);
        if (band && band.nodes.length > 0) model.lists.push({ kind: 'list', name: obj.typeName.toLowerCase() + '链', ...band });
      } else if (fields.includes('left') || fields.includes('right')) {
        const band = buildTreeBand(id, objects, visited);
        if (band && band.order.length > 0) model.trees.push({ kind: 'tree', name: obj.typeName.toLowerCase() + '树', ...band });
      }
    }
  }

  // 4) 收尾去重：同一个变量名只保留一条 band
  const dedupe = <T extends { name: string }>(arr: T[]): T[] => {
    const seen = new Set<string>();
    return arr.filter((b) => (seen.has(b.name) ? false : (seen.add(b.name), true)));
  };
  model.trees = dedupe(model.trees);
  model.lists = dedupe(model.lists);

  // 4.5) 别名合并：函数形参和模块变量常常是同一个数组（arr 传进去就是 a）。
  //      内容完全相同、且一个来自当前栈帧、一个来自全局时，只画一张卡片，
  //      其余名字记进 alias 一起显示，避免右栏出现两条一模一样的数据。
  if (model.arrays.length > 1) {
    const merged: ArrayBand[] = [];
    for (const b of model.arrays) {
      const key = JSON.stringify(b.items);
      const host = merged.find(
        (m) => JSON.stringify(m.items) === key && (frameNames.has(m.name) !== frameNames.has(b.name)),
      );
      if (host) {
        // 用用户自己的全局名字做标题（arr），形参名降级为别名（a）
        if (!frameNames.has(b.name) && frameNames.has(host.name)) {
          const prev = host.name;
          host.name = b.name;
          host.alias = [prev, ...(host.alias ?? [])];
        } else {
          host.alias = [...(host.alias ?? []), b.name];
        }
        // 指针标注合并（两边可能在不同作用域各有一份 lo/hi）
        const have = new Set(host.marks.map((x) => x.name));
        for (const mk of b.marks) if (!have.has(mk.name)) host.marks.push(mk);
        host.marks.sort((x, y) => x.index - y.index);
      } else {
        merged.push(b);
      }
    }
    model.arrays = merged;
  }

  // 5) 已经画成树 / 链表的变量，不要再额外画一张"哈希表卡片"
  //    （Java 的 Node 被序列化成 {v,l,r} 裸对象时，两者其实是同一个东西，
  //      同时出现会让右栏又长又重复）
  const structural = new Set<string>([...model.trees.map((t) => t.name), ...model.lists.map((l) => l.name)]);
  model.dicts = model.dicts.filter((d) => !structural.has(d.name) && !isNodeLikeDict(d) && !isAddressOnlyDict(d));

  return model;
}

/** 形如 {v:…, l:…, r:…} / {val:…, next:…} 的对象是节点，不当哈希表展示 */
function isNodeLikeDict(d: DictBand): boolean {
  const keys = d.entries.map((e) => e.key);
  const hasChild = keys.some((k) => ['l', 'r', 'left', 'right', 'leftChild', 'rightChild'].includes(k));
  const hasLink = keys.some((k) => ['next', 'prev'].includes(k));
  if (!hasChild && !hasLink) return false;
  // 至少要有一个对象/引用类型的子字段，否则只是个普通结构体
  return d.entries.some((e) => e.value !== null && typeof e.value === 'object');
}

/** 值是纯地址（0x… / @0x…）的"对象"没有任何可视化意义，展示出来只是噪音 */
function isAddressOnlyDict(d: DictBand): boolean {
  if (d.entries.length === 0) return true;
  return d.entries.every((e) => {
    const v = e.value;
    if (typeof v === 'string') return /^@?0x[0-9a-f]{4,}$/i.test(v.trim());
    if (typeof v === 'number') return false;
    if (v === null) return true;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const vals = Object.values(v as Record<string, unknown>);
      return vals.length > 0 && vals.every((x) => typeof x === 'string' && /^@?0x[0-9a-f]{4,}$/i.test(x.trim()));
    }
    return false;
  });
}

function isSymmetric(m: (number | null)[][]): boolean {
  const n = m.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((m[i][j] === null) !== (m[j][i] === null)) return false;
    }
  }
  return true;
}

function buildListBand(
  rootId: number,
  objects: Map<number, ObjectV>,
  visited: Set<number>,
): Omit<ListBand, 'kind' | 'name'> | null {
  const nodes: ListNode[] = [];
  let cur: number | null = rootId;
  let guard = 0;
  while (cur !== null && guard < 300) {
    guard++;
    if (visited.has(cur)) break; // 环形保护
    visited.add(cur);
    const obj = objects.get(cur);
    if (!obj) break;
    const next = obj.fields.next;
    const prev = obj.fields.prev;
    nodes.push({
      id: cur,
      value: mainField(obj),
      typeName: obj.typeName,
      nextId: isRef(next) ? next.id : null,
      prevId: isRef(prev) ? prev.id : null,
    });
    cur = isRef(next) ? next.id : null;
  }
  if (nodes.length === 0) return null;
  // 环形链表：尾节点的 next 指回首节点
  const isCircular = !!nodes[nodes.length - 1] && nodes[nodes.length - 1].nextId === rootId;
  return { nodes, isCircular };
}

function buildTreeBand(
  rootId: number,
  objects: Map<number, ObjectV>,
  visited: Set<number>,
): Omit<TreeBand, 'kind' | 'name'> | null {
  const nodes = new Map<number, TreeNodeInfo>();
  const order: number[] = [];
  const stack: number[] = [rootId];
  let guard = 0;
  const LKEYS = ['left', 'l', 'leftChild', 'lc'];
  const RKEYS = ['right', 'r', 'rightChild', 'rc'];
  const pickF = (f: Record<string, V>, keys: string[]) => {
    for (const k of keys) if (k in f) return f[k];
    return undefined;
  };
  while (stack.length > 0 && guard < 500) {
    guard++;
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const obj = objects.get(id);
    if (!obj) continue;
    const left = pickF(obj.fields, LKEYS);
    const right = pickF(obj.fields, RKEYS);
    nodes.set(id, {
      id,
      value: mainField(obj),
      leftId: isRef(left) ? left.id : null,
      rightId: isRef(right) ? right.id : null,
      typeName: obj.typeName,
    });
    order.push(id);
    if (isRef(right)) stack.push(right.id);
    if (isRef(left)) stack.push(left.id);
  }
  if (order.length === 0) return null;
  return { rootId, nodes, order };
}

function mainField(obj: ObjectV): V {
  const { fields } = obj;
  if ('v' in fields) return fields.v;
  if ('val' in fields) return fields.val;
  if ('value' in fields) return fields.value;
  if ('data' in fields) return fields.data;
  if ('key' in fields) return fields.key;
  const skip = new Set(['next', 'prev', 'left', 'right', 'l', 'r', 'leftChild', 'rightChild', 'head', 'tail']);
  for (const k of Object.keys(fields)) {
    if (!skip.has(k)) return fields[k];
  }
  return null;
}
