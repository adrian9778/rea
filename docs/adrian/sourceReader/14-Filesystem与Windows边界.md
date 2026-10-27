# 14 · Filesystem 与 Windows 边界

> 第四层「宿主边界」之文件系统与 Windows 原生面。本篇讲两件事：`src/filesystem/` 给上层提供的**所有权语义抽象**（谁打开了 fd/dir、谁负责关、关闭失败怎么留证据），以及 `src/windows/` + `native/windows/` 这条 **Node-API 原生边界**——REA 为什么要把 DACL/Job Object/重解析点这类特权系统调用下推到 C++，而不是用纯 JS 完成。边界澄清：本篇讲机制与 ownership，不讲任何 provider 的分析语义（那是 15~21 篇）；`src/process/` 的子进程生命周期与本篇的 `WindowsOwnedProcess` 咬合，只在此处点到位、细目归 15 篇。

版本口径：本篇按当前源码走读（HEAD `9541eb1f2`，Node v24.10.0，macOS/darwin，2026-10-27）。凡「原生 addon 实际行为」只能靠真机 Windows 证实的，一律标「未实测，待补」，本篇不启动、不调用任何引擎或 addon。

## 0 速览

1. **caller 路径保留两种语义**：`src/filesystem/callerPath.ts 函数：absoluteCallerPath 偏移：+0` 在 win32 走 `win32.resolve`（就地折叠 `..`），在 POSIX **不折叠 `..`**（只剥 `.` 与空段、保留结尾斜杠作为目录要求）——直接落地 AGENTS.md「绝对路径/文件 URL/HTTP 路径各不相同」，防止 REA 把语义未定的 `..` 写死。
2. **稳定读靠 identity 复核而非信任句柄**：`src/filesystem/RegularFile.ts 函数：sameRegularFileState 偏移：+0` 比对 `dev/ino/size/mode/mtimeNs` 五元组；`src/filesystem/StableFileHash.ts 函数：hashStableFile 偏移：+0` 把「初始 stat → handle.stat → 路径 stat」三处对齐，任一不符即 `RegularFileChangedError`（POSIX `ESTALE` 家族）。
3. **Windows 特权操作只在原生侧成立**：`native/windows/src/filesystem.cc 函数：verifyPrivate 偏移：+0` 断言所有者为当前用户、DACL 恰好两条 ACE 且带 `SE_DACL_PROTECTED`；`native/windows/src/process.cc 函数：spawnProcess 偏移：+0` 用 `CREATE_SUSPENDED`+`PROC_THREAD_ATTRIBUTE_JOB_LIST`+`ResumeThread` 之前 `IsProcessInJob` 复核，实现**原子入 Job**——这两件事纯 JS 无法原子完成。
4. **加载即自检，能力表是硬门禁**：`src/windows/WindowsNativeLoader.ts 函数：loadWindowsNativeAuthority 偏移：+0` 顺序执行 host→artifact→load→self-test→inspection，`Const：inspectionSchema`（同文件）要求 `privateDacl/atomicJobAssignment/killOnOwnerClose` 必须为字面 `true`，任一项不达标 → 拒绝加载，不降级。
5. **关闭失败被保留而非吞掉**：`src/filesystem/OwnedFileHandle.ts 函数：close 偏移：+0` 的 `#state` 是 open/closing/closed/failed 状态机，失败粘滞（sticky）；原生侧 `native/windows/src/handle_close.hpp 函数：decideOwnedHandleClose 偏移：+0` 把 `CloseHandle` 失败且活性探针非「已不在表内」判为 Unconfirmed 并把句柄 park 住——**失败的 CloseHandle + 活性探针不是原子的**。
6. **私有运行根按平台二分**：`src/process/PrivateRuntimeRoot.ts 函数：create 偏移：+0` 在 win32 委托 `WindowsPrivateRuntime.create`（原生 DACL 目录），否则用 `mkdtemp`（POSIX 原子、owner-only），`函数：privateRuntimeRootCapability 偏移：+0` 分别给出 `posix-mkdtemp-owner-only` 与委派原生的能力证明。

## 1 filesystem 抽象：它到底给上层什么

