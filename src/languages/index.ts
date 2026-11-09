/**
 * 语言注册表（轻量）
 *
 * 这里只放 UI 需要的元信息：语言 id、显示名、Monaco 语法 id。
 * 真正的执行全部走本地服务（见 pythonRuntime / javaRuntime / ccRuntime），
 * 本文件不 import 任何解释器、词法器或 AST —— 避免把旧「教学子集」代码
 * 顺带打进生产包。
 *
 * 历史上这个文件同时是「编译 + 解释执行」的入口，那套实现已随
 * 「只保留真实执行」的产品调整整体归档，不再参与构建。
 */

export type LangId = 'python' | 'c' | 'cpp' | 'java';

export interface LangSpec {
  id: LangId;
  /** 界面显示名 */
  name: string;
  /** Monaco 语言 id（C 与 C++ 共用 cpp 高亮） */
  monacoLang: string;
}

export const LANGS: Record<LangId, LangSpec> = {
  python: { id: 'python', name: 'Python', monacoLang: 'python' },
  c: { id: 'c', name: 'C', monacoLang: 'cpp' },
  cpp: { id: 'cpp', name: 'C++', monacoLang: 'cpp' },
  java: { id: 'java', name: 'Java', monacoLang: 'java' },
};

export const LANG_LIST: LangSpec[] = [LANGS.python, LANGS.c, LANGS.cpp, LANGS.java];
