# 15 · 深度 Provider：Hopper 与 Ghidra

> 第四层「深度分析引擎」两篇之首：Hopper 与 Ghidra。这两者的**接入范式几乎相反**，本篇把它们并置讲透——Hopper 是 REA **主动拉起厂商 GUI 应用**、把一段 Python bridge **注入到 Hopper 进程内**、通过私有 unix socket 说 NDJSON；Ghidra 是 REA **拉起 `analyzeHeadless` 批处理**、用打包的 Java 脚本在**临时只读库**上跑完分析后由脚本 **serve 一个 socket**。边界澄清：本篇讲进程启动、bridge 协议、能力表与只读/变更权的执行点，不讲 provider 在 dispatcher 里的路由细节（那是 03/04 篇），也不讲 IDA/Kuna/JEB/Cutter（见 16 篇）。

安全红线：本篇不启动、不调用 Hopper/Ghidra，不执行 `rea setup`/`rea update`，不打开任何数据库文件；一切「引擎行为」结论只来自源码与协议定义，需真机证实的标「未实测，待补」。环境：HEAD `9541eb1f2`、Node v24.10.0、darwin、2026-10-27。

## 0 速览

1. **Hopper 是「进程内」范式**：`src/hopper/BridgeLauncher.ts 函数：bridgeBootstrapSource 偏移：+0` 生成一个 `bootstrap.py`，把 `REA_SOCKET/REA_TOKEN/REA_TARGET_PATH/REA_OWNS_PROCESS_LIFETIME` 写成模块常量后 `exec(compile(open(bridgeScriptPath)...))`（`偏移：+22`）——**Python bridge 运行在 Hopper 自己的进程与线程里**，因为 Hopper API 只能在主线程取文档（`bridge/hopper_bridge.py` 头注释：「把 dispatch 挪到 worker 会死锁」）。
2. **Ghidra 是「批处理 + 临时库」范式**：`src/ghidra/GhidraLauncher.ts 函数：ghidraHeadlessArguments 偏移：+131` 固定拼 `-readOnly`、`偏移：+132` 拼 `-deleteProject`，直接落地 AGENTS.md「Ghidra 用临时库、不改目标字节、不控 GUI」。
3. **两者共享同一请求帧形状**：`{id,token,method,params}\n`——Hopper 侧 `src/hopper/HopperClient.ts 函数：constructor 偏移：+19` 造 `payloadValue`、`偏移：+47` 的 `socket.write(payload+"\n")`；Ghidra 侧 `bridge/ghidra/ReaGhidraBridge.java 函数：parseRequest 偏移：+13` 校验同样四键。**响应帧不同**：Hopper 是 `{id,result}` 或 `{id,error}`（`src/hopper/protocol.ts Const：responseSchema`），Ghidra 是 `{id,ok:true,result}`（`bridge/ghidra/ReaGhidraBridge.java 函数：writeSuccess 偏移：+0`）。
4. **鉴权用一次性随机能力令牌 + 常数时间比对**：Hopper `src/hopper/HopperClient.ts 函数：#startWithin 偏移：+15` 令 `this.#token = randomBytes(32).toString("hex")`，Python 侧 `bridge/hopper_bridge.py 函数：_serve_connection 偏移：+43` 用 `hmac.compare_digest(token, REA_TOKEN)`，不符抛 `PermissionError`；Ghidra `函数：parseRequest 偏移：+14` 用 `函数：constantTimeEquals 偏移：+0`。
5. **Ghidra 有一道「导入字节摘要」门**：`bridge/ghidra/ReaGhidraBridge.java 函数：run 偏移：+36` 取 `currentProgram.getExecutableSHA256()`，`偏移：+38` 与 descriptor 的 `target_sha256` 常数时间比对，不等即 `IllegalStateException`——这保证「serve 出来的分析结果」对应「REA 准入的那份字节」。
6. **变更权按平台收紧**：Hopper 的能力表把 6 个 `set_*/unset_*` 标 `mutatesArtifact:true`（`src/hopper/HopperProviderCapabilities.ts Const：MUTATING_OPERATIONS`），Ghidra 在 Windows 上直接拒绝数据库变更（`bridge/ghidra/ReaGhidraBridge.java 函数：handleRequest 偏移：+46` 与 `偏移：+52`：`method_unavailable` + 「Windows P0 does not admit database mutation」）；Hopper 把 `search_bytes` 标为 `available:false`（`src/hopper/HopperProviderCapabilities.ts 函数：hopperCapabilities 偏移：+10`，reason「Masked byte search has not been verified for Hopper.」）。

## 1 接入范式对照：一张表定住两者