`src/filesystem/` 实测 11 个非测试文件、1,166 行（`find … ! -name '*.test.ts' | xargs wc -l` 口径，见环境）。它不是「小 utils」，而是本仓库 ownership 概念的物理载体（AGENTS.md：「file handles… 用窄所有权原语」）。四个层次：

```
路径规范化     callerPath.ts                     ← 语义未定就保留，不折叠
打开与稳定读   RegularFile.ts / StableFileHash.ts / readStableFileBytes.ts
                │  openRegularFile → 复核 sameRegularFileState
所有权原语     OwnedFileHandle / OwnedDirectoryHandle / OwnedRegularFile / OwnedStagedOutput
                │  withOwnedXxx 把「打开-用-关」收进单一函数 + cleanup 失败聚合
读取工具       readFileHandleChunks.ts / fileHandleMatchesBytes.ts / decodeDirectoryEntryName.ts
```

### 1.1 caller 路径：`..` 是语义问题不是算术问题

`src/filesystem/callerPath.ts 函数：absoluteCallerPath 偏移：+0`（`Const：absoluteCallerPath` 的箭头体）分支极短但关键：

```
if (platform === "win32") return win32.resolve(cwd, path);   // +7   就地折叠 ..（Win32 词汇解析精确）
// POSIX 绝对路径：split("/") 后 filter 掉 "" 与 "."，保留其余（含 ".."）   +14~+16
// 结尾若原串匹配 /\/\.?$/ 则补一个 "/"，保留「必须是目录」的下游要求          +17~+18
```

`[推导]` 保留 `..` 的意义：POSIX 里 `..` 是否已被 symlink 重解析依赖内核逐段解析，字符串层面的 `resolve` 会给出与内核不同的结果；REA 选择把未定语义原样下传给内核，而不是自己算——这与 AGENTS.md「never normalize it in a way that changes meaning」同源。

### 1.2 打开：非普通文件的显式拒绝

`src/filesystem/RegularFile.ts 函数：openRegularFile 偏移：+0` 的 flags（`偏移：+10` 附近）为 `O_RDONLY | O_NONBLOCK | O_NOCTTY`，`rejectSymbolicLinks` 时再加 `O_NOFOLLOW`。三处非平凡：

- `openRegularFile 偏移：+20` 起捕获 `ENXIO`/`EOPNOTSUPP` 转 `Const：nonRegularOpenFailure`（命名/字符设备、FIFO 的打开失败被归类为「非普通文件」而非 I/O 错误）。
- Windows 无 `O_NOFOLLOW`：`openRegularFile 偏移：+30` 起改用打开后 `lstat` 复核（注释明言这一补偿）。
- 身份复核：`函数：sameRegularFileState 偏移：+0` 是五元组 `dev/ino/size/mode/mtimeNs` 全等；调用方 `openRegularFile` 在拿到 handle 后立即比对初始 stat，不符抛 `RegularFileAdmissionFailure`。

`NonRegularFileReadError`、`RegularFileAdmissionFailure`、`RegularFileChangedError` 是这套错误面的具名 `Class：`（`src/filesystem/RegularFile.ts`）；判别函数是 `src/filesystem/RegularFile.ts 函数：isSelectedRegularFileError 偏移：+0`。

### 1.3 with-所有权：把「关不掉」变成可投影的失败

`src/filesystem/OwnedRegularFile.ts 函数：withOwnedRegularFile 偏移：+0` 与 `函数：withOwnedFileHandle 偏移：+0` 是同一模板的两个 specialization：无论操作成功/取消/抛错，都强制走关闭，再把「操作结果 + 关闭原因」合成 `Const：RegularFileCleanupFailure`。该失败类（同文件 `Class：RegularFileCleanupFailure`）本质是 `AggregateError`，聚合了 `outcome / cleanupCause / retention / completionCancellation / operationFailure`——06 篇 §4.3 的「cleanup 与主失败并存」在这里有文件系统实例：`函数：regularFileCancellation 偏移：+0` 从聚合里辨认「这其实是取消」，`Const：RegularFileCancelled` 保留被取消时的操作值。

