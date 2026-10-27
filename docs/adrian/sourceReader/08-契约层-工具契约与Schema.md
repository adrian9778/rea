# 08 · 契约层：工具契约与 Schema

> 定位：`src/contracts/` 是调用方可见的**工具契约声明层**——每个公开 MCP/CLI 工具一份 `ToolContract`（名字、说明、zod input/output schema、effects、annotations、examples），纯声明、被 CLI 与 MCP 两个适配器共同消费。它属于分层依赖里 `domain ← contracts ← provider ← application ← CLI/MCP` 的第二环；不要与 `src/domain/` 的语义 schema（Evidence、错误代数）混淆，也不要与 `src/server/register*.ts` 的注册动作混淆——注册在 server 层，契约只是它绑定的名字与类型。

实测基线：`src/contracts/` 非测试 `.ts` 共 12,698 行、23 个领域子目录、54 个根级非测试 `.ts`（与 02 篇 §2 修正后的口径一致）。

## 0 速览

1. 一份契约的字段集是封闭的：`ToolContract` 共 12 个字段（`name/title/description/kind/requiresActiveTarget?/inputSchema/outputSchema/effects/annotations/returnsTargetContent/examples`），见 `src/contracts/toolContractTypes.ts Type：ToolContract`；其中 title/effects/annotations/returnsTargetContent 四项由 `toolContractMetadata(name)` 按名字从审计表 `TOOL_EFFECTS` 自动生成，缺审计直接抛 `Missing effect audit for <name>`（`src/contracts/toolEffects.ts 函数：toolContractMetadata 偏移：+4`）。
2. 全量契约按数组聚合于 `TOOL_CONTRACTS`（`src/contracts/toolContracts.ts Const：TOOL_CONTRACTS`，45 个 spread 条目），注释自称「Complete ordered public inventory used by registration and verification」。
3. catalog 的**身份**（digest）与数组顺序无关：`src/catalogIdentity.ts 函数：sortByName`（偏移 +0~+5，按 Unicode 码点排序名字）先对契约排序再做投影与 sha256；handler 通过 `toolContract("字面量名字")` 按名解析绑定，不按位置选取。**观测到一处顺序依赖残留**：`toolContract` 用 `.find` 取首个同名项，若存在重名契约则数组顺序会决定选中哪一份——是否在装配边界强制「名字唯一」，当前源码未在同一文件内找到显式守卫（见 §2 与已知缺口）。[推导] 结合 AGENTS.md 的约束与 sortByName/按名绑定，可判定「catalog 顺序选中 operation/schema」在 digest 与 handler 绑定两条路径上均不成立。
4. 输出 schema 目录形态由环境变量 `REA_MCP_OUTPUT_SCHEMA_PROFILE`（`full`/`off`，默认 `full`）切换：`src/main.ts 函数：run 偏移：+9` 读 `fullOutputCatalog` 决定是否走 deferred 快速启动；`src/server/createServer.ts 函数：outputSchemasOmitted` 把 `off` 变成 `omitOutputSchemas`，`off` 时 `tools/list` 省略 `outputSchema`、但服务端仍按契约校验每个成功结果（文案见 `src/config/mcpOutputSchemaProfile.ts Const：profileConstraint 偏移：+1`——该常量是一条匿名字符串文案，绑定在 `profileConstraint` 这个名字上）。
5. 错误契约是单一判别联合：`src/contracts/errorSchemas.ts Const：analysisErrorProjectionSchema`（20 个 `code` 分支的 `z.discriminatedUnion("code", …)`），注释明确「Stable discriminated schema shared by every CLI and MCP error surface」，并与 `src/domain/analysisErrorProjection.ts` 的 `AnalysisErrorProjection` 类型通过 `as unknown as z.ZodType<AnalysisErrorProjection>` 强制对齐。
6. 契约层**不知道任何 provider 的实现**：对 `src/contracts/` 全目录 grep `from "../providers|from "../ghidra|from "../hopper|from "../ida|from "../jeb"`（排除测试）零命中；`kind` 字段（`TOOL_KINDS`，17 个适配器家族名）只是字符串标签，不产生反向依赖。

## 1 契约是什么：一份 ToolContract 的逐字段走读

### 1.1 字段定义

`src/contracts/toolContractTypes.ts` 共 70 行，定义了三个类型与一个常量：

- `Type：ToolAnnotations`（偏移 +0~+5）：`readOnlyHint/destructiveHint/idempotentHint/openWorldHint` 四个布尔，注释标为「Caller-visible MCP execution hints」，直接对应 MCP 工具 annotations。
- `Type：ToolExample`：`{ title, input }`，一条经过校验的示例请求。
- `Const：TOOL_KINDS`：17 个适配器家族（`official-proxy`、`enhanced`、`native-provider`…`session`），注释「Canonical adapter families responsible for public MCP tools」。
- `Type：ToolContract<Name, InputSchema, OutputSchema>`：泛型把 `name` 与两个 zod schema 的类型钉在每个契约实例上，供下游 `Extract` 精确取型。

注意：契约本身**不携带错误 schema 字段**。错误形态在全局层面由 `errorSchemas.ts` 统一（见 §4），而不是逐契约声明。

### 1.2 实例走读一：`inspect_apk_signature`（apkSignature 子目录）

`src/contracts/apkSignature/apkSignatureToolContracts.ts` 全文件只有 39 行、一个契约加一个聚合数组，正好呼应 03/04 篇走的那条链：