| 维度 | Hopper | Ghidra |
|---|---|---|
| REA 拉起的进程 | 厂商 GUI 应用 `hopper`（`--analysis -Y bootstrap.py`） | JDK 批处理 `analyzeHeadless` |
| bridge 运行位置 | **注入到应用进程内**（Python 在 Hopper 里跑） | **打包 Java 脚本**（HeadlessScript，跑在 analyzeHeadless 里） |
| 目标如何进引擎 | `--executable/--database loadedPath`（私有根内的副本） | `-import targetPath` + `-readOnly` |
| 传输 | 私有 unix socket `bridge.sock` | POSIX: unix socket；Windows: 认证 loopback TCP |
| 数据库寿命 | 依附 Hopper 进程/文档 | 临时：`-deleteProject`，用完即弃 |
| 单实例约束 | 目标级 lease + Linux 应用级单例 lease | 每次 launch 一个私有运行根 |
| 生命周期归属 | `launcher-process`（REA 拥有进程）或 `external-application`（用户已开） | REA 始终拥有 analyzeHeadless 子进程 |
| 只读承诺执行点 | 能力表 `mayWriteFilesystem=MUTATING.has(op)` | 命令行 `-readOnly` + 摘要门 + Windows 拒变更 |
| 版本门 | descriptor/bootstrap 携带 run/token；health 探活 | `run 偏移：+34` `providerVersion` 必须等于当前 Ghidra 版本 |

`[推导]` 范式差异的根因：Hopper 无「无头批处理 + 网络服务」的原生形态，REA 只能把控制面注入进去、由 GUI 进程自己开 socket；Ghidra 天生有 `analyzeHeadless`，REA 选择「让 Ghidra 跑完分析后由最后一个 postScript 起 socket serve」，从而不需要长期持有 GUI。

## 2 Hopper：从「拉起」到「serve」

### 2.1 启动与 bootstrap 注入

`src/hopper/BridgeLauncher.ts 函数：HopperApplicationLauncher 偏移：+0` 实现 `BridgeLauncher`；它的 `src/hopper/BridgeLauncher.ts 函数：#launchPreparedTarget 偏移：+0` 拼的参数是 `...loaderArgs` 之后的固定五段：

```
["--analysis", "-Y", bootstrapPath, action, loadedPath]      ← #launchPreparedTarget 偏移：+20~+24
   action = targetKind==="database" ? "--database" : "--executable"   ← 偏移：+16~+17
```

`bootstrapPath` 指向 `src/hopper/BridgeLauncher.ts 函数：#writeBootstrap 偏移：+0` 落盘的 `bootstrap.py`，写入权限 `mode 0o600`；其内容由 `src/hopper/BridgeLauncher.ts 函数：bridgeBootstrapSource 偏移：+0` 生成：

```
REA_SOCKET = "<runtimeRoot>/bridge.sock"              ← bridgeBootstrapSource 偏移：+15
REA_TOKEN  = "<32B hex 能力令牌>"                      ← 偏移：+16
REA_RUN_ID / REA_TARGET_PATH / REA_OWNS_PROCESS_LIFETIME /
REA_RECONNECT_TIMEOUT_SECONDS [/ REA_BRIDGE_MAX_REQUEST_BYTES]
exec(compile(open(bridgeScriptPath,'rb').read(), bridgeScriptPath,'exec'))   ← 偏移：+22
```

`[推导]` 把 `bridgeScriptPath` 用 `exec(compile(...))` 而不是 `import`，是为了让 REA 打包的 `hopper_bridge.py` 以「与 Hopper 主脚本同一命名空间/同一线程」的方式运行——这正是「不能挪 worker」约束的落法。

`src/hopper/BridgeLauncher.ts 函数：linuxDemoLaunch 偏移：+0` 与同文件的 `函数：usesLinuxDemo 偏移：+0` 是 Linux 无 GUI 场景的 `unshare`/`python3` 演示启动路径；macOS/Windows 走真实 launcherPath。生命周期归属在 `src/hopper/BridgeLauncher.ts 函数：#launchPreparedTarget 偏移：+94~+109` 分叉：`ownsProcessLifetime` 真则 `providerLifetime:"launcher-process", shutdownMode:"process-cleanup"`，假则 `external-application, "bridge-request"`。

### 2.2 socket、令牌与所有权文件

`src/hopper/HopperClient.ts 函数：#startWithin 偏移：+14` 令 `socketPath = join(runtimeRoot.path, "bridge.sock")`，`偏移：+15` 生成 `this.#token`，随后 `ownership.json` 落 runtime 根（`src/hopper/HopperClient.ts 函数：#startWithin 偏移：+48`）。真正连接/health 走 `src/hopper/HopperClient.ts 函数：callTool 偏移：+0` → 内部私有 `#request`（本篇不点其行号，语义见下）。

