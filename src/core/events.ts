/**
 * 统一事件流协议 —— 整个平台的中枢
 *
 * 解释器执行代码时产出有序的 StepEvent 序列（事件流）。
 * 事件流同时是「状态变更日志」（唯一事实源）：
 *   - 前进：依次应用事件
 *   - 后退 / 任意步跳转：重置为初始状态后，重放到目标步
 * 变量表、调用栈、数据结构、输出日志全部可由事件流重建，
 * 因此回放绝不会出现状态错乱。
 */

import type { V } from './value';

/** 判断是否为对象引用（避免与 Record 混淆） */
function isRefV(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as any).ref === 'obj';
}

/**
 * 防御性深拷贝：进入回放状态的值必须与事件流隔离。
 * 事件流的 variable 值可能被后续 insert/write 修改（如 C++ vector 的
 * push_back 追加），若直接引用，反复重放（播放/seek）会把已污染的值
 * 再次作为初始值，导致数组指数膨胀。对象引用（ref）原样保留。
 */
export function deepCopyV(v: V): V {
  if (Array.isArray(v)) return v.map((x) => deepCopyV(x));
  if (v && typeof v === 'object' && !isRefV(v) && !(v as any).ref) {
    const o: Record<string, V> = {};
    for (const k of Object.keys(v as Record<string, V>)) o[k] = deepCopyV((v as Record<string, V>)[k]);
    return o;
  }
  return v;
}

/** 目标定位：事件作用在哪个数据结构的哪个位置 */
export type Target =
  | { kind: 'array'; name: string; index: number } // 数组元素
  | { kind: 'dict'; name: string; key: string } // 哈希表键
  | { kind: 'object'; id: number; field?: string } // 对象实例 / 字段
  | { kind: 'vertex'; name: string; v: number } // 图顶点
  | { kind: 'var'; name: string }; // 普通变量

export type EventType =
  | 'variable' // 变量赋值（全局或当前栈帧局部）
  | 'write' // 数组元素 / 字典键 / 对象字段写入
  | 'compare' // 比较
  | 'swap' // 交换（数组两元素）
  | 'insert' // 数组插入（push / insert / 链表节点插入）
  | 'remove' // 数组删除（pop / remove / 链表节点删除）
  | 'node_create' // 对象 / 结构体实例创建（链表节点、树节点…）
  | 'call' // 函数调用（入栈）
  | 'return' // 函数返回（出栈）
  | 'print' // 输出
  | 'highlight' // 结构高亮（不改变状态，仅动画标记）
  | 'comment'; // 纯文字说明（如"开始第 i 轮冒泡"）

export interface StepEvent {
  type: EventType;
  /** 0-based 步号 */
  step: number;
  /** 1-based 源码行号（左栏高亮同步） */
  line: number;
  /** 中文步骤说明 */
  desc: string;
  // —— 负载（按类型取用）——
  name?: string; // variable / vertex
  value?: V; // variable / write / insert / return
  scope?: string; // variable 所在帧：'global' 或函数名
  target?: Target;
  targets?: Target[]; // compare / highlight
  a?: string; // compare 左侧表达式文本
  b?: string; // compare 右侧表达式文本
  result?: number; // compare 结果（-1 | 0 | 1）
  index?: number; // insert / remove
  fn?: string; // call / return
  args?: { name: string; value: V }[]; // call
  id?: number; // node_create
  typeName?: string; // node_create
  fields?: Record<string, V>; // node_create 初始字段
  text?: string; // print
}

/** 调用栈帧（用于调用栈面板） */
export interface Frame {
  fn: string;
  args: Record<string, V>;
  locals: Record<string, V>;
  line: number;
}

/** 对象实例（链表节点 / 树节点 / 图顶点等） */
export interface ObjectV {
  typeName: string;
  fields: Record<string, V>;
}

/**
 * 回放状态：由事件流重建的完整可视化状态
 */
export interface ReplayState {
  /** 全局变量表 */
  globals: Record<string, V>;
  /** 调用栈（栈顶为当前帧） */
  frames: Frame[];
  /** 数组值（name -> elements） */
  arrays: Map<string, V[]>;
  /** 哈希表值 */
  dicts: Map<string, Map<string, V>>;
  /** 对象实例 */
  objects: Map<number, ObjectV>;
  /** 输出日志 */
  outputs: string[];
  /** 当前步事件（用于高亮与步骤说明） */
  lastEvent: StepEvent | null;
}

/** 从零构造初始状态 */
export function emptyReplayState(): ReplayState {
  return {
    globals: {},
    frames: [],
    arrays: new Map(),
    dicts: new Map(),
    objects: new Map(),
    outputs: [],
    lastEvent: null,
  };
}

/**
 * 应用一个事件到状态上（前进）
 * 返回该事件产生的「动画意图」，供渲染器播放
 */
export function applyEvent(state: ReplayState, ev: StepEvent): void {
  switch (ev.type) {
    case 'variable': {
      const v = deepCopyV(ev.value!);
      if (ev.scope === 'global') state.globals[ev.name!] = v;
      else {
        const frame = state.frames[state.frames.length - 1];
        if (frame) frame.locals[ev.name!] = v;
        else state.globals[ev.name!] = v;
      }
      break;
    }
    case 'write': {
      const t = ev.target!;
      if (t.kind === 'array') {
        // 数组值内联存储在 globals[name]（V[]）
        const arr = state.globals[t.name];
        if (Array.isArray(arr) && t.index >= 0 && t.index < arr.length) arr[t.index] = deepCopyV(ev.value!);
      } else if (t.kind === 'dict') {
        const d = state.globals[t.name];
        if (d && typeof d === 'object' && !Array.isArray(d) && !isRefV(d)) {
          (d as Record<string, V>)[t.key] = deepCopyV(ev.value!);
        }
      } else if (t.kind === 'object') {
        const obj = state.objects.get(t.id);
        if (obj && t.field) obj.fields[t.field] = deepCopyV(ev.value!);
      }
      break;
    }
    case 'insert': {
      const t = ev.target!;
      if (t.kind === 'array') {
        const arr = state.globals[t.name];
        if (Array.isArray(arr)) arr.splice(Math.min(ev.index ?? arr.length, arr.length), 0, deepCopyV(ev.value!));
      }
      break;
    }
    case 'remove': {
      const t = ev.target!;
      if (t.kind === 'array') {
        const arr = state.globals[t.name];
        if (Array.isArray(arr)) arr.splice(ev.index ?? 0, 1);
      }
      break;
    }
    case 'node_create': {
      state.objects.set(ev.id!, { typeName: ev.typeName!, fields: deepCopyV(ev.fields ?? {}) as Record<string, V> });
      break;
    }
    case 'call': {
      state.frames.push({
        fn: ev.fn!,
        args: Object.fromEntries((ev.args ?? []).map((a) => [a.name, deepCopyV(a.value)])),
        locals: {},
        line: ev.line,
      });
      break;
    }
    case 'return': {
      state.frames.pop();
      break;
    }
    case 'print': {
      state.outputs.push(ev.text ?? '');
      break;
    }
    default:
      break;
  }
  state.lastEvent = ev;
}
