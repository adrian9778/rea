# 17 · Native 与调试器 Provider 族

> 一句话定位：`src/native/`、`src/gdb/`、`src/rizin/`、`src/objdump/`、`src/frida/` 这五个 provider 目录，加上 `bridge/native/`、`bridge/pwntools/`、`bridge/pwndbg/` 三座 Python 桥，把「外部可执行文件 + 子进程 + 注入到引擎内部的脚本」统一包装成 application 层可调用的一次性命令端口或长会话端口。
>
> 边界澄清：本篇**不讲** Ghidra/IDA/Hopper/JEB/Cutter（[15](15-深度Provider-Hopper与Ghidra.md)、[16](16-深度Provider-IDA-Kuna-JEB-Cutter.md)），**不讲** `src/process/` 的子进程监督与所有权实现本体（[13](13-Process层-子进程监督与所有权.md)），**不讲** `src/composition/` 的装配根全貌（[11](11-Composition层-生产装配根.md)）。本篇只讲这一族「怎么把外部工具变成端口」。

## 0 速览

1. 这一族有**两种 provider 形状**：**命令 profile 型**（`src/objdump/ObjdumpCommand.ts` 只有 29 行、`src/rizin/RizinCommand.ts` 只有 19 行——只构造 argv + provider identity，不 spawn、不解析）与**会话/桥型**（`GdbSessionManager`、`RizinDebugSessionManager`、`FridaInstrumentationManager`、`LldbCallTracer`、pwntools/pwndbg provider）。
2. `src/native/` 的 28,657 行里**绝大多数是静态二进制 reader**（Mach-O/PE/ELF/apple/parsers），不 spawn 任何引擎；本篇深读其中 4 个文件，其余只到接口级（见 §1）。
3. **Frida 不走 `bridge/`**：`bridge/` 下没有 frida 目录，`src/frida/FridaInstrumentationManager.ts` 以 `import type { ... } from "frida"` 只引类型，运行时靠可注入的 loader 取 `DeviceManager`（`函数：FridaInstrumentationManager 偏移：+0`，同类内有 `Const：deviceManagerLoader`）。它是这一族里唯一「引擎直接跑在本进程内」的成员。
4. **三座 Python 桥的帧协议是同一种形状：文件式 JSON，不是 stdio JSON-line**。约定为 `request.json` → `reply.json` + `limits.json` + 单字节 marker 文件（`src/native/pwntools/PwntoolsDecoder.ts` 的 `函数：PwntoolsCommand 偏移：+0` 之下的 `Const：requestPath` / `Const：replyPath`，以及 `bridge/pwntools/layout.py` `函数：resource_exit 偏移：+3`）。
5. **只读边界不统一**：pwntools layout 与 recorded-core、pwndbg core-context 是「离线读制品」（`bridge/pwntools/recorded_crash_impl.py 函数：inspect_core 偏移：+118` 直接回写 `target_execution: "not-performed"`）；LLDB tracer **会启动目标进程**（`bridge/native/rea_lldb_tracer.py` 模块 docstring：`It launches one owned process`）；GDB/Rizin 会话接受调用方给的任意命令，是否写目标取决于命令本身，源码没有禁令。
6. 缺工具/缺绑定**一律降级为 capability-unavailable 类错误并给出配置指引**，不是抛栈：`src/gdb/GdbSessionManager.ts Class：GdbExecutableRefusal`（gdb 侧的可执行文件拒绝错误）、`src/native/pwntools/PwntoolsDecoder.ts` 的 `Set REA_PWNTOOLS_PYTHON ...` 指引、`src/native/pwndbg/PwndbgCoreContext.ts 函数：inspectPwndbgCore 偏移：+30` 处的 `AnalysisCapabilityUnavailableError("pwndbg-core", ...)`。

## 1 本篇怎么选的：体量与深读清单

`src/native/` 94 个非测试文件 / 28,657 行不可能逐行读。下表按「先 `src/native/`、再跨目录的会话型 manager」分组列出体量前列的文件（行数来自 `wc -l`，非排序）：

| 文件 | 行数 | 本篇处理深度 | 为什么 |
|---|---|---|---|
| `src/native/LldbCallTracer.ts` | 1568 | **深读**（spawn/argv/config/cleanup/partial） | 本族唯一的「调试器注入 + 目标执行」桥 |
| `src/native/NativeMacOSProvider.ts` | 1564 | **接口级**（只查它怎么拿 tracer 工厂） | 是 `LldbCallTracer` 的持有者 |
| `src/native/AppleMachoFixups.ts` | 1371 | **未读** | 纯 Mach-O 修复项 reader，与调试器无关 |
| `src/native/pwntools/PwntoolsDecoder.ts` | 796 | **深读**（帧协议、supervisor、失败分级） | 三座桥的公共底座 |
| `src/native/parsers/otool.ts` | 683 | **未读** | 静态 reader |
| `src/native/exports/NativeExportParser.ts` | 654 | **未读** | 静态 reader |
| `src/native/CommandRunner.ts` | 611 | **接口级** | objdump/rizin 一次性命令的执行入口候选 |
| `src/gdb/GdbSessionManager.ts` | 2438 | **深读**（MI 会话、上限、清理） | 会话型代表 |
| `src/rizin/RizinDebugSessionManager.ts` | 1862 | **深读**（tty 附着、argv、marker 完成判据） | 会话型代表 |
| `src/frida/FridaInstrumentationManager.ts` | 1709 | **深读偏浅**（端口实现、限制、清理） | 唯一的 in-process 引擎 |
| `src/objdump/ObjdumpCommand.ts` | 29 | **全读** | 验证「薄适配」命题 |

`[推导]` 判据：凡是「名字里带 Provider/Manager/Tracer/Session」且行数在前 20 的，逐个读到端口边界；纯 reader（`apple/`、`elf/`、`pe/`、`parsers/`、`metadata/`、`exports/`）只确认它们属于同一目录、不进入本篇机制叙述。

## 2 共同形状：provider 类 ↔ Port 类型 ↔ 装配点