请求帧的唯一产生点在构造函数里为 `HopperRequestQueue` 装的发送闭包：`函数：constructor 偏移：+19` 组 `payloadValue={id,token,method,params}`，`偏移：+32` 做 `bridgeMaxRequestBytes` 预算检查（超限即 `bridgeRequestOversizeError`，不发），`偏移：+47` `socket.write(`${payload}\n`)`。

### 2.3 Python 侧的 serve 循环与鉴权

`bridge/hopper_bridge.py 函数：_serve_connection 偏移：+0`：

```
line = file.readline(MAX_REQUEST_BYTES + 1)        ← 偏移：+9   预算外多读 1 字节判超限
若不以 \n 结尾 → 超限/残帧，写 {"id":0,"error":...} 并断   ← 偏移：+12~+22
request = json.loads(line)                          ← 偏移：+28
set(request) != {"id","token","method","params"} → InvalidRequest   ← 偏移：+31
isinstance(request_id,int) and >=0 校验              ← 偏移：+34
token 必须 ascii 且 hmac.compare_digest(token, REA_TOKEN) 否则 PermissionError   ← 偏移：+41~+45
authenticated 后置 connection.settimeout(None)       ← 偏移：+50  鉴权后取消空闲超时
发 progress 事件 (completed 0/1)                     ← 偏移：+51~+57
result = _dispatch(request["method"], request["params"])   ← 偏移：+58
```

`_dispatch(method, params)`（`偏移：+0`）是一条长 if-链的方法路由（health、shutdown/shutdown_document、list_documents、current_document、analyze_function、read_bytes `偏移：+52`、address_to_file_offset `偏移：+84`、search_procedures/strings、set_*/unset_* 变更、list_* …）。**注意它没有 `search_bytes` 分支**——与能力表 `available:false` 一致：masked byte search 只在 Ghidra 侧有实现（见 §3.3）。

`_write_message`（`偏移：+0`）把每条消息压成**紧凑单行 JSON + `\n`**（NDJSON），progress 事件先于响应、失败先 diagnostic 事件再 `error` 响应；`_diagnostic_type`（`偏移：+0`）把异常映射到 `capability_unavailable`/`authorization`/`invalid_request`/`bridge_exception` 四类。

### 2.4 单实例 lease

Hopper 的 GUI 应用「同一目标只能开一个」由 `src/process/HopperLease.ts` 保证（`acquireHopperTargetLease` 以 realpath 规范化后的 `loaderArgs+targetPath+targetKind` 为键；`acquireLinuxHopperApplicationLease` 锁应用级单例），lease 目录 `/tmp/rea-hopper-<uid>`。`[未知]` lease 冲突的确切用户可见文案与释放时机，需读 application 层调用点，本篇未展开。

## 3 Ghidra：批处理、临时库与 serve

### 3.1 analyzeHeadless 命令拼装

`src/ghidra/GhidraLauncher.ts 函数：ghidraHeadlessArguments 偏移：+0` 返回的定长数组（去掉 loader 条件段）：

```
[projectRoot, "rea-project", "-import", targetPath,
   <loader/processor/cspec 条件段>,                     ← 偏移：+68~+119
 "-readOnly",                                           ← 偏移：+131
 "-deleteProject",                                      ← 偏移：+132
 "-log", ghidraLogPath, "-scriptlog", scriptLogPath,
 "-scriptPath", bridgeDirectory,
   <preScript: prepareCom/prepareRaw/prepareDol/applySeeds/analysisOptions>,   ← 偏移：+139~+180
   <postScript: noReturnFix(非 win32)/mipsSoftFloat>,   ← 偏移：+181~+193
 "-postScript", bridgeScriptPath, descriptorPath ]
```

`函数：ghidraHeadlessCommand 偏移：+0` 负责跨平台落地：非 win32 直接 `{command: analyzeHeadlessPath, arguments}`；win32 走 `windowsBatchCommand`，并在末参长度 >30000 时抛「Windows Ghidra command exceeds the P0 length limit」（`偏移：+19`）。

语言/分析器微调是**用户可配置但不改语义承诺**的两处：`src/config/ghidraLanguageOverride.ts Type：GhidraLanguageOverride`（`languageId` + 可选 `compilerSpecId`，正则见 `Const：ghidraLanguageIdSchema`）；`src/config/ghidraDisabledAnalyzers.ts`（`Const：MAX_GHIDRA_DISABLED_ANALYZER_NAMES = 32`、`Const：MAX_GHIDRA_DISABLED_ANALYZER_NAME_LENGTH = 120`，来源 `REA_GHIDRA_DISABLED_ANALYZERS`）→ 拼成 `-preScript analysisOptions <names,joined>`。

