import { useState } from 'react';
import { useApp } from '../store/appStore';
import { vToString } from '../core/value';
import type { ReplayState } from '../core/events';

type Tab = 'vars' | 'stack' | 'log';

export default function StatePanel() {
  const [tab, setTab] = useState<Tab>('vars');
  const replay = useApp((s) => s.replay);

  return (
    <div className="state-panel">
      <div className="state-tabs">
        <div className={`state-tab ${tab === 'vars' ? 'active' : ''}`} onClick={() => setTab('vars')}>
          变量
        </div>
        <div className={`state-tab ${tab === 'stack' ? 'active' : ''}`} onClick={() => setTab('stack')}>
          调用栈
        </div>
        <div className={`state-tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>
          输出与日志
        </div>
      </div>
      <div className="state-body">
        {tab === 'vars' && <VarsView state={replay} />}
        {tab === 'stack' && <StackView state={replay} />}
        {tab === 'log' && <LogView state={replay} />}
      </div>
    </div>
  );
}

function VarsView({ state }: { state: ReplayState }) {
  const top = state.frames[state.frames.length - 1];
  // 过滤掉编译器注入的临时量（__for_begin…）和空数组（如 Java 的 args）
  const useful = (k: string, v: unknown) => {
    if (k.startsWith('__')) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  };
  const rawLocals = top ? { ...top.locals, ...top.args } : {};
  const locals = Object.fromEntries(Object.entries(rawLocals).filter(([k, v]) => useful(k, v)));
  const globals = Object.entries(state.globals).filter(([k, v]) => useful(k, v));
  if (globals.length === 0 && Object.keys(locals).length === 0) {
    return <div className="empty">（暂无变量）</div>;
  }
  return (
    <table>
      {Object.keys(locals).length > 0 && (
        <>
          <tr>
            <td className="k" colSpan={2} style={{ color: 'var(--accent)', fontWeight: 600, border: 'none' }}>
              当前函数 {top?.fn} 的局部变量
            </td>
          </tr>
          {Object.entries(locals).map(([k, v]) => (
            <tr key={'l' + k}>
              <td className="k">{k}</td>
              <td className="v">{vToString(v)}</td>
            </tr>
          ))}
        </>
      )}
      <tr>
        <td className="k" colSpan={2} style={{ color: 'var(--accent)', fontWeight: 600, border: 'none' }}>
          全局变量
        </td>
      </tr>
      {globals.map(([k, v]) => (
        <tr key={'g' + k}>
          <td className="k">{k}</td>
          <td className="v">{vToString(v)}</td>
        </tr>
      ))}
    </table>
  );
}

function StackView({ state }: { state: ReplayState }) {
  if (state.frames.length === 0) {
    return <div className="empty">（调用栈为空）</div>;
  }
  const frames = [...state.frames].reverse(); // 栈顶在上
  return (
    <div>
      {frames.map((f, i) => (
        <div className="frame" key={i}>
          <div className="fhead">
            {i === 0 ? '▸ ' : ''}调用 {f.fn}
          </div>
          <div className="fbody">
            <table>
              {Object.entries(f.args).map(([k, v]) => (
                <tr key={'a' + k}>
                  <td className="k">参数 {k}</td>
                  <td className="v">{vToString(v)}</td>
                </tr>
              ))}
              {Object.entries(f.locals).map(([k, v]) => (
                <tr key={'l' + k}>
                  <td className="k">局部 {k}</td>
                  <td className="v">{vToString(v)}</td>
                </tr>
              ))}
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function LogView({ state }: { state: ReplayState }) {
  if (state.outputs.length === 0) {
    return <div className="empty">（暂无输出）</div>;
  }
  const lines = state.outputs.slice(-300);
  return (
    <div>
      {lines.map((l, i) => (
        <div className="log-line" key={i}>
          {l}
        </div>
      ))}
    </div>
  );
}
