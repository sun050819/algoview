import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../store/appStore';
import { VisualRenderer } from '../visualizer/renderer';
import { buildModel } from '../visualizer/model';

export default function CanvasView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<VisualRenderer | null>(null);
  const prevStepRef = useRef(0);

  const theme = useApp((s) => s.theme);
  const replay = useApp((s) => s.replay);
  const currentStep = useApp((s) => s.currentStep);
  const events = useApp((s) => s.events);
  const maxStep = useApp((s) => s.maxStep);
  const runStatus = useApp((s) => s.runStatus);

  const model = useMemo(() => buildModel(replay), [replay]);

  // 初始化渲染器
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = new VisualRenderer(canvas);
    r.setTheme(theme);
    r.start();
    rendererRef.current = r;
    // 调试/自动化：便于确认渲染器实际使用的主题
    (window as any).__dsaRenderer = r;
    // 尺寸同步
    const wrap = wrapRef.current;
    if (wrap) {
      r.resize(wrap.clientWidth, wrap.clientHeight);
      const ro = new ResizeObserver(() => {
        r.resize(wrap.clientWidth, wrap.clientHeight);
      });
      ro.observe(wrap);
      return () => {
        ro.disconnect();
        r.destroy();
        rendererRef.current = null;
      };
    }
    return () => {
      r.destroy();
      rendererRef.current = null;
    };
  }, [theme]);

  // 主题切换
  useEffect(() => {
    rendererRef.current?.setTheme(theme);
  }, [theme]);

  // 每次步进更新画布与动画
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setModel(model);
    const ev = currentStep > 0 && currentStep <= events.length ? events[currentStep - 1] : null;
    const desc = ev ? ev.desc : runStatus === 'error' ? '执行出错，请查看错误提示' : currentStep === 0 && maxStep > 0 ? '准备就绪，点击播放开始' : '点击「运行」开始可视化';
    r.setStepInfo(desc, ev?.line ?? 0, currentStep, maxStep);
    // 前进一步 → 播放动画；后退/跳转不播动画（状态直接呈现）
    if (currentStep === prevStepRef.current + 1 && ev) {
      r.pulse(ev);
    }
    prevStepRef.current = currentStep;
  }, [model, currentStep, events, maxStep, runStatus]);

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