`src/filesystem/OwnedFileHandle.ts 函数：close 偏移：+0` 的状态机值得单列：`closed` 直接 resolve、`closing` 复用同一 attempt、`failed` 直接 reject 同一 cause（粘滞）、`fd<0` 视作已关。`src/filesystem/OwnedDirectoryHandle.ts 函数：close 偏移：+0` 更保守：注释「Dir.close 在原生关闭落地前就使 Node 私有句柄失效」，故 dir handle **无公开有效性判据**，任何异常一律判 failed（与文件句柄的 `fd<0` 重检不对称）。

### 1.4 暂存输出与目录名解码

`src/filesystem/OwnedStagedOutput.ts 函数：create 偏移：+0`（`static create`）用 `#verifiedDirectory`（同文件）以 dev/ino 复核所在目录身份，注释解释 FAT/exFAT 上「写完再验 identity」的必要；生命周期 `setFile → assertReadyForPublication → closeFile → recordPublishedRename → close`（后者 `偏移：+0`）把「改名发布」与「清理暂存」分成显式两步，防止半成品被发布。

`src/filesystem/decodeDirectoryEntryName.ts 函数：decodeDirectoryEntryName 偏移：+0` 只做一件事：UTF-8 严格有效才返回解码串，否则返回 `unrepresentable` + 十六进制（**不接受 replacement-char 别名**）——目录名是证据面，宁可显示 hex 也不伪造一个「看起来对」的字符串。`src/filesystem/fileHandleMatchesBytes.ts 函数：fileHandleMatchesBytes 偏移：+0` 是「拿句柄里的字节和给定期望字节比对」的无所有权工具，刻意不关句柄（关由 owner 负责）。

## 2 Windows 原生边界：分工与三条能力线

`src/windows/` 3 个非测试文件 + `native/windows/src/` 的 C++。分工判据（AGENTS.md「Windows 边界只放在 adapter/native layer」）落成一条清晰线：**JS 负责编排与策略，native 负责必须由内核原子性/特权才能保证的 syscall 序列**。

| 关注点 | JS 侧 | native 侧（Node-API addon） | 为什么这样切 |
|---|---|---|---|
| 加载/自检 | `src/windows/WindowsNativeLoader.ts 函数：loadWindowsNativeAuthority 偏移：+0`、`systemWindowsNativeAuthority 偏移：+0`（缓存+可重试 self-test）、`requireWindowsNativeAuthority 偏移：+0` | `native/windows/src/addon.cc 函数：initialize 偏移：+0` 暴露 `call`；`函数：reaHostHook 偏移：+0` delay-load hook 拦 `node.exe`/Bun | JS 决定「要不要用、用不用得起」；native 决定「dlopen 面」 |
| 私有运行根（DACL 目录/文件） | `src/windows/WindowsPrivateRuntime.ts 函数：create 偏移：+0`、`mkdir 偏移：+0`、`writeFile 偏移：+0`、`readFile 偏移：+0`、`close 偏移：+0` | `native/windows/src/filesystem.cc 函数：createRuntime 偏移：+0`（BCryptGenRandom 后缀）、`verifyPrivate 偏移：+0`、`closeRuntime 偏移：+0` | 受保护 DACL、逐段重解析安全打开：Node `fs` 做不到 |
| 子进程所有权（Job Object） | `src/windows/WindowsOwnedProcess.ts 函数：WindowsOwnedProcess 偏移：+0`（构造即 `process_spawn`）、`kill 偏移：+0`、`cleanup 偏移：+0` | `native/windows/src/process.cc 函数：spawnProcess 偏移：+0`、`createJob 偏移：+0`、`inspect 偏移：+0` | 挂起态入 Job、kill-on-close：`child_process` 无法原子 |

### 2.1 能力表：inspectionSchema 是「非 true 即拒」

`src/windows/WindowsNativeLoader.ts 函数：loadWindowsNativeAuthority 偏移：+0` 的最后阶段用 `Const：inspectionSchema`（同文件）解析 native 自检回传：`privateDacl:z.literal(true)`、`atomicJobAssignment:z.literal(true)`、`killOnOwnerClose:z.literal(true)`，外加 `jobMemoryLimit`/`protocolStdin` 为 optional。`[推导]` optional 意味着这两项是「有则用、无则拒用相应功能」而非「加载门槛」：`src/windows/WindowsOwnedProcess.ts 函数：WindowsNativeControlUnavailableError 偏移：+0` 正是当请求了 job-memory-limit / protocol-stdin 而 native 未报支持时抛出。artifact 层 `函数：assertWindowsX64Artifact 偏移：+0` 校验 PE 的 `MZ`、machine `0x8664`、optional header magic `0x20b`——只接受 x64 PE。拒绝路径的文案 `Const：WINDOWS_NATIVE_LOAD_REFUSED_REMEDIATION`（同文件）明确点名「Ghidra 与 JADX 在 Windows 上需要它」，把「缺原生能力」与「缺引擎」区分开。