### 3.2 辅助脚本 = 扩展点（打包 Java）

`src/ghidra/GhidraBridgeSources.ts Const：GHIDRA_BRIDGE_SOURCES` 是 10 条映射（`bridge` + 9 个 helper），全部随 REA 打包：

| key | 文件 | 角色（观察：脚本基类与措辞） |
|---|---|---|
| bridge | ReaGhidraBridge.java | `extends HeadlessScript`，分析后起 socket serve |
| bundleActivator | ReaGhidraBundleActivator.java | `implements BundleActivator`，no-op；与 REA 脚本同编译以免第二个编译器 |
| extensions | ReaGhidraExtensions.java | `AutoCloseable`，entry_class 驱动的原生类型/镜像恢复 |
| prepareCom / prepareRaw / prepareDol | ReaGhidraPrepare*.java | pre-script：DOL 重建段表、Raw 设 entry block、COM 设 `1000:0100` |
| applySeeds | ReaGhidraApplySeeds.java | pre-script：读 `0x<hex>\t(function\|code\|label)[\tname]` 种子行 |
| analysisOptions | ReaGhidraAnalysisOptions.java | pre-script：`AutoAnalysisManager` 关指定 analyzer |
| noReturnFix | ReaGhidraNoReturnFix.java | **post-script**，`CreateFunctionCmd`；注释「Windows P0 does not admit analysis-database mutation」→ 故 `ghidraHeadlessArguments 偏移：+181` 仅在非 win32 追加 |
| mipsSoftFloat | ReaGhidraMipsSoftFloat.java | post-script：SpecExtension/CompilerSpec 软浮点 |

`[推导]` pre/post-script 的排序被写进数组顺序即「loader 准备 → 种子 → 分析器选项 → 默认自动分析 → no-return 修复 → 软浮点 → bridge serve」，保证「serve 出来的结果」是配好 analyzer 之后的最终态。

### 3.3 ReaGhidraBridge 的 run / serve / dispatch

`bridge/ghidra/ReaGhidraBridge.java 函数：run 偏移：+0`（`public void run()`）关键序列：

```
getScriptArgs() 必须恰 1 个 descriptor                     ← run 偏移：+1~+4
readDescriptor(...) → SessionDescriptor                     ← 偏移：+6
非 Windows：Files.deleteIfExists(descriptorPath)（消费即删）  ← 偏移：+13~+14
currentProgram 非空校验                                      ← 偏移：+16~+18
providerVersion 必须 == Application.getApplicationVersion()  ← 偏移：+34
importedSha256 = currentProgram.getExecutableSHA256()       ← 偏移：+36
constantTimeEquals(imported, descriptor.targetSha256) 否则抛 ← 偏移：+37~+45
end(true)  // 结束 GhidraScript 包裹的事务，让后续编辑各持真事务   ← 偏移：+49
非 unix-socket 且 analysisExtensions>0 → 抛（Windows P0 拒元数据/变更） ← 偏移：+51~+52
serve(descriptor)                                            ← 偏移：+55
```

`函数：serve 偏移：+0` 二选一：`unix-socket` → `函数：serveUnixSocket 偏移：+0`（`ServerSocketChannel.open(UNIX)` bind 后 `setPosixFilePermissions("rw-------")`），`authenticated-loopback-tcp` → `函数：serveLoopbackTcp 偏移：+0`（bind `127.0.0.1:0`、把 `{host,port}` 以 `CREATE_NEW` 写 endpoint json、Windows 直写正式名 / POSIX 先 `.pending` 再 `ATOMIC_MOVE`）。serve 前后各 `deleteIfExists` 套接字/endpoint 文件。

`函数：serveClient 偏移：+0` 逐行 `reader.readLine()` → `函数：parseRequest`（校验四键 + token 常数时间等）→ `shutdown` 特判（回 `{shutdown:true, project_ephemeral:true}`）→ 否则 `writeSuccess(writer, id, 函数：handleRequest(...))`。命令 dispatch 表在 `函数：handleRequest 偏移：+0`，`偏移：+12` 起一个 `switch(request.method)`：