```
        ┌───────────────────────── adapter（CLI / MCP server）─────────────────────────┐
        │ src/cli/reverseEngineeringCommands.ts   src/server/registerGdbTools.ts        │
        │ src/cli/nativeCallCommands.ts           src/server/registerRizinDebugTools.ts │
        │ src/cli/fridaCommands.ts                src/server/registerFridaTools.ts      │
        │                                         src/server/registerReverseEngineeringTools.ts
        └───────────────┬──────────────────────────────────────────────────────────────┘
                        │ 只依赖端口类型（Frida 例外，见 §5）
        ┌───────────────▼──────────────── application 端口 ────────────────────────────┐
        │ ReverseEngineeringCommandPort   FridaInstrumentationPort   BinaryLayoutPort   │
        │ NativeCallTracer                RecordedCrashService ...                     │
        └───────────────┬──────────────────────────────────────────────────────────────┘
                        │ composition 装配（唯一「认识所有 provider」的地方）
        ┌───────────────▼──────────────────────────────────────────────────────────────┐
        │ src/composition/reverseEngineering.ts   createReverseEngineeringCommandPort  │
        │ src/composition/binaryDiagnostics.ts    createBinaryLayoutService /           │
        │                                         createRecordedCrashService           │
        └───────────────┬──────────────────────────────────────────────────────────────┘
                        │ implements
        ┌───────────────▼──────────── provider（外部工具包装）──────────────────────────┐
        │ ObjdumpCommand  RizinCommand              ← 纯 argv profile，无进程          │
        │ GdbSessionManager  RizinDebugSessionManager  ← 长驻 MI/命令行会话             │
        │ LldbCallTracer   PwntoolsLayoutProvider   PwntoolsRecordedCrashProvider      │
        │ PwndbgCoreContext   FridaInstrumentationManager ← in-process 绑定            │
        └───────┬───────────────────────────┬──────────────────────────┬───────────────┘
                │ spawn + 注入脚本           │ spawn + request/reply    │ 直接调用 npm 绑定
        ┌───────▼────────┐        ┌─────────▼──────────┐      ┌───────▼────────┐
        │ lldb --batch   │        │ python (REA_PWNTOOL│      │ frida@17.23.2  │
        │ + rea_lldb_    │        │ _S_PYTHON)         │      │ DeviceManager  │
        │   tracer.py    │        │ + layout.py /      │      └────────────────┘
        └────────────────┘        │   decoder_runtime.py│
                                  │ gdb -nx --batch     │
                                  │ + core_context.py   │
                                  └─────────────────────┘
```

对应关系（能力表，本篇的路由真相源）：

| 能力 | provider 实现 | application 端口/服务 | 装配点 | MCP 注册文件（工具契约名） |
|---|---|---|---|---|
| 静态 objdump 读取 | `函数：objdumpCommand 偏移：+0`（`src/objdump/ObjdumpCommand.ts`） | `src/application/reverse/ReverseEngineeringCommandPort.ts` `Type：ReverseEngineeringCommandPort`、`src/application/reverse/ReverseEngineeringService.ts` `函数：ReverseEngineeringService 偏移：+0` | `src/composition/reverseEngineering.ts 函数：createReverseEngineeringCommandPort 偏移：+4` | `src/server/registerReverseEngineeringTools.ts`：`inspect_with_objdump` |
| 一次性 Rizin 命令 | `函数：rizinCommand 偏移：+0`（`src/rizin/RizinCommand.ts`） | 同上 | 同上 `偏移：+14` | `execute_rizin_command` |
| 持久 GDB 会话 | `函数：start 偏移：+0`（`src/gdb/GdbSessionManager.ts`） | **无独立 Port 接口**；register 直接 `import type { GdbSessionManager }` | `src/server/createServer.ts` 、`src/cli/reverseEngineeringCommands.ts` | `start_gdb_session` / `gdb_console` / `gdb_session_status` / `close_gdb_session` |
| 持久 Rizin 调试会话 | `src/rizin/RizinDebugSessionManager.ts` `函数：start 偏移：+0` | **无独立 Port 接口** | `src/server/createServer.ts` 、`src/cli/reverseEngineeringCommands.ts` | `start_rizin_debug_session` / `rizin_debug_command` / `rizin_debug_session_status` / `close_rizin_debug_session` |
| Frida 运行时 instrumentation | `src/frida/FridaInstrumentationManager.ts 函数：FridaInstrumentationManager 偏移：+0` | `Type：FridaInstrumentationPort`（`src/application/frida/FridaInstrumentationPort.ts`） | **不经 composition**：`src/server/createServer.ts`  与 `src/cli/fridaCommands.ts`  默认参数 | `list_frida_devices` … `instrument_with_frida`（10 个，`src/server/registerFridaTools.ts`） |
| ELF 内存布局解码 | `src/native/pwntools/PwntoolsLayoutProvider.ts 函数：PwntoolsLayoutProvider 偏移：+0` | `BinaryLayoutPort` + `BinaryLayoutService` | `src/composition/binaryDiagnostics.ts 函数：createBinaryLayoutService 偏移：+3` | 见 `src/server/registerNativeTools.ts`（本篇未展开，§已知缺口） |
| Linux core 崩溃现场 | `src/native/pwntools/PwntoolsRecordedCrashProvider.ts`（接口级）+ `函数：inspectPwndbgCore 偏移：+0`（`src/native/pwndbg/PwndbgCoreContext.ts`） | `RecordedCrashService` | `src/composition/binaryDiagnostics.ts 函数：createRecordedCrashService 偏移：+3` | `src/server/registerRecordedCrashTools.ts` |
| macOS 原生调用观测 | `函数：LldbCallTracer 偏移：+0` | `NativeCallTracer`（被 `implements`） | `src/native/NativeMacOSProvider.ts`  的 `tracerFactory` | `src/cli/nativeCallCommands.ts`、`src/server/registerNativeTools.ts` |

三个值得记住的结论：