```ts
export const INSPECT_APK_SIGNATURE_CONTRACT = {
  name: "inspect_apk_signature",
  ...toolContractMetadata("inspect_apk_signature"),   // title/effects/annotations/returnsTargetContent
  kind: "artifact-provider",
  requiresActiveTarget: true,
  description: "Inspect declared v1/v2/v3/v3.1 APK signers, …",  // 长文，含能力边界与未验证声明
  inputSchema: inspectApkSignatureInputSchema,        // ← 来自 domain/apkSignature/apkSignatureQuery.js
  outputSchema: evidenceResultOf(z.union([apkSignatureResultSchema,
    apkSignatureSummaryViewResultSchema, apkSignaturePageViewResultSchema])),
  examples: [{ title: "Identify who signed an APK and under which schemes",
               input: { path: "/artifacts/app.apk" } }],
} as const satisfies ToolContract;
```

要点（锚点：`src/contracts/apkSignature/apkSignatureToolContracts.ts Const：INSPECT_APK_SIGNATURE_CONTRACT`）：

- input/output schema **不在 contracts 层造**，而是从 `../../domain/apkSignature/apkSignatureQuery.js`、`…/apkSignatureReport.js`、`../../domain/analysisView/analysisView.js` 导入——契约层的职责是「组合 + 元数据 + 交付形态」，语义仍归 domain。
- `evidenceResultOf`（`src/contracts/toolOutputSchemaPrimitives.ts 函数：evidenceResultOf 偏移：+0~+5`）把结果 schema 包进统一的 Evidence 信封；`analysisDetail` 的 complete/summary 双形态在输出侧用 `z.union` 表达（配合 `src/contracts/analysisDetail.ts 函数：analysisDetailOutputSchemaOf 偏移：+0~+6`）。
- description 里写明了「Content-digest equality is not cryptographic signature verification」这类**不可越级声明**，即契约文本本身就是事实分级载体。
- 聚合数组 `Const：APK_SIGNATURE_TOOL_CONTRACTS` 的注释「Keep the public catalog in its existing order, using its named contract」说明子目录数组的**拼接顺序只为可读性维护**，身份另有机制（§2）。

### 1.3 实例走读二：`official()` 工厂（official-proxy 家族）

`src/contracts/officialToolContracts.ts 函数：official 偏移：+0~+16` 是一个局部工厂：

```ts
const official = (name, description, inputSchema) => {
  const strictInputSchema = inputSchema.strict();
  return { name, ...toolContractMetadata(name), description,
    kind: "official-proxy", requiresActiveTarget: true,
    inputSchema: strictInputSchema,
    outputSchema: requireOutputSchema(officialOutputSchemas, name),
    examples: examplesFor(name, strictInputSchema) } …;
};
```

- 输入一律 `.strict()`：未知键在 schema 层即拒。
- 输出 schema 不在本文件写，而是按名字从 `officialOutputSchemas` 表查找，`requireOutputSchema`（`src/contracts/toolOutputSchemaPrimitives.ts 函数：requireOutputSchema`）查不到就抛——即「名字→输出 schema」是**查表而非按序**。
- `OFFICIAL_TOOL_CONTRACTS`（`src/contracts/officialToolContracts.ts Const：OFFICIAL_TOOL_CONTRACTS`，约 40 个条目）逐条给出名字、面向分析师的长 description、以及 `z.object({ document, address: optionalAddress })` 这类从 `src/contracts/toolContractHelpers.ts` 复用的公共字段（`document`/`address`/`procedure` 都带 `.describe(...)`，见同文件 `函数：document` 偏移 +0~+6）。
- 文件尾 `src/contracts/officialToolContracts.ts Type：OfficialToolName` 把全部官方 operation 名收成一个联合类型，供下游穷举检查。

## 2 注册与聚合：从 TOOL_CONTRACTS 到 tools/list

```
src/contracts/<domain>/*.ts ──导出 <X>_TOOL_CONTRACTS──┐
src/contracts/officialToolContracts.ts 等根文件 ────────┤
                                                       ▼
                          src/contracts/toolContracts.ts  Const：TOOL_CONTRACTS   （数组 spread，46 段）
                                     │                    │
                     按名解析 toolContract("name")         │ 全量投影
                                     ▼                    ▼
        src/server/register<域>Tools.ts（每域一个）      src/catalogIdentity.ts
          contract = toolContract(...) → server.registerTool(        函数：sortByName ↓
              contract.name, registrationOptions(contract),          函数：createToolCatalog ↓
              handler(contract))                                     函数：createCatalogDigests → tools_sha256
                                     │                                 函数：createCatalogIdentity
                                     ▼
                  EvidenceMcpServerCore.registerTool（compact 输入改写）
                                     ▼
                  MCP SDK Server → tools/list（声明）+ tools/call（校验与交付）
```

图里的 `<域>` 占位对应一组同构文件；以 sqlite 域为例，`src/server/registerSqliteTools.ts 函数：registerSqliteTools` 就是那个「按名取契约 → `server.registerTool`」的实体。

### 2.1 消费者清单

非测试代码里引用 `TOOL_CONTRACTS` 的模块（grep -l 实测）包括 `src/catalogIdentity.ts`、`src/mcpDoctor.ts`、`src/application/CapabilityInventory.ts`、`src/server/registerArtifactTools.ts`、`src/server/registerOfficialTools.ts`、`src/server/registerNativeTools.ts`、`src/server/registerManagedTools.ts`、`src/application/binary/BinarySession.ts` 等——聚合、体检（doctor）、能力清单、注册四条路径都从同一份数组出发。