```
ping（switch 前特判）                                          ← handleRequest 偏移：+4
analysisTimeoutOccurred → analysis_incomplete                  ← 偏移：+9~+14
switch: read_binary_inventory_summary / inspect_native_load_image
        read_bytes→readMemoryBytes / search_bytes→searchMemoryBytes
        address_to_file_offset / address_name
        list_{documents,names,procedures,segments,strings}
        procedure_{address,assembly,callees,callers,info,pseudo_code}
        read_function_instructions / procedure_references
        resolve_containing_procedure / search_{procedures,strings}
        inspect_native_{data_type,instruction} / resolve_native_call_targets
        xrefs / analyze_function
        set_address_name,set_addresses_names → 非 unix 抛 method_unavailable   ← 偏移：+46~+48
        annotate_native_function → 同上门禁                      ← 偏移：+52~+54
        default → method_unavailable                             ← 偏移：+57
```

命令调度表位置：`bridge/ghidra/ReaGhidraBridge.java` 的 `函数：handleRequest`（其 `switch` 覆盖 §0.6 提到的 Windows 变更门禁）。操作计数：`Const：CAPABILITIES`（`偏移：+0`）声明 **32** 个操作名（含 `ping`、`shutdown`、以及 `set_address_name`/`set_addresses_names`/`annotate_native_function` 这类变更名）；`handleRequest` 的 `switch` 以约 29 个 case 标签（部分合并两个方法名）路由，加 switch 前的 `ping` 特判，default 收敛到 `method_unavailable`。

### 3.4 只读边界的三道锁（AGENTS.md 执行点）

AGENTS.md 的「Ghidra 用临时库不改字节、不控 GUI；Windows Ghidra P0 无变更权」在本篇有三处可指认的执行点：

1. **命令行级**：`ghidraHeadlessArguments 偏移：+131~+132` 的 `-readOnly`/`-deleteProject`——不改目标字节、库用完即删、全程无 GUI。
2. **脚本门禁级**：`bridge/ghidra/ReaGhidraBridge.java 函数：handleRequest 偏移：+46` 与 `偏移：+52`——Windows（非 unix-socket）请求 `set_*`/`annotate_*` 直接 `method_unavailable`；`函数：run 偏移：+51` 连「元数据恢复扩展」也拒绝。`ReaGhidraNoReturnFix.java` 注释同理说明为何 win32 不追加该 post-script。
3. **归属级**：`函数：run 偏移：+37~+45` 的摘要门——分析对象必须是 REA 准入的那份字节，防止「serve 到别的库」。

> **未实测，待补**：以上均是「源码里写死了分支」的观察；`-readOnly` 在真实 Ghidra 上是否严格不写、`-deleteProject` 是否不留盘、Windows TCP 通道下变更请求是否确被拒，需真机执行验证——本篇遵守红线未运行 Ghidra。

## 4 报文帧字节布局（ASCII）

两 provider 的**请求帧同形**、**响应帧异形**，且都是 NDJSON（一行一帧、`\n` 结尾、无长度前缀、无二进制分帧）：

```
Hopper 请求（HopperClient→socket→hopper_bridge.py）：
 offset→  0                                       len-1
        {"id":7,"token":"a1b2…64hex…","method":"read_bytes","params":{"address":"0x1000","length":256}}\n
          └id┘ └────token(32B hex,能力)────┘ └──method──┘ └──────────────params(JSON)──────────────┘  └LF┘
 预算：JSON.stringify 后 Buffer.byteLength ≤ bridgeMaxRequestBytes.maximumBytes（超限不发）

Hopper 响应（三态，_write_message 压紧凑行）：
  {"id":7,"event":{"type":"progress","phase":"hopper_bridge","completed":0,"total":1,...}}\n   ← 前置进度
  {"id":7,"result":{…}}\n            或   {"id":7,"error":{"code":…,"message":…,"type":…}}\n   ← 终帧
  {"id":7,"event":{"type":"diagnostic","error":{…}}}\n                                        ← 鉴权后异常时

Ghidra 请求（同 shape，Java parseRequest 强校验四键集合）：
  {"id":7,"token":"…","method":"procedure_pseudo_code","params":{…}}\n

Ghidra 响应（writeSuccess/writeFailure，多一个 ok 布尔）：
  {"id":7,"ok":true,"result":{…}}\n
  {"id":7,"ok":false,"error":{"code":"method_unavailable","message":"…"}}\n

loopback-TCP 端点文件（Windows，serveLoopbackTcp 写，CREATE_NEW 单行）：
  {"host":"127.0.0.1","port":53123}\n
```

`[推导]` Ghidra 多出的 `ok` 字段是 Java 侧判别成功的显式位；Hopper 用「有 result 还是 error」的键存在性判别（`src/hopper/protocol.ts Const：responseSchema` 是 `{id,result}` 与 `{id,error}` 的 `z.union`，`函数：responseResult 偏移：+0` 用 `"error" in response` 分流）。

## 5 一次 decompile 请求的跨进程时序（sequenceDiagram）