- `[推导]` **command profile 型不带 identity 之外的任何逻辑**：`objdumpCommand` 与 `rizinCommand` 都只做「operation → argv 数组」映射，并强制把路径交给 `函数：absoluteCallerPath 偏移：+0`（`src/filesystem/callerPath.ts`）归一，因此 provider 层不做解析、不 spawn，spawn 与解析都在 application/service 侧。
- **会话型 manager 没有端口抽象**：GDB/Rizin 的 register 文件直接依赖 provider 具体类，这是本族与「Frida/pwntools 走端口」最明显的形状差异（见问题清单 P1）。
- `src/objdump/` 只有 29 行**证实了「薄适配」**：文件里只有 `Const：OBJDUMP_PROVIDER_IDENTITY`（`id: "gnu.objdump"`、`version: null`）与一个纯函数，没有类、没有 import `src/process/`（`grep -c` 该文件无 process 依赖）。

## 3 三座 Python 桥

### 3.1 帧格式：一次调用的字节布局

三座桥共用 `src/native/pwntools/`+`src/native/pwndbg/` 的一套私有目录约定。ASCII 布局（一次 pwntools 调用）：

```
<PrivateRuntimeRoot>/<runId>/          权限 0o600 的文件，一次调用一套
├── request.json   ── TS 写入 ──▶ Python 读 sys.argv[-1] 解析
│     { "path": "...", ...caller 选定的输入 }        # 路径只作为 JSON 数据，不进命令行
├── limits.json  ◀── Python 用 O_WRONLY|O_CREAT|O_EXCL 0o600 写「实际生效的 rlimits」
├── reply.json   ◀── Python 写 json.dumps(..., ensure_ascii=True, allow_nan=False)
│     超 64 MiB 时整份替换为 {"ok":false,"reason":"output-limit",...}
└── marker 文件  ◀── 资源失败时写 1 字节：M=MemoryError / F=EFBIG(27) / 其它 errno 映射
                      status 用 os._exit(75|76|...) 回传
```

证据（Python 侧）：`bridge/pwntools/layout.py 函数：resource_exit 偏移：+4`（`os.open(sys.argv[1], O_WRONLY|O_CREAT|O_EXCL, 0o600)` 写 marker）、`bridge/pwntools/decoder_runtime.py 函数：main 偏移：+10`（写 `limits.json`）、`偏移：+27`（编码 reply）、`偏移：+29`（`output-limit` 兜底）。

证据（TS 侧）：`src/native/pwntools/PwntoolsDecoder.ts` 的 `Const：requestPath`、`Const：replyPath`（`join(root.path, "request.json")` / `"reply.json"`），以及 `函数：PwntoolsCommand 偏移：+0` 这一 launcher 类型——provider 把「怎么起进程」也做成注入点（`Type：PwntoolsLauncher`）。

**没有 stdio JSON-line**：`bridge/pwntools/layout_impl.py` 的 docstring 明确 `Owned request/snapshot/reply paths are supplied by REA`。`[未知]` reply 是否走 stdout 兜底通道：当前源码无法确定，需读 `PwntoolsDecoder` 的回读分支（本篇只确认存在 `reply.json` 路径）。

### 3.2 pwntools 桥：`decoder_runtime.py` 是被复用的底座

- `bridge/pwntools/decoder_runtime.py 函数：lower_resource_limits 偏移：+0` 负责在替换进程前压低继承的 rlimit；`函数：main 偏移：+0` 是统一外壳，签名是 `main(request_path, inspect, failure_type, profile)`——即**每个具体能力只提供 `inspect(request)` 回调 + 自己的失败类型 + profile 字符串**。
- profile 是被钉死的：`Const：PROFILE` = `"pwntools@4.15.0;pyelftools@0.33;unicorn@2.1.2"`，`Const：PACKAGES` 逐包版本，`Const：OUTPUT_BYTES` = 64 MiB，`Const：PROFILES` 只列 (amd64/i386/arm/mips) 四种 ELF 组合，其它组合由 `函数：file_range 偏移：+1` 之类的边界检查与 `PROFILE_SCOPE` 拒绝。
- `bridge/pwntools/layout_impl.py` docstring 是这一族的权限声明：`Offline adapter ... never use libs/maps/libc` + `No host target-process launch, user configuration initialization, debugger startup, or dependency installation.`
- `bridge/pwntools/recorded_crash_impl.py 函数：inspect_core 偏移：+12`、`偏移：+25` 用「ELF64 小端 / System-V 或 GNU/Linux OSABI 且 abi version 0 / `ET_CORE` 且 x86-64 或 AArch64」三重 profile 门拒绝其它输入；`偏移：+118` 返回的字典里写死 `"target_execution": "not-performed", "live_process_identity": "unknown"`。

### 3.3 pwndbg 桥：名字叫 pwndbg，实际是「GDB 内嵌 Python」

- `bridge/pwndbg/launch.py 函数：resource_exit 偏移：+0` 与 pwntools 的 `layout.py` 同一套 marker 骨架；它 exec 的是同目录的 `launch_impl.py`。
- `bridge/pwndbg/launch_impl.py 函数：launch 偏移：+0` 复用 pwntools 的底座：`runtime_path = ... / "pwntools" / "decoder_runtime.py"`（同文件的模块级常量 `runtime_path`）。
- `偏移：+6` 把要跑的代码固定为字符串常量 `command = "python exec(compile(open(<core_context.py> ...` ，注释写明「Only fixed package code appears in the GDB Python command. Selected paths stay JSON data」——**caller 给的路径永远不进 argv，只有 REA 自己的桥文件名进 GDB 命令**。
- `偏移：+8` 是 `os.execve(request["gdb"], [gdb, "-nx", "-nh", "--batch", "--quiet", "-iex", "set auto-load off", "-iex", "set debuginfod enabled off", "-iex", "set auto-solib-add off", "-ex", command], environment)`：用 exec 家族**替换自己**变成 GDB，而不是再起一层。
- `bridge/pwndbg/core_context.py` 第 6 行 `import gdb`（GDB 内嵌解释器可用性的观察证据），`函数：inspect 偏移：+13` 才 `import pwndbg.aglib.vmmap`，`偏移：+19` 校验 `Expected unchanged pwndbg2026.09.15`——版本不符直接 `ContextFailure("unsupported")`，`函数：failure_exit 偏移：+0` 负责写 marker 并退出。