### 2.2 catalog 组装（tools/list 的真值来源）

`src/catalogIdentity.ts`：

- `函数：sortByName`：对契约数组按 `compareUnicodeCodePoints(name)` 稳定排序；`Const：sortedToolContracts` 是 `TOOL_CONTRACTS` 的排序副本（偏移 +28~+29 处）。
- `函数：createToolCatalog`：投影每个契约的**客户端可见字段**为一个对象——`name/title/surface(=kind)/description/effects/returns_target_content/annotations/input_schema/output_schema`；注释明确「Every contract field that changes what a client receives belongs here」，包括 `returns_target_content`，否则旧服务器会与新 `_meta.provenance` 服务器误判 digest 对齐。input schema 走 `advertisedInputJsonSchema(contract)`，output schema 走 `toolOutputSchemaWithMetadata(contract)["~standard"].jsonSchema.output({ target: "draft-2020-12" })`。
- `函数：createCatalogDigests`：`canonicalize` + sha256 得 `tools_sha256 / prompts_sha256 / combined_sha256`，且把 `output_schema_profile` 一起入摘要（`digestCatalogs`，偏移 +37~+41：`{ output_schema_profile, catalog }`）——profile 不同则 digest 不同。
- `函数：createCatalogDigestProfiles`：一次性构建 full/compact × full/off 四组合的身份，注释「Build-time identities share schema conversion across the four supported profiles」。
- `Const：FULL_CATALOG_IDENTITY` / `DEFAULT_CATALOG_IDENTITY`：默认 full profile 的构建期身份，供启动期快速比对。

### 2.3 「catalog 顺序不得选中 operation/schema」的核查

- **digest 路径**：`createCatalogDigests`/`createCatalogIdentity` 消费的都是 `sortByName(contracts)` 的输出（`src/catalogIdentity.ts 函数：createCatalogDigests 偏移：+9`），数组拼接顺序不进摘要 → 顺序不影响 catalog 身份。观察。
- **handler 绑定路径**：注册文件全部按**字面量名字**取契约，例：`src/server/registerSqliteTools.ts 函数：registerSqliteTools 偏移：+7` `const contract = toolContract("inspect_sqlite_database")`，随后 `registerTool(contract.name, applicationToolRegistrationOptions(contract), handler(contract))` → 选哪个 operation/schema 由名字决定，与数组位置无关。观察。
- **例外/残留**：`src/contracts/toolContracts.ts 函数：toolContract 偏移：+5~+12` 用 `TOOL_CONTRACTS.find(candidate => candidate.name === name)`，若两个契约重名，**首个数组项胜出**。本轮 grep 未在 `toolContracts.ts`/`catalogIdentity.ts` 生产代码中找到显式的重名拒绝（存在 `src/contracts/tupleSchemaParity.test.ts` 等 parity 测试，是否在其中锁定名字唯一**未读取确认**）。[推导] 由于所有生产调用点传入的是编译期字面量，重名一旦引入会先被 `OfficialToolName`/`Extract` 类型或 doctor 的 digest 比对暴露，但「数组顺序选中重复 schema」这一路径在类型层面不是硬保证。→ 已列入问题清单 P2。
- **tools/list 的返回顺序**：由 MCP SDK 的注册顺序（各 `register<X>Tools` 调用序）决定，本轮未读 SDK 内部实现；不臆测（已知缺口）。

## 3 Schema 生成与压缩

### 3.1 zod → JSON Schema 的边界：toolSchemaMetadata.ts

`src/contracts/toolSchemaMetadata.ts`：

- `函数：advertisedInputJsonSchema`（偏移 +0~+4）：经 zod v4 的 `~standard.jsonSchema.input({ target: "draft-2020-12" })` 投影输入 schema——声明方言为 JSON Schema **draft-2020-12**（同文件第 93 行观测）。
- `函数：toolOutputSchemaWithMetadata` / `函数：toolInputSchemaWithMetadata`：在投影前后附加 `_meta` 类元数据（`PROPERTY_DESCRIPTIONS` 常量补公共属性描述）。
- `函数：transformAdvertisedInputJsonSchema`：对「已投影」的 schema 做再变换而**不重跑 zod 转换**，靠 `hasRelativeSchemaReference` 判断是否可安全改写，并用 `memoizeByTarget` 缓存——服务端校验始终用原 zod schema，压缩只发生在广告形态。注释：「Kimi expands schema-local references … Canonical server-side validation remains unchanged」（`src/contracts/compactInputSchema.ts` 文件头）。

### 3.2 压缩与呈现

- `src/contracts/compactInputSchema.ts`：
  - `Type：CompactInputSchemaPresentation`：`{ budgetBytes }` 一个字段；`Const：AdvertisedInputSchemaPresentation` 取 `"inline" | "reduced"` 两档。
  - `函数：compactAdvertisedInputSchema`：三步降级——①`stripAnnotations` 去纯注解键（`description/examples/default/title`，见 `Const：annotationKeys`）后引用内联展开、若在预算内则 `presentation: "inline"`；②超预算则 `reduceToShallowProperties` 收成浅层对象 `"reduced"`；③极端情况连浅层都放不下时，输出「描述 + REDUCED_ANNOTATION」的诚实空壳而不是超限 schema。另有 `COMPACT_SCHEMA_MAX_DEPTH` 与 `hasGatewayIncompatibleShape` 两道闸（Gemini 拒绝 `items` 与 type 列表并存等客户兼容事实写在注释里）。
  - `函数：presentAdvertisedInputSchema`：`presentation === undefined` 直通原 schema，否则走上面的压缩；被 `src/catalogIdentity.ts`（digest 前投影）与 `src/server/EvidenceMcpServerCore.ts`（注册前改写 `config.inputSchema`）两处消费。