```mermaid
sequenceDiagram
  participant C as MCP/CLI 调用方
  participant A as application 层
  autonull
  Note over C,A: Hopper 路径（进程内 Python）
  C->>A: read_bytes / analyze_function 请求
  A->>A: HopperClient.callTool → #request 入队
  A->>A: constructor 发送闭包: {id,token,method,params}+"\n"
  A->>A: socket.write → bridge.sock
  A->>A: hopper_bridge.py _serve_connection: readline + hmac.compare_digest
  A->>A: _dispatch(method,params) 在 Hopper 主线程执行
  A-->>A: _write_message NDJSON 进度+结果
  A->>C: responseResult 解析 → createEvidence(confidence=observed)
  Note over C,A: Ghidra 路径（批处理 + 临时库）
  C->>A: procedure_pseudo_code 请求
  A->>A: analyzeHeadless 已 -readOnly -deleteProject 跑完分析
  A->>A: ReaGhidraBridge.run: providerVersion + getExecutableSHA256 摘要门
  A->>A: serveUnixSocket/serveLoopbackTcp 起 socket, serveClient.readLine
  A->>A: parseRequest 四键+token → handleRequest switch → procedurePseudocode
  A-->>A: writeSuccess {id,ok:true,result}
  A->>C: 结果 → Evidence；shutdown 时 project_ephemeral:true, 库随进程消亡
```

> 时序图为便于阅读把两段合并画在同一泳道示意；节点名均可在正文/索引回源码：Hopper 侧 `src/hopper/HopperClient.ts 函数：callTool`、`函数：constructor 偏移：+47`、`bridge/hopper_bridge.py 函数：_serve_connection`、`函数：_dispatch`、`函数：_write_message`、`src/hopper/protocol.ts 函数：responseResult`；Ghidra 侧 `src/ghidra/GhidraLauncher.ts 函数：ghidraHeadlessArguments`、`bridge/ghidra/ReaGhidraBridge.java 函数：run`、`函数：serve`、`函数：serveClient`、`函数：handleRequest`、`函数：writeSuccess`。

## 6 能力表：路由的唯一真相源（provider 文档硬要求）

Hopper 能力在 `src/hopper/HopperProviderCapabilities.ts 函数：hopperCapabilities 偏移：+0` 由 `Const：HOPPER_OPERATIONS`（36 个）外加 `search_bytes`（**available:false**）合成，共 37 条 CapabilityDescriptor；`effects.mutatesArtifact = MUTATING_OPERATIONS.has(op)`、`launchesProcess:true, mayShowUi:true, mayAccessNetwork:false`。字节级内存工具定义在 `src/contracts/hopperMemoryContracts.ts Const：HOPPER_MEMORY_TOOL_DEFINITIONS`：`search_bytes`（Ghidra-only）、`read_bytes`（`length:z.int().min(1).default(256)`）、`address_to_file_offset`。

Ghidra 能力真相源在 Java 侧 `Const：CAPABILITIES`（32 项），dispatch 由 `函数：handleRequest` 执行。下表把两 provider 的读/搜/命名/变更四类操作并置（`观察` = 源码里能直接定位的分支或声明）：

| 操作类 | 代表 op | Hopper 声明位置 | Ghidra 声明位置 | mutatesArtifact / 备注 |
|---|---|---|---|---|
| 元信息 | list_documents | HOPPER_OPERATIONS `偏移：+9` | CAPABILITIES `偏移：+12` | false |
| 反编译 | procedure_pseudo_code | HOPPER_OPERATIONS `偏移：+25` | CAPABILITIES `偏移：+26` → `handleRequest 偏移：+30` | false |
| 读字节 | read_bytes | HOPPER_OPERATIONS `偏移：+22` → `_dispatch 偏移：+52` | `handleRequest 偏移：+16` | false；length 1..(默认 256) |
| 掩码搜字节 | search_bytes | available:false（`hopperCapabilities 偏移：+10`）| `handleRequest 偏移：+17` searchMemoryBytes | Hopper 未验证故不路由 |
| 地址↔文件偏移 | address_to_file_offset | `_dispatch 偏移：+84`（含反查校验+header）| `handleRequest 偏移：+18` | false |
| 引用 | procedure_references / xrefs | HOPPER_OPERATIONS `偏移：+24,+35` | CAPABILITIES `偏移：+31,+32` | false |
| 命名变更 | set_address_name / set_addresses_names | MUTATING（true）| `handleRequest 偏移：+46`（win32 拒）| Hopper true / Ghidra 仅 unix |
| 标注变更 | annotate_native_function | —（Hopper 无此 op）| `handleRequest 偏移：+52`（win32 拒）| Ghidra unix-only 变更 |
| 书签 | set_bookmark / unset_bookmark | MUTATING（true）| —（Ghidra 无）| Hopper 专有 |