### 3.4 lldb 桥：注入到 `lldb --batch` 里跑

TS 侧的 argv 完全固定（`src/native/LldbCallTracer.ts`，见源码索引 `:command:637`、`:rea_trace:639`）：

```
lldb --batch --no-lldbinit --no-use-colors \
     -o "command script import <BRIDGE>" \
     -o "rea_trace <config.json>"
```

- `src/native/LldbCallTracer.ts Const：BRIDGE`（`fileURLToPath(new URL("../../bridge/native/rea_lldb_tracer.py", import.meta.url))` 指向随包分发的桥文件；所有 target 侧参数一律走 `config.json`，`函数：quote 偏移：+0` 只做引号化（注释：`LLDB command arguments are quoted; the bridge path is REA's own install path`）。
- 启动前提（观察 + 代码内注释）：目标必须**可调试**。`Const：ATTACH_REMEDIATION` 原文给出修复路径——`DevToolsSecurity -enable` 或加入 `_developer` 组，且「A hardened-runtime target is debuggable only with the `com.apple.security.get-task-allow` entitlement」。工具本身通过 `函数：resolveXcrunTool 偏移：+0` 解析（不是 PATH 猜）。
- Python 侧会**真的拉起目标进程**：`bridge/native/rea_lldb_tracer.py 函数：_launch_info 偏移：+1`（`lldb.SBLaunchInfo(config["arguments"])`）、`函数：_create_breakpoints 偏移：+7`（`target.BreakpointCreateByName(...)`）、`函数：breakpoint_hit 偏移：+0`（停止回调）。
- 同时它**不执行任何目标表达式**：模块 docstring `No expression is evaluated and no target code runs on the tracer's behalf`，参数只从寄存器与内存读取（`函数：_record 偏移：+0`、`函数：_read_register 偏移：+0`）。
- 边界：`Const：MAX_TRACE_BYTES` = 8 MiB、`Const：MAX_TRACE_FRAMES` = 65536、`Const：MAX_TARGET_OUTPUT_BYTES` = 1 MiB，`函数：_can_retain_trace 偏移：+0` 同时卡字节与帧两个预算；`Type：_ObservationJournal`（`函数：_ObservationJournal 偏移：+1`）持续 flush JSONL 前缀，注释写「so observations survive tracer failure」。
- 命令注册与失败语义：`函数：__lldb_init_module 偏移：+1` 用 `command script add -f rea_lldb_tracer.run rea_trace` 把 `rea_trace` 挂成 LLDB 命令；`函数：run 偏移：+1` 的 docstring 就是「LLDB command entry point: `rea_trace <config.json>`」，`偏移：+7` 把任何 Python 异常转成 `{"status": "tracer-error", ...}`（注释原文「never re-raised into LLDB」），`偏移：+9` 才把结果 `json.dump` 到 `config["result_path"]`。`[推导]` 因此 TS 侧读到的 `result.json` **只可能是合法 JSON 或不存在**，异常不会污染 stdout 通道；这与 `LldbCallTracer` 里「exited 才选 result.json 作主结果、被中断时仍保留该结果的目标事实」那段注释相互印证。

### 3.5 TS 侧谁负责派生与监督（只指锚点）

| 桥 | TS 派生点 | 用的 `src/process/` 原语 |
|---|---|---|
| pwntools/pwndbg | `src/native/pwntools/PwntoolsDecoder.ts` | `Type：ProviderProcessSupervisor`、`函数：spawnOwnedProviderProcess`（同文件 import），细节归 [13](13-Process层-子进程监督与所有权.md) |
| gdb | `src/gdb/GdbSessionManager.ts 函数：#startProtocol 偏移：+22` | `函数：spawnOwnedProviderProcess` + `src/process/ownedDebuggerSession.js` 的 inferior 身份（`Type：OwnedInferiorIdentity`） |
| rizin debug | `src/rizin/RizinDebugSessionManager.ts`（`spawnProcess` 字段，见索引 `:launched:435`） | 同上两个原语 |
| lldb | `src/native/LldbCallTracer.ts 函数：LldbCallTracer 偏移：+11`（可注入的 `launch: typeof runLldb = runLldb`） | `函数：PrivateRuntimeRoot 偏移：+0` + `函数：cleanupOwnedProcessGroup 偏移：+0` |
| frida | 无子进程（in-process 绑定） | 仅 `函数：AnalysisCleanupLease 偏移：+0` 管理脚本/会话句柄 |

`[推导]` 「可注入 launcher」是本族的通用设计：`LldbCallTracer` 构造参数注入 `launch` 与 `resolveTool`；`PwntoolsDecoder` 用 `Type：PwntoolsLauncher`；`GdbSessionManager`/`RizinDebugSessionManager` 都有 `spawnProcess` 覆盖参数。这样测试可以不碰真引擎，代价是**生产路径与测试路径不同**（见问题清单 P2）。

## 4 gdb / rizin / objdump：谁反汇编、谁看崩溃现场、谁只静态读

