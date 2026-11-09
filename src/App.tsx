import { useEffect, useRef, useState } from 'react';
import { useApp } from './store/appStore';
import TopBar from './ui/TopBar';
import EditorPanel from './ui/EditorPanel';
import CanvasView from './ui/CanvasView';
import StatePanel from './ui/StatePanel';
import ControlBar from './ui/ControlBar';

export default function App() {
  const theme = useApp((s) => s.theme);
  const setCode = useApp((s) => s.setCode);
  const [leftW, setLeftW] = useState(46); // %
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  // 桌面端：菜单 Ctrl+O / Ctrl+S 桥接
  useEffect(() => {
    const api = (window as unknown as { dsaDesktop?: {
      onFileOpened: (cb: (p: { filePath: string; content: string }) => void) => () => void;
      onSaveRequested: (cb: (p: { filePath: string }) => void) => void;
      saveSourceFile: (content: string, name?: string) => Promise<boolean>;
    } }).dsaDesktop;
    if (!api) return;
    const offOpen = api.onFileOpened(({ content }) => setCode(content));
    api.onSaveRequested(() => {
      const code = useApp.getState().code;
      void api.saveSourceFile(code, 'demo');
    });
    return () => { offOpen(); };
  }, [setCode]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: leftW };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ((ev.clientX - dragRef.current.startX) / window.innerWidth) * 100;
      setLeftW(Math.min(72, Math.max(22, dragRef.current.startW + dx)));
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div className={`app theme-${theme}`}>
      <TopBar collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)} />
      <div className="main">
        {!collapsed && (
          <div className="left-pane" style={{ width: `${leftW}%` }}>
            <EditorPanel />
          </div>
        )}
        <div className="divider" onMouseDown={startDrag} />
        <div className="right-pane">
          <CanvasView />
          <StatePanel />
        </div>
      </div>
      <ControlBar />
    </div>
  );
}