- `src/contracts/inputSchemaPresentation.ts`：`函数：presentInputJsonSchema` 做**广告呈现层**归一：`normalizeAdvertisedSchema`（空 schema 补 JSON 全类型、枚举值类型推导）、`flattenRootObjectUnion`、`presentDiscriminatedRoot`（把判别式根 union 折叠成人类可读形态）、`preserveSharedDefault`。调用方为 `toolSchemaMetadata.ts`（grep 实测 `presentInputJsonSchema` 的非测试引用者只有该文件）。
- `src/contracts/jsonSchemaKeywords.ts`：四个集合常量 `Const：schemaMaps / schemaArrays / schemaChildren / schemaLiteralValues`——「哪里嵌着子 schema、哪里是实例字面量值」的方言词汇表，被 `compactInputSchema.ts` 与 `jsonSchemaReferences.ts` 共同 import，是遍历 JSON Schema 树时的**唯一切片规则来源**。
- `src/contracts/jsonSchemaReferences.ts`：`Type：Dialect`（`"draft-07" | "draft-2020-12"`）+ `class JsonSchemaReferences`：先索引 `$id`/`$defs` 再解析本地引用（注释「Index resources before consumers resolve anything, so later duplicate IDs …」），`dialectOf` 按 `$schema` 关键字判定方言、默认 `draft-2020-12`。它是压缩前「引用展开/保留」的机制层。
- `src/contracts/enhancedInputs.ts`：`Const：enhancedInputSchemas` 一张「名字 → zod 输入 schema」的表（`trace_native_values`、`analyze_function`、`batch_decompile` 等约 15 项），注释「Input schemas shared by MCP registration and enhanced application dispatch」——enhanced 家族把输入形状放这里复用；`Type：EnhancedToolName` 收名。注意注释里的一条边界：`analyze_function` 的 provider 输入**刻意排除** `detail` 字段，「delivery detail belongs to the MCP tool contract」——即同一工具在 CLI/provider 边界与 MCP 广告边界上的输入 schema 是两份，投递选项不污染 provider 协议。
- `src/contracts/analysisDetail.ts`：三个交付档位常量。`Const：analysisDetailSchema` 默认 `"complete"`；`Const：analysisDetailSummaryDefaultSchema` 默认 `"summary"`（注释给出理由：完整 native dossier 可达数 MB，token 预算上默认从简）；`函数：analysisDetailOutputSchemaOf` 把「complete Evidence ∪ summary 视图」包成输出 schema。

### 3.3 REA_MCP_OUTPUT_SCHEMA_PROFILE 的上下行

- 配置定义在 contracts 层之外：`src/config/mcpOutputSchemaProfile.ts Const：mcpOutputSchemaProfileSchema`（`z.enum(["full","off"])`）与 `函数：parseMcpOutputSchemaProfile`；`src/config/mcpOutputSchemaProfile.ts Const：profileConstraint 偏移：+1`（第 14 行的匿名字符串常量）写明 off 语义（原文为英文，此处中译）：「tools/list 省略 output schemas，但 REA 仍按 canonical 契约校验每个成功结果并返回完整 structured content」——**off 只改广告形态，不改服务端校验**。观察。
- 往上（启动路径）：`src/main.ts 函数：run` 读 `environment.REA_MCP_OUTPUT_SCHEMA_PROFILE`，`Const：fullOutputCatalog`（偏移 +9~+10）为 false（即 `off`）时**不走** deferred 快速启动分支，改走 `runEager`——因为 deferred 分支依赖与构建期录制 catalog（`RECORDED_MCP_CATALOG_SHA256`，`src/recordedMcpCatalog.ts`）比对，而录制的默认 profile 是 full。观察（分支条件逐列见 `src/main.ts 函数：run 偏移：+11~+16`）。
- 往下（服务路径）：`src/server/createServer.ts 函数：outputSchemasOmitted` 解析环境得 `omitOutputSchemas`（偏移 +452 处赋值点观测），传入 `EvidenceMcpServer` 构造函数并选择 `createCatalogIdentity(compactPresentation, omitOutputSchemas ? "off" : "full")`（偏移 +432~+434、+530 两处调用点观测）；`src/server/EvidenceMcpServerCore.ts` 把 `omitOutputSchemas` 交给 `ErrorEvidenceTransport`（`函数：connect` 偏移 +0~+7 观测），在**出网报文层**省略输出 schema；`registerTool` 覆写则用 `compactPresentation` 在注册前改写输入 schema（观察）。
- 姊妹开关：`REA_MCP_INPUT_SCHEMA_PROFILE`（`src/config/mcpInputSchemaProfile.ts Const：COMPACT_INPUT_SCHEMA_BUDGET_BYTES`），`src/server/createServer.ts 函数：selectCompactInputSchemaPresentation` 消费——目录形态实为 2×2 四组合，`createCatalogDigestProfiles` 逐一预计算。
- server 侧身份比对：`src/serverIdentity.ts 函数：createServerIdentity` 把客户端上报的 `catalog_digest` 与本地 `catalog.digests.combined_sha256` 比较，不一致给出 `catalog_digest_mismatch` 原因（偏移 +36~+40）——profile 选错的服务器会在握手时被判不对齐，这是「catalog 真值」的第二道闸。观察。