| 工具 | 能力 | 关键 argv | 解析在哪 |
|---|---|---|---|
| GNU objdump | **静态读取**：`-i` 架构列表、`-f` 文件头、`-h` 节头、`-t` 符号、`-r` 重定位、`-W -WN/-WK` DWARF、`-d`/`-D` 反汇编、`--disassemble=<sym>` 单符号 | `src/objdump/ObjdumpCommand.ts 函数：objdumpCommand 偏移：+7`（`follow_debug_links ? "-WK" : "-WN"`）、`偏移：+16`（路径最后追加） | REA 侧解析；provider 不解析 |
| Rizin（一次性） | 静态命令执行，`-c <command>` 由 caller 给；默认关颜色保留插件能力 | `函数：rizinCommand 偏移：+1~+7`：`-N -q -e scr.color=0 -c <cmd> <path>` | 输出原样作为 Evidence（`函数：createRizinCommandEvidence 偏移：+0`） |
| Rizin（调试会话） | **活体调试**：`-d`，且用 tty 做 stdout/stderr 身份校验 | `偏移：+1~+7` 见索引 `:arguments_:420`：`-N -0 -d -R stdout=<tty> -R stderr=<tty> -e dbg.exitkills=false [-D <backend>] <path>` | 会话内命令输出；完成判据用 marker（索引 `:marker:686`） |
| GDB（会话） | **活体调试 + MI 机器接口**；不是纯静态工具 | `函数：#startProtocol 偏移：+16`：`--nx --quiet --interpreter=<miVersion>`；console 命令在 `函数：execute 偏移：+43` 处包成 `-interpreter-exec console <miQuote>` | MI 文本由 provider 自己解析（`函数：gdbMiGroupsListSpan 偏移：+0`、`函数：snapshotGdbCommandRecords 偏移：+0`） |
| pwntools | ELF **布局**（离线）、Linux **core 崩溃现场**（离线） | 由 `REA_PWNTOOLS_PYTHON` 指定的 Python + `bridge/pwntools/*.py` | 结构化 reply 由 `Type：replySchema`（`src/native/pwndbg/PwndbgCoreContext.ts`）校验 |
| pwndbg | core 里的 **内存映射/vmmap** 视角 | `bridge/pwndbg/launch_impl.py 函数：launch 偏移：+8` | reply 结构化，版本硬钉 `pwndbg2026.09.15` |

三个必须记住的差异：

- **只有 GDB/Rizin-debug 会「反汇编 + 附着活进程」**：二者都是持久会话（`src/gdb/GdbSessionManager.ts` 的 `Const：DEFAULT_MAX_SESSIONS`、`Const：MAX_PENDING_GDB_COMMANDS`；`src/rizin/RizinDebugSessionManager.ts` 的 `Const：MAX_SESSIONS`、`Const：MAX_PENDING_COMMANDS`），有帧/输出上限（`Const：MAX_COMMAND_OUTPUT_BYTES` 16 MiB、`Const：MAX_MI_LINE_BYTES`、`Const：MAX_FRAME_BYTES`）。
- **崩溃现场是离线读制品**，不是现场调试：core 侧走 pwntools/pwndbg，两者 profile 上都要求「ELF64/`ET_CORE`/x86-64 或 AArch64」，且明确 `target_execution: not-performed`。
- **objdump 的 29 行不是缺失，是分工**：identity（`version: null` 表示版本由调用时探测，`[推导]`）+ 纯 argv 构造 + `absoluteCallerPath` 归一。反证尝试：`grep -n "child_process\|spawn\|ProviderProcess" src/objdump/ObjdumpCommand.ts` 无命中，说明它**不可能**自己派生进程；解析与执行都不在本目录。

## 5 Frida：为什么端口是注入参数

`FridaInstrumentationPort` 的声明与消费：

- 端口：`src/application/frida/FridaInstrumentationPort.ts 函数：FridaInstrumentationPort 偏移：+0`，方法集合是 `listDevices / listProcesses / startSession / loadScript / resumeSession / unloadScript / ...`，返回一律 `Result<T, AnalysisError>`。
- 目标选择是**判别联合**，attach 与 spawn 各自带必填字段：`Type：StartFridaSessionInput`（`{ mode: "attach", pid }` 或 `{ mode: "spawn", program, argv? }`）。
- 脚本来源同样二选一：`Type：FridaScriptSource`（`sourceKind: "inline" | "file"`）。
- 观测带溯源：`Type：FridaScriptObservation` 里的 `sourceSha256` 注释写明「Digest of selected file bytes, or the inline source encoded as UTF-8」。
- 生命周期错误是一等的：`函数：FridaScriptLoadCancelledError 偏移：+0` 继承 `AnalysisCancelledError`，还额外带 `scriptHandleAcquired` 布尔——取消时「脚本句柄拿没拿到」必须能被下游知道。
- 清理有明确语义：`Type：FridaSessionCleanupObservation` 与 `Type：FridaSessionStatus` 上的 `targetResumeObserved` 注释「True only after REA has successfully resumed this spawned target」。

**注入参数**的证据链（这就是权限边界的体现）：

```
src/cli.ts:81        fridaInstrumentation?: FridaInstrumentationPort,   ← createCli 的可选入参
src/cli.ts:151       registerFridaCommands(cli, logger, fridaInstrumentation);
src/cli/fridaCommands.ts:29   provider: FridaInstrumentationPort = new FridaInstrumentationManager()
src/server/createServer.ts:258  readonly fridaInstrumentation?: FridaInstrumentationPort
src/server/createServer.ts:384  options.optionalProviderLoadFailures?.fridaInstrumentation
src/server/createServer.ts:385            ?? fridaInstrumentation.availabilityFailure?.()
src/server/createServer.ts:392  fridaInstrumentation: fridaFailure
src/server/createServer.ts:551  options.fridaInstrumentation ?? new FridaInstrumentationManager()
src/server/createServer.ts:580  fridaInstrumentation.closeAll()
```

`[推导]` 三条理由，全部由上面锚点支撑：

1. **它可能加载失败**。端口上有可选方法 `availabilityFailure?()`，server 侧把它折叠成 `optionalProviderLoadFailures`，即「Frida 不可用」是一种**能力缺失状态**而不是启动失败。这与 `src/frida/FridaInstrumentationManager.ts` 只 `import type ... from "frida"`（纯类型）、并保留 `Const：deviceManagerLoader` 这种运行时 loader 注入点一致。
2. **它不在 composition 里**。`src/composition/` 下没有 `frida.ts`（`ls src/composition` 确认），实例化推迟到 adapter 的默认参数——装配根不认识它。
3. **它能改目标进程**。`startSession` 的 `mode: "spawn"` + `loadScript` 接受任意 inline JS + `resumeSession` 才真正放行 spawn 出来的进程：这三步合起来就是 AGENTS.md 所说「目标执行 / 注入 / 变异」类能力。把它做成参数，意味着**宿主（CLI 调用方、测试、未来的 scope gate）可以决定是否提供、提供哪一个实现**。

关于 AGENTS.md 的 scope decision 要求在代码里的体现，本篇的诚实结论是：

