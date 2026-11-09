/**
 * 统一值模型（跨语言）
 *
 * 教学子集的所有运行时值统一为以下形式：
 *  - number：int / float / double 统一映射
 *  - string、boolean、null
 *  - {ref:'arr'}：数组引用（元素内容保存在 ReplayState.arrays）
 *  - {ref:'dict'}：哈希表引用（内容保存在 ReplayState.dicts）
 *  - {ref:'obj'}：对象/结构体实例引用（内容保存在 ReplayState.objects）
 *  - V[]：字面量数组（内联值，如 new int[]{1,2,3} 的元素）
 *
 * 这样事件流中携带的值都可以被 JSON 序列化，且重放时无需深拷贝大对象。
 */

/** 字典/哈希表：键值对普通对象（interface 允许递归引用） */
export interface DictValue {
  [key: string]: V;
}

export type V =
  | number
  | string
  | boolean
  | null
  | { ref: 'arr'; name: string }
  | { ref: 'dict'; name: string }
  | { ref: 'obj'; id: number }
  | V[]
  | DictValue;

/** 值的人类可读表示（用于变量面板 / 日志） */
export function vToString(v: V | undefined, depth = 0): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') return String(v);
  if (t === 'string') return v as string;
  if (t === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (depth > 1) return `[长度 ${v.length}]`;
    return '[' + v.map((x) => vToString(x, depth + 1)).join(', ') + ']';
  }
  if ((v as any).ref === 'arr') return `数组[${(v as any).name}]`;
  if ((v as any).ref === 'dict') return `哈希表[${(v as any).name}]`;
  if ((v as any).ref === 'obj') return `对象#${(v as any).id}`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, V>);
    if (entries.length === 0) return '{}';
    if (depth > 1) return `{${entries.length} 个键值}`;
    return '{' + entries.map(([k, x]) => `${k}: ${vToString(x, depth + 1)}`).join(', ') + '}';
  }
  return String(v);
}

/** 判断是否为对象引用 */
export function isRef(v: V | undefined): v is { ref: 'obj'; id: number } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as any).ref === 'obj';
}

export function isArrRef(v: V | undefined): v is { ref: 'arr'; name: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as any).ref === 'arr';
}

export function isDictRef(v: V | undefined): v is { ref: 'dict'; name: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as any).ref === 'dict';
}