## 4 错误契约

- `src/contracts/errorSchemas.ts Const：analysisErrorProjectionSchema`：`z.discriminatedUnion("code", …)`，19 个 `generic(code)` 分支 + 1 个带结构化 `details` 的 `artifact_integrity_mismatch` 分支（sha256 对 / md5 对两种 `z.union`）。每个分支共享 `Const：common`（`category` 十值枚举、`message`、`retryable`、`remediation.action`、可选 `recovery`——recovery schema 来自 domain 的 `analysisErrorRecovery.js`）。
- 与 domain 的 tagged error 对应关系：文件尾 `as unknown as z.ZodType<AnalysisErrorProjection>`（偏移 +81）把 schema 类型**强制锚定**到 `src/domain/analysisErrorProjection.ts` 的 `AnalysisErrorProjection`。[推导] 这是单向的「schema ⊆ 域类型」断言：域类型新增 code 而 schema 未补，编译期即红；反向（schema 有、类型无）由同一断言的 `unknown as` 转换掩盖，只能靠测试兜底（本轮未读对应测试，见缺口）。domain 侧的映射函数群（如 reason→code 表）在 `src/domain/analysisErrorProjection.ts` 内（观测到 `函数：projectError` 类出口与 `Record<BrowserObservationError["reason"], AnalysisErrorProjection["code"]>` 映射表存在）。
- CLI 外壳：`Const：analysisCliErrorEnvelopeSchema`（偏移 +85~+105）用 `superRefine` 把「CLI label + 输入诊断」拆掉后，剩余部分必须能通过 canonical 投影 schema——即 CLI 错误信封**内嵌而非替代** MCP 错误形态，注释「Stable discriminated schema shared by every CLI and MCP error surface」。
- 文档投影：`Const：analysisErrorJsonSchema`（偏移 +112）= `z.toJSONSchema(analysisErrorProjectionSchema)`，供生成的 API 文档与客户端。
- 「SDK 转换后按声明方言校验」的证据有四处：①`src/contracts/toolSchemaMetadata.ts` 的 `~standard.jsonSchema` 转换显式钉 `target: "draft-2020-12"`；②`src/contracts/jsonSchemaReferences.ts` 携带 `Dialect` 类型并按 `$schema` 判定 draft-07/draft-2020-12；③`src/contracts/compactInputSchema.ts` 文件头与 `inlineWithinBudget` 注释记录真实客户端（Kimi/Gemini）兼容行为、并声明「the compact catalog test fails if a tool would advertise this presentation」；④**测试侧真的把 SDK 产物喂给方言校验器**——`src/contracts/canonicalBase64Metadata.test.ts` 把 input/output 投影分别交给 `Ajv2020`（draft-2020-12）与 `Ajv`（draft-07）`compile()`，再用三个样例把 Ajv 判定与 `safeParse` 判定逐例对齐；`src/contracts/pythonPycDeliveryContracts.test.ts`、`javascriptRouteDeliveryContracts.test.ts`、`erlangBeamDeliveryContracts.test.ts`、`tupleSchemaParity.test.ts` 则直接断言 `ajv.validateSchema(projected) === true`，即官方 meta-schema 校验。观察（实测计数：全仓 `validateSchema(` 调用点 86 处；`src/contracts/` 测试里 `"draft-2020-12"` 出现 38 次、`"draft-07"` 33 次）。→ 该条要求已被实现闭合，不再列为缺口。

## 5 示例与 advertised inputs：会不会带出敏感值/真实路径

- 示例来源一：契约文件内联 `examples` 字段（如 §1.2 的 `{ path: "/artifacts/app.apk" }`）。观察：apkSignature 与 `TOOL_EXAMPLE_OVERRIDES` 中出现的均为 `/artifacts/firmware.bin`、`0x1000`、`"main"` 这类**合成占位路径/地址**（`src/contracts/toolContractExamples.ts Const：TOOL_EXAMPLE_OVERRIDES` 前 30 行实测），未见用户真实绝对路径或凭证形态字面值。
- 示例来源二：`函数：examplesFor`（`src/contracts/toolContractHelpers.ts` 偏移 +7~+16）：把 `TOOL_EXAMPLE_OVERRIDES[name] ?? {}` 过一遍 `inputSchema.parse`（**校验后才成为示例**），再包一层 `exampleInputSchema` 归一为 JSON 值——示例与 schema 的一致性在构造点就被 zod 锁住。
- 广告压缩与脱敏改写：`src/contracts/advertisedInputExamples.ts 函数：advertisedInputExamples`——遍历契约 examples，把内嵌的**完整 Evidence 记录**（能被 domain `evidenceSchema.safeParse` 通过且带 `evidence_id`/`normalized_result` 的对象）替换为同会话保留引用 `{ kind: "retained-evidence", evidence_id }`；若替换后不再能通过 input schema（只接受 inline Evidence 的工具），该示例**退出广告**但保留在契约与可执行测试里。文件头注释解释了动机：宿主每轮把 input schema 全量转发给模型，内嵌完整 Evidence 会重复上轮结果的字节。→ [推导] 该机制客观上防止了「示例携带整段目标内容/Evidence 文本进目录」；去重靠 `JSON.stringify` 作键（观察）。调用方：`toolSchemaMetadata.ts`（grep 实测唯一非测试消费者）。
- `src/contracts/investigationExamples.ts`：在**模块加载期**真实调用 `parseFunctionEvidence`/`compareFunctions`/`parseProcessCapture` 构建 `Const：FUNCTION_COMPARISON_EVIDENCE` 等示例 Evidence（偏移 +11~+40），失败即 `throw`（fail-closed，注释「Canonical examples for contracts whose required inputs have no defaults」在 `toolContractExamples.ts`）；其输入是 `functionComparisonExample.js` 等 domain 级合成样例。观察：这些示例最终经 `advertisedInputExamples` 的引用替换再进广告。
- 目标内容标记与示例无关但同属交付安全：`src/contracts/toolEffects.ts Const：TARGET_CONTENT_FREE_TOOLS`（偏移 +787~+791）只豁免 4 个审计过的工具，`函数：toolReturnsTargetContent` 对未知名字一律返回 true——「未审计的新工具默认带 untrusted 标记」，与示例机制构成两道独立防线。观察。

