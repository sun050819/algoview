#!/usr/bin/env python3
"""
数据结构与算法可视化平台 · Python 真实运行时追踪器
用法:
  python python-tracer.py < source.py            # 从 stdin 读源码
  python python-tracer.py --file path.py         # 从文件读源码
  python python-tracer.py --code "..."           # 直接从参数读源码
输出(stdout):
  第一行: __EVENTS_START__
  随后: JSONL（每行一个事件对象）
  最后: __EVENTS_END__  （错误时输出 __ERROR__ + 错误信息）
限制: 事件行数上限 / 递归深度 / 超时 / 危险内建禁用 / 输出字节上限
"""
import sys
import os
# Windows 控制台默认编码可能炸代理字符；直接把 stdout/stderr 包一层，强制 errors='replace'
class _SafeWriter:
    def __init__(self, real):
        self.real = real
        self.buffer = getattr(real, 'buffer', None)
    def write(self, s):
        if not isinstance(s, str):
            return self.real.write(s)
        if self.buffer is not None:
            try:
                self.buffer.write(s.encode('utf-8', errors='replace'))
                return len(s)
            except Exception:
                pass
        try:
            self.real.write(s.encode('ascii', errors='replace').decode('ascii'))
        except Exception:
            pass
        return len(s)
    def flush(self):
        try: self.real.flush()
        except Exception: pass
    def reconfigure(self, **kw): pass

try:
    sys.stdout = _SafeWriter(sys.stdout)
    sys.stderr = _SafeWriter(sys.stderr)
except Exception:
    pass
import io
import json
import copy
import signal
import builtins as _b

# ---------------- 配置 ----------------
MAX_STEPS = 50000          # 行事件上限
MAX_DEPTH = 3              # 变量快照深拷贝深度
MAX_ITEMS = 200            # 容器元素上限
TIMEOUT_SEC = 8            # 超时（秒）
MAX_OUTPUT = 200 * 1024    # 捕获输出字节上限

# ---------------- 全局状态 ----------------
_state = {
    'steps': 0,
    'events': [],          # 行事件（line/call/return）
    'prints': [],          # print 输出记录
    'max_depth_seen': 0,
    'killed': False,
}
_restricted_globals = None


# ---------------- 变量快照（限深限元素） ----------------
def _cap(value, depth):
    if depth <= 0:
        return '<depth-limit>'
    if isinstance(value, (int, float, bool, str, bytes, type(None))):
        return value
    if isinstance(value, (list, tuple)):
        items = value[:MAX_ITEMS]
        return [ _cap(v, depth - 1) for v in items ]
    if isinstance(value, dict):
        items = list(value.items())[:MAX_ITEMS]
        return { str(k): _cap(v, depth - 1) for k, v in items }
    if isinstance(value, set):
        return [ _cap(v, depth - 1) for v in list(value)[:MAX_ITEMS] ]
    # 普通对象：抽字段
    try:
        fields = getattr(value, '__dict__', None)
        if isinstance(fields, dict):
            return { str(k): _cap(v, depth - 1) for k, v in list(fields.items())[:MAX_ITEMS] }
    except Exception:
        pass
    return '<' + type(value).__name__ + '>'


def _safe_vars(locals_dict):
    out = {}
    for k, v in list(locals_dict.items()):
        if k.startswith('__'):
            continue
        # 函数/类/模块没法可视化，显示成 {} 只会让人困惑（变量表里会冒充空字典）
        if callable(v) or isinstance(v, type):
            continue
        if hasattr(v, '__file__') or hasattr(v, '__loader__'):
            continue
        try:
            out[k] = _cap(v, MAX_DEPTH)
        except Exception:
            out[k] = '<unserializable>'
    return out


def _safe_globals(frame):
    """模块级全局变量的实时快照。

    函数里的形参和模块里的变量经常是同一个对象（arr 传进 qs 就是 a），
    只读 f_locals 的话，递归期间全局那份会一直停在进入函数前的旧值，
    画面上就会出现"同一份数据两个样子"。所以每步都带一份实时全局快照。
    """
    try:
        g = frame.f_globals
    except Exception:
        return {}
    out = {}
    for k, v in list(g.items()):
        if k.startswith('__'):
            continue
        if callable(v) or isinstance(v, type):
            continue
        if hasattr(v, '__file__') or hasattr(v, '__loader__'):  # 模块对象
            continue
        try:
            out[k] = _cap(v, MAX_DEPTH)
        except Exception:
            pass
    return out


def _call_stack(frame):
    stack = []
    f = frame
    while f is not None:
        # 只保留用户代码帧（<user_code>）与模块帧，过滤 tracer 内部帧
        if f.f_code.co_filename == '<user_code>' or f.f_code.co_filename == '<string>':
            name = f.f_code.co_name
            if name == '<module>':
                name = 'main'
            stack.append(name)
        f = f.f_back
    return stack