- 观察：`src/frida/`、`src/application/frida/` 里**没有**任何注释写「read-only」或「requires maintainer scope decision」；`grep -rn "scope decision\|read-only" src/frida src/application/frida` 无命中（范围仅这两个目录）。
- 观察：约束是以**工程 gate** 形式存在的——`package.json` 有独立脚本 `verify:frida`（索引 `:verify:465` 附近，见源码索引 `package.json`）与 `verify:frida:bindings`，且依赖钉版本 `package.json` 的 `"frida": "17.23.2"`；`package.json` 另有一处 `"frida@17.23.2": true` 的白名单式条目（其所属键在本篇未回读，`[未知]`）。
- `[未知]` 是否存在运行时的「显式授权」开关：当前源码无法确定，查证方向是读 `src/server/registerFridaTools.ts` 全文与 `src/config/` 的 provider 就绪门（[22](22-配置系统.md)）。

## 边界与失败模式

| 触发 | 返回 | 保留 partial facts？ | 锚点 |
|---|---|---|---|
| GDB 可执行文件不可启动（宿主拒绝） | `GdbExecutableRefusal`（`AnalysisCapabilityUnavailableError` 子类），userMessage 带 systemCode，remediation 指向 `REA_GDB_COMMAND` | 是（错误对象带命令与环境事实） | `src/gdb/GdbSessionManager.ts 函数：GdbExecutableRefusal 偏移：+0`，注释「A host executable refusal cannot be repaired by changing MI dialect」 |
| GDB 命令超时 | `函数：GdbCommandTimeoutError 偏移：+0`（`AnalysisTimeoutError`），并有 `函数：fixedDeadlineGuidance 偏移：+0` 与 `函数：copiedTimeoutGuidance 偏移：+0` 两套指引文案 | 会话仍在，命令记录可读 | `src/gdb/GdbSessionManager.ts` |
| pwntools 未配置 | 指引文案「`Set REA_PWNTOOLS_PYTHON to an absolute caller-supplied Python executable ... REA never installs Python or packages`」；`executablePath` 取 `REA_PWNTOOLS_PYTHON ?? ""` | 不适用（未起进程） | `src/native/pwntools/PwntoolsDecoder.ts`（索引 `:executablePath:258`、） |
| Python 侧 OOM / 输出超预算 | 退出码 + marker（`M`/`F`）；`reply.json` 被替换为 `{"ok":false,"reason":"output-limit"}` | 是：`limits.json` 记录生效 rlimits，`"limitations"` 追加说明「Inherited tighter limits are retained」 | `bridge/pwntools/decoder_runtime.py 函数：main 偏移：+10~+29` |
| pwndbg 版本不是钉住的 2026.09.15 | `ContextFailure("unsupported")` → TS 侧 `AnalysisCapabilityUnavailableError("pwndbg-core", ...)` | 是（providerId 固定） | `bridge/pwndbg/core_context.py 函数：inspect 偏移：+19`；`src/native/pwndbg/PwndbgCoreContext.ts`（索引 `:pwndbg:82`、`:providerId:146`） |
| core 文件不符合 profile | `CoreFailure("unsupported-target")` / `CoreFailure("format")`，消息里带上实际读到的 `e_machine`、OSABI、ET_TYPE 值 | 是（失败消息保留源值） | `bridge/pwntools/recorded_crash_impl.py 函数：inspect_core 偏移：+12~+25` |
| LLDB 起不来（preparation-failed） | `函数：lldbPreparationFailure 偏移：+0`，注释说明「LLDB was never spawned. Release only this tracer's runtime」 | 不适用 | `src/native/LldbCallTracer.ts`（索引 `:exited:656`） |
| LLDB 被取消/目标还在 | 读回 `result.json` 与观测 journal，`retained.targetStopped` 与 `ensureTerminated` 决定资源是否**被保留**（`Const：RetainedLldbResources`、`函数：lldbCleanupResources 偏移：+0`） | 是：`函数：partialNativeObservation 偏移：+0` 专门产 partial observation | `src/native/LldbCallTracer.ts` |
| 目标不可调试（macOS 权限/hardened runtime） | `src/native/LldbCallTracer.ts Const：ATTACH_REMEDIATION` 文案；不可启动分支由 `函数：tracerFailure 偏移：+40` 生成 `lldb-target-unloadable` 前缀（该串是错误消息文本，不是符号名） | 是，`inspect_signature` 结果被引用 | `src/native/LldbCallTracer.ts` |
| Rizin tty 身份不符 / 取消在 realpath 之前 | `函数：rizinCancellation 偏移：+0`（`start_rizin_debug_session`），注释「Cancellation may arrive while realpath/open/stat are pending, and must prevent the debugger spawn」 | 是（保留 launch provenance 限制文案 `Const：RIZIN_LAUNCH_PROVENANCE_LIMITATION`） | `src/rizin/RizinDebugSessionManager.ts`（索引 `:isatty:386`、`:arguments_:420`） |
| Frida 模块装载失败 | `availabilityFailure()` 返回 `OptionalProviderLoadFailure`，server 记录为 optional 失败 | 是（不影响其它工具注册） | `src/server/createServer.ts`（索引 `:fridaInstrumentation:384`） |
| Frida 取消在 loadScript 中途 | `函数：FridaScriptLoadCancelledError 偏移：+0`，携带 `script` 观测与 `scriptHandleAcquired` | 是 | `src/application/frida/FridaInstrumentationPort.ts` |

静默出错的三个候选点（不是「会报错」，而是「看起来成功」）：

1. Rizin/GDB 会话接受任意命令文本，REA 只加完成 marker；`[推导]` 一条写内存的命令会**成功返回**且被当成合法 Evidence，副作用不在 REA 的记录里。
2. pwntools 桥的 marker 只在 `sys.argv[1]` 存在且能 `O_EXCL` 创建时写；`函数：resource_exit 偏移：+0` 的 `except (OSError, MemoryError): pass` 意味着**marker 缺失时父进程「keep this failure unclassified」**（注释原文），此时降级路径是「未知」而不是「成功」——这是设计特性，但很容易被误读成失败。
3. `Const：MAX_RECENT_MI_LINE_BYTES` / `函数：truncateUtf8RecordPrefix 偏移：+0` 会插 `Const：RECENT_RECORD_TRUNCATION_MARKER`，截断标记进的是记录文本而不是结构化字段。