`[推导]` 这张表就是 dispatcher 选路的依据：`search_bytes` 只有 Ghidra 能路由、`set_bookmark` 只有 Hopper 能路由、Ghidra 的命名/标注在 Windows 通道被硬拒——三者都不是「运行时试错」而是**能力表静态声明**，与 AGENTS.md「能力表是 provider 路由依据，不得从工具名或响应文本猜」一致。工具在 contracts/register 层的挂载属第三层（03 篇）主题，本篇只到「provider 声明了什么能力」。

## 边界与失败模式

- **Hopper「不能挪 worker」**：若上层试图在 bridge 内异步派发到别的线程访问 Hopper API → 死锁（文件头注释）。失败模式：主线程被长任务占用时 health 探活可能超时；REA 侧靠 `REA_RECONNECT_TIMEOUT_SECONDS` 与 `shutdownMode` 区分「bridge 请求关」vs「进程清理关」。
- **令牌错配 = PermissionError，不是重试信号**：`_serve_connection 偏移：+41~+45` 抛 `PermissionError` → `_diagnostic_type` 映射 `authorization`；`[推导]` 这属「连接被冒充/串台」而非「可重试」，客户端应重开 session 而非重发。
- **Ghidra 摘要/版本门误杀**：目标字节被别处改动或 Ghidra 版本与 session 不符 → `run` 直接抛、不起 socket；表现为「provider 启动失败」而非「空结果」，是响亮失败。
- **loopback TCP 端点竞态**：`serveLoopbackTcp` 用 `CREATE_NEW` + POSIX `ATOMIC_MOVE`（Windows 直写正式名，注释解释原生 reader 拒读「仍被 writer 占有」的文件）；失败模式：崩溃残留 `.pending`/endpoint 文件，serve 前后各有 `deleteIfExists`，但 abrupt death 可能留私存（`run 偏移：+11~+12` 注释）。
- **超限帧的处理不对称**：Hopper 客户端在**发送前**按 `bridgeMaxRequestBytes` 拒（`constructor 偏移：+32`）；Python 在**接收时**靠 `readline(MAX_REQUEST_BYTES + 1)` 判超限（`_serve_connection 偏移：+9`）。二者预算都源自 `REA_BRIDGE_MAX_REQUEST_BYTES`（见 22 篇 config），默认 16 MiB、下限 7464。

## 问题清单

- **P1** Hopper 的 `search_bytes` 能力表标 `available:false`，但 `contracts/hopperMemoryContracts.ts` 仍在工具定义里列出 `search_bytes`。`[未知]` 上层如何保证「定义了但不可用」的工具不会被误路由——能力表的 `available:false` 是否在 dispatcher 之前先过滤？查证方向：03/04 篇路由与 `hopperCapabilities` 的消费点。
- **P1（待拍板）** Ghidra「Windows P0 无变更权」目前靠**传输类型**（非 unix-socket）推断平台（`run 偏移：+51`、`handleRequest` 门禁用 transport），而非直接读 OS。若未来 Windows 也能开 unix-socket，门禁是否会误放行变更？决策点：门禁判据是 transport 还是 platform。锚点：`bridge/ghidra/ReaGhidraBridge.java 函数：handleRequest 偏移：+46`。
- **P2** Hopper `shutdown` 的 `should_stop` 条件（`_serve_connection 偏移：+59~+64`）要求 `document_closed/analysis_stopped/document_retained` 组合成立才停，逻辑较细；`[未知]` 各组合的语义完备性未在源码外印证，未实测。
- **P2（复核后撤回）** 初稿怀疑 `constantTimeEquals` 的「常数时间」名不副实、可能落到 `String.equals` 短路。读实现后不成立：`bridge/ghidra/ReaGhidraBridge.java 函数：constantTimeEquals 偏移：+1~+4` 把两侧转 UTF-8 字节后交给 `java.security.MessageDigest.isEqual`，JDK 该方法是文档保证的抗时序比较。观察；残余风险只剩「`getBytes` 前的字符串本身若被截断则长度差异仍可见」，属长度泄漏而非逐字符泄漏。
- **P3** `HopperLease` 冲突文案与释放时机、`linuxDemoLaunch` 的展示策略选择，属更外围主题。

## 已知缺口

