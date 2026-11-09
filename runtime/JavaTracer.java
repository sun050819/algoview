// JavaTracer —— JDWP/JDI 逐步执行追踪器（Java 真实运行时轨）
// 用法: java JavaTracer <port> [stepLimit] [timeoutMs] [classFilters逗号分隔]
// 目标 JVM 以 -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=0 启动。
// 说明：suspend=y 的挂起点在 main 线程创建之前，因此用 ThreadStartRequest 捕获
// main 线程启动事件，在该挂起点创建 StepRequest（STEP_LINE + STEP_OVER + 类过滤）。
// 输出 JSONL 事件流（与 runtime/python-tracer.py 对齐）：
//   __EVENTS_START__
//   {"type":"call","line":0,"fn":"main","vars":{},"stack":["main"]}
//   {"type":"line","line":N,"fn":"...","vars":{...},"stack":[...]}
//   __EVENTS_END__
import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.util.*;

public class JavaTracer {
    static int stepLimit = 50000;
    static long timeoutMs = 8000;
    static String[] classFilters = new String[] { "*" };

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        if (args.length > 1) stepLimit = Integer.parseInt(args[1]);
        if (args.length > 2) timeoutMs = Long.parseLong(args[2]);
        if (args.length > 3 && !args[3].isEmpty()) {
            classFilters = args[3].split(",");
        }

        // 1. attach 目标 JVM
        VirtualMachineManager mgr = Bootstrap.virtualMachineManager();
        AttachingConnector connector = null;
        for (AttachingConnector c : mgr.attachingConnectors()) {
            if ("com.sun.jdi.SocketAttach".equals(c.name())) { connector = c; break; }
        }
        if (connector == null) { System.out.println("__EVENTS_START__\n__EVENTS_END__"); return; }
        Map<String, Connector.Argument> params = connector.defaultArguments();
        params.get("port").setValue(String.valueOf(port));
        VirtualMachine vm = connector.attach(params);

        EventRequestManager erm = vm.eventRequestManager();
        // 2. ThreadStart：捕获 main 线程启动（此时全挂起，可在挂起点创建 StepRequest）
        ThreadStartRequest tsr = erm.createThreadStartRequest();
        tsr.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        tsr.enable();

