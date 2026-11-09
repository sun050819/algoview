/**
 * Canvas 可视化渲染器
 *
 * 设计目标：把"数据结构 + 当前执行位置"画得一眼看懂，并且好看。
 *
 * 渲染流程
 *   1. 外部每步更新 model（结构快照）+ pulse(事件) 添加动画意图
 *   2. RAF 循环推进插值并全量重绘
 *
 * 版面
 *   ┌ 顶部状态条：步骤 x/y · 当前动作
 *   ├ 结构卡片（数组 / 树 / 链表 / 图 / 字典），每张卡片自带标题
 *   └ 内容超高时整体等比缩放，保证一屏永远看得全
 */

import type { StepEvent } from '../core/events';
import { vToString } from '../core/value';
import {
  VisualModel,
  ArrayBand,
  ListBand,
  TreeBand,
  GraphBand,
  DictBand,
  emptyModel,
} from './model';

export type ThemeMode = 'dark' | 'light';

export interface ThemeColors {
  bg: string;
  bgGlow: string;
  dot: string;
  card: string;
  cardBorder: string;
  panel: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  accentSoft: string;
  compare: string;
  swap: string;
  write: string;
  nodeNew: string;
  highlight: string;
  edge: string;
  nodeBg: string;
  nodeBg2: string;
  gridBorder: string;
}

const THEMES: Record<ThemeMode, ThemeColors> = {
  dark: {
    bg: '#0b1220',
    bgGlow: '#16233b',
    dot: 'rgba(148,163,184,0.10)',
    card: 'rgba(30,41,59,0.55)',
    cardBorder: 'rgba(148,163,184,0.16)',
    panel: '#1e293b',
    text: '#e8eef8',
    dim: '#94a3b8',
    faint: '#5b6b82',
    accent: '#38bdf8',
    accentSoft: '#0ea5e9',
    compare: '#f87171',
    swap: '#fbbf24',
    write: '#34d399',
    nodeNew: '#a78bfa',
    highlight: '#f472b6',
    edge: 'rgba(125,150,180,0.55)',
    nodeBg: '#243449',
    nodeBg2: '#1a2637',
    gridBorder: 'rgba(148,163,184,0.22)',
  },
  light: {
    bg: '#f6f8fc',
    bgGlow: '#e8effa',
    dot: 'rgba(100,116,139,0.14)',
    card: 'rgba(255,255,255,0.85)',
    cardBorder: 'rgba(15,23,42,0.10)',
    panel: '#ffffff',
    text: '#16233b',
    dim: '#5b6b82',
    faint: '#8fa0b6',
    accent: '#0284c7',
    accentSoft: '#0ea5e9',
    compare: '#ef4444',
    swap: '#d97706',
    write: '#059669',
    nodeNew: '#7c3aed',
    highlight: '#db2777',
    edge: 'rgba(100,116,139,0.55)',
    nodeBg: '#ffffff',
    nodeBg2: '#eef3fa',
    gridBorder: 'rgba(15,23,42,0.14)',
  },
};

type Anim =
  | { kind: 'flash'; key: string; color: string; t: number; dur: number }
  | { kind: 'swap'; band: string; i: number; j: number; t: number; dur: number }
  | { kind: 'shift'; band: string; index: number; t: number; dur: number; fromX: number };

interface Pt { x: number; y: number }

/** 版面常量（虚拟坐标，缩放前） */
const HEADER_H = 54;
const CARD_MX = 16;
const CARD_PAD = 16;
const TITLE_H = 32;
const CARD_GAP = 14;

/** 数组格子 */
const CELL_W = 46;
const CELL_H = 46;
/** 元素少时格子可以撑到的最大宽度：让一行数组填满卡片，而不是缩在左边一小段 */
const CELL_MAX_W = 96;
const CELL_GAP = 10;
const CELL_LABEL_H = 16;
const MARK_H = 24;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** 指针标注配色（按名字稳定取色） */
const MARK_COLORS = ['#38bdf8', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#fb923c'];
const markColor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return MARK_COLORS[Math.abs(h) % MARK_COLORS.length];
};