## 6 双适配器共用：CLI 侧消费点

同一份契约文件被 CLI 直接 import（grep `src/cli` 非测试命中，锚点即结论）：

- `src/cli/options.ts` 偏移 +12~+13：import `analysisProviderSelectorSchema`（`contracts/providerSelection.ts`）——CLI 选项校验复用契约 schema。
- `src/cli/utilityCommands.ts` 偏移 +24：`swiftSymbolsSchema`（`contracts/native/nativeToolContracts.ts`）。
- `src/cli/managedCommands.ts` 偏移 +19：`managedMembersInputSchema`；`src/cli/nativeFunctionMatchingCommands.ts` 偏移 +5：`matchNativeFunctionsInputSchema`；`src/cli/analysisViewCommands.ts` 偏移 +11：`sessionToolSchemas`；`src/cli/fridaCommands.ts` 偏移 +14~+15：`FRIDA_KEEPALIVE_INTERVAL_DESCRIPTION`（连 CLI 帮助文本都取自契约）与 `isValidFridaRemoteAddress`；`src/cli/sourceToBundleCommand.ts` 偏移 +7：`compareSourceToBundleCliInputSchema`（注意名字带 `Cli`，即契约层为 CLI 边界**单独派生**输入形状，与 MCP 广告形状并存不混用）。

MCP 侧消费即 §2 的 `toolContract(name)` + `registerTool`。CLI option 如何从 schema 生成旗标，细节归 10 篇。

## 7 契约与 provider 的绑定关系（依赖方向核查）

- grep 证据：`src/contracts/`（排除 `*.test.ts`）内 `from "../providers`、`from "../ghidra`、`from "../hopper`、`from "../ida`、`from "../jeb"` **零命中**（本轮实测）。契约层 import 的上游只有 `../domain/*` 与同目录兄弟文件（如 `apkSignatureToolContracts.ts` 的三行 domain import）。
- 契约对 provider 的全部感知是**字符串标签**：`kind: "artifact-provider"` 等 `TOOL_KINDS` 成员，以及 description 文本里对 provider 行为（Ghidra ephemeral DB、Hopper 1024 UTF-16 符号上限等）的如实描述。`outputSchema` 侧用 `providerCapability`（`toolOutputSchemaPrimitives.ts` 的判别联合）表达「能力是否可用」的事实形状，仍是纯数据声明。
- 反方向（provider 适配器 import contracts）大量存在：`src/server/registerSqliteTools.ts` 等注册文件、以及 `src/native/NativeMacOSProvider.ts`、`src/dotnet/ManagedStaticProvider.ts`、`src/ida/IdaInput.ts` 均引用 `TOOL_CONTRACTS`/契约 schema——符合 `domain ← contracts ← provider ← …`  inward 依赖。观察。

## 边界与失败模式

| 边界 | 行为 | 静默出错的方式 | 锚点 |
|---|---|---|---|
| 契约名缺 effects 审计 | `toolContractMetadata` 构造期即抛 `Missing effect audit for X` | 不会静默；但抛点在 import 期，表现为启动崩 | `src/contracts/toolEffects.ts 函数：toolContractMetadata 偏移：+3~+4` |
| 官方输出 schema 表缺名 | `requireOutputSchema` 抛 | 同上，import 期失败 | `src/contracts/toolOutputSchemaPrimitives.ts 函数：requireOutputSchema` |
| 重名契约 | `toolContract(name).find` 取数组首项 | 后注册的同名 operation 的 schema 被静默忽略（未见生产侧显式去重守卫） | `src/contracts/toolContracts.ts 函数：toolContract 偏移：+5~+12` |
| profile=off 被误读为「不校验」 | off 只省广告；服务端仍按契约校验 | 若未来有人拿 `tools/list` 输出形态推断校验强度会得出假结论 | `src/config/mcpOutputSchemaProfile.ts Const：mcpOutputSchemaProfileSchema 偏移：+7~+14` |
| compact 压缩破坏语义 | 三步降级 + `hasGatewayIncompatibleShape` + 引用感知遍历（`jsonSchemaReferences.ts` 注释：先索引后解析，后到重复 `$id` 不被误用） | 客户端（Kimi/Gemini）形状兼容靠测试锁，新客户端行为不在保证内 | `src/contracts/compactInputSchema.ts 函数：compactAdvertisedInputSchema 偏移：+1~+26` |
| 示例内嵌整段 Evidence | 广告层替换为 retained 引用；替换不过校验则该例退出广告 | 契约测试里仍有 inline 例；只看广告看不到完整输入形状 | `src/contracts/advertisedInputExamples.ts 函数：advertisedInputExamples 偏移：+12~+20` |
| 未审计新工具 | `toolReturnsTargetContent` 默认 true（保守） | 无：默认即安全；豁免需显式加入集合 | `src/contracts/toolEffects.ts 函数：toolReturnsTargetContent 偏移：+1` |
| catalog digest 漂移 | `serverIdentity` 比对 `catalog_digest_mismatch`；`mcpDoctor`/`recordedMcpCatalog` 用构建期录制 sha 判进程是否过期 | 录制 digest 缺失（`RECORDED_MCP_CATALOG_SHA256` 可为 undefined）时 deferred 路径自动退回 eager | `src/main.ts 函数：run 偏移：+11~+13` |

