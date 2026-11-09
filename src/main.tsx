import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// Monaco 本地打包（离线可用，不依赖 CDN）
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import { loader } from '@monaco-editor/react';

self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
loader.config({ monaco });

// 调试/自动化测试接口：暴露 monaco 实例，便于脚本注入代码（不参与任何运行逻辑）
(window as any).__dsaMonaco = monaco;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