## 问题清单

**P1（形状不一致，需要决策）**

- 会话型 provider 没有 application 端口：`src/server/registerGdbTools.ts` 与 `src/server/registerRizinDebugTools.ts` 直接 `import type { GdbSessionManager }` / `{ RizinDebugSessionManager }`（两处都是 `import type`，见索引 `:GdbSessionManager:4`、`:RizinDebugSessionManager:7`），而 Frida/pwntools 走端口。后果：这两族工具无法在不引入 provider 目录的情况下被替换或 mock。锚点：`src/server/registerGdbTools.ts` `Const：toolContract` 所在的类型 import（索引 `:GdbSessionManager:4`）。
- 02 篇 §0 第 2 条把「只有装配根被允许认识它们」写成了 provider 目录入度低的统一原因。对本族**不成立**：`src/gdb/`、`src/rizin/`、`src/frida/` 的被 import 者里包含 `src/server/` 与 `src/cli/`（证据即上一条与 `src/cli/reverseEngineeringCommands.ts` 索引 ）。02 表格里的入度数字（3/4/3/1）本身与实测一致，问题只在 §0 的概括措辞。按任务约定不改 02，只在此登记。
- `FridaInstrumentationManager` 不在 `src/composition/` 里装配，与 AGENTS.md「依赖流…composition → CLI/MCP」的叙述存在张力（其它 provider 都有工厂文件）。锚点：`src/server/createServer.ts` 。

**P2（可维护性/验证成本）**

- 生产 spawn 路径与测试注入路径分离：`函数：LldbCallTracer 偏移：+11`、`Type：PwntoolsLauncher`、`spawnProcess` 覆盖参数。真实引擎行为需要 acceptance 级验证，模块测试不能声称覆盖（00 §「simulated providers do not establish real-provider behavior」）。
- pwndbg 版本钉在单一字符串（`bridge/pwndbg/core_context.py 函数：inspect 偏移：+19`），pwntools profile 钉在 `bridge/pwntools/layout_impl.py Const：PROFILE`；引擎升级即 capability 消失，且消失方式是 `unsupported`/`unavailable` 而不是「降级可用」。
- `src/native/NativeMacOSProvider.ts` 的 `tracerFactory` 默认值在构造函数里才 `new LldbCallTracer(...)`（索引 ），装配点与其它 provider 不同层。

**P3（文档/小坑）**

- `Const：OBJDUMP_PROVIDER_IDENTITY` 与 `Const：RIZIN_PROVIDER_IDENTITY` 的 `version: null`：本篇未读到「版本何时被填上」的锚点（GDB 会话侧有 `gdb_version`、pwndbg 侧有 `pwndbg_version`）。
- `bridge/pwntools/layout.py` 与 `bridge/pwndbg/launch.py` 是几乎同构的 39 行外壳，注释与退出码约定重复两份。

**待拍板**

- 「objdump/rizin 一次性命令」是否算**只读**：argv 里没有写开关（`函数：rizinCommand 偏移：+1~+7` 无 `-w`），但 Rizin 是否隐式创建项目/缓存文件在当前 TS 源码里没有证据。`[未知]`，查证方向是 rizin 官方 `-N`/`-0` 语义 + `tests/boundary` 的 rizin 回归。
- 「是否给 GDB/Rizin 会话加命令级副作用分级」（读命令 vs 写命令）——涉及 AGENTS.md 的 scope decision 要求，本篇只在 §5 记录「源码未体现」。

## 已知缺口

1. `src/native/` 的 90 个文件（apple/elf/pe/parsers/metadata/exports 等静态 reader）**未读取**，本篇只确认它们不 spawn 引擎；`src/native/CommandRunner.ts`（611 行）只到接口级，因此「objdump 输出到底在哪个文件被解析」本篇**未证实**。
2. 三座桥的 **stdout/stderr 通道**细节未读全：lldb 侧看到 `Const：stdout_path` 类字段与 FIFO 概念（`Type：_ObservationJournal` 之外的 reader 线程，`bridge/native/rea_lldb_tracer.py 函数：drain 偏移：+0`）只到结构级。
3. `src/server/registerNativeTools.ts`、`registerRecordedCrashTools.ts`、`registerNativeExportsTool.ts`、`registerNativeFunctionMatchingTool.ts` 与 `src/cli/coreNativeCommands.ts`、`nativeCallCommands.ts` 的**工具契约名未逐一枚举**，§2 能力表在这些行标了「未展开」。
4. `src/frida/frida-bindings.d.ts`（81 行）与 `fridaCaptureLimits.ts`（97 行）未逐行读；`bridge/native/*.swift`（`ReaNativeUI.swift` 等 3 个）与 `src/native/NativeUiObservation.ts` 本篇**完全未涉及**，UI 观测这条线与三座 Python 桥不同源，需要另开小节。
5. `src/gdb/GdbCommandRecords.ts` 只读了 `函数：snapshotGdbCommandRecords 偏移：+0` 一行签名。
6. 未实测任何引擎或调试器（任务禁止），本篇**没有任何**运行时行为断言来自真实执行；所有关于「会/不会写目标」的判断都来自 argv、docstring 与返回字段。

## 源码索引

