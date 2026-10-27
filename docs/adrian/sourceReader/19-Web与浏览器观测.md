# 19 · Web 与浏览器观测

> 本篇讲 **Web/浏览器这一族 provider 内部**：`src/browser/`（CDP + Playwright）、`src/inspector/`（V8 Inspector）、`src/electron/`（Electron fuse 静态读取）、`src/javascript/`（JS 静态/语义分析与 source map）、`bridge/mitmproxy/capture.py`（原生抓包解码）。它们都属于层级的第 3 层（provider 适配器），端口与替身的装配结论在 [11 篇 §2.3](11-Composition层-生产装配根.md#23-可选观测端口)，本篇**只回链、不重复**。
>
> 边界澄清：本篇**不**讲工具契约与注册（见 [09](09-Server层-MCP适配器.md)）、**不**讲 Evidence 与 authority 的定义本身（见 [06](06-域层-Evidence与错误代数.md)）、**不**讲 worker 子进程所有权（见 [11](11-Composition层-生产装配根.md) / [13](13-Process层-子进程监督与所有权.md)）。

实测环境：提交 `9541eb1f2`（`src/` 与该基线一致）、darwin、未运行任何 `rea` 子命令、未启动浏览器/Playwright/CDP/mitmproxy —— 本篇全部结论来自静态读取，**没有任何运行时实测**，涉及运行时行为的判断一律降级标注。

体量（`wc -l`，仅非测试 `.ts`）：`src/browser/` 121 文件 / 31,539 行；`src/javascript/` 20 / 6,137；`src/inspector/` 5 / 1,373；`src/electron/` 4 / 1,177；`bridge/mitmproxy/capture.py` 384 行。

**选取判据**（`src/browser/` 太大，无法逐行）：按「被 `src/composition/` 的观测端口直接构造」+「文件内导出面即 provider 公开能力」两条筛出主干 —— `CdpBrowserProvider.ts` / `CdpTargetSession.ts` / `CdpConnection.ts` / `CdpEndpoint.ts` / `CdpElectronProvider.ts` / `PlaywrightBrowserScenarioProvider.ts` / `PlaywrightScenarioBrowser.ts` / `PlaywrightScenarioSession.ts` / `WebSourceMapFetcher.ts` / `history/` 全部 / `execution/CdpWebRuntimeProvider.ts`；叶子捕获器（`CdpCapture*.ts` 共 13 个、`CdpSnapshot*.ts`）只读入口不读内部，列入「已知缺口」。

## 0 速览

1. **三条观测通道在源码里是三套不同的连接对象**，不是一个：CDP 走 `CdpConnection`（`src/browser/CdpConnection.ts Class：CdpConnection`）；V8 Inspector 复用同一个 `CdpConnection` 类但走**自己的发现函数** `discoverV8Inspector`（`src/inspector/V8InspectorEndpoint.ts 函数：discoverV8Inspector 偏移：+0`，它从 `../browser/CdpEndpoint.js` 导入 `readCdpJson` / `parseCdpEndpointValue`）；Playwright 走 `playwright-core` 的 API 对象，不出现任何 CDP 类名。
2. **Playwright 只出现在 scenario 一侧**，且**是运行时动态导入**：`src/browser/PlaywrightScenarioBrowser.ts 函数：openPlaywrightScenarioBrowser 偏移：+11`（`(await import("playwright-core")).chromium`），注释原文「Load Playwright only when a scenario opens; MCP startup stays off its module graph」。版本钉在 `package.json` 的 `"playwright-core": "1.58.2"`。
3. **CDP 命令超时是三段式，不是一段**：发现阶段固定 10 s（`CDP_DISCOVERY_RESPONSE_TIMEOUT_MS`）、握手/命令阶段默认 20 s 且只有 9 个操作可传 `command_timeout_ms`（`COMMAND_TIMEOUT_OPERATIONS`）、清理宽限期固定 5 s；三者各自有独立文案函数（`src/domain/browserDeadline.ts Const：DEFAULT_CDP_COMMAND_TIMEOUT_MS` / `Const：COMMAND_TIMEOUT_OPERATIONS` / `Const：CDP_CLEANUP_GRACE_MS`）。
4. **本族 provider 自己不写 Evidence `authority`**：`grep -n "authority:" src/browser/ src/inspector/ src/electron/ src/javascript/`（排除 `*.test.ts`）**只有 1 处命中**，且它不是 Evidence authority 而是投影字段 `runtime_kind_authority`（`src/inspector/V8InspectorCaptureProjection.ts`）。真正打 `controlled-replay` / `external-service` 标签的代码在 `src/domain/javascript/` 里，见 §7。
5. **web 网络抓包解码一次构造 4 个 adapter**，但只有 3 个是 Node 子进程（har/saz/qlog 共用 `NodeCaptureAdapter`），第 4 个 `MitmproxyCaptureAdapter` 只在 Linux + 显式 `REA_MITMDUMP_COMMAND` 绝对路径下才给命令，否则抛 `AnalysisCapabilityUnavailableError`（`src/browser/history/MitmproxyCaptureAdapter.ts 函数：command 偏移：+6~+16`）。堆预算**不是**在装配根算的，而是 `runtimeCaptureDecoderHeap` 解一次、由 decoder 从 adapter 复用（`函数：sharedCaptureDecoderHeap`）。
6. **Electron 观测不是独立协议**：`CdpElectronProvider` 直接吃 `src/browser/CdpConnection.js` 与 `src/browser/CdpEndpoint.js` 的同一套发现/连接函数，差别在准入（asar 头部准入 + 文件页作用域），见 §6。

## 1 三条观测通道的分层

```
                     ┌───────────────────────────────────────────────────────────────┐
  端口（application）│ BrowserObservationPort  BrowserScenarioCapturePort            │
                     │ ElectronObservationPort ElectronActiveObservationPort         │
                     │ JavaScriptRuntimeObservationPort  WebRuntimePort              │
                     └───────────┬───────────────┬───────────────────┬───────────────┘
                                 │               │                   │
        ┌────────────────────────┼───────────────┼───────────────────┼─────────────────────┐
        │ CDP 通道（被动观测）    │ Playwright 通道（受控重放）        │ V8 Inspector 通道    │
        │                        │               │                   │                     │
  CdpBrowserProvider        PlaywrightBrowser   V8InspectorProvider  │                     │
  CdpElectronProvider       ScenarioProvider    (JavaScriptRuntime   │                     │
  CdpWebRuntimeProvider     PlaywrightElectron   ObservationPort)    │                     │
        │                   ActiveProvider            │              │                     │
        ▼                        ▼                     ▼              │                     │
  CdpTargetSession.ts      PlaywrightScenario     V8Inspector         │                     │
   openCdpEndpoint          Browser.ts            Endpoint.ts         │                     │
   openCdpTargetSession      launcher.launch-     discoverV8Inspector │                     │
   attachCdpTargetSession    PersistentContext    │                   │                     │
   closeCdpTargetSession     / connectOverCDP     ├─ readCdpJson ◄────┴── 复用 browser 侧    │
        │                   │                     └─ parseCdpDiscoveryTargets   的 HTTP 发现  │
        ▼                   ▼                       │                                          │
  CdpConnection.ts    playwright-core 1.58.2        ▼                                          │
   (WebSocket, ws)    （自己的传输，不看 Cdp-  CdpConnection.ts（同一类，                        │
        │              Connection）                  maxPayloadBytes 换成 Inspector 常量）      │
        ▼                   ▼                        ▼                                          │
  目标：已在监听 CDP     目标：REA 自己启动的      目标：Node / Electron 主进程                    │
  的 Chrome/Chromium     Chromium（或连接用户      --inspect / --inspect=0                        │
  --remote-debugging-    已开 CDP 的浏览器）                                                    │
  port 端点                                                                                      │
```

（图为 ASCII 分层；节点名全部是正文或索引中的真实符号。）

### 1.1 CDP 通道：能做什么，前提是什么

能力面由 `CdpBrowserProvider` 的方法面直接给出（`src/browser/CdpBrowserProvider.ts Class：CdpBrowserProvider`，共 10 个公开方法）：

| 方法 | 偏移 | 落到的实现 | 页面结构/执行/事件/截图/webMCP |
|---|---|---|---|
| `listTargets` | +33 | `openCdpEndpoint`（同文件 `函数：withTargetSession 偏移：+17` 之外的调用点 `CdpBrowserProvider.ts`） | 目标枚举 |
| `inspectPage` | +82 | `#capture` → `capturePage` | 页面结构（DOM 快照 + 资源） |
| `analyzeBundle` | +94 | `IsolatedWebBundleAnalyzer` | JS bundle 语义 |
| `observeSession` | +169 | `observeCdpSession` | 事件/网络/存储等时间线 |
| `discoverWebMcpTools` | +190 | `discoverWebMcp` | **webMCP 工具发现** |
| `compareCaptures` | +211 | `compareBrowserCaptures`（domain 纯函数） | 离线比对，不开连接 |
| `captureScreenshot` | +223 | `captureCdpScreenshot` | 截图 |
| `compareScreenshots` | +246 | `comparePngScreenshots` | 离线 PNG diff |
| `close` | +4 | `#owner.close()` + `#bundleAnalyzer.close()` | 清理 |

「页面结构」的具体形状在 `capturePage`（`src/browser/CdpPageCapture.ts 函数：capturePage 偏移：+0`）与其下游 `CdpSnapshotNodes.ts` / `CdpSnapshotStrings.ts`；「执行」的活体归属在 `src/browser/execution/CdpWebRuntimeProvider.ts Class：CdpWebRuntimeProvider`（端口 `WebRuntimePort`，装配见 `src/composition/webRuntime.ts`）；「事件监听器」在 `src/browser/execution/CdpEventListeners.ts` 与 `CdpListenerSelector.ts`（本篇只定位文件，未逐行读，见已知缺口）。

前提（观察）：`webRuntimeCommandTimeoutSchema` 的 describe 文案把这条通道的性质写成「CDP WebSocket handshake and per-command response deadline」（`src/domain/browserDeadline.ts Const：webRuntimeCommandTimeoutSchema`）；`openCdpEndpoint` 的注释写「Discover one passive browser endpoint」，`CdpBrowserProvider` 的类注释写「Passive browser observation through a selected user-owned CDP endpoint」。**"passive" 与 "user-owned" 是源码用词**：目标浏览器必须已经在监听一个 REA 可达的 CDP 端点，REA 不启动它。目标浏览器如何被启动、该用什么命令行开关，**本篇源码中无相关字符串**（`grep -rn "remote-debugging" src/` 只命中两处文档性文案：`src/browser/PlaywrightElectronActiveFuses.ts` 注释、`src/domain/electron/electronFuses.ts` 提示语）——即 CDP 通道本身不校验、也不要求特定开关名。

### 1.2 V8 Inspector 通道

`src/inspector/` 只有 5 个非测试文件，可以逐个说：

| 文件 | 导出 | 作用 |
|---|---|---|
| `V8InspectorEndpoint.ts` | `discoverV8Inspector` | `/json/version` + `/json/list` 并发发现（`函数：discoverV8Inspector 偏移：+5` 的 `Promise.all`），版本校验用 `Const：versionSchema`（要求 `Browser`、`Protocol-Version` 必填，`V8-Version` 可选，`.passthrough()`） |
| `V8InspectorProvider.ts` | `V8InspectorProvider` | 端口实现，两个方法 `listTargets`（`src/inspector/V8InspectorProvider.ts 函数：listTargets 偏移：+0`）、`observe`；类注释是**能力契约**：「Attach-only provider; sends only `Runtime.enable` and `Debugger.enable`」（类注释，位于 `Class：V8InspectorProvider` 上方） |
| `V8InspectorCaptureProjection.ts` | 投影 | 把捕获状态投影成报告；`src/inspector/V8InspectorCaptureProjection.ts` 内投影出 `runtime_kind_authority` 字段 |
| `JavaScriptRuntimeScope.ts` | `throwIfRuntimeObservationCancelled` / `authorizeRuntimeLocation` / `projectReportedRuntimeUrl` / `authorizeRuntimeTargetLocation` | 取消检查点与**运行时位置授权**（origin/作用域判定，是本通道的安全边界所在） |
| `providerIdentity.ts` | `V8_INSPECTOR_PROVIDER_IDENTITY` | 身份常量（装配根用它报失败，见 11 篇 §2.3） |

与 CDP 通道的**复用程度很高**：`#observe` 直接用 `src/browser/CdpConnection.js` 的 `CdpConnection`，只把 payload 预算换成 Inspector 自己的常量 —— `src/inspector/V8InspectorProvider.ts 函数：#observe 偏移：+44` 处传 `{ maxPayloadBytes: INSPECTOR_MAX_PAYLOAD_BYTES }`，`Const：INSPECTOR_MAX_PAYLOAD_BYTES` = 16 MiB，另有 `Const：INSPECTOR_MAX_RETAINED_METADATA_BYTES` = 8 MiB。[推导] 这两个常量比 CDP 默认的 `WEB_RUNTIME_LIMITS.protocolBytes`（`src/browser/CdpConnection.ts 函数：connect 偏移：+15` 的兜底）大，是因为一次 runtime 观测要把全部脚本元数据一次性留在内存里。

目标前提：Inspector 通道连的是 **Node/Electron 的 V8 inspector**（`--inspect`），端口注释与 `PlaywrightElectronActiveFuses.ts` 的「`--inspect=0` or `--remote-debugging-port=0`」文案一致；`runtime` 字段从 `/json/version` 的 `Browser` / `Protocol-Version` / `V8-Version` 直接填（`src/inspector/V8InspectorEndpoint.ts 函数：discoverV8Inspector 偏移：+16~+20`）。

### 1.3 Playwright 通道（scenario 侧）

只有一条链：`PlaywrightBrowserScenarioProvider`（`src/browser/PlaywrightBrowserScenarioProvider.ts Class：PlaywrightBrowserScenarioProvider`）注入一个 session 工厂，工厂就是 `PlaywrightScenarioSession.open`（`src/browser/PlaywrightScenarioSession.ts Class：PlaywrightScenarioSession`、`函数：open 偏移：+0`）；装配回链 `src/composition/browserScenario.ts`。

session 之下是 `openPlaywrightScenarioBrowser`（`src/browser/PlaywrightScenarioBrowser.ts 函数：openPlaywrightScenarioBrowser 偏移：+0`），它有两种模式，源码里是显式分支：

- `scenario.browser.mode === "connect"` → `openAttachedScenarioBrowser`（同文件 `函数：openAttachedScenarioBrowser 偏移：+0`），偏移 `+18` 处调 `launcher.connectOverCDP(browserRequest.cdp_endpoint, ...)`，即**用户已开 CDP 的浏览器**；
- 否则 → `launcher.launchPersistentContext(profilePath, {...})`（偏移 `+31`），profile 目录由 `mkdtemp(join(tmpdir(), "rea-browser-scenario-"))` 创建并 `chmod 0o700`，参数逐项来自场景声明：`executablePath`、`headless`、`acceptDownloads: false`、`viewport`、`deviceScaleFactor`、`locale`、`timezoneId`、`colorScheme`、`reducedMotion`、`serviceWorkers`、`env: allowedBrowserEnvironment(environment)`（**环境变量白名单**），以及 `handleSIGHUP/SIGINT/SIGTERM: false`（信号交给 REA 自己）与 `timeout: commandTimeoutMs`。
- Android 专属分支（偏移 `+53`）：`process.platform === "android"` 时传 `["--no-sandbox", "--single-process"]`，注释原文解释 Termux 的 Chromium 无法通过 Android 的可执行边界创建 renderer 进程。[观察] 这是本族唯一一处 REA 主动关闭浏览器沙箱的代码。

`launcher` 类型被刻意收窄成两个方法：`type ScenarioBrowserLauncher = Pick<... "launchPersistentContext" ...>` 与 `readonly connectOverCDP: (...)`（`src/browser/PlaywrightScenarioBrowser.ts Type：ScenarioBrowserLauncher`），因此测试替身只能实现这两件事。

**能力面**（Playwright 独有、CDP 通道没有的）：逐步动作重放由 `performPlaywrightScenarioAction` 承担（`src/browser/PlaywrightScenarioActions.ts 函数：performPlaywrightScenarioAction 偏移：+0`）；步骤产物（截图/DOM/HAR）在 `PlaywrightScenarioArtifacts.ts`；事件与 console 在 `PlaywrightScenarioEvents.ts`；storage 与 service worker 各有 `PlaywrightScenarioStorage.ts` / `PlaywrightScenarioServiceWorkers.ts`；网络内容在 `src/browser/network/PlaywrightScenarioNetwork.ts` 与 `PlaywrightNetworkContent.ts`。

## 2 CDP provider 的形状：连接、超时、取消

### 2.1 一次操作的骨架

所有需要连目标的方法都收敛到同一个私有编排函数 `withTargetSession`（`src/browser/CdpBrowserProvider.ts 函数：withTargetSession 偏移：+0`），它是本族最重要的一个函数，七步（每步带锚点，偏移相对 `函数：withTargetSession 偏移：+0`）：

```
+14  const commandTimeoutMs = selectedCdpCommandTimeoutMs(input.command_timeout_ms)
+17  const endpoint = await openCdpEndpoint(input.cdp_endpoint, operation,
         options.signal, undefined, owner, commandTimeoutMs)
+29  const { target, allowedOrigins } = authorizeCdpTarget(endpoint.discovery, input, operation)
+40  targetSession = endpoint.connection === undefined
         ? openCdpTargetSession(discovery, target, ...)   // HTTP 发现 → 另开 page socket
         : attachCdpTargetSession(endpoint.connection, target, ...)  // 浏览器 socket 已开 → 扁平会话
+53  outcome = ok(await work({ connection, sessionId, discovery, target, input: scopedInput, signal, progress }))
+67  await closeCdpTargetSession(targetSession, CLEANUP_DOMAINS, options.signal, owner)
+86  cleanupFailure = (cause instanceof AnalysisError ? cause : new ProviderCleanupError("rea-cdp-browser", ...))
+97  if (outcome.ok && options.signal?.aborted === true) outcome = err(AnalysisCancelledError(...))
```

三个值得单独说的形状事实：

1. **`input` 类型被约束成四个字段**：`Pick<InspectWebPageInput, "cdp_endpoint" | "target_id" | "allowed_origins" | "command_timeout_ms">`（`函数：withTargetSession 偏移：+1~+6`）—— 任何新方法想复用这条骨架，必须暴露这四个字段，否则编译不过。
2. **owner 是 `CdpTargetSessionOwner`**（`src/browser/CdpBrowserProvider.ts Const：#owner`，来自 `CdpTargetSessionOwner.ts`，同文件还提供 `bindCdpTransportCleanup`）。socket 交给 owner 记账，因此「命令失败 + 清理也失败」时能保留资源归属；`CLEANUP_DOMAINS` 是一个 `as const` 数组（`src/browser/CdpBrowserProvider.ts Const：CLEANUP_DOMAINS`）＝ `["Network","Debugger","Runtime","Page","WebMCP"]`，即本族会**启用**的 CDP 域清单，清理时逐个 `.disable`。[推导] 这个清单就是 CDP 通道的协议面：五个域，没有 `DOM`/`Log`/`Emulation`。
3. **`close()` 用 `Promise.allSettled` 同时关 owner 与 analyzer**，单失败直接抛原错误、多失败合成一个 `ProviderCleanupError`（`operation` 硬编码为 `"analyze_web_bundle"`，`reason: "Browser transport and analyzer cleanup remain incomplete"`），并 `bindCleanupDependencies(typed)`（`函数：close 偏移：+4~+28`）。

### 2.2 三段式 deadline（消费侧）

定义都在 `src/domain/browserDeadline.ts`；11 篇/06 篇已介绍常量表，本篇给出**谁在什么时候用哪一段**：

| 阶段 | 值 | 谁选 | 消费锚点 |
|---|---|---|---|
| discovery（HTTP 或浏览器 socket 的发现文档） | `CDP_DISCOVERY_RESPONSE_TIMEOUT_MS = 10_000`，固定 | 不可选 | `src/browser/CdpTargetSession.ts 函数：openCdpEndpoint 偏移：+13`（`timeoutMs ?? CDP_DISCOVERY_RESPONSE_TIMEOUT_MS`）；`Const：CDP_DISCOVERY_RESPONSE_TIMEOUT_MS` |
| handshake | **discovery + 1000** | 派生，不可选 | 同文件 偏移 `+20`：`handshakeTimeoutMs: discoveryTimeoutMs + 1_000`，注释解释「多留 1 s 让卡住的 open 被标成 discovery 而不是 command_timeout_ms handshake」 |
| command / source-join | `command_timeout_ms`，默认 `DEFAULT_CDP_COMMAND_TIMEOUT_MS = 20_000`，上限 `MAX_BROWSER_DEADLINE_MS = 2_147_483_647` | 仅 `COMMAND_TIMEOUT_OPERATIONS` 9 个操作 | `openCdpEndpoint 偏移：+48`：发现成功后 `connection.selectCommandTimeout(commandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS)`；`src/browser/CdpConnection.ts 函数：selectCommandTimeout 偏移：+0` |
| cleanup grace | `CDP_CLEANUP_GRACE_MS = 5_000`，固定 | 不可选 | 文案侧 `Const：cdpCleanupGraceExpired`（`src/domain/browserDeadline.ts`）；实际清理用的是另一个 **1 s** 定时器：`src/browser/CdpTargetSession.ts 函数：cleanupCdpTargetCommands 偏移：+11`（`setTimeout(() => cleanup.abort(), 1_000)`） |

[观察] 最后一条是本篇发现的**不一致候选**：domain 侧的恢复文案说清理宽限是 5 000 ms，而 `cleanupCdpTargetCommands` 里写的是硬编码 `1_000`；两者是否服务于同一段清理，本篇无法从这两个文件确定（列 P1，见问题清单）。

`COMMAND_TIMEOUT_OPERATIONS`（`src/domain/browserDeadline.ts Const：COMMAND_TIMEOUT_OPERATIONS`）九个成员逐个是：`inspect_web_page`、`analyze_web_bundle`、`observe_web_session`、`observe_web_execution`、`inspect_web_event_listeners`、`discover_webmcp_tools`、`capture_web_screenshot`、`inspect_electron_page`、`capture_browser_scenario`。判据函数是 `cdpCommandTimeoutIsSelectable`，文案侧 `cdpCommandDeadlineRecovery`按 `selectable` 分两支：**不可选时 `userMessage` 与 `remediationAction` 写成同一句话**（`const fixed = noRuntimeOverrideSentence(...)` 后两个字段都填 `fixed`，`src/domain/browserDeadline.ts 函数：cdpCommandDeadlineRecovery 偏移：+8~+11`），且这句里不含「用 `--command-timeout-ms`」。[推导] 这是刻意的：不可选的操作不能 advertising 一个它没有的旋钮，与 `COMMAND_TIMEOUT_OPERATIONS` 上方的注释「Other CDP callers keep the same numeric deadline and must not advertise a setting they lack」一致。

三个阶段名枚举也在这里：`type CdpCommandDeadlinePhase = "handshake" | "command" | "source-join"`（`src/domain/browserDeadline.ts Type：CdpCommandDeadlinePhase`），`cdpDeadlineSubject`据此产出三条不同句子。"source-join" 是**被动脚本源收集与 source 关联阶段共用命令 deadline**（文案见 `Const：webRuntimeCommandTimeoutSchema` 里那句 "It also bounds passive script-source collection and the inspection/source-join phase"）。

### 2.3 传输层与 payload 预算

`CdpConnection`（`src/browser/CdpConnection.ts Class：CdpConnection`、`函数：connect 偏移：+0`）：

- `maxPayloadBytes` 默认取 `WEB_RUNTIME_LIMITS.protocolBytes`（偏移 `+15`），显式传入时校验「正安全整数且不大于 `MAX_WEBSOCKET_PAYLOAD_BYTES`」（偏移 `+20~+25`），并直接交给 ws 的 `maxPayload`（偏移 `+31`）。
- `commandTimeoutMs` 默认同样是 20 s（偏移 `+16`）。
- 超包的报错文案是字面事实：「CDP message exceeded the `N` byte protocol budget.」（`src/browser/CdpConnection.ts 函数：#transportError 偏移：+9`）。

发现层 `src/browser/CdpEndpoint.ts`：HTTP 发现要读**两个**文档 —— `Const：/json/version`（`函数：discoverCdpEndpoint 偏移：+6`）与 `/json/list`（偏移 `+11`）；文档注释「Per-response bounds for loopback CDP discovery documents. There is no runtime override.」 与 `readCdpJson` 的注释「Read one loopback CDP discovery document without redirects.」 共同说明**只读环回、不跟随重定向**。[未知] 「无重定向」具体由 `fetch` 选项还是手工判断实现，本篇未读到该函数体，未确认；`loopback` 是否等价于「拒绝非 127.0.0.1/::1 主机名」也未在 `CdpEndpoint.ts` 里读到显式主机名校验，列 P1。

`CdpWebSocketEndpoint`（`src/browser/CdpEndpoint.ts Type：CdpWebSocketEndpoint`）是端点的判别联合；`cdpTargetWebSocket`决定某个 target 用 page socket 还是浏览器 socket，返回值里的 `scope` 由 `openCdpTargetSession 偏移：+22` 消费：`scope === "page"` 时 `sessionId` 为 `undefined`（扁平会话不需要），否则再 `attachCdpTargetSession`。

### 2.4 取消如何传播

- 连接与会话层：`options.signal` 一路透传（`withTargetSession 偏移：+53` 把 signal 放进 `work` 的入参；`attachCdpTargetSession` 把它传给 `connection.send`）。
- **成功结果也可能被改成取消**：`withTargetSession 偏移：+97` —— `outcome.ok` 且 `signal.aborted` 时改写成 `AnalysisCancelledError`，并在有 `partialObservation` 回调时挂上部分观测（`inspectPage` / `analyzeBundle` 传了 `(captured) => captured.inspection`，见 `函数：#capture 偏移：+18`；`observeSession` / `discoverWebMcpTools` / `captureScreenshot` 都没传，因此这三个操作取消时**不产出 partialObservation**）。
- 清理不被取消杀死：`cleanupCdpTargetCommands` 用 `AbortSignal.any([cleanup.signal, signal])` 组合（偏移 `+8~+10`），并且注释写明「Cancellation skips optional domain shutdown but still releases the attached session using its independent, bounded cleanup signal」；`.disable` 与 `Target.detachFromTarget` 两处都 `catch {}` 空吞（偏移 `+19`、`+34`，注释「Best-effort ...; transport close is the definitive boundary」）。
- Playwright 侧另有一套：`withPlaywrightExecutionBoundary`（`src/browser/PlaywrightExecutionBoundary.ts 函数：withPlaywrightExecutionBoundary 偏移：+0`）把「超时 + 取消 + 同步抛出」统一收敛成一次 settle（`settled` 标志 + `cleanup()`），并且超时**用 `performance.now()` 绝对 deadline 反复重排**，每次 `Math.min(remaining, 2_147_483_647)`（偏移 `+26~+29`）以规避 Node 定时器溢出；定时器 `timer.unref()`。`timeoutMs <= 0` 直接 reject（偏移 `+7~+8`）。清理确认另有固定预算 `Const：PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS = 30_000`（`src/browser/PlaywrightExecutionBoundary.ts`，注释「Chrome shutdown can take several seconds; expiry bounds the response, not ownership」）。

## 3 JavaScript 侧：分析入口与 source map

### 3.1 分析函数与 worker 的关系

worker **进程**归 11 篇；本篇只讲它两侧的分析函数：

| 角色 | 文件 | 入口 |
|---|---|---|
| worker 服务端 | `src/javascript/analysis/JavaScriptAnalysisWorkerServer.ts` | `serveJavaScriptAnalysisWorker`，被装配根入口 `await` 调用 |
| 协议与默认值 | `src/javascript/analysis/JavaScriptAnalysisWorkerProtocol.ts` | `Const：JAVASCRIPT_ANALYSIS_WORKER_DEFAULTS`、`javaScriptWorkerRequestSchema`、`javaScriptWorkerAdmissionSchema`、`javaScriptWorkerMessageSchema`（`z.discriminatedUnion("kind", ...)`） |
| 客户端/宿主 | `src/javascript/analysis/JavaScriptAnalysisWorker.ts` | 与 worker 对话的类（11 篇引过它的 `Const：WORKER_HEAP_FLAGS_ENFORCED`） |
| 载荷与预算 | `src/javascript/analysis/JavaScriptAnalysisTransfer.ts` | `Const：JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES = 8 * 1024 * 1024`、`javaScriptTransferRetentionBytes`、`javaScriptTransferByteBudget`、`javaScriptTransferCeilingRemediation`、`writeJavaScriptAnalysisTransfer` |

`writeJavaScriptAnalysisTransfer` 上方的注释是所有权声明：「Complete-file coordinates authenticated before adopting any worker facts.」（`JavaScriptAnalysisTransfer.ts`）——[推导] worker 返回的事实**在宿主采纳之前**必须先与整文件坐标（摘要）对账，因此跨进程结果不是无条件可信。

bundle 分析走**另一套** worker：`src/browser/WebBundleAnalysisWorker.ts Class：WebBundleAnalysisWorker` 与 `WebBundleAnalysisWorkerProtocol.ts` / `WebBundleAnalysisWorkerServer.ts`，由 `IsolatedWebBundleAnalyzer`（`src/browser/IsolatedWebBundleAnalyzer.ts`）持有；堆是显式参数并有区间校验：`函数：WebBundleAnalysisWorker 偏移：+56`（`heapMb = DEFAULT_WEB_BUNDLE_HEAP_MB`）与 `+60~+65`（越界抛「Web analyzer heap must be an integer from ... MiB (max_heap_mb)」）。进程级内存上限同样回到 `javaScriptWorkerMemoryLimitBytes(this.heapMb)`。[观察] 它还从 worker 的 stderr/退出信息里**用正则识别堆耗尽**：`/heap out of memory|heap limit|allocation failed/iu` 并置 `heapExhaustion: true`；`getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed` 用于剩余容量估算。

### 3.2 source map / web source location：混淆位置映回源位置

三段，各有归属：

1. **取 map（在线）**：`src/browser/WebSourceMapFetcher.ts 函数：fetchWebSourceMaps 偏移：+0`，默认 host `{ fetch: globalThis.fetch }`（偏移 `+4`），并有**独立的** fetch 超时与响应预算：`Const：SOURCE_MAP_RESPONSE_BYTES = 64 * 1024 * 1024`，`fetchTimeoutMs` 来自 `input.source_map_fetch_timeout_ms`（偏移 `+23~+29`）。它的失败语义很特别，注释原文（位于 `函数：fetchWebSourceMaps` 上方）：「Source maps are normally fetched as a small part of a larger inspection. ... hitting either produces an explicit `fetch_failed` item, **never truncated data**」，`type FailedSourceMapStatus = "fetch_failed" | "invalid" | "policy_filtered"`。策略过滤发生在 `fetchOne`里：`if (!approvedUrl(request.fetchUrl, input.allowed_origins))`—— **origin 白名单在取 map 时仍然生效**，且重定向要用 `fetchFollowingApprovedRedirects`。
2. **解 map（离线/进程内）**：`src/javascript/sourceMaps/SourceMapDecoder.ts Class：SourceMapDecoder`（实现 `WebSourceMapPort`），预算文案在 `src/javascript/sourceMaps/SourceMapDecoder.ts 函数：#trace 偏移：+22`：「`<path>`: Source-map input exceeds the `N`-byte map or `M`-byte encoded request budget. ... Those budgets stay fixed.」（限额来自 `WEB_SOURCE_MAP_LIMITS.mapBytes` / `.outputBytes`），超时兜底 `input.decodeTimeoutMs ?? DEFAULT_WEB_SOURCE_MAP_DECODE_TIMEOUT_MS`。真正的解码被派给**子进程**：`SourceMapCodecProcess.ts` / `SourceMapCodecProtocol.ts`，进程身份串 `"source-map-decoder"`（`SourceMapDecoder.ts`）。
3. **位置映射**：`src/javascript/sourceMaps/TraceSourceMap.ts 函数：traceSourceMap 偏移：+0` 做逐点 trace（消费解码后的 map），产物形态在 `DecodedSourceMap.ts` / `SourceMapFormat.ts`；把「URL + 行列」解析成本地文件与偏移的落点是 `src/browser/assets/WebSourceLocationArtifacts.ts`（端口 `LocalWebSourceLocationArtifacts`），装配见 `src/composition/webSourceLocations.ts`：`createWebSourceLocationService` 一次绑 `LocalWebSourceLocationArtifacts()` + `new SourceMapDecoder({ environment })`，`src/application/WebSourceLocationService.ts Class：WebSourceLocationService` 的 `函数：trace 偏移：+0` 把两者串起来。

`Const：SOURCE_MAP_RESPONSE_BYTES` 还被复用作「已解析 source-map 身份」的表示预算（`WebSourceMapFetcher.ts` 的文案「Resolved source-map identities exceed the `64` MiB decoder representation budget」）与逐条累计判断。[观察] 同一个数字兼任三种预算（响应体、累计解析字节、身份表示），是本族「一个常量多处复用」的例子。

### 3.3 反编译/还原（外部引擎）

`src/javascript/recovery/` 是 `WakaruProvider` 一族（装配 `src/composition/javascriptRecovery.ts`，11 篇列为小工厂之一）：`WakaruCommand.ts` / `WakaruExecution.ts` / `WakaruRelease.ts` / `WakaruVersion.ts`（版本校验）/ `WakaruReport.ts` / `WakaruPublication.ts` / `RecoveryFiles.ts`（归属与清理）。本篇未逐行读（缺口）。

## 4 web network capture：四路解码与 mitmproxy 协议

### 4.1 归属与堆预算

`src/composition/webNetworkCaptures.ts 函数：createWebNetworkCaptureService 偏移：+0`一次构造四个 adapter（偏移 `+8~+11`）：

```
new NodeCaptureAdapter("har", environment, heap)
new NodeCaptureAdapter("saz", environment, heap)
new NodeCaptureAdapter("qlog", environment, heap)
new MitmproxyCaptureAdapter(environment)
```

堆来源在同函数偏移 `+4`：`const heap = runtimeCaptureDecoderHeap(environment, settings)`（`src/config/runtimeAnalysisSettings.ts`）。但**decoder 侧会优先复用 adapter 已解析的事实**：`src/browser/history/HistoricalCaptureDecoder.ts Class：HistoricalCaptureDecoder`，构造函数偏移 `+12`取 `sharedCaptureDecoderHeap(adapters)`，其注释原文：「Adapters that launch the Node decoder already carry its parsed heap. Reuse that fact. This environment is only the fallback when none do, or when those facts disagree.」——`sharedCaptureDecoderHeap` 本体在 `src/browser/history/HistoricalCaptureDecoder.ts 函数：sharedCaptureDecoderHeap 偏移：+0`。`NodeCaptureAdapter` 的对应注释（`src/browser/history/NodeCaptureAdapter.ts 函数：constructor 偏移：+0` 上方的构造入参注释）：「default heap, not ambient `process.env`. An invalid setting is refused. `heap` is an already parsed fact and is not read from `environment` again.」

`src/browser/history/NodeCaptureAdapter.ts 函数：command 偏移：+0`（class `NodeCaptureAdapter` 上的方法）产出 `--max-old-space-size=<oldGenerationMiB>`（`偏移：+17`），并且对非 HAR 格式有**硬性要求**（`偏移：+5~+12`）：「`<format>` decoding requires an enforced decoder memory limit. Run REA with Node.js on this host.」`src/browser/history/CaptureRelease.ts Const：NODE_CAPTURE_HEAP_ENFORCED` 与 `函数：captureDecoderProcessMemoryLimitBytes`、`Const：NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES` 给出进程级第二道预算。四个格式 provider 身份（`Const：HAR_CAPTURE_PROVIDER_IDENTITY`、`MITMPROXY_CAPTURE_PROVIDER_IDENTITY`、`SAZ_CAPTURE_PROVIDER_IDENTITY`、`QLOG_CAPTURE_PROVIDER_IDENTITY`）都在 `CaptureRelease.ts`。

三个 Node 侧纯解码函数：`decodeHarCapture`（`HarCapture.ts`）、`decodeSazCapture`（`SazCapture.ts`，**async**）、`decodeQlogCapture`（`QlogCapture.ts`）。SAZ 相关还有 `SazHttp.ts` / `SazMetadata.ts` / `SazProjection.ts`；qlog 用到 protobuf：`history/protobuf/` 由 `ProtobufCapture.ts` 的 `decodeCaptureProtobuf` / `prepareCaptureProtobuf` 暴露（由 `HistoricalCaptureDecoder.ts` 头部 import）。

**共享生命周期**在 `HistoricalCaptureDecoder`：请求/回复文件、私有运行根、owned 进程都归它，`OPERATION = "inspect_web_network_capture"`；运行根由构造参数注入且默认是 `PrivateRuntimeRoot.create({ prefix: "rea-web-capture-" })`（构造参数默认值，偏移 `+3~+5`）。子进程内部是 `src/browser/history/NodeCaptureProcess.ts`：请求路径与格式来自 `process.argv`（用 `z.enum(["har","saz","qlog"]).parse(process.argv[3])`），回复写回 `request.reply_path`，用 `writeFile(..., { flag: "wx", mode: 0o600 })`；超预算时替换成固定文案（「Capture reply exceeds the complete-evidence output budget. This release has no runtime override.」）。

### 4.2 mitmproxy：适配器与 Python 协议

`src/browser/history/MitmproxyCaptureAdapter.ts 函数：command 偏移：+0` 的准入是四件事，全部可锚定：
- `this.environment.REA_MITMDUMP_COMMAND`（偏移 `+4`）必须是**绝对路径**；
- `process.platform !== "linux"` 直接拒绝；
- `access(command, constants.R_OK | constants.X_OK)` + `stat().isFile()`（偏移 `+18~+23`），否则抛「Configured mitmdump executable is unavailable: `<path>`.」；
- 拒绝时的文案是 `Const：MITMDUMP_REQUIREMENT`（`src/browser/history/MitmproxyCaptureAdapter.ts`）：「Native capture decoding requires Linux and an absolute REA_MITMDUMP_COMMAND path to caller-supplied mitmdump 12.2.3; **HAR needs no external engine.**」

命令帧（偏移 `+32~+41`）：`["--no-server", "-q", "--set", "confdir=<runtimePath>", "--set", "rea_request_path=<requestPath>", "-s", <fileURLToPath(bridge/mitmproxy/capture.py)>]` —— **无服务器模式、静默、脚本随请求文件路径注入**。脚本路径由 `new URL("../../../bridge/mitmproxy/capture.py", import.meta.url)` 解析，因此打包后仍能定位。

`bridge/mitmproxy/capture.py` 的协议与生命周期（全部为 Python `def`/`class` 锚点）：

```
请求：一个 JSON 文件，路径来自 mitmproxy 自定义选项 rea_request_path
      （`bridge/mitmproxy/capture.py 函数：load 偏移：+0` 注册选项；`函数：running 偏移：+0` 读取）
      字段（由 decode/project_record 消费推断）：snapshot_path / sensitive_values / reply_path
回复：reply_path 上的一个 JSON 对象，两种形态：
      {"ok":true,"value":decode(...)} 或 failure_reply(error)
      序列化约束：ensure_ascii=True, allow_nan=False, separators=(",",":"), 编码为 ASCII
      字节预算：OUTPUT_BYTES = 96 * 1024 * 1024（`bridge/mitmproxy/capture.py Const：OUTPUT_BYTES`），超出即替换成
      {"ok":false,"reason":"limit","message":"Native reply exceeds the complete-evidence output budget.","pointer":""}
      finally 必做：ctx.master.shutdown()
```

资源限制在 `bridge/mitmproxy/capture.py 函数：running 偏移：+0` 里一次性设四条 `setrlimit`：`RLIMIT_AS = 768 MiB`、`RLIMIT_CPU = 30`、`RLIMIT_FSIZE = OUTPUT_BYTES`、`RLIMIT_CORE = 0`。因此 `MemoryError` 的回复文案是「Native decoder exhausted its 768 MiB address-space budget.」（`bridge/mitmproxy/capture.py 函数：failure_reply 偏移：+6~+7`）。[观察] `768` 这个数字在 Python 里以字面量出现两次（`setrlimit` 与文案），没有共享常量 —— 改预算要动两处（P2）。

版本门槛在 `bridge/mitmproxy/capture.py 函数：decode 偏移：+0`第一行：`if version.VERSION != PROFILE` → `CaptureFailure("unsupported", "Expected mitmproxy 12.2.3; observed <实际版本>.")`，`Const：PROFILE = "12.2.3"`（`bridge/mitmproxy/capture.py`）。这与 TS 侧 `MITMDUMP_REQUIREMENT` 里的「12.2.3」是两个独立副本（P2）。

记录解码：逐条 `tnetstring.load(reader)`（`from mitmproxy.io import tnetstring`），读句柄是 `bridge/mitmproxy/capture.py Class：BoundedReader`；每条记录带 `ordinal` 与 `location`（`{"kind":"byte-range","offset":start,"bytes":...}`），字段投影由 `bridge/mitmproxy/capture.py 函数：project_record 偏移：+0` 完成并接收 `request["sensitive_values"]` 做脱敏。三类失败被刻意分开：`RecursionError → "input-limit"`、`ValueError/IndexError/UnicodeError/EOFError → "format"`（消息带**字节偏移**）、非 dict → `"format"`；`CaptureFailure` 自身带 `reason / message / pointer` 三段（`bridge/mitmproxy/capture.py Class：CaptureFailure`、`函数：pointer 偏移：+0` 用来给 JSON Pointer 式定位）。URL/主机名校验在 Python 侧**重新实现**了一遍：`bridge/mitmproxy/capture.py 函数：authority_start 偏移：+0`、`ipv4_number`、`domain_parses`、`special_host_parses`、`without_userinfo`—— 用于把记录里的地址规范化并剥掉 userinfo（凭据）。[推导] 这些函数存在意味着 TS 侧的 redaction 不能假定 Python 传来的 URL 已经干净；两处各有一份 URL 语义，是本族最大的重复解释面（P1）。

## 5 只读与副作用边界

| 操作/组件 | 是否让目标**执行代码** | 证据 |
|---|---|---|
| `listTargets` / `compareCaptures` / `compareScreenshots` | 否（纯本地或纯发现） | `compareCaptures` 与 `compareScreenshots` 的 `withTargetSession` **一次都不出现**（`src/browser/CdpBrowserProvider.ts 函数：compareCaptures 偏移：+0~+10`、`函数：compareScreenshots 偏移：+0~+10` 直接调 domain 纯函数） |
| CDP `inspectPage` / `observeSession` / `captureScreenshot` / `discoverWebMcpTools` | **是，但机制不同** | 类注释自称 passive（`src/browser/CdpBrowserProvider.ts` 的类注释），但 `CLEANUP_DOMAINS` 含 `Runtime`、`Debugger`，意味着会话期间会启用 `Runtime.enable`（收到 `executionContextCreated` 等事件即目标侧活动）；`WebMCP` 域**不是标准 CDP 域**，发现工具需要向目标询问能力。[未知] `CdpWebMcpDiscovery.ts` 是否调用 `Runtime.evaluate`/`Runtime.callFunctionOn`，本篇未逐行读（P1，必须先证实再写「只读」） |
| `analyzeBundle` | 否（不在目标里跑） | 走 `IsolatedWebBundleAnalyzer` → `WebBundleAnalysisWorker` 子进程，与目标连接无关（`src/browser/CdpBrowserProvider.ts 函数：analyzeBundle 偏移：+0`，收尾 `finally { this.#bundleAnalyzer.releaseReservation(); }`） |
| Playwright scenario（`capture_browser_scenario`） | **是，最强** | `performPlaywrightScenarioAction`（点击/输入/导航）+ `PlaywrightScenarioEvents`（console/page 事件）+ `PlaywrightScenarioRequest.ts`（请求级）；浏览器由 REA 亲启（`launchPersistentContext`）或 `connectOverCDP` 附着 |
| V8 Inspector `observe` | 启用 `Runtime.enable` / `Debugger.enable`，**仅此两个命令** | 类注释「Attach-only provider; sends only `Runtime.enable` and `Debugger.enable`」（`V8InspectorProvider.ts`）—— 这是全族最明确的一条副作用上界声明 |
| `MitmproxyCaptureAdapter` / `HistoricalCaptureDecoder` | 否（离线文件解码） | `--no-server`（`MitmproxyCaptureAdapter.ts`）；`createWebNetworkCaptureService` 注释「without import-time reads, installation or process startup」 |
| `WebSourceMapFetcher` | 否（不执行 JS），但**会发网络请求** | `fetchOne` + `fetchFollowingApprovedRedirects`（`src/browser/WebSourceMapFetcher.ts 函数：fetchOne 偏移：+16~+25`），受 `allowed_origins` 约束 |

authority 对应关系（关键，别从名字推断）：

- **观察**：本族 provider 代码里**没有** Evidence `authority` 赋值（`grep -n "authority:" src/browser/ src/inspector/ src/electron/ src/javascript/` 非测试仅 1 处，且是 `runtime_kind_authority` 投影字段）。
- `controlled-replay` / `external-service` 的**声明点在 domain 层**：`src/domain/javascript/javascriptRuntimeReconciliationActive.ts`（`authority: "controlled-replay"`）、`src/domain/javascript/javascriptRuntimeReconciliationCaptureParsing.ts`（三处 `authority: "external-service"`，分别在 `函数：parseBrowserCapture 偏移：+12`、`函数：parseElectronCapture 偏移：+12`、`函数：parseV8Capture 偏移：+12`）、`src/domain/javascript/javascriptRuntimeReconciliationParsing.ts`（`authority: "shipped-artifact"`）。另有 `src/domain/javascript/javascriptApplicationGraph.ts` 用 `["passive-cdp-runtime", "controlled-replay"].includes(...)` 做过滤 —— 说明 **`"passive-cdp-runtime"` 是这一族实际使用的 kind 字符串**（P1：它的权威映射在哪里，需回 `evidenceBundle`/`reconstructionCoverage` 侧确认）。
- [推导] 因此「谁有副作用」不写在 provider 里，而是由**上层把观测归入哪个 kind/reconciliation 分支**决定：活体重放产物走 `controlled-replay`，外部引擎（Wakaru / mitmdump 之类）走 `external-service`，只读工件走 `shipped-artifact`。这条推断需要在 06/20 篇侧交叉验证，本篇不视为结论。

## 6 Electron：哪些是换 target，哪些是独立 provider

- **同一条 CDP 路径换 target**：`src/browser/CdpElectronProvider.ts Class：CdpElectronProvider`（实现 `ElectronObservationPort`）与 `CdpBrowserProvider` 用同一批文件：`CdpConnection` / `CdpEndpoint` / `CdpTargetSession` / `ElectronCaptureCleanup.ts` / `ElectronFileScope.ts`；能力方法是 `listTargets` 与 `inspectPage`，外面各包一层准入 `函数：#withAdmission 偏移：+0` 与目标授权 `函数：authorizeTarget 偏移：+0`；`close` 拆成 `close` 与 `#closeAfterOperations`，即**在途操作跑完才真正关**（对应 11 篇/13 篇的完成语义）。
  差异点：构造入参是 `runtimeAsarHeaderAdmission(environment, settings)`（`src/composition/electronObservation.ts 函数：createElectronObservationProvider 偏移：+0`），身份 `CDP_ELECTRON_PROVIDER_IDENTITY` 的 name 直说是「REA Electron **file-page** CDP observation provider」（`src/browser/providerIdentities.ts:19~+5`）—— 观测对象是 `file://` 页面。相关专文件：`CdpElectronInspection.ts`、`CdpElectronScripts.ts`、`CdpElectronScriptEvents.ts`、`CdpElectronWorkers.ts`、`CdpElectronScriptMetadata`（测试同名）。
- **独立的 Playwright 路径**：`PlaywrightElectronActiveProvider`（`src/browser/PlaywrightElectronActiveProvider.ts`）+ `PlaywrightElectronExecution.ts` + `PlaywrightElectronActiveActions/Fuses/Projection.ts`，端口 `ElectronActiveObservationPort`，装配 `src/composition/electronScenario.ts`，身份 `PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY`。它是「启动/附着 Electron 进程并操作」的一侧，与 CDP 被动观测不同层。
- **完全独立的 provider**：`src/electron/ElectronFuseProvider.ts` + `ElectronFuseReader.ts`（静态读二进制里的 fuse，端口面在 `src/domain/electron/electronFuses.ts`），不开运行时、不连 CDP。`src/domain/electron/electronFuses.ts` 的提示语反过来印证分工：fuse 状态**不能**证明应用是否用别的方式开启 Inspector。

## 7 边界与失败模式

| 触发 | 返回/表现 | 级别 | 锚点 |
|---|---|---|---|
| 可选观测端口加载失败 | 不抛；`err({ providerId, reason })` 与其它成功端口同时保留 | 观察 | `src/composition/optionalObservationProviders.ts 函数：loadPort 偏移：+4`（11 篇 §2.3） |
| 端点不可连 / 发现超时 | `BrowserObservationError(operation, ...)` 或 deadline 文案 `deadlineExpired` | 观察 | `withCdpDiscoveryDeadline`（`CdpEndpoint.ts`）+ `cdpCommandDeadlineRecovery`（`browserDeadline.ts`） |
| `command_timeout_ms` 给了非 9 个可选操作之一 | 数值仍生效（同 20 s/自定义值），但**不 advertise** 该旋钮；恢复文案变成「This release has no runtime override.」 | 观察 | `Const：COMMAND_TIMEOUT_OPERATIONS`、`cdpCommandDeadlineRecovery 偏移：+8~+11` |
| `Target.attachToTarget` 返回里没有非空 `sessionId` | `BrowserObservationError(operation, "protocol_error")` | 观察 | `src/browser/CdpTargetSession.ts 函数：attachedSessionId 偏移：+0` |
| 命令成功但信号已 abort | 改写为 `AnalysisCancelledError`，有 `partialObservation` 回调的操作才带部分观测 | 观察 | `withTargetSession 偏移：+97` |
| 清理失败（关 socket / disable 域） | 一律升级为 `ProviderCleanupError`（provider id 字符串**硬编码 `"rea-cdp-browser"`**）并 `bindCdpTransportCleanup`；无 typed 错误时抛 `AggregateError` | 观察 | `withTargetSession 偏移：+86`、`函数：failCdpOpenAfterCleanup 偏移：+0`（`CdpTargetSession.ts`）与 `combineOpenFailure` |
| 单条 CDP 消息超 payload 预算 | 文案含 `byte protocol budget`，会话被终止 | 观察 | `CdpConnection.ts` |
| 场景启动失败（无可执行文件等） | 建 `AnalysisCleanupLease` 删 profile 目录（`rm(..., {recursive,force,maxRetries:3})`）；若清理本身失败则 `retainCleanup?.(cleanup)` **保留归属**后再抛 | 观察 | `openPlaywrightScenarioBrowser 偏移：+43~+50` |
| Playwright 边界内 `timeoutMs <= 0` | 立即 `AnalysisTimeoutError(OPERATION, timeoutMs ?? 0)` | 观察 | `withPlaywrightExecutionBoundary 偏移：+7` |
| mitmproxy 平台/路径不符 | `AnalysisCapabilityUnavailableError("mitmproxy", OPERATION, MITMDUMP_REQUIREMENT)` | 观察 | `MitmproxyCaptureAdapter 函数：command 偏移：+10` |
| Node 侧格式（saz/qlog）在无强制内存上限的宿主 | 抛「`<format>` decoding requires an enforced decoder memory limit. Run REA with Node.js on this host.」；**har 不受此限** | 观察 | `NodeCaptureAdapter 函数：command 偏移：+5~+12` |
| 回复超预算 | Node：`reason: "limit"` 固定文案；Python：96 MiB 判定后替换同义回复 | 观察 | `src/browser/history/NodeCaptureProcess.ts 函数：main 偏移：+50`、`bridge/mitmproxy/capture.py 函数：running 偏移：+15~+16` |
| mitmproxy 版本不是 12.2.3 | `CaptureFailure("unsupported", "Expected mitmproxy 12.2.3; observed X.")` → 回复 `reason: "unsupported"` | 观察 | `bridge/mitmproxy/capture.py 函数：decode 偏移：+1~+2` |
| 版本不符（CDP 侧） | `discoverV8Inspector` 只要求 `Browser`/`Protocol-Version` 非空字符串；**没有**最低版本比较 | 观察（缺失本身是事实） | `src/inspector/V8InspectorEndpoint.ts Const：versionSchema` |
| `runtime_kind` 与目标实际类型不符 | `assertRuntimeKind(target, input.runtime_kind)` 在 `#observe` 中断言 | 观察 | `V8InspectorProvider 函数：#observe 偏移：+31~+32` |
| **未确定**：CDP 发现对非环回主机名是否硬拒 | 本篇未读到主机名校验代码 | `[未知]` | 需读 `CdpEndpoint.ts parseCdpEndpointValue`全体与 `src/domain/browserObservation.ts sanitizeBrowserUrl` |
| **未确定**：`CDP_CLEANUP_GRACE_MS = 5_000` 与清理里硬编码 `1_000` 的分工 | 两处都读到，但没有互相引用 | `[未知]` | `Const：CDP_CLEANUP_GRACE_MS` vs `cleanupCdpTargetCommands 偏移：+11` |

## 8 问题清单

**P1（会影响结论正确性，建议先查）**

1. `cleanupCdpTargetCommands` 的 1 s 定时器（`src/browser/CdpTargetSession.ts 函数：cleanupCdpTargetCommands 偏移：+11`）与 domain 面向用户承诺的 `CDP_CLEANUP_GRACE_MS = 5_000`（`src/domain/browserDeadline.ts Const：CDP_CLEANUP_GRACE_MS`）是否同一段清理？若不同，哪一处真的用 5 s？`grep -rn "CDP_CLEANUP_GRACE_MS" src/` 是判定入口。
2. `WebMCP` 出现在 `CLEANUP_DOMAINS`（`src/browser/CdpBrowserProvider.ts Const：CLEANUP_DOMAINS`），但 `WebMCP` 不是标准 CDP 域。`discoverWebMcp`（`src/browser/CdpWebMcpDiscovery.ts 函数：discoverWebMcp 偏移：+0`）到底发了什么命令（`Runtime.evaluate`？`WebMCP.*`？）决定「webMCP 工具发现」算不算让目标执行代码。**在证实之前，本篇不把它写成只读。**
3. URL 语义有**两份实现**：TS 侧 `sanitizeBrowserUrl` / `approvedUrl`，Python 侧 `bridge/mitmproxy/capture.py 函数：authority_start 偏移：+0`与同文件的 `without_userinfo` / `domain_parses` / `special_host_parses`。两份若判定不一致，就会出现「TS 认为已脱敏、Python 又还原出 userinfo」的静默泄露面。
4. CDP 通道的「passive」自我描述（`CdpBrowserProvider.ts` 上方注释）与 `Runtime`/`Debugger` 域被启用并存；「passive」在文档与用户话术里的承诺强度需要 maintainer 拍板（待拍板）。
5. provider 层完全不写 Evidence `authority`，副作用强度只在上层 kind/reconciliation 里体现（`src/domain/javascript/javascriptRuntimeReconciliationActive.ts`）。`"passive-cdp-runtime"`（`javascriptApplicationGraph.ts`）与 `controlled-replay` 的映射表在哪、由谁保证不漂移，未找到单点。

**P2（一致性/可维护性）**

1. mitmproxy 版本号 `12.2.3` 有两处副本：`bridge/mitmproxy/capture.py Const：PROFILE` 与 TS 侧 `src/browser/history/MitmproxyCaptureAdapter.ts Const：MITMDUMP_REQUIREMENT`，两者都是文件顶部的 `const`。
2. Python 侧 768 MiB 预算在 `函数：running 偏移：+2` 与 `函数：failure_reply 偏移：+7` 各写一次字面量。
3. `withTargetSession` 的清理分支里 provider id 写成裸字符串 `"rea-cdp-browser"`（`src/browser/CdpBrowserProvider.ts 函数：withTargetSession 偏移：+88`），而同文件 `close()` 用的是 `CDP_BROWSER_PROVIDER_IDENTITY.id`；11 篇 §2.3 明确说「用恒等常量以免漂移」，这里是一个例外。
4. `SOURCE_MAP_RESPONSE_BYTES` 一个常量兼任响应体、累计字节、身份表示三种预算（`WebSourceMapFetcher.ts`）。

**P3（体验/文案）**

1. 不可选 `command_timeout_ms` 的操作，`userMessage` 与 `remediationAction` 完全相同（`cdpCommandDeadlineRecovery 偏移：+8~+11`），调用方若分开展示会出现重复句子。
2. `analyzeBundle` 失败时 `ProviderCleanupError` 的 `operation` 固定为 `"analyze_web_bundle"`（`函数：close 偏移：+18`），即使真正失败的是 transport 清理。

**待拍板**

- 「Playwright 在 Android 下 `--no-sandbox`」（`openPlaywrightScenarioBrowser 偏移：+53`）是否要在 CLI/MCP 契约与用户文档里显式暴露为副作用。
- CDP 是否允许非环回端点（P1-未定项）——决定本篇 §1.1「前提」那一行最终写法。

## 9 已知缺口

1. **`src/browser/CdpCapture*.ts` 13 个文件与 `CdpSnapshot*.ts` 未读**：因此「页面结构/DOM 命名空间/事件体形状/存储指纹」四组细节只给了文件归属（`CdpCaptureDomNamespaces.ts`、`CdpCaptureEventBodyShapes.ts`、`CdpCaptureStorageFingerprints.ts`、`CdpSnapshotNodes.ts`），未给字段级结论。
2. **`CdpObservationSession.ts` / `CdpPageCapture.ts` / `CdpWebMcpDiscovery.ts` / `CdpScreenshot.ts` 只读签名行**（`observeCdpSession+0`、`capturePage+0`、`discoverWebMcp+0`、`captureCdpScreenshot+0`），内部命令序列未读；§5 表格里对应两行的执行代码判定因此带 `[未知]`。
3. **`src/javascript/analysis/` 的分析函数本体不在 `src/javascript/`**：该目录只有 worker/传输/schema，真正的 JS 语义分析实现（`analyze_javascript_application` 的生产者）本篇未定位到文件，属**明确缺口**；`grep -n "analyze_javascript_application" src/javascript/analysis/*.ts` 只命中 `JavaScriptAnalysisTransfer.ts` 的错误上下文。
4. **`src/javascript/sourceMaps/SourceMapCodecProcess.ts` / `SourceMapCodecProtocol.ts` 未读**：source-map 解码子进程的帧布局与堆参数未记录（00 篇要求 provider 族给「bridge 协议帧字节级布局」，本篇仅对 mitmproxy 通道做到了字段级）。
5. **`bridge/mitmproxy/capture.py 函数：project_record 偏移：+0~+117` 的主体（约 118 行）未逐行读**：只确认它接收 `sensitive_values` 并按字段投影，具体脱敏字段清单未验证。
6. `src/electron/` 的 fuse 读取（`ElectronFuseReader.ts`）与 `src/browser/history/Saz*.ts` / `protobuf/` 内部只做了存在性确认，未展开。
7. **全程未运行任何 provider**，所以所有「连接后行为」都是源码结论；`[假设]` 未使用，`[推导]` 共 7 处均可回源复核。

## 10 源码索引

以下行号均为 `grep -n` 实测（提交 `9541eb1f2`）。

- `src/browser/CdpBrowserProvider.ts:CdpBrowserProvider:98`
- `src/browser/CdpBrowserProvider.ts:CLEANUP_DOMAINS:89`
- `src/browser/CdpBrowserProvider.ts:withTargetSession:388`
- `src/browser/CdpConnection.ts:CdpConnection:44`
- `src/browser/CdpConnection.ts:connect:80`
- `src/browser/CdpConnection.ts:selectCommandTimeout:174`
- `src/browser/CdpEndpoint.ts:CdpWebSocketEndpoint:96`
- `src/browser/CdpEndpoint.ts:discoverCdpEndpoint:124`
- `src/browser/CdpEndpoint.ts:withCdpDiscoveryDeadline:178`
- `src/browser/CdpEndpoint.ts:discoverCdpBrowserSocket:233`
- `src/browser/CdpEndpoint.ts:cdpTargetWebSocket:337`
- `src/browser/CdpEndpoint.ts:parseCdpEndpointValue:365`
- `src/browser/CdpEndpoint.ts:readCdpJson:458`
- `src/browser/CdpTargetSession.ts:openCdpEndpoint:44`
- `src/browser/CdpTargetSession.ts:openCdpTargetSession:113`
- `src/browser/CdpTargetSession.ts:attachCdpTargetSession:151`
- `src/browser/CdpTargetSession.ts:failCdpOpenAfterCleanup:174`
- `src/browser/CdpTargetSession.ts:closeCdpTargetSession:206`
- `src/browser/CdpTargetSession.ts:cleanupCdpTargetCommands:222`
- `src/browser/CdpTargetSession.ts:attachedSessionId:270`
- `src/browser/CdpAuthorizedTarget.ts:authorizeCdpTarget:7`
- `src/browser/CdpObservationSession.ts:observeCdpSession:60`
- `src/browser/CdpWebMcpDiscovery.ts:discoverWebMcp:48`
- `src/browser/CdpScreenshot.ts:captureCdpScreenshot:43`
- `src/browser/CdpPageCapture.ts:capturePage:77`
- `src/browser/CdpElectronProvider.ts:CdpElectronProvider:51`
- `src/browser/CdpElectronProvider.ts:withAdmission:407`
- `src/browser/CdpElectronProvider.ts:authorizeTarget:433`
- `src/browser/PlaywrightBrowserScenarioProvider.ts:PlaywrightBrowserScenarioProvider:401`
- `src/browser/PlaywrightScenarioSession.ts:PlaywrightScenarioSession:78`
- `src/browser/PlaywrightScenarioSession.ts:open:144`
- `src/browser/PlaywrightScenarioBrowser.ts:ScenarioBrowserLauncher:666`
- `src/browser/PlaywrightScenarioBrowser.ts:openAttachedScenarioBrowser:681`
- `src/browser/PlaywrightScenarioBrowser.ts:openPlaywrightScenarioBrowser:816`
- `src/browser/PlaywrightScenarioBrowser.ts:launchPersistentContext:847`
- `src/browser/PlaywrightScenarioActions.ts:performPlaywrightScenarioAction:45`
- `src/browser/PlaywrightExecutionBoundary.ts:PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS:9`
- `src/browser/PlaywrightExecutionBoundary.ts:withPlaywrightExecutionBoundary:11`
- `src/browser/providerIdentities.ts:CDP_BROWSER_PROVIDER_IDENTITY:4`
- `src/browser/providerIdentities.ts:PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY:11`
- `src/browser/providerIdentities.ts:CDP_ELECTRON_PROVIDER_IDENTITY:19`
- `src/browser/providerIdentities.ts:PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY:26`
- `src/browser/WebSourceMapFetcher.ts:SOURCE_MAP_RESPONSE_BYTES:75`
- `src/browser/WebSourceMapFetcher.ts:fetchWebSourceMaps:102`
- `src/browser/WebSourceMapFetcher.ts:fetchOne:315`
- `src/browser/WebBundleAnalysisWorker.ts:WebBundleAnalysisWorker:120`
- `src/browser/execution/CdpWebRuntimeProvider.ts:CdpWebRuntimeProvider:37`
- `src/browser/history/HistoricalCaptureDecoder.ts:HistoricalCaptureDecoder:61`
- `src/browser/history/HistoricalCaptureDecoder.ts:sharedCaptureDecoderHeap:459`
- `src/browser/history/NodeCaptureAdapter.ts:NodeCaptureAdapter:19`
- `src/browser/history/NodeCaptureAdapter.ts:command:54`
- `src/browser/history/NodeCaptureProcess.ts:reply_path:9`
- `src/browser/history/MitmproxyCaptureAdapter.ts:MITMDUMP_REQUIREMENT:9`
- `src/browser/history/MitmproxyCaptureAdapter.ts:MitmproxyCaptureAdapter:13`
- `src/browser/history/MitmproxyCaptureAdapter.ts:command:17`
- `src/browser/history/MitmproxyCaptureAdapter.ts:capture.py:57`
- `src/browser/history/CaptureRelease.ts:HAR_CAPTURE_PROVIDER_IDENTITY:9`
- `src/browser/history/CaptureRelease.ts:NODE_CAPTURE_HEAP_ENFORCED:32`
- `src/browser/history/HarCapture.ts:decodeHarCapture:30`
- `src/browser/history/SazCapture.ts:decodeSazCapture:17`
- `src/browser/history/QlogCapture.ts:decodeQlogCapture:28`
- `src/inspector/V8InspectorProvider.ts:INSPECTOR_MAX_PAYLOAD_BYTES:134`
- `src/inspector/V8InspectorProvider.ts:V8InspectorProvider:170`
- `src/inspector/V8InspectorProvider.ts:listTargets:195`
- `src/inspector/V8InspectorProvider.ts:observe:325`
- `src/inspector/V8InspectorProvider.ts:observe:338`
- `src/inspector/V8InspectorProvider.ts:INSPECTOR_MAX_PAYLOAD_BYTES:382`
- `src/inspector/V8InspectorEndpoint.ts:versionSchema:13`
- `src/inspector/V8InspectorEndpoint.ts:discoverV8Inspector:36`
- `src/inspector/JavaScriptRuntimeScope.ts:throwIfRuntimeObservationCancelled:27`
- `src/inspector/JavaScriptRuntimeScope.ts:authorizeRuntimeLocation:52`
- `src/inspector/JavaScriptRuntimeScope.ts:projectReportedRuntimeUrl:77`
- `src/inspector/JavaScriptRuntimeScope.ts:authorizeRuntimeTargetLocation:109`
- `src/inspector/V8InspectorCaptureProjection.ts:runtime_kind_authority:181`
- `src/javascript/analysis/JavaScriptAnalysisWorkerProtocol.ts:JAVASCRIPT_ANALYSIS_WORKER_DEFAULTS:13`
- `src/javascript/analysis/JavaScriptAnalysisWorkerProtocol.ts:javaScriptWorkerMessageSchema:51`
- `src/javascript/analysis/JavaScriptAnalysisWorkerServer.ts:serveJavaScriptAnalysisWorker:67`
- `src/javascript/analysis/JavaScriptAnalysisTransfer.ts:JAVASCRIPT_ANALYSIS_TRANSFER_RECORD_BYTES:28`
- `src/javascript/analysis/JavaScriptAnalysisTransfer.ts:writeJavaScriptAnalysisTransfer:191`
- `src/javascript/sourceMaps/SourceMapDecoder.ts:SourceMapDecoder:35`
- `src/javascript/sourceMaps/TraceSourceMap.ts:traceSourceMap:29`
- `src/application/WebSourceLocationService.ts:WebSourceLocationService:70`
- `src/application/WebSourceLocationService.ts:trace:87`
- `src/domain/browserDeadline.ts:MAX_BROWSER_DEADLINE_MS:6`
- `src/domain/browserDeadline.ts:DEFAULT_CDP_COMMAND_TIMEOUT_MS:12`
- `src/domain/browserDeadline.ts:CDP_DISCOVERY_RESPONSE_TIMEOUT_MS:15`
- `src/domain/browserDeadline.ts:CDP_CLEANUP_GRACE_MS:18`
- `src/domain/browserDeadline.ts:webRuntimeCommandTimeoutSchema:60`
- `src/domain/browserDeadline.ts:CdpCommandDeadlinePhase:64`
- `src/domain/browserDeadline.ts:COMMAND_TIMEOUT_OPERATIONS:70`
- `src/domain/browserDeadline.ts:cdpCommandDeadlineRecovery:109`
- `src/domain/browserDeadline.ts:cdpCleanupGraceExpired:129`
- `src/domain/javascript/javascriptRuntimeReconciliationActive.ts:controlled-replay:33`
- `src/domain/javascript/javascriptRuntimeReconciliationCaptureParsing.ts:external-service:175`
- `src/domain/javascript/javascriptRuntimeReconciliationParsing.ts:shipped-artifact:61`
- `src/domain/javascript/javascriptApplicationGraph.ts:passive-cdp-runtime:239`
- `src/domain/electron/electronFuses.ts:inspector-hint:63`
- `src/composition/webNetworkCaptures.ts:createWebNetworkCaptureService:9`
- `src/composition/browserObservation.ts:createBrowserObservationProvider:5`
- `src/composition/electronObservation.ts:createElectronObservationProvider:7`
- `src/composition/javascriptRuntimeObservation.ts:createJavaScriptRuntimeObservationProvider:7`
- `src/composition/webSourceLocations.ts:createWebSourceLocationService:6`
- `bridge/mitmproxy/capture.py:CaptureFailure:25`
- `bridge/mitmproxy/capture.py:pointer:31`
- `bridge/mitmproxy/capture.py:BoundedReader:35`
- `bridge/mitmproxy/capture.py:authority_start:55`
- `bridge/mitmproxy/capture.py:without_userinfo:170`
- `bridge/mitmproxy/capture.py:project_record:207`
- `bridge/mitmproxy/capture.py:decode:325`
- `bridge/mitmproxy/capture.py:failure_reply:349`
- `bridge/mitmproxy/capture.py:OfflineCapture:358`
- `bridge/mitmproxy/capture.py:running:362`
- `package.json:playwright-core:371`

## 相关篇

[03 最小例子：一次全路径走读](03-最小例子-一次全路径走读.md) · [06 域层：Evidence 与错误代数](06-域层-Evidence与错误代数.md) · [11 Composition 层：生产装配根](11-Composition层-生产装配根.md) · [02 模块地图与依赖方向](02-模块地图与依赖方向.md) · [24 测试体系](24-测试体系.md)