### 2.2 受保护 DACL：恰两条 ACE 且根带继承

`native/windows/src/filesystem.cc 函数：verifyPrivate 偏移：+0`（校验）与相邻的 `struct Security`（构造）配对：Security 在 `函数：identity 偏移：+54` 建立「owner=当前用户 + SYSTEM」两条 `FILE_ALL_ACCESS` ACE 并 `SetSecurityDescriptorControl(..., SE_DACL_PROTECTED, ...)`，verifyPrivate 反过来断言 `(control & SE_DACL_PRESENT)` 且根目录还须 `SE_DACL_PROTECTED`，ACE 数恰为 2。`[推导]` 「恰两条 + 保护位 + 无继承污染」是「同机其它用户无法读进 REA 私有目录」这一安全承诺在 C++ 端的执行点。

路径准入在 `native/windows/src/filesystem.cc 函数：localPath 偏移：+0`：只接受绝对本地 NTFS 盘路径，拒 `/`、ADS（交替数据流 `:`）、`.`/`..`；重解析点在逐段 `函数：openComponent 偏移：+0` 处被拒（注释「descendant 消费期间禁止就地重解析转换」），descriptor 目录另有把重解析点判为 `ERROR_REPARSE_TAG_INVALID` 的显式拒绝。`函数：identity 偏移：+0`（同文件）用 `FILE_ID_INFO` 的 128-bit 文件 ID + `GetFinalPathNameByHandleW` 作为目录/文件身份来源。

### 2.3 原子入 Job：挂起 → 校验 → 最后恢复

`native/windows/src/process.cc 函数：spawnProcess 偏移：+0` 的关键序列：`createJob`（`偏移：+0`）先建 Job 并置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（可选叠 `JOB_OBJECT_LIMIT_JOB_MEMORY`）；`CreateProcessW` 带 `CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT`，用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 把子线程入 Job；**`ResumeThread` 之前**调 `IsProcessInJob` 复核已入，否则视为失败并清理。`jobMemoryLimit`（同文件）要求页对齐并 query-back 必须与请求一致。`inspect`（同文件）把 `killOnOwnerClose`/`atomicJobAssignment`/`privateDacl` 三项能力回报给 JS 的 inspectionSchema。

> AGENTS.md「Windows Ghidra P0 has no mutation authority」与「Job Object 所有权」这两条约束，在这段 C++ 里的落点是 `killOnOwnerClose=true` + 原子入 Job；Ghidra 侧的「不写库」执行点见 15 篇（`bridge/ghidra/ReaGhidraBridge.java 函数：handleRequest`）。本篇只标机制，未启动 Ghidra，**具体是否生效未实测，待补**。

### 2.4 快照：单待决、可取消、失败关的句柄要 park

`src/windows/WindowsPrivateRuntime.ts 函数：snapshot 偏移：+0` 触发 `runtime_snapshot`，abort 时发 `runtime_snapshot_cancel`；`ERROR_BUSY` 表示「同一时刻只允许一个待决快照」。`readFile 偏移：+0` 把「关不掉的失败句柄」塞进 `#unreleasedFiles`（字段名见同文件；`[未知]` 该字段是否等价暴露给上层，未在 JS 侧读到 getter），`close 偏移：+0` → `#closeRuntime` 在 win32Code 32/33（sharing/lock violation）下最多重试 10 次、每次间隔 100ms。`src/windows/WindowsPrivateRuntime.ts Const：windowsRuntimeIdentityKey` = `volumeSerial:fileId`，即运行根的身份。native 侧快照拷贝是异步线程 `copySnapshot`（`native/windows/src/filesystem.cc`），SHA-256 校验、经 `snapshotCancelled` 可中断；`closeRuntime` 做递归 `FILE_ID_BOTH_DIR_INFO` 目录遍历来删树。