export class VisualRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  theme: ThemeMode = 'dark';
  private colors: ThemeColors = THEMES.dark;

  private w = 600;
  private h = 400;

  private model: VisualModel = emptyModel();
  private stepDesc = '';
  private stepLine = 0;
  private maxStep = 0;
  private currentStep = 0;

  private anims: Anim[] = [];
  private raf = 0;
  private lastTs = 0;
  private running = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.applyDpr();
  }

  private applyDpr() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.w || this.canvas.clientWidth || 600;
    const h = this.h || this.canvas.clientHeight || 400;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
  }

  setTheme(mode: ThemeMode) {
    this.theme = mode;
    this.colors = THEMES[mode];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTs = performance.now();
    const loop = (ts: number) => {
      if (!this.running) return;
      const dt = Math.min(ts - this.lastTs, 50);
      this.lastTs = ts;
      this.advance(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  setModel(m: VisualModel) {
    this.model = m;
  }

  setStepInfo(desc: string, line: number, current: number, max: number) {
    this.stepDesc = desc;
    this.stepLine = line;
    this.currentStep = current;
    this.maxStep = max;
  }

  /**
   * 尺寸变化：只改画布后备分辨率，尺寸交给 CSS（width/height:100%）。
   * 早先这里会写 canvas.style.width，一旦传进来的是 0 或脏值，
   * 内联样式就会把 CSS 的 100% 永久盖掉，画布卡死在几像素。
   */
  resize(w: number, h: number) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.applyDpr();
  }

  /** 前进播放时：由当前步事件生成动画意图 */
  pulse(ev: StepEvent | null) {
    if (!ev) return;
    switch (ev.type) {
      case 'compare': {
        for (const t of ev.targets ?? []) {
          if (t.kind === 'array') this.flash(`a:${t.name}:${t.index}`, this.colors.compare);
          else if (t.kind === 'vertex') this.flash(`v:${t.name}:${t.v}`, this.colors.compare);
          else if (t.kind === 'object') this.flash(`o:${t.id}`, this.colors.compare);
        }
        break;
      }
      case 'swap': {
        const [a, b] = ev.targets ?? [];
        if (a && b && a.kind === 'array' && b.kind === 'array' && a.name === b.name) {
          this.anims.push({ kind: 'swap', band: a.name, i: a.index, j: b.index, t: 0, dur: 560 });
        }
        break;
      }
      case 'insert': {
        const t = ev.target;
        if (t && t.kind === 'array') {
          this.flash(`a:${t.name}:${t.index}`, this.colors.write);
          this.anims.push({ kind: 'shift', band: t.name, index: t.index, t: 0, dur: 400, fromX: 0 });
        }
        break;
      }
      case 'remove': {
        const t = ev.target;
        if (t && t.kind === 'array') this.flash(`a:${t.name}:${t.index}`, this.colors.compare);
        break;
      }
      case 'write': {
        const t = ev.target;
        if (t) {
          if (t.kind === 'array') this.flash(`a:${t.name}:${t.index}`, this.colors.write);
          else if (t.kind === 'object') this.flash(`o:${t.id}`, this.colors.write);
          else if (t.kind === 'dict') this.flash(`d:${t.name}:${t.key}`, this.colors.write);
        }
        break;
      }
      case 'node_create': {
        if (ev.id !== undefined) this.flash(`o:${ev.id}`, this.colors.nodeNew);
        break;
      }
      case 'highlight': {
        for (const t of ev.targets ?? []) {
          if (t.kind === 'array') this.flash(`a:${t.name}:${t.index}`, this.colors.highlight);
          else if (t.kind === 'object') this.flash(`o:${t.id}`, this.colors.highlight);
          else if (t.kind === 'vertex') this.flash(`v:${t.name}:${t.v}`, this.colors.highlight);
        }
        break;
      }
      default:
        break;
    }
  }

  private flash(key: string, color: string) {
    this.anims.push({ kind: 'flash', key, color, t: 0, dur: 700 });
  }

  private advance(dt: number) {
    for (const a of this.anims) a.t += dt / a.dur;
    this.anims = this.anims.filter((a) => a.t < 1);
  }

  private flashOf(key: string): string | null {
    for (const a of this.anims) {
      if (a.kind === 'flash' && a.key === key) return a.color;
    }
    return null;
  }

  private animT(key: string): number {
    for (const a of this.anims) {
      if (a.kind === 'flash' && a.key === key) return Math.min(a.t, 1);
    }
    return 1;
  }

  /* ================= 绘制主流程 ================= */

  private draw() {
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    if (W <= 1 || H <= 1) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintBackdrop(W, H);

    const bands = this.collectBands();
    if (!this.stepDesc) {
      this.drawIdle(W, H, bands.length === 0);
      return;
    }
    this.drawHeader(W);

    if (bands.length === 0) {
      this.drawNoStructure(W, H);
      return;
    }

    const availTop = HEADER_H + 6;
    const availH = H - availTop - 10;
    const cardW = W - CARD_MX * 2;
    const innerW = cardW - CARD_PAD * 2;
    const heights = bands.map((b) => this.measure(b, innerW));
    const total = heights.reduce((a, b) => a + b + CARD_GAP, 0) - CARD_GAP;
    const scale = Math.min(1, Math.max(0.5, availH / Math.max(total, 1)));
    // 内容不满一屏时垂直居中，避免全挤在顶上留下大片空白
    const offsetY = Math.max(0, (availH - total * scale) / 2);

    ctx.save();
    ctx.translate(W / 2, availTop + offsetY);
    ctx.scale(scale, scale);
    ctx.translate(-W / 2, 0);
    let y = 0;
    bands.forEach((b, i) => {
      this.drawCard(b, CARD_MX, y, cardW, heights[i], innerW);
      y += heights[i] + CARD_GAP;
    });
    ctx.restore();
  }

  private collectBands(): Array<{ kind: string; band: ArrayBand | ListBand | TreeBand | GraphBand | DictBand }> {
    const out: Array<{ kind: string; band: any }> = [];
    for (const b of this.model.trees) out.push({ kind: 'tree', band: b });
    for (const b of this.model.lists) out.push({ kind: 'list', band: b });
    for (const b of this.model.arrays) out.push({ kind: 'array', band: b });
    for (const b of this.model.graphs) out.push({ kind: 'graph', band: b });
    for (const b of this.model.dicts) out.push({ kind: 'dict', band: b });
    return out;
  }

  /** 画布底：柔和径向光 + 点阵网格 */
  private paintBackdrop(W: number, H: number) {
    const ctx = this.ctx;
    const C = this.colors;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    const g = ctx.createRadialGradient(W * 0.72, -H * 0.15, 0, W * 0.72, -H * 0.15, Math.max(W, H) * 1.05);
    g.addColorStop(0, C.bgGlow);
    // 收尾必须过渡到「背景色本身」而不是 rgba(0,0,0,0)：
    // 透明黑在非预乘插值下会让中段变成半透明灰，把整块底压暗（浅色主题尤其明显）。
    g.addColorStop(1, C.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const step = 26;
    ctx.fillStyle = C.dot;
    for (let x = step; x < W; x += step) {
      for (let y = step; y < H; y += step) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  /* -------- 顶部状态条 -------- */

  private drawHeader(W: number) {
    const ctx = this.ctx;
    const C = this.colors;
    ctx.save();

    // 磨砂底
    ctx.fillStyle = this.theme === 'dark' ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.82)';
    ctx.fillRect(0, 0, W, HEADER_H);
    ctx.strokeStyle = C.cardBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H - 0.5);
    ctx.lineTo(W, HEADER_H - 0.5);
    ctx.stroke();

    // 步骤徽标
    const label = `${this.currentStep}`;
    const totalLabel = `/ ${this.maxStep}`;
    ctx.font = 'bold 13px "JetBrains Mono", Consolas, monospace';
    const lwNum = ctx.measureText(label).width;
    ctx.font = '11px "JetBrains Mono", Consolas, monospace';
    const lwTotal = ctx.measureText(totalLabel).width;
    const lw = 20 + lwNum + 6 + lwTotal;
    this.roundRect(16, 13, lw, 28, 8);
    ctx.fillStyle = this.theme === 'dark' ? 'rgba(56,189,248,0.14)' : 'rgba(2,132,199,0.10)';
    ctx.fill();
    ctx.strokeStyle = this.theme === 'dark' ? 'rgba(56,189,248,0.35)' : 'rgba(2,132,199,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.accent;
    ctx.font = 'bold 13px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(label, 26, HEADER_H / 2 + 1);
    ctx.fillStyle = C.faint;
    ctx.font = '11px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(totalLabel, 26 + lwNum + 6, HEADER_H / 2 + 2);

    // 动作描述
    const tx = 16 + lw + 14;
    ctx.fillStyle = C.text;
    ctx.font = '13.5px "Inter", "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    const maxW = W - tx - 18;
    let desc = this.stepDesc;
    if (ctx.measureText(desc).width > maxW) {
      while (desc.length > 4 && ctx.measureText(desc + '…').width > maxW) desc = desc.slice(0, -1);
      desc += '…';
    }
    ctx.fillText(desc, tx, HEADER_H / 2 + 1);

    // 进度细线
    const p = this.maxStep > 0 ? this.currentStep / this.maxStep : 0;
    ctx.fillStyle = this.theme === 'dark' ? 'rgba(148,163,184,0.18)' : 'rgba(15,23,42,0.08)';
    ctx.fillRect(0, HEADER_H - 2, W, 2);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, C.accentSoft);
    grad.addColorStop(1, C.accent);
    ctx.fillStyle = grad;
    ctx.fillRect(0, HEADER_H - 2, W * p, 2);
    ctx.restore();
  }

  /* -------- 空态 -------- */

  private drawIdle(W: number, H: number, noStructure: boolean) {
    const ctx = this.ctx;
    const C = this.colors;
    ctx.save();
    const cx = W / 2;
    const cy = H / 2;

    ctx.beginPath();
    ctx.arc(cx, cy - 26, 30, 0, Math.PI * 2);
    ctx.fillStyle = this.theme === 'dark' ? 'rgba(56,189,248,0.10)' : 'rgba(2,132,199,0.08)';
    ctx.fill();
    ctx.strokeStyle = this.theme === 'dark' ? 'rgba(56,189,248,0.30)' : 'rgba(2,132,199,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = C.accent;
    ctx.font = 'bold 22px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▶', cx + 2, cy - 25);

    ctx.fillStyle = C.dim;
    ctx.font = '14px "Inter", "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText('点击「运行」开始可视化', cx, cy + 30);
    ctx.fillStyle = C.faint;
    ctx.font = '12px "Inter", "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(noStructure ? '在左侧写下任意 Python / Java / C / C++ 代码' : '逐步执行，右侧同步画出数据结构', cx, cy + 52);
    ctx.restore();
  }

  private drawNoStructure(W: number, H: number) {
    const ctx = this.ctx;
    const C = this.colors;
    ctx.save();
    ctx.fillStyle = C.dim;
    ctx.font = '13.5px "Inter", "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('这一步没有可画的数据结构', W / 2, H / 2 - 10);
    ctx.fillStyle = C.faint;
    ctx.font = '12px "Inter", "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText('试试声明一个数组 / 链表 / 树，或查看下方变量面板', W / 2, H / 2 + 14);
    ctx.restore();
  }

  /* ================= 卡片 ================= */

  private cardChrome(x: number, y: number, w: number, h: number) {
    const ctx = this.ctx;
    const C = this.colors;
    this.roundRect(x, y, w, h, 12);
    ctx.fillStyle = C.card;
    ctx.fill();
    ctx.strokeStyle = C.cardBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawCard(
    item: { kind: string; band: any },
    x: number,
    y: number,
    w: number,
    h: number,
    innerW: number,
  ) {
    const ctx = this.ctx;
    const C = this.colors;
    this.cardChrome(x, y, w, h);

    const b = item.band;
    const meta = this.bandMeta(item.kind, b);

    // 标题
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.accent;
    ctx.font = 'bold 13px "Inter", "Segoe UI", "Microsoft YaHei", sans-serif';
    const nameY = y + CARD_PAD + 8;
    ctx.fillText(b.name, x + CARD_PAD, nameY);
    let nw = ctx.measureText(b.name).width;

    // 别名（同一份数据的其他叫法）
    const alias: string[] = item.kind === 'array' ? ((b as ArrayBand).alias ?? []) : [];
    if (alias.length > 0) {
      ctx.fillStyle = C.faint;
      ctx.font = '11px "JetBrains Mono", Consolas, monospace';
      const aliasText = '≡ ' + alias.join(', ');
      ctx.fillText(aliasText, x + CARD_PAD + nw + 8, nameY + 0.5);
      nw += 8 + ctx.measureText(aliasText).width;
    }

    // 类型小徽标
    const chipX = x + CARD_PAD + nw + 9;
    ctx.font = '10.5px "JetBrains Mono", Consolas, monospace';
    const cw = ctx.measureText(meta.tag).width + 14;
    this.roundRect(chipX, nameY - 9, cw, 18, 6);
    ctx.fillStyle = this.theme === 'dark' ? 'rgba(148,163,184,0.14)' : 'rgba(15,23,42,0.06)';
    ctx.fill();
    ctx.fillStyle = C.dim;
    ctx.fillText(meta.tag, chipX + 7, nameY + 0.5);

    // 右侧补充信息
    if (meta.right) {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.faint;
      ctx.font = '11px "JetBrains Mono", Consolas, monospace';
      ctx.fillText(meta.right, x + w - CARD_PAD, nameY + 0.5);
      ctx.textAlign = 'left';
    }

    if (item.kind === 'array') this.drawArray(b, x + CARD_PAD, y, innerW);
    else if (item.kind === 'tree') this.drawTree(b, x + CARD_PAD, y, innerW);
    else if (item.kind === 'list') this.drawList(b, x + CARD_PAD, y, innerW);
    else if (item.kind === 'graph') this.drawGraph(b, x + CARD_PAD, y, innerW);
    else if (item.kind === 'dict') this.drawDict(b, x + CARD_PAD, y, innerW);
  }

  private bandMeta(kind: string, b: any): { tag: string; right?: string } {
    if (kind === 'array') {
      const marks = (b as ArrayBand).marks;
      return {
        tag: 'array',
        right: marks.length
          ? marks.map((m) => `${m.name}→${m.index}`).join('  ')
          : `长度 ${(b as ArrayBand).items.length}`,
      };
    }
    if (kind === 'tree') {
      return { tag: 'bst', right: `${(b as TreeBand).order.length} 节点` };
    }
    if (kind === 'list') {
      const lb = b as ListBand;
      return { tag: lb.isCircular ? 'circular' : 'list', right: `${lb.nodes.length} 节点` };
    }
    if (kind === 'graph') {
      const gb = b as GraphBand;
      return { tag: gb.directed ? 'digraph' : 'graph', right: `${gb.size} 顶点 · ${gb.edges.length} 边` };
    }
    return { tag: 'map', right: `${(b as DictBand).entries.length} 键` };
  }

  /* ================= 尺寸度量 ================= */

  /** 自适应格子尺寸：元素少就撑开填满卡片，元素多则退回固定尺寸换行 */
  private cellSize(n: number, innerW: number): { w: number; h: number; grow: number } {
    const fit = (innerW - CELL_GAP * Math.max(0, n - 1)) / Math.max(1, n);
    const w = Math.max(CELL_W, Math.min(CELL_MAX_W, fit));
    const grow = (w - CELL_W) / (CELL_MAX_W - CELL_W);
    return { w, h: Math.round(CELL_H + grow * 14), grow };
  }

  /** 一行能放几格：格子被撑开时就是全部一行，否则按固定宽度折行 */
  private colsFor(n: number, innerW: number, w: number): number {
    if (w > CELL_W + 0.5) return Math.max(1, n);
    return Math.max(1, Math.floor((innerW + CELL_GAP) / (CELL_W + CELL_GAP)));
  }

  private measure(item: { kind: string; band: any }, innerW: number): number {
    const base = TITLE_H + CARD_PAD + 8;
    if (item.kind === 'array') {
      const b = item.band as ArrayBand;
      const { w, h } = this.cellSize(b.items.length, innerW);
      const cols = this.colsFor(b.items.length, innerW, w);
      const rows = Math.ceil(b.items.length / cols);
      const marksH = b.marks.length > 0 ? MARK_H : 0;
      return base + marksH + rows * (h + CELL_LABEL_H + 12) + 4;
    }
    if (item.kind === 'tree') {
      const b = item.band as TreeBand;
      return base + this.treeDepth(b) * 82 + 30;
    }
    if (item.kind === 'list') {
      return base + 92;
    }
    if (item.kind === 'graph') {
      return base + 210;
    }
    const b = item.band as DictBand;
    const cardW = 148;
    const gap = 10;
    const cols = Math.max(1, Math.floor((innerW + gap) / (cardW + gap)));
    const rows = Math.ceil(b.entries.length / cols);
    return base + rows * (56 + gap) + 2;
  }

  private treeDepth(b: TreeBand): number {
    const depth = (id: number | null): number => {
      if (id === null || !b.nodes.has(id)) return 0;
      const n = b.nodes.get(id)!;
      return 1 + Math.max(depth(n.leftId), depth(n.rightId));
    };
    return Math.max(1, depth(b.rootId));
  }

  /* ================= 数组 ================= */

  private drawArray(b: ArrayBand, x: number, cardY: number, innerW: number) {
    const ctx = this.ctx;
    const C = this.colors;
    const { w: cw, h: ch, grow } = this.cellSize(b.items.length, innerW);
    const cols = this.colsFor(b.items.length, innerW, cw);
    const marksH = b.marks.length > 0 ? MARK_H : 0;
    const contentTop = cardY + TITLE_H + CARD_PAD + 8 + marksH;

    const pos = new Map<number, Pt>();
    for (let i = 0; i < b.items.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      pos.set(i, {
        x: x + col * (cw + CELL_GAP),
        y: contentTop + row * (ch + CELL_LABEL_H + 12),
      });
    }

    // 交换动画：两格位置插值
    for (const a of this.anims) {
      if (a.kind === 'swap' && a.band === b.name) {
        const p1 = pos.get(a.i);
        const p2 = pos.get(a.j);
        if (p1 && p2) {
          const e = easeInOut(Math.min(a.t, 1));
          pos.set(a.i, { x: p1.x + (p2.x - p1.x) * e, y: p1.y + (p2.y - p1.y) * e });
          pos.set(a.j, { x: p2.x + (p1.x - p2.x) * e, y: p2.y + (p1.y - p2.y) * e });
        }
      }
    }

    // 指针游标（画在格子上方）
    const byIndex = new Map<number, string[]>();
    for (const m of b.marks) {
      const arr = byIndex.get(m.index) ?? [];
      arr.push(m.name);
      byIndex.set(m.index, arr);
    }

    for (const [idx, names] of byIndex) {
      const p = pos.get(idx);
      if (!p) continue;
      names.forEach((nm, k) => {
        const col = markColor(nm);
        const cx = p.x + cw / 2;
        const my = contentTop - 8 - k * 15;
        // 标签
        ctx.font = 'bold 10.5px "JetBrains Mono", Consolas, monospace';
        const tw = ctx.measureText(nm).width;
        this.roundRect(cx - tw / 2 - 5, my - 9, tw + 10, 16, 5);
        ctx.fillStyle = this.alpha(col, 0.18);
        ctx.fill();
        ctx.strokeStyle = this.alpha(col, 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(nm, cx, my - 0.5);
        // 指示小三角
        ctx.beginPath();
        ctx.moveTo(cx - 4, my + 7);
        ctx.lineTo(cx + 4, my + 7);
        ctx.lineTo(cx, my + 12);
        ctx.closePath();
        ctx.fillStyle = this.alpha(col, 0.75);
        ctx.fill();
      });
    }

    for (let i = 0; i < b.items.length; i++) {
      const p = pos.get(i)!;
      const key = `a:${b.name}:${i}`;
      const flash = this.flashOf(key);
      const t = flash ? this.animT(key) : 1;
      const glow = flash ? 1 - t : 0;

      // 投影
      ctx.save();
      ctx.shadowColor = flash ? this.alpha(flash, 0.55 * glow) : 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = flash ? 18 * glow : 8;
      ctx.shadowOffsetY = flash ? 0 : 2;

      this.roundRect(p.x, p.y, cw, ch, 9);
      const g = ctx.createLinearGradient(p.x, p.y, p.x, p.y + ch);
      if (flash) {
        g.addColorStop(0, this.alpha(flash, 0.92));
        g.addColorStop(1, this.alpha(flash, 0.62));
      } else {
        g.addColorStop(0, C.nodeBg);
        g.addColorStop(1, C.nodeBg2);
      }
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();

      // 描边
      this.roundRect(p.x, p.y, cw, ch, 9);
      ctx.strokeStyle = flash ? this.alpha('#ffffff', 0.5) : C.gridBorder;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // 值
      ctx.fillStyle = flash ? '#ffffff' : C.text;
      ctx.font = `bold ${Math.round(14 + grow * 4)}px "JetBrains Mono", Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const v = b.items[i];
      let label = v === null || v === undefined ? '∅' : vToString(v);
      if (label.length > 4) label = label.slice(0, 4);
      ctx.fillText(label, p.x + cw / 2, p.y + ch / 2 + 1);

      // 下标
      ctx.fillStyle = C.faint;
      ctx.font = '10px "JetBrains Mono", Consolas, monospace';
      ctx.fillText(String(i), p.x + cw / 2, p.y + ch + 10);
    }
    ctx.textAlign = 'left';
  }

  /* ================= 树 ================= */

  private drawTree(b: TreeBand, x: number, cardY: number, innerW: number) {
    const ctx = this.ctx;
    const C = this.colors;
    const r = 20;
    const levelH = 82;
    const unit = 50;

    const widthOf = (id: number | null, guard = 0): number => {
      if (id === null || guard > 64) return 0;
      const nd = b.nodes.get(id);
      if (!nd) return 0;
      return 1 + widthOf(nd.leftId, guard + 1) + widthOf(nd.rightId, guard + 1);
    };
    const totalW = Math.max(1, widthOf(b.rootId));
    const contentTop = cardY + TITLE_H + CARD_PAD + 10;

    const pos = new Map<number, Pt>();
    const layout = (id: number | null, left: number, level: number) => {
      if (id === null) return;
      const nd = b.nodes.get(id);
      if (!nd) return;
      const wl = widthOf(nd.leftId);
      pos.set(id, { x: left + wl * unit + unit / 2, y: contentTop + r + level * levelH });
      layout(nd.leftId, left, level + 1);
      layout(nd.rightId, left + (wl + 1) * unit, level + 1);
    };
    const startX = Math.max(0, (innerW - totalW * unit) / 2);
    layout(b.rootId, startX, 0);

    // 连线：二次贝塞尔，轻微弧度更自然
    const walk = (id: number | null, guard = 0) => {
      if (id === null || guard > 200) return;
      const nd = b.nodes.get(id);
      if (!nd) return;
      const p = pos.get(id);
      if (!p) return;
      for (const childId of [nd.leftId, nd.rightId]) {
        if (childId === null) continue;
        const cp = pos.get(childId);
        if (!cp) continue;
        const my = (p.y + cp.y) / 2;
        ctx.beginPath();
        ctx.moveTo(x + p.x, p.y + r);
        ctx.bezierCurveTo(x + p.x, my, x + cp.x, my, x + cp.x, cp.y - r);
        ctx.strokeStyle = C.edge;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        walk(childId, guard + 1);
      }
    };
    walk(b.rootId);

    for (const id of b.order) {
      const p = pos.get(id);
      if (!p) continue;
      const nd = b.nodes.get(id)!;
      const key = `o:${id}`;
      const flash = this.flashOf(key);
      const glow = flash ? 1 - this.animT(key) : 0;
      this.node(x + p.x, p.y, r, flash, glow);
      ctx.fillStyle = flash ? '#ffffff' : C.text;
      ctx.font = 'bold 13.5px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(vToString(nd.value), x + p.x, p.y + 1);
    }
    ctx.textAlign = 'left';
  }

  private node(cx: number, cy: number, r: number, flash: string | null, glow: number) {
    const ctx = this.ctx;
    const C = this.colors;
    ctx.save();
    ctx.shadowColor = flash ? this.alpha(flash, 0.6 * glow) : 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = flash ? 20 * glow : 9;
    ctx.shadowOffsetY = flash ? 0 : 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    if (flash) {
      g.addColorStop(0, this.alpha(flash, 0.95));
      g.addColorStop(1, this.alpha(flash, 0.65));
    } else {
      g.addColorStop(0, C.nodeBg);
      g.addColorStop(1, C.nodeBg2);
    }
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = flash ? this.alpha('#ffffff', 0.55) : C.gridBorder;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  /* ================= 链表 ================= */

  private drawList(b: ListBand, x: number, cardY: number, innerW: number) {
    const ctx = this.ctx;
    const C = this.colors;
    const nW = 56;
    const nH = 46;
    const gap = 36;
    const n = b.nodes.length;
    const contentTop = cardY + TITLE_H + CARD_PAD + 20;

    const totalW = n * nW + (n - 1) * gap;
    const startX = Math.max(0, (innerW - totalW) / 2);
    const cy = contentTop + nH / 2;

    const centers = b.nodes.map((_, i) => ({ x: x + startX + i * (nW + gap) + nW / 2, y: cy }));

    // 箭头
    for (let i = 0; i < n; i++) {
      const to = i < n - 1 ? centers[i + 1] : b.isCircular ? centers[0] : null;
      if (!to) continue;
      const from = centers[i];
      const x1 = from.x + nW / 2 + 3;
      const x2 = to.x - nW / 2 - 7;
      ctx.strokeStyle = C.edge;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (i < n - 1) {
        ctx.moveTo(x1, from.y);
        ctx.lineTo(x2, to.y);
      } else {
        // 环形：从下方绕回去
        ctx.moveTo(from.x, from.y + nH / 2 + 2);
        ctx.bezierCurveTo(from.x, from.y + 62, to.x, to.y + 62, to.x, to.y + nH / 2 + 4);
      }
      ctx.stroke();
      if (i < n - 1) this.arrowHead(x2 + 7, to.y, 0);
    }

    b.nodes.forEach((node, i) => {
      const c = centers[i];
      const key = `o:${node.id}`;
      const flash = this.flashOf(key);
      const glow = flash ? 1 - this.animT(key) : 0;

      ctx.save();
      ctx.shadowColor = flash ? this.alpha(flash, 0.6 * glow) : 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = flash ? 18 * glow : 8;
      ctx.shadowOffsetY = flash ? 0 : 2;
      this.roundRect(c.x - nW / 2, c.y - nH / 2, nW, nH, 10);
      const g = ctx.createLinearGradient(c.x, c.y - nH / 2, c.x, c.y + nH / 2);
      if (flash) {
        g.addColorStop(0, this.alpha(flash, 0.95));
        g.addColorStop(1, this.alpha(flash, 0.65));
      } else {
        g.addColorStop(0, C.nodeBg);
        g.addColorStop(1, C.nodeBg2);
      }
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();

      this.roundRect(c.x - nW / 2, c.y - nH / 2, nW, nH, 10);
      ctx.strokeStyle = flash ? this.alpha('#ffffff', 0.5) : C.gridBorder;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = flash ? '#ffffff' : C.text;
      ctx.font = 'bold 14px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(vToString(node.value), c.x, c.y + 1);
    });
    ctx.textAlign = 'left';
  }

  private arrowHead(x: number, y: number, ang: number) {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.edge;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 8 * Math.cos(ang - 0.42), y - 8 * Math.sin(ang - 0.42));
    ctx.lineTo(x - 8 * Math.cos(ang + 0.42), y - 8 * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  /* ================= 图 ================= */

  private drawGraph(b: GraphBand, x: number, cardY: number, innerW: number) {
    const ctx = this.ctx;
    const C = this.colors;
    const n = b.size;
    const r = 19;
    const contentTop = cardY + TITLE_H + CARD_PAD + 12;
    const cy = contentTop + 88;
    const R = Math.min(innerW / 2 - 26, 84);
    const cx = x + innerW / 2;

    const pts: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const ang = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
      pts.push({ x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) });
    }

    for (const [a2, b2, w] of b.edges) {
      const p1 = pts[a2];
      const p2 = pts[b2];
      if (!p1 || !p2) continue;
      ctx.strokeStyle = C.edge;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      if (b.directed) {
        const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        this.arrowHead(mx + 6 * Math.cos(ang), my + 6 * Math.sin(ang), ang);
      }
      if (w !== null && w !== 1) {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        ctx.font = '10.5px "JetBrains Mono", Consolas, monospace';
        const t = String(w);
        const tw = ctx.measureText(t).width;
        this.roundRect(mx - tw / 2 - 5, my - 9, tw + 10, 17, 6);
        ctx.fillStyle = this.theme === 'dark' ? 'rgba(11,18,32,0.9)' : 'rgba(255,255,255,0.95)';
        ctx.fill();
        ctx.strokeStyle = C.cardBorder;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = C.dim;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(t, mx, my);
      }
    }

    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (!p) continue;
      const key = `v:${b.name}:${i}`;
      const flash = this.flashOf(key);
      const glow = flash ? 1 - this.animT(key) : 0;
      this.node(p.x, p.y, r, flash, glow);
      ctx.fillStyle = flash ? '#ffffff' : C.text;
      ctx.font = 'bold 13px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i), p.x, p.y + 1);
    }
    ctx.textAlign = 'left';
  }

  /* ================= 字典 ================= */

  private drawDict(b: DictBand, x: number, cardY: number, innerW: number) {
    const ctx = this.ctx;
    const C = this.colors;
    const cardW = 148;
    const cardH = 56;
    const gap = 10;
    const cols = Math.max(1, Math.floor((innerW + gap) / (cardW + gap)));
    const top = cardY + TITLE_H + CARD_PAD + 8;

    b.entries.forEach((en, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx = x + col * (cardW + gap);
      const cy = top + row * (cardH + gap);
      const key2 = `d:${b.name}:${en.key}`;
      const flash = this.flashOf(key2);
      const glow = flash ? 1 - this.animT(key2) : 0;

      this.roundRect(cx, cy, cardW, cardH, 9);
      ctx.fillStyle = flash ? this.alpha(flash, 0.55) : C.nodeBg2;
      ctx.fill();
      ctx.strokeStyle = flash ? this.alpha(flash, 0.6 * glow + 0.3) : C.cardBorder;
      ctx.lineWidth = 1.1;
      ctx.stroke();

      ctx.fillStyle = C.accent;
      ctx.font = 'bold 11px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const kl = en.key.length > 9 ? en.key.slice(0, 9) + '…' : en.key;
      ctx.fillText(kl, cx + 11, cy + 17);

      ctx.fillStyle = C.text;
      ctx.font = '13px "JetBrains Mono", Consolas, monospace';
      const v = en.value;
      let label = v === null || v === undefined ? '∅' : vToString(v);
      if (label.length > 13) label = label.slice(0, 13) + '…';
      ctx.fillText(label, cx + 11, cy + 38);
    });
    ctx.textAlign = 'left';
  }

  /* ================= 基础图元 ================= */

  /** #rrggbb + alpha → rgba() */
  private alpha(hex: string, a: number): string {
    if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b2 = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b2},${Math.max(0, Math.min(1, a))})`;
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}
