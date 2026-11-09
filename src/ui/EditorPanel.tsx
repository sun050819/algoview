import { useEffect, useRef, useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { useApp } from '../store/appStore';
import { LANGS } from '../languages';
import { engineStatus, invalidateEngineStatus, type EngineStatus } from '../languages/localBridge';

export default function EditorPanel() {
  const lang = useApp((s) => s.lang);
  const code = useApp((s) => s.code);
  const setCode = useApp((s) => s.setCode);
  const theme = useApp((s) => s.theme);
  const errorMsg = useApp((s) => s.errorMsg);
  const runStatus = useApp((s) => s.runStatus);
  const currentStep = useApp((s) => s.currentStep);
  const events = useApp((s) => s.events);

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decRef = useRef<string[]>([]);

  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const probe = (force = false) => {
    if (force) invalidateEngineStatus();
    let alive = true;
    void engineStatus(force).then((st) => { if (alive) setEngine(st); });
    return () => { alive = false; };
  };
  useEffect(() => probe(), [lang]);

  // 从当前步往前找最近一个有真实行号的事件（call/return 等可能 line=0，不能高亮）
  let highlightLine = 0;
  for (let i = currentStep - 1; i >= 0 && i < events.length; i--) {
    const ev = events[i];
    if (ev && ev.line > 0) { highlightLine = ev.line; break; }
  }
  const spec = LANGS[lang];

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.updateOptions({ bracketPairColorization: { enabled: true }, minimap: { enabled: false } });
    if (errorMsg) {
      const m = /第 (\d+) 行/.exec(errorMsg);
      if (m) {
        const line = Number(m[1]);
        monaco.editor.setModelMarkers(editor.getModel()!, 'dsa', [
          { severity: monaco.MarkerSeverity.Error, message: errorMsg, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1000 },
        ]);
      }
    }
  };

  // 当前执行行高亮（与动画严格同步）
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    decRef.current = ed.deltaDecorations(
      decRef.current,
      highlightLine > 0
        ? [
            {
              range: new monaco.Range(highlightLine, 1, highlightLine, 1),
              options: {
                isWholeLine: true,
                className: 'cur-line',
                linesDecorationsClassName: 'cur-line-gutter',
              },
            },
          ]
        : [],
    );
  }, [highlightLine]);

  return (
    <>
      {runStatus === 'error' && errorMsg && (
        <div className="error-banner">⚠ {errorMsg}</div>
      )}
      <div className="editor-wrap">
        {!code.trim() && (
          <div className="editor-empty">
            <div className="editor-empty__t">在左侧写下 {spec.name} 代码</div>
            <div className="editor-empty__s">
              点右上角「运行」，逐行真实执行，右侧同步画出数组 / 链表 / 树 / 图
            </div>
          </div>
        )}
        <Editor
          language={spec.monacoLang}
          value={code}
          onChange={(v) => setCode(v ?? '')}
          theme={theme === 'dark' ? 'vs-dark' : 'light'}
          onMount={onMount}
          options={{
            fontSize: 13,
            lineNumbers: 'on',
            tabSize: 4,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderWhitespace: 'none',
            fontFamily: 'Consolas, "Courier New", monospace',
            wordWrap: 'off',
            minimap: { enabled: false },
            matchBrackets: 'always',
            occurrencesHighlight: 'off',
          }}
        />
      </div>
      <div className={'engine-bar' + (engine && !engine.ok ? ' is-bad' : '')}>
        <span className={'engine-dot' + (engine?.ok ? ' ok' : engine ? ' bad' : '')} />
        <span className="engine-txt">
          {engine ? engine.message : '正在检测本地运行时…'}
        </span>
        {engine && !engine.ok && (
          <button className="btn engine-retry" onClick={() => probe(true)}>重试</button>
        )}
        <span className="engine-lang">{spec.name} · 真实执行</span>
      </div>
    </>
  );
}