## 3 私有运行根布局与句柄所有权（ASCII）

一次 provider 会话在 win32 下由 `PrivateRuntimeRoot.create` 生成的典型目录，及其句柄归属：

```
<parent tmpdir>\rea-provider-<16B random suffix>\        ← runtime_create 建，owner+SYSTEM DACL, SE_DACL_PROTECTED
│   [owner = 当前用户 SID]  [SYSTEM SID]   (恰 2 ACE, FILE_ALL_ACCESS)
│
├─ hopper\bridge.sock        ← OwnedFileHandle/OwnedDirectoryHandle，close() 粘滞失败
├─ ghidra\project\           ← WindowsPrivateRuntime.mkdir（逐段重解析安全）
├─ ghidra\home\  tmp\  cache\  config\ghidra\<release>\  data\   ← createGhidraRuntimeDirectories（见 15 篇）
├─ ghidra\session.json       ← descriptor；runtime_write 原子、写完复核 identity
├─ ghidra\ownership.json     ← 运行归属记录
├─ ghidra\ghidra.log  script.log
└─ snapshot/<id>             ← runtime_snapshot；同时仅 1 个待决，可 cancel
```

句柄所有权图（谁 open、谁 close、失败后归谁）：

```
              JS caller (application/provider)
                         │  withOwnedRegularFile / withOwnedFileHandle / OwnedStagedOutput
                         ▼
   OwnedFileHandle ──close()──> Node FileHandle ──native close──> [Released]
        │ #state: open→closing→closed
        └ 失败(throw) → #state=failed(粘滞) → RegularFileCleanupFailure 上抛（不丢证据）

   WindowsPrivateRuntime ──readFile/writeFile──> addon Resource<Handle,Kind::File>
        │ #unreleasedFiles  ← CloseHandle 失败且活性≠NotInTable → park（保留）
        ▼
   OwnedHandle<T> (native/windows/src/handle_close.hpp)  decideOwnedHandleClose →
        { Released | TerminalInvalid | Unconfirmed }
                     ▲ failed CloseHandle + 活性探针非原子 → Unconfirmed 必 park

   WindowsOwnedProcess ──process_spawn──> addon Resource<Handle,Kind::Process>
        │ cleanup/#stop/#release → process_close；失败留 #releasePending 重试
        ▼
   Job Object (kill-on-close)  ← 父进程 REA 崩溃时内核回收子进程树
```

`[推导]` 三处所有权终点（文件句柄 / 目录 / 进程）都遵循同一原则：**关不掉就把资源与原因保留在 owner 上**，交由上层的 `ProviderCleanupError`（06 篇）投影为 `cleanup_incomplete`，而不是谎报已清理。

## 4 跨平台实现差异表（macOS / Linux / Windows）

| 维度 | macOS (darwin) | Linux | Windows (win32) | 锚点 |
|---|---|---|---|---|
| caller 路径 `..` | 保留不折叠 | 保留不折叠 | `win32.resolve` 折叠 | `src/filesystem/callerPath.ts 函数：absoluteCallerPath 偏移：+7` |
| `O_NOFOLLOW` | 有 | 有 | **无** → 打开后 `lstat` 补偿 | `src/filesystem/RegularFile.ts 函数：openRegularFile 偏移：+30` |
| 私有运行根 | `mkdtemp` owner-only | `mkdtemp` owner-only | 原生 `runtime_create` + DACL | `src/process/PrivateRuntimeRoot.ts 函数：create 偏移：+0` |
| 能力证明串 | `posix-mkdtemp-owner-only` | `posix-mkdtemp-owner-only` | 委派 native inspection | `src/process/PrivateRuntimeRoot.ts 函数：privateRuntimeRootCapability 偏移：+0` |
| 子进程 | `spawn` detached + `REA_PROCESS_RUN_ID` | `spawn` detached + runId | `WindowsOwnedProcess`（Job Object） | `src/process/ProviderProcess.ts 函数：spawnOwnedProviderProcess 偏移：+0` |
| 内存上限（子进程） | 拒绝（off-Windows） | 拒绝 | Job `JOB_OBJECT_LIMIT_JOB_MEMORY`（可选） | `src/process/ProviderProcess.ts 函数：spawnOwnedProviderProcess 偏移：+0`；`native/windows/src/process.cc 函数：createJob` |
| provider socket | unix socket `bridge.sock` | unix socket | loopback TCP + endpoint json | `src/ghidra/GhidraTransport.ts 函数：createGhidraEndpoint 偏移：+0`（详见 15 篇） |
| sockaddr_un 上限 | 103（注释 104 含 NUL） | 107（注释 108 含 NUL） | 不适用（走 TCP） | `src/ghidra/GhidraTransport.ts 函数：createGhidraEndpoint 偏移：+13` |
| Ghidra no-return 修复脚本 | 加 `-postScript` | 加 | **不加**（P0 无变更权） | `src/ghidra/GhidraLauncher.ts 函数：ghidraHeadlessArguments 偏移：+181` |