## 问题清单

- **P1**（影响正确性/信任，应尽快核实）
  - P1-1：契约名唯一性是否有装配期守卫？`toolContract` 的 `find` 允许重名共存且顺序取胜（`src/contracts/toolContracts.ts 函数：toolContract 偏移：+5`）。需读 `tupleSchemaParity.test.ts` 与 catalog 测试确认，若无守卫则补一个「名字集合大小 == 数组长度」断言是廉价修法。
- **P2**（设计缺口/文档-代码落差）
  - P2-1（复核后撤回）：AGENTS.md 要求 schema「validated after SDK conversion against their declared dialect and actual clients」。初稿把它记成「未见独立的 dialect meta-validation 步骤」，实测不成立：`src/contracts/pythonPycDeliveryContracts.test.ts`、`javascriptRouteDeliveryContracts.test.ts`、`erlangBeamDeliveryContracts.test.ts`、`tupleSchemaParity.test.ts`、`toolInputReferences.test.ts` 均以 `ajv.validateSchema(...)` 对投影产物做官方 meta-schema 断言，`canonicalBase64Metadata.test.ts` 进一步按 `target` 分别用 `Ajv2020`/`Ajv` 编译并把判定与 Zod 逐例对齐（见 §3 证据④）。锚点：`src/contracts/toolSchemaMetadata.ts 函数：toolOutputSchemaWithMetadata`、`src/contracts/compactInputSchema.ts 函数：inlineWithinBudget 偏移：+73`。残余可议项只有一个：meta-schema 断言集中在若干代表性契约的测试里，而非对全量 catalog 逐工具遍历——是否需要「全量遍历」属产品取舍，不是实现缺失。
  - P2-2：`errorSchemas.ts` 尾部的 `as unknown as z.ZodType<AnalysisErrorProjection>` 是断言不是校验；「schema 覆盖全部域 code」若靠测试维持，应点名该测试。锚点：`src/contracts/errorSchemas.ts Const：analysisErrorProjectionSchema 偏移：+43~+45`。
  - P2-3：`examplesFor` 对无 override 的工具用 `{}` parse 输入 schema——凡是**必填字段**的官方工具，这条 `{}` 路径只有在 schema 有默认值时才不抛；重名/漏 override 会 import 期抛，属正确 fail-closed，但把「示例库完整性」变成启动依赖。锚点：`src/contracts/toolContractHelpers.ts 函数：examplesFor 偏移：+3~+5`。
- **P3**（卫生/口径）
  - P3-1：`apkSignature/` 只有 1 个文件却单开目录，与 `jeb/`、`adb/` 等多文件目录不同粒度；注释已自解释（「Keep the public catalog in its existing order」），接受现状即可。
  - P3-2：`TOOL_CONTRACTS` 的 spread 顺序（46 段）与 `TOOL_KINDS` 顺序无对应关系，纯历史排布；建议注释指认「身份由 sortByName 保证」以止住读者误读。锚点：`src/contracts/toolContracts.ts Const：TOOL_CONTRACTS`。
- **待拍板**
  - D-1：deferred 快速启动仅在 `full` profile 且存在录制 digest 时启用（`src/main.ts 函数：run 偏移：+11~+16`）。`off` profile 用户失去 warm 启动路径是否有意为之？源码未注释原因。

## 已知缺口

1. 未读：`mcpDoctor.ts`/`application/Doctor.ts` 如何用 catalog digest 做运行期体检的细节；`recordedMcpCatalog.ts`/`recordedCatalogDigests.ts` 的录制生成流程（只观测了消费点）。
2. 未读：MCP SDK 内部 `tools/list` 响应的组装顺序与 `_meta` 处理——「返回顺序由注册顺序决定」仅为 [假设]，未读 SDK 源码不臆测。
3. 未验证：`tupleSchemaParity.test.ts`、`compactInputSchema.test.ts` 等测试是否恰好锁住了 P1-1（名字唯一）与 P2-2（error schema↔域类型全覆盖）；本轮预算内未读测试正文。
4. 未覆盖：23 个领域子目录中仅逐行读了 `apkSignature/`，`evm/wasm/jeb/…` 等其余 22 个目录只确认了聚合入口与文件名；各 `*Example.ts`（`analysisViewApiSurfaceExample.ts` 等）只看了 import 关系，未读内容。
5. 未查证：`REA_MCP_INPUT_SCHEMA_PROFILE` 取值集合（`full|compact`）与自定义预算值的解析细节，位于 `src/config/mcpInputSchemaProfile.ts`，本轮只观测其两个导出名。
6. 02 篇 §2 曾记 contracts「22 个子目录 + 82 个根文件」；本次按 `ls`/`find` 实测修正为 23 个领域子目录 + 54 个根级非测试 `.ts`，两篇现已一致。剩余口径差异只在「根文件是否计入测试/fixture」。