        // 3. 事件循环
        long start = System.currentTimeMillis();
        int steps = 0;
        boolean tracedMain = false;
        // 物理调用栈簿记：仅按「用户帧」数推 call/return（JDK 帧透明跳过）
        java.util.List<String> callStack = new java.util.ArrayList<>();
        int lastUserDepth = 0;
        System.out.println("__EVENTS_START__");
        vm.resume();
        try {
            while (steps < stepLimit && System.currentTimeMillis() - start < timeoutMs) {
                EventSet es = vm.eventQueue().remove(500);
                if (es == null) continue;
                for (Event ev : es) {
                    if (ev instanceof ThreadStartEvent) {
                        ThreadReference t = ((ThreadStartEvent) ev).thread();
                        if (!tracedMain && "main".equals(t.name())) {
                            tracedMain = true;
                            StepRequest sr = erm.createStepRequest(t, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
                            // 注意：JDI 的 addClassFilter 一个请求只能调一次，多类用户代码会抛异常。
                            // 改为不加过滤器，在事件循环里按类名前缀跳过 JDK 内部类。
                            sr.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
                            sr.enable();
                            callStack.add("main");
                            lastUserDepth = 1;
                            System.out.println("{\"type\":\"call\",\"line\":0,\"fn\":\"main\",\"vars\":{},\"stack\":[\"main\"]}");
                            steps++;
                        }
                    } else if (ev instanceof StepEvent) {
                        StepEvent se = (StepEvent) ev;
                        String cname = se.location().declaringType().name();
                        boolean jdk = cname.startsWith("java.") || cname.startsWith("javax.")
                            || cname.startsWith("jdk.") || cname.startsWith("sun.")
                            || cname.startsWith("com.sun.") || cname.startsWith("org.");
                        if (jdk) {
                            // JDK 内部帧：跳过，不记事件
                        } else {
                            Location loc = se.location();
                            int line = loc.lineNumber();
                            String fn = loc.method().name();
                            ThreadReference th = se.thread();
                            // 按用户帧深度差补发 call/return（与 gdb-tracer 同思路）
                            int userDepth = 0;
                            java.util.List<String> userStack = new java.util.ArrayList<>();
                            for (StackFrame f : th.frames()) {
                                String cn = f.location().declaringType().name();
                                boolean fjdk = cn.startsWith("java.") || cn.startsWith("javax.")
                                    || cn.startsWith("jdk.") || cn.startsWith("sun.")
                                    || cn.startsWith("com.sun.") || cn.startsWith("org.");
                                if (!fjdk) {
                                    userDepth++;
                                    userStack.add(f.location().method().name());
                                }
                            }
                            if (userDepth > lastUserDepth) {
                                for (int i = callStack.size(); i < userDepth; i++) {
                                    String nf = i < userStack.size() ? userStack.get(userStack.size() - 1 - i) : fn;
                                    callStack.add(nf);
                                    System.out.println("{\"type\":\"call\",\"line\":0,\"fn\":" + q(nf)
                                        + ",\"vars\":{},\"stack\":" + stackFromList(callStack) + "}");
                                }
                            } else if (userDepth < lastUserDepth) {
                                while (callStack.size() > userDepth) {
                                    String ret = callStack.remove(callStack.size() - 1);
                                    System.out.println("{\"type\":\"return\",\"line\":" + line + ",\"fn\":" + q(ret)
                                        + ",\"vars\":{},\"stack\":" + stackFromList(callStack) + "}");
                                }
                            }
                            lastUserDepth = userDepth;
                            StringBuilder json = new StringBuilder("{");
                            json.append("\"type\":\"line\",\"line\":").append(line)
                                .append(",\"fn\":").append(q(fn))
                                .append(",\"vars\":");
                            Map<String, String> vars = readVars(th, line, fn);
                            json.append(toJson(vars));
                            json.append(",\"stack\":").append(stackJson(th));
                            // 全局快照：main 这一层的变量。
                            // 递归进到 ins() 之后，只读当前帧会让 root/data 停在旧值，
                            // 画面上树就不长、数组不动，所以每步都补一份底部帧快照。
                            int bottom = bottomUserFrame(th);
                            if (bottom > 0) {
                                json.append(",\"gvars\":").append(toJson(readFrameVars(th, bottom)));
                            }
                            json.append("}");
                            System.out.println(json);
                            steps++;
                        }
                    }
                }
                es.resume();
            }
        } catch (VMDisconnectedException e) {
            // 程序自然结束（正常）
        } catch (Exception e) {
            System.err.println("JT-EX: " + e);
        }
        // 程序退出：补发残留栈帧的 return（main 走完后直接 VMDisconnect，可能漏发）
        while (!callStack.isEmpty()) {
            String ret = callStack.remove(callStack.size() - 1);
            System.out.println("{\"type\":\"return\",\"line\":0,\"fn\":" + q(ret)
                + ",\"vars\":{},\"stack\":" + stackFromList(callStack) + "}");
        }
        System.out.println("__EVENTS_END__");
        try { vm.dispose(); } catch (Exception ignore) {}
    }

    // 读取当前帧局部变量（限深/限元素）
    static Map<String, String> readVars(ThreadReference th, int line, String fn) {
        return readFrameVars(th, 0);
    }

    // 读取指定栈帧的可见局部变量
    static Map<String, String> readFrameVars(ThreadReference th, int idx) {
        Map<String, String> out = new LinkedHashMap<>();
        try {
            if (idx < 0 || idx >= th.frameCount()) return out;
            StackFrame frame = th.frame(idx);
            List<LocalVariable> locals = null;
            try { locals = frame.visibleVariables(); } catch (Exception e) { locals = null; }
            if (locals != null) {
                for (LocalVariable lv : locals) {
                    try {
                        Value v = frame.getValue(lv);
                        out.put(lv.name(), valueJson(v, 0));
                    } catch (Exception ignore) {}
                }
            }
        } catch (Exception ignore) {}
        return out;
    }

    static String stackJson(ThreadReference th) {
        StringBuilder sb = new StringBuilder("[");
        try {
            int n = 0;
            for (StackFrame f : th.frames()) {
                if (++n > 20) break;
                if (n > 1) sb.append(",");
                sb.append(q(f.location().method().name()));
            }
        } catch (Exception ignore) {}
        sb.append("]");
        return sb.toString();
    }