`spawnOwnedProviderProcess`（`src/process/ProviderProcess.ts 函数：spawnOwnedProviderProcess 偏移：+0`）是这条差异的总闸：win32 分支 `new WindowsOwnedProcess`（ownership 从 `child.pid`），否则 `node:child_process.spawn` detached；请求 memory limits 而平台非 win32 直接拒（无 Job 无法原子约束）。

## 边界与失败模式

- **句柄关闭非原子**：`native/windows/src/handle_close.hpp 函数：decideOwnedHandleClose 偏移：+0` 把「CloseHandle 失败」再叠加活性探针，只有判为 `NotInTable` 才算 TerminalInvalid，否则 `Unconfirmed` → park。失败模式：`[假设]` 高负载下大量 Unconfirmed 句柄滞留会拖慢 `closeRuntime` 重试；防线是 10×100ms 上限 + 上抛 cleanup 证据。真机堆积阈值**未实测，待补**。
- **写完再改的竞态（TOCTOU→ESTALE）**：稳定读在三处复核 identity，中途被换/截断 → `RegularFileChangedError`；调用方若忽略此错误继续用旧内容，就是 06 篇「静默漂移」的文件系统版本。
- **重解析点冒充**：`native/windows/src/filesystem.cc 函数：localPath 偏移：+0` 与 `openComponent` 拒 symlink/junction/mounted-folder，避免 REA 私有目录被软链到他人可控路径。`[未知]` 上游是否覆盖全部 reparse tag（如某些 cloud-provider tag），未在本篇读到枚举表。
- **快照并发**：`ERROR_BUSY` 保证同时只有一个 pending snapshot；取消靠 `runtime_snapshot_cancel` 置 `snapshotCancelled`。失败模式：`[推导]` 取消与拷贝线程收尾存在竞态，故快照句柄走 `disposeSnapshot`/`parkUnresolved` 而非直接关。
- **能力缺失≠功能降级**：inspectionSchema 任一 false 直接拒绝加载 native authority，因此 Windows 上缺 addon 时是「相关 provider 不可用」而非「悄悄用更弱的实现」。

## 问题清单

- **P1（待拍板）** `OwnedFileHandle` 与 `OwnedDirectoryHandle` 的关闭判据不对称：文件句柄有 `fd<0` 重检、目录「无公开有效性判据故一律 failed」。是否值得给目录句柄补一个 `released/terminal-invalid/unconfirmed` 的**类型化结果**（06 篇的三态在此只有 failed/closed 两态）？锚点：`src/filesystem/OwnedDirectoryHandle.ts 函数：close 偏移：+0`。
- **P2** `WindowsPrivateRuntime.readFile` 把失败句柄放进 `#unreleasedFiles`，但本篇未读到 JS 侧对该集合的公开查询/重试入口（`close` 只见 `#closeRuntime` 的 win32Code 32/33 重试）。`[未知]` 未确认释放是否有独立上报路径；查证方向：`src/windows/WindowsPrivateRuntime.ts` 是否被 application 层以 `hasPending` 类 API 消费。
- **P2** `callerPath` 的 POSIX 分支保留 `..` 依赖下游内核解析；若某 provider 在拼命令前又自行 `normalize`，语义会分叉。待核对：provider 侧是否都经 `absoluteCallerPath` 而未二次折叠（跨 15~21 篇）。
- **P3** `decodeDirectoryEntryName` 的 `unrepresentable` hex 呈现属 contracts/CLI 篇主题。