# ---------------- 追踪函数 ----------------
def _trace(frame, event, arg):
    s = _state
    if s['killed']:
        return None
    # 只追踪用户代码帧，跳过 tracer 内部帧（如输出捕获对象）
    if frame.f_code.co_filename != '<user_code>':
        return None
    if s['steps'] >= MAX_STEPS:
        s['killed'] = True
        raise SystemExit('\n[平台提示] 执行步数超过上限 (%d)，已自动终止。请精简代码或减少循环次数。' % MAX_STEPS)

    if event in ('line', 'call', 'return'):
        s['steps'] += 1
        try:
            ev = {
                'type': event,
                'line': frame.f_lineno,
                'fn': frame.f_code.co_name if frame.f_code.co_name != '<module>' else 'main',
                'vars': _safe_vars(frame.f_locals),
                'stack': _call_stack(frame),
                'gvars': _safe_globals(frame),
            }
            if event == 'return':
                try:
                    ev['ret'] = _cap(arg, MAX_DEPTH)
                except Exception:
                    ev['ret'] = None
            s['events'].append(ev)
        except Exception:
            pass
    return _trace


# ---------------- 输出捕获 ----------------
class _Capture(io.TextIOBase):
    def __init__(self):
        self.buf = []
        self.size = 0
    def write(self, text):
        if text is None:
            return 0
        text = str(text)
        if self.size + len(text.encode('utf-8', 'replace')) > MAX_OUTPUT:
            self.buf.append('\n[平台提示] 输出超过上限，已截断。')
            raise SystemExit('[平台提示] 输出超过上限，已自动终止。')
        self.buf.append(text)
        self.size += len(text.encode('utf-8', 'replace'))
        # 保留最后 200 条 print 记录（供事件流）
        return len(text)
    def flush(self):
        pass


# ---------------- 安全限制 ----------------
_DISABLED = {
    'open', 'input', 'exec', 'eval', 'compile', '__import__',
    'globals', 'locals', 'vars', 'breakpoint', 'exit', 'quit',
    'help', 'memoryview', 'bytearray', 'getattr', 'setattr', 'delattr',
}


def _make_restricted_builtins():
    rb = {}
    for name in dir(_b):
        if name.startswith('__') and name not in ('__build_class__', '__name__'):
            continue
        if name in _DISABLED:
            continue
        try:
            obj = getattr(_b, name)
        except Exception:
            continue
        rb[name] = obj
    # 常用数学/随机：安全子集
    try:
        import math as _math
        for n in ('pi', 'e', 'sqrt', 'pow', 'floor', 'ceil', 'abs',
                  'log', 'log10', 'log2', 'exp', 'sin', 'cos', 'tan',
                  'fabs', 'factorial', 'gcd', 'isqrt', 'trunc', 'fmod'):
            if hasattr(_math, n):
                rb[n] = getattr(_math, n)
    except Exception:
        pass
    try:
        import random as _random
        for n in ('randint', 'randrange', 'choice', 'shuffle', 'sample', 'seed', 'uniform'):
            if hasattr(_random, n):
                rb[n] = getattr(_random, n)
    except Exception:
        pass
    return rb


def _run_user_code(code):
    # 用户命名空间与内置隔离：用户变量只出现在 globals 中，内置经 __builtins__ 访问
    g = {'__builtins__': _make_restricted_builtins(), '__name__': '__main__'}
    sys.settrace(_trace)
    exec(compile(code, '<user_code>', 'exec'), g)
    sys.settrace(None)


# ---------------- 入口 ----------------
def main():
    # 解析参数
    args = sys.argv[1:]
    code = None
    if '--code' in args:
        i = args.index('--code')
        code = args[i + 1] if i + 1 < len(args) else ''
    elif '--file' in args:
        i = args.index('--file')
        with open(args[i + 1], 'r', encoding='utf-8') as f:
            code = f.read()
    else:
        code = sys.stdin.read()

    if not code:
        print('__ERROR__ 空代码')
        return

    # 超时
    def _timeout(_signum, _frame):
        _state['killed'] = True
        sys.stderr.write('\n[平台提示] 执行超时（%ds），已自动终止。\n' % TIMEOUT_SEC)
        os._exit(2)
    try:
        signal.signal(signal.SIGALRM, _timeout)
        signal.alarm(TIMEOUT_SEC)
    except Exception:
        pass

    # 输出重定向
    cap = _Capture()
    old_stdout = sys.stdout
    sys.stdout = cap

    global _restricted_globals
    _restricted_globals = None  # 不再使用全局注入

    try:
        _run_user_code(code)
    except SystemExit as e:
        # 步数超限/输出超限触发的终止：正常路径
        if _state['killed']:
            pass
        else:
            print(str(e) if e.args else '')
    except KeyboardInterrupt:
        pass
    except Exception as e:
        err = '%s: %s' % (type(e).__name__, e)
        # 输出错误定位（行号）
        tb = sys.exc_info()[2]
        lineno = None
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == '<user_code>':
                lineno = tb.tb_lineno
                break
            tb = tb.tb_next
        # 先恢复真实 stdout 再写 __ERROR__ 定界标记（否则会被输出捕获吞掉）
        sys.stdout = old_stdout
        sys.settrace(None)
        print('__ERROR__ %s%s' % (err, '（第 %d 行）' % lineno if lineno else ''))
        return
    finally:
        sys.settrace(None)
        sys.stdout = old_stdout

    # 输出事件流
    print('__EVENTS_START__')
    for ev in _state['events']:
        try:
            print(json.dumps(ev, ensure_ascii=True, separators=(',', ':')))
        except Exception:
            pass
    print('__EVENTS_END__')
    print('__OUTPUT_START__')
    print(''.join(cap.buf), end='')
    print('__OUTPUT_END__')


if __name__ == '__main__':
    main()