    /** 最底部那一层"用户代码"栈帧的下标（跳过 JDK 内部帧）；没有则返回 -1 */
    static int bottomUserFrame(ThreadReference th) {
        try {
            for (int i = th.frameCount() - 1; i >= 0; i--) {
                String tn = th.frame(i).location().declaringType().name();
                if (tn.startsWith("java.") || tn.startsWith("javax.") || tn.startsWith("jdk.")
                    || tn.startsWith("sun.") || tn.startsWith("com.sun.")) continue;
                return i;
            }
        } catch (Exception ignore) {}
        return -1;
    }

    static String stackFromList(java.util.List<String> stack) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < stack.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(q(stack.get(i)));
        }
        sb.append("]");
        return sb.toString();
    }

    // 值 → JSON 字符串
    //   - 深度上限放到 5：二叉树/链表常有三四层嵌套，深度 2 会在第二层就退化成
    //     "instance of Node(id=…)" 字符串，导致可视化层识别不出结构、画不成树
    //   - 用 seen 记录已展开对象的 uniqueID 防自引用死循环
    //   - budget 控制总节点数，避免大对象图把事件流撑爆
    static String valueJson(Value v, int depth) {
        return valueJson(v, depth, new java.util.HashSet<Long>(), new int[] { 0 });
    }

    static String valueJson(Value v, int depth, java.util.Set<Long> seen, int[] budget) {
        if (v == null) return "null";
        if (budget[0] > 3000) return "null";
        if (v instanceof PrimitiveValue) {
            PrimitiveValue pv = (PrimitiveValue) v;
            if (pv.type().name().equals("char")) {
                char c = (char) pv.charValue();
                return q(String.valueOf(c));
            }
            return pv.toString();
        }
        if (v instanceof StringReference) return q(((StringReference) v).value());
        if (v instanceof ArrayReference && depth < 4) {
            ArrayReference ar = (ArrayReference) v;
            int len = Math.min((int) ar.length(), 200);
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < len; i++) {
                if (i > 0) sb.append(",");
                budget[0]++;
                try { sb.append(valueJson(ar.getValue(i), depth + 1, seen, budget)); }
                catch (Exception e) { sb.append("null"); }
            }
            if (ar.length() > 200) sb.append(",...");
            sb.append("]");
            return sb.toString();
        }
        if (v instanceof ObjectReference) {
            ObjectReference or = (ObjectReference) v;
            try {
                String tn = or.referenceType().name();
                if (tn.equals("java.lang.Boolean") || tn.equals("java.lang.Integer")
                    || tn.equals("java.lang.Long") || tn.equals("java.lang.Double")
                    || tn.equals("java.lang.Float") || tn.equals("java.lang.Short")
                    || tn.equals("java.lang.Byte") || tn.equals("java.lang.Character")) {
                    Value inner = or.getValue(or.referenceType().fieldByName("value"));
                    return inner == null ? "null" : valueJson(inner, depth + 1, seen, budget);
                }
            } catch (Exception ignore) {}
            // 引用环：直接给个占位，不再展开
            long uid = or.uniqueID();
            if (seen.contains(uid)) return q("↺ #" + Long.toHexString(uid));
            if (depth >= 5) return q("instance of " + or.referenceType().name() + "(id=" + uid + ")");
            seen.add(uid);
            budget[0]++;
            StringBuilder sb = new StringBuilder("{");
            int n = 0;
            for (Field f : or.referenceType().allFields()) {
                if (++n > 50 || budget[0] > 3000) break;
                if (f.isStatic()) continue;
                if (n > 1) sb.append(",");
                try { sb.append(q(f.name())).append(":").append(valueJson(or.getValue(f), depth + 1, seen, budget)); }
                catch (Exception e) { sb.append(q(f.name())).append(":null"); }
            }
            if (n == 0) { seen.remove(uid); return q(or.referenceType().name() + "@" + Long.toHexString(uid)); }
            sb.append("}");
            seen.remove(uid);
            return sb.toString();
        }
        return q(v.toString());
    }

    static String toJson(Map<String, String> vars) {
        StringBuilder sb = new StringBuilder("{");
        int i = 0;
        for (Map.Entry<String, String> e : vars.entrySet()) {
            if (i++ > 0) sb.append(",");
            sb.append(q(e.getKey())).append(":").append(e.getValue());
        }
        sb.append("}");
        return sb.toString();
    }

    static String q(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append("\"");
        return sb.toString();
    }
}