- **未实测，待补**：所有「真实 Hopper/Ghidra 进程内的行为」——GUI 是否真起来、`-readOnly` 是否真不写盘、`-deleteProject` 是否真不留库、loopback TCP 认证是否真阻断非本机连入——本篇仅从源码与协议推断，未运行引擎。
- **未逐行读取，不臆测**：`bridge/ghidra/ReaGhidraBridge.java`（5001 行）只定位了 `run/serve/serveClient/handleRequest/writeSuccess/parseRequest/constantTimeEquals` 与 CAPABILITIES，其余反编译/引用实现未逐行读；`bridge/hopper_bridge.py`（1321 行）读的是 `_serve_connection`、`_dispatch` 框架与内存工具分支，各 procedure_* 细节未逐行读；9 个辅助 Java 脚本读了角色级签名/注释，未逐行。
- **风险 vs 特性**：Hopper「进程内、单线程 API」是**特性**（无头方案的必然代价），其风险是长任务阻塞探活；Ghidra「临时库每次重建分析」是**特性**（只读承诺的必然代价），其风险是大镜像重复分析耗时——两者均非缺陷，但决定各自 SLA。

## 源码索引

```
src/hopper/protocol.ts:parseBridgeMessageLine:86
src/hopper/protocol.ts:responseResult:110
src/hopper/HopperClient.ts:HopperClient:135
src/hopper/HopperClient.ts:start:366
src/hopper/HopperClient.ts:startWithin:468
src/hopper/HopperClient.ts:callTool:652
src/hopper/HopperClient.ts:close:707
src/hopper/BridgeLauncher.ts:HopperApplicationLauncher:195
src/hopper/BridgeLauncher.ts:launch:280
src/hopper/BridgeLauncher.ts:launchPreparedTarget:364
src/hopper/BridgeLauncher.ts:writeBootstrap:539
src/hopper/BridgeLauncher.ts:bridgeBootstrapSource:623
src/hopper/BridgeLauncher.ts:linuxDemoLaunch:684
src/hopper/HopperProviderCapabilities.ts:HOPPER_OPERATIONS:24
src/hopper/HopperProviderCapabilities.ts:hopperCapabilities:73
src/contracts/hopperMemoryContracts.ts:HOPPER_MEMORY_TOOL_DEFINITIONS:9
bridge/hopper_bridge.py:_dispatch:842
bridge/hopper_bridge.py:_serve_connection:1153
bridge/hopper_bridge.py:_write_message:1257
bridge/hopper_bridge.py:_diagnostic_type:1263
src/ghidra/GhidraLauncher.ts:GhidraHeadlessLauncher:250
src/ghidra/GhidraLauncher.ts:ghidraHeadlessCommand:666
src/ghidra/GhidraLauncher.ts:ghidraHeadlessArguments:749
src/ghidra/GhidraTransport.ts:createGhidraEndpoint:34
src/ghidra/GhidraBridgeSources.ts:GHIDRA_BRIDGE_SOURCES:2
src/config/ghidraLanguageOverride.ts:ghidraLanguageIdSchema:18
src/config/ghidraDisabledAnalyzers.ts:MAX_GHIDRA_DISABLED_ANALYZER_NAMES:3
bridge/ghidra/ReaGhidraBridge.java:CAPABILITIES:142
bridge/ghidra/ReaGhidraBridge.java:run:189
bridge/ghidra/ReaGhidraBridge.java:serve:255
bridge/ghidra/ReaGhidraBridge.java:serveUnixSocket:267
bridge/ghidra/ReaGhidraBridge.java:serveLoopbackTcp:280
bridge/ghidra/ReaGhidraBridge.java:serveClient:379
bridge/ghidra/ReaGhidraBridge.java:handleRequest:425
bridge/ghidra/ReaGhidraBridge.java:parseRequest:4775
bridge/ghidra/ReaGhidraBridge.java:constantTimeEquals:4898
bridge/ghidra/ReaGhidraBridge.java:writeSuccess:4905
```

## 相关篇

- 上游：06 域层（`createEvidence`/`confidence` 如何吃下这里的 result 帧）；14 Filesystem 与 Windows 边界（`WindowsPrivateRuntime` 建 Ghidra 私有运行根与 descriptor、`WindowsOwnedProcess` 管 analyzeHeadless 子进程）。
- 平行：16 深度 Provider·IDA/Kuna/JEB/Cutter——同一「谁起进程 / 谁持有会话 / 谁关闭 / 失败留什么」四维的另外四种形态，尤其 IDA 的「attached GUI 只读、绝不 idb_close(save)」与本篇 Ghidra「-readOnly + 摘要门」是同一类只读承诺的不同实现。
- 下游/相邻：03 注册与路由（能力表如何被 dispatcher 消费）、22 配置（`REA_BRIDGE_MAX_REQUEST_BYTES`/`REA_GHIDRA_DISABLED_ANALYZERS`/`REA_KUNA_COMMAND` 等）。