## 已知缺口

- **未实测**：本篇所有 native addon 行为（DACL 是否真隔离、kill-on-close 是否真回收、Job 内存上限是否生效、park 阈值）都基于源码与协议推断，**未在 Windows 真机执行 addon**；红线要求「绝不启动/调用引擎与 `rea setup/update`、不打开任何数据库」，故标「未实测，待补」。
- **未逐行读取，不臆测**：`native/windows/src/handle_close_test.cc`（测试）与 `src/windows/*.test.ts` 未作为事实来源；`ReaGhidraBridge.java` 5001 行仅定位 dispatch/guard/digest 相关段（见 15 篇），其余未逐行读。
- **设计特性 vs 风险**：目录句柄「无有效性判据」是 Node `fs.Dir` API 限制下的**特性**（宁可判 failed 也不假装有效）；能力表 optional 字段（jobMemoryLimit/protocolStdin）是**特性**（按 native 回报决定是否启用该功能）。

## 源码索引

```
src/filesystem/callerPath.ts:absoluteCallerPath:13
src/filesystem/OwnedFileHandle.ts:OwnedFileHandle:10
src/filesystem/OwnedDirectoryHandle.ts:OwnedDirectoryHandle:10
src/filesystem/RegularFile.ts:openRegularFile:94
src/filesystem/RegularFile.ts:sameRegularFileState:181
src/filesystem/OwnedRegularFile.ts:withOwnedRegularFile:146
src/filesystem/OwnedRegularFile.ts:RegularFileCleanupFailure:69
src/filesystem/OwnedStagedOutput.ts:OwnedStagedOutput:20
src/filesystem/StableFileHash.ts:hashStableFile:56
src/filesystem/readStableFileBytes.ts:readStableFileBytes:28
src/filesystem/readFileHandleChunks.ts:readFileHandleChunks:33
src/filesystem/decodeDirectoryEntryName.ts:decodeDirectoryEntryName:7
src/filesystem/fileHandleMatchesBytes.ts:fileHandleMatchesBytes:4
src/windows/WindowsNativeLoader.ts:loadWindowsNativeAuthority:118
src/windows/WindowsNativeLoader.ts:inspectionSchema:38
src/windows/WindowsNativeLoader.ts:assertWindowsX64Artifact:191
src/windows/WindowsPrivateRuntime.ts:WindowsPrivateRuntime:59
src/windows/WindowsOwnedProcess.ts:WindowsOwnedProcess:77
src/process/PrivateRuntimeRoot.ts:PrivateRuntimeRoot:45
src/process/WindowsAuthority.ts:inspectWindowsNativeReadiness:57
src/process/ProviderProcess.ts:spawnOwnedProviderProcess:252
native/windows/src/addon.cc:initialize:167
native/windows/src/addon.cc:reaHostHook:186
native/windows/src/filesystem.cc:verifyPrivate:234
native/windows/src/filesystem.cc:localPath:17
native/windows/src/filesystem.cc:openComponent:42
native/windows/src/filesystem.cc:createRuntime:363
native/windows/src/filesystem.cc:closeRuntime:524
native/windows/src/process.cc:spawnProcess:91
native/windows/src/process.cc:createJob:24
native/windows/src/process.cc:inspect:472
native/windows/src/handle_close.hpp:decideOwnedHandleClose:40
src/ghidra/GhidraTransport.ts:createGhidraEndpoint:34
src/ghidra/GhidraLauncher.ts:ghidraHeadlessArguments:749
```

## 相关篇

- 上游：01 系统骨架（domain 纯度、三进程角色）；02 模块地图（`src/windows/` fan-in 9、`src/filesystem/` fan-in 148 的度量）；06 域层（Evidence/错误代数——本篇的 cleanup 并存三态在此成型）。
- 平行/下游：15 深度 Provider·Hopper 与 Ghidra（`WindowsOwnedProcess`/`WindowsPrivateRuntime` 的实际消费者、Ghidra `-readOnly/-deleteProject` 与 Windows P0 无变更权的执行点）；16 深度 Provider·IDA/Kuna/JEB/Cutter（同一 ownership/private-root 机制在不同 provider 接入形态下的复用）。