- `src/objdump/ObjdumpCommand.ts:objdumpCommand:11`
- `src/rizin/RizinCommand.ts:rizinCommand:11`
- `src/rizin/RizinDebugSessionManager.ts:MAX_SESSIONS:37`
- `src/rizin/RizinDebugSessionManager.ts:RizinDebugSessionManager:254`
- `src/rizin/RizinDebugSessionManager.ts:start:293`
- `src/rizin/RizinDebugSessionManager.ts:isatty:386`
- `src/rizin/RizinDebugSessionManager.ts:arguments_:420`
- `src/rizin/RizinDebugSessionManager.ts:launched:435`
- `src/rizin/RizinDebugSessionManager.ts:marker:686`
- `src/rizin/RizinDebugSessionManager.ts:REA_RIZIN_COMMAND:283`
- `src/composition/reverseEngineering.ts:createReverseEngineeringCommandPort:14`
- `src/composition/reverseEngineering.ts:REA_OBJDUMP_COMMAND:20`
- `src/composition/reverseEngineering.ts:objdumpCommand:24`
- `src/composition/reverseEngineering.ts:rizinCommand:34`
- `src/composition/binaryDiagnostics.ts:createBinaryLayoutService:59`
- `src/composition/binaryDiagnostics.ts:BinaryLayoutService:62`
- `src/composition/binaryDiagnostics.ts:createRecordedCrashService:65`
- `src/composition/binaryDiagnostics.ts:RecordedCrashService:68`
- `src/application/reverse/ReverseEngineeringCommandPort.ts:ReverseEngineeringCommandPort:16`
- `src/application/reverse/ReverseEngineeringService.ts:ReverseEngineeringService:107`
- `src/application/frida/FridaInstrumentationPort.ts:StartFridaSessionInput:35`
- `src/application/frida/FridaInstrumentationPort.ts:FridaScriptSource:45`
- `src/application/frida/FridaInstrumentationPort.ts:FridaScriptLoadCancelledError:73`
- `src/application/frida/FridaInstrumentationPort.ts:FridaSessionStatus:87`
- `src/application/frida/FridaInstrumentationPort.ts:FridaInstrumentationPort:103`
- `src/frida/FridaInstrumentationManager.ts:FridaInstrumentationManager:125`
- `src/frida/FridaInstrumentationManager.ts:deviceManagerLoader:121`
- `src/server/registerFridaTools.ts:instrument:36`
- `src/server/registerGdbTools.ts:GdbSessionManager:4`
- `src/server/registerGdbTools.ts:start:38`
- `src/server/registerRizinDebugTools.ts:RizinDebugSessionManager:7`
- `src/server/registerRizinDebugTools.ts:start:31`
- `src/server/registerReverseEngineeringTools.ts:objdump:45`
- `src/server/registerReverseEngineeringTools.ts:rizin:46`
- `src/server/createServer.ts:fridaInstrumentation:258`
- `src/server/createServer.ts:fridaInstrumentation:384`
- `src/server/createServer.ts:gdbSessions:536`
- `src/server/createServer.ts:rizinDebugSessions:539`
- `src/server/createServer.ts:fridaInstrumentation:551`
- `src/server/createServer.ts:fridaInstrumentation:580`
- `src/cli.ts:fridaInstrumentation:81`
- `src/cli.ts:registerFridaCommands:151`
- `src/cli/fridaCommands.ts:provider:29`
- `src/cli/reverseEngineeringCommands.ts:GdbSessionManager:128`
- `src/cli/reverseEngineeringCommands.ts:manager:398`
- `src/native/NativeMacOSProvider.ts:LldbCallTracer:170`
- `src/native/LldbCallTracer.ts:LLDB_REQUIREMENT:68`
- `src/native/LldbCallTracer.ts:BRIDGE:89`
- `src/native/LldbCallTracer.ts:LldbCallTracer:201`
- `src/native/LldbCallTracer.ts:command:637`
- `src/native/LldbCallTracer.ts:rea_trace:639`
- `src/native/LldbCallTracer.ts:exited:656`
- `src/native/LldbCallTracer.ts:quote:948`
- `src/native/LldbCallTracer.ts:partialNativeObservation:1036`
- `src/native/LldbCallTracer.ts:lldbRuntimePaths:1114`
- `src/native/pwntools/PwntoolsDecoder.ts:executablePath:258`
- `src/native/pwntools/PwntoolsDecoder.ts:requestPath:330`
- `src/native/pwntools/PwntoolsDecoder.ts:replyPath:332`
- `src/native/pwntools/PwntoolsDecoder.ts:command:361`
- `src/native/pwntools/PwntoolsLayoutProvider.ts:PwntoolsLayoutProvider:15`
- `src/native/pwndbg/PwndbgCoreContext.ts:OPERATION:35`
- `src/native/pwndbg/PwndbgCoreContext.ts:inspectPwndbgCore:52`
- `src/native/pwndbg/PwndbgCoreContext.ts:pwndbg:82`
- `src/native/pwndbg/PwndbgCoreContext.ts:providerId:146`
- `src/native/pwndbg/PwndbgCoreContext.ts:recordedCrashStageOutput:276`
- `src/process/ownedDebuggerSession.ts:OwnedInferiorIdentity:15`
- `bridge/native/rea_lldb_tracer.py:rea_trace:914`
- `bridge/native/rea_lldb_tracer.py:__lldb_init_module:913`
- `bridge/pwntools/layout.py:resource_exit:10`
- `bridge/pwntools/decoder_runtime.py:main:26`
- `bridge/pwntools/decoder_runtime.py:descriptor:36`
- `bridge/pwntools/layout_impl.py:PROFILE:15`
- `bridge/pwndbg/launch_impl.py:runtime_path:7`
- `bridge/pwndbg/launch_impl.py:launch:18`
- `bridge/pwndbg/core_context.py:gdb:6`
- `bridge/pwndbg/core_context.py:inspect:17`
- `bridge/pwntools/recorded_crash_impl.py:inspect_core:37`
- `package.json:verify:221`

## 相关篇

- [02 · 模块地图与依赖方向](02-模块地图与依赖方向.md)：本族各目录行数/入度口径来源（§2.4）。
- [11 · Composition 层：生产装配根](11-Composition层-生产装配根.md)：`createReverseEngineeringCommandPort`、`createBinaryLayoutService` 等装配点的全貌。
- [13 · Process 层：子进程监督与所有权](13-Process层-子进程监督与所有权.md)：`spawnOwnedProviderProcess`、`ProviderProcessSupervisor`、`ownedDebuggerSession` 的所有权与清理语义。
- [20 · 移动与桌面 App](20-移动与桌面App.md)：另一族「外部引擎 + owned 进程」provider（adb/apktool/JEB）的对照。
