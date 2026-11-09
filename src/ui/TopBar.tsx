import { useApp } from '../store/appStore';
import { LANGS, LangId } from '../languages';

interface Props {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const LANG_FILE_EXT: Record<LangId, string> = {
  python: 'py',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
};

const LANG_NAME: Record<LangId, string> = {
  python: 'Python',
  c: 'C',
  cpp: 'C++',
  java: 'Java',
};

export default function TopBar({ collapsed, onToggleCollapse }: Props) {
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const run = useApp((s) => s.run);
  const setTheme = useApp((s) => s.setTheme);
  const theme = useApp((s) => s.theme);
  const runStatus = useApp((s) => s.runStatus);
  const errorMsg = useApp((s) => s.errorMsg);
  const reset = useApp((s) => s.reset);
  const code = useApp((s) => s.code);
  const setCode = useApp((s) => s.setCode);

  const doImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `.${LANG_FILE_EXT[lang]},.txt`;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        setCode(String(reader.result || ''));
      };
      reader.readAsText(f);
    };
    input.click();
  };

  const doExport = () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `algorithm.${LANG_FILE_EXT[lang]}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="topbar">
      <button className="btn ghost" title="折叠/展开代码区" onClick={onToggleCollapse}>
        {collapsed ? '≫' : '≪'}
      </button>
      <div className="logo">
        算法视界
        <span className="badge badge-real">
          真实运行时（{LANG_NAME[lang]}）
        </span>
      </div>
      <div className="spacer" />
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as LangId)}
        title="选择编程语言"
      >
        {Object.values(LANGS).map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <button className="btn" title="从磁盘导入代码文件" onClick={doImport}>
        导入
      </button>
      <button className="btn" title="导出当前代码到磁盘" onClick={doExport}>
        导出
      </button>
      <button className="btn primary" onClick={run} disabled={runStatus === 'compiling' || runStatus === 'running'}>
        {runStatus === 'compiling' ? '编译中…' : '▶ 运行'}
      </button>
      <button className="btn" onClick={reset}>
        重置
      </button>
      <button className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? '浅色' : '深色'}
      </button>
      {errorMsg && <span style={{ color: 'var(--danger)', fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✕ 有错误</span>}
    </div>
  );
}