## 源码索引

- `src/contracts/toolContractTypes.ts:ToolContract:45`
- `src/contracts/toolContractTypes.ts:TOOL_KINDS:21`
- `src/contracts/toolContractTypes.ts:ToolAnnotations:7`
- `src/contracts/toolContracts.ts:TOOL_CONTRACTS:48`
- `src/contracts/toolContracts.ts:toolContract:97`
- `src/contracts/apkSignature/apkSignatureToolContracts.ts:INSPECT_APK_SIGNATURE_CONTRACT:13`
- `src/contracts/apkSignature/apkSignatureToolContracts.ts:APK_SIGNATURE_TOOL_CONTRACTS:37`
- `src/contracts/officialToolContracts.ts:official:25`
- `src/contracts/officialToolContracts.ts:OFFICIAL_TOOL_CONTRACTS:44`
- `src/contracts/officialToolContracts.ts:OfficialToolName:253`
- `src/contracts/toolEffects.ts:TARGET_CONTENT_FREE_TOOLS:787`
- `src/contracts/toolEffects.ts:toolReturnsTargetContent:799`
- `src/contracts/toolEffects.ts:toolContractMetadata:803`
- `src/contracts/errorSchemas.ts:analysisErrorProjectionSchema:38`
- `src/contracts/errorSchemas.ts:analysisCliErrorEnvelopeSchema:85`
- `src/contracts/errorSchemas.ts:analysisErrorJsonSchema:112`
- `src/contracts/toolOutputSchemaPrimitives.ts:evidenceResultOf:26`
- `src/contracts/toolOutputSchemaPrimitives.ts:requireOutputSchema:36`
- `src/contracts/toolSchemaMetadata.ts:toolInputSchemaWithMetadata:66`
- `src/contracts/toolSchemaMetadata.ts:advertisedInputJsonSchema:89`
- `src/contracts/toolSchemaMetadata.ts:toolOutputSchemaWithMetadata:97`
- `src/contracts/toolSchemaMetadata.ts:transformAdvertisedInputJsonSchema:127`
- `src/contracts/compactInputSchema.ts:CompactInputSchemaPresentation:49`
- `src/contracts/compactInputSchema.ts:compactAdvertisedInputSchema:620`
- `src/contracts/compactInputSchema.ts:presentAdvertisedInputSchema:652`
- `src/contracts/inputSchemaPresentation.ts:presentInputJsonSchema:572`
- `src/contracts/jsonSchemaKeywords.ts:schemaMaps:1`
- `src/contracts/jsonSchemaReferences.ts:JsonSchemaReferences:53`
- `src/contracts/analysisDetail.ts:analysisDetailSchema:6`
- `src/contracts/analysisDetail.ts:analysisDetailSummaryDefaultSchema:18`
- `src/contracts/analysisDetail.ts:analysisDetailOutputSchemaOf:30`
- `src/contracts/enhancedInputs.ts:enhancedInputSchemas:20`
- `src/contracts/enhancedInputs.ts:EnhancedToolName:80`
- `src/contracts/advertisedInputExamples.ts:advertisedInputExamples:61`
- `src/contracts/toolContractHelpers.ts:examplesFor:22`
- `src/contracts/toolContractExamples.ts:TOOL_EXAMPLE_OVERRIDES:12`
- `src/contracts/investigationExamples.ts:FUNCTION_COMPARISON_EVIDENCE:23`
- `src/catalogIdentity.ts:sortByName:27`
- `src/catalogIdentity.ts:createToolCatalog:42`
- `src/catalogIdentity.ts:presentToolCatalog:57`
- `src/catalogIdentity.ts:createCatalogDigests:117`
- `src/catalogIdentity.ts:createCatalogIdentity:157`
- `src/catalogIdentity.ts:FULL_CATALOG_IDENTITY:198`
- `src/config/mcpOutputSchemaProfile.ts:mcpOutputSchemaProfileSchema:7`
- `src/config/mcpOutputSchemaProfile.ts:parseMcpOutputSchemaProfile:17`
- `src/main.ts:run:89`
- `src/server/createServer.ts:outputSchemasOmitted:885`
- `src/server/registerSqliteTools.ts:registerSqliteTools:11`
- `src/server/EvidenceMcpServerCore.ts:bindTool:274`
- `src/serverIdentity.ts:createServerIdentity:28`
- `src/cli/options.ts:analysisProviderSelectorSchema:12`

## 相关篇

- 最小例子走读（apkSignature 链）→ [03 最小例子-一次全路径走读](03-最小例子-一次全路径走读.md)
- 请求到 Evidence 的主链路 → [04 主链路拆解-请求到Evidence](04-主链路拆解-请求到Evidence.md)
- 域层 Evidence 与错误代数（契约输出/错误 schema 的语义来源）→ [06 域层-Evidence与错误代数](06-域层-Evidence与错误代数.md)
- 制品身份与格式声明 → [07 域层-制品身份与格式声明](07-域层-制品身份与格式声明.md)
- 契约的交付与运行期校验 → [09 Server层-MCP适配器](09-Server层-MCP适配器.md)
- CLI 侧 option 生成与契约消费 → [10 CLI 层](10-CLI层-一次性命令适配器.md)
