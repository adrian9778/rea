# 18 · Managed 与语言元数据 Reader

> 一句话定位：`src/dotnet`、`src/il2cpp`、`src/go`、`src/rust`、`src/python`、`src/erlang`、`src/wasm`、`src/evm`、`src/gpu`、`src/model`、`src/flutter` 这十一批目录是「**制品字节 → 结构化事实**」的本地 reader 族，属于 provider 适配层；本篇讲它们**内部解析什么、边界在哪、怎么失败**。**边界澄清**：这批 provider 在装配层怎么被挂上、返回什么 service 类型，见 [11 篇 §2.4](11-Composition层-生产装配根.md)（本篇不重复装配结论，只回链）；Ghidra/Hopper 引擎内部见 [15 篇](15-深度Provider-Hopper与Ghidra.md)；本族产出的 Evidence 语义本体见 [06 篇](06-域层-Evidence与错误代数.md)（注：06 篇尚未产出，见文末「相关篇」）。

**版本基线**：`src/` 未变，文档提交 `9541eb1f2`。所有行号类事实按当前工作区源码实测。

---

## 0 速览

1. **族定义性共同点是「解析入口吃字节，不吃引擎会话」**：`src/dotnet/ManagedStaticProvider.ts` 函数：ManagedStaticProvider 的类注释写作 "Execution-free managed PE/CLI auxiliary provider"，`src/composition/go.ts` 函数：createGoBinaryService 上方注释写作 "Compose bundled offline inspection without acquiring a toolchain or starting any process"，`src/composition/model.ts` 函数：createModelArtifactService 写作 "Construct the local reader without acquiring files, processes or network resources"。但**本族内部分三档**：9 个目录真的零进程零写（dotnet/il2cpp/go/rust/python/erlang/gpu/model/flutter），wasm 要调用外部 wabt 可执行文件、evm 要在 `prlimit` 下起一个受限子进程跑自带 evmole，见 §5.1。`[推导]`
2. **dotnet 族 33 个文件只有一个地址解释权**：RVA → 文件偏移全部走 `src/dotnet/ManagedPeReader.ts` 函数：resolveRva 偏移：+17 那一处（注释原文 "VirtualSize owns RVA containment; raw size also includes alignment padding"），并且会主动拒绝跨节重叠映射。
3. **本族没有统一的错误代数**：dotnet 用 `ManagedReaderFailure`，erlang 用 `ArtifactReaderFailure`，go/rust 共享 `BinaryFormatFailure`/`BinaryResourceFailure`，python 有 `PythonPycFormatFailure`/`PythonPycResourceFailure`，rust 另有 `RustAuditableFormatFailure`/`RustAuditableResourceFailure`，model 有 `ModelFormatFailure`，gpu 走 `ArtifactReaderFailure`。分级只靠各目录内部约定，跨目录不通用。`[推导]`（各类型定义处见 §7）
4. **「保留部分事实」在 dotnet 里有显式二档**：`managedMetadataFailureStatus` 把 issue 分成 `"partial"`（资源上限、不支持的元数据布局 ⇒ 元数据「未知」）与 `"malformed"`（格式坏 ⇒ 输入失败），见 `src/dotnet/ManagedReaderFailure.ts` 函数：managedMetadataFailureStatus 偏移：+3；`resource-limit`/`unsupported-metadata` 被明确注释为 "leaves metadata unknown, not malformed"。
5. **`xxxHostSupported` 只服务「需要外部可执行文件或 OS 资源边界的主机」**：grep 全 `src`（排除 `*.test.ts`）得到 7 个定义点——`evmHostSupported`、`wakaruHostSupported`（都要求 Linux x64）、`tsharkHostSupported`/`firmwareHostSupported`（只要求 Linux）、`pcapCaptureHostSupported`（Linux 或 win32）、`sigrokHostSupported`、`pwntoolsHostSupported`。本族的纯字节 reader（dotnet/il2cpp/go/rust/python/erlang/gpu/model/flutter/wasm）**没有任何** `HostSupported` 符号——wasm 虽要外部 wabt 可执行文件，但它的可用性判定走「配置里的绝对路径 + `access(X_OK)`」而不是 host 判定（§6）。
6. **本族写文件的地方有三类，只有一类写用户指定的路径**：`src/il2cpp/Il2cppGhidraSeedWriter.ts` 写调用方给的绝对路径（"Atomic create-only publication"）；`src/wasm/WabtArtifactProvider.ts` 与 `src/evm/EvmoleInterfaceProvider.ts`、`src/flutter/FlutterBuildProvider.ts` 只往**自己的私有 runtime root** 写临时快照（`flag: "wx"`、mode `0o400`/`0o600`）；其余目录 `grep writeFile|mkdir` **零命中**。详见 §8。

---

## 1 共同骨架

本族每个 reader 都走同一条四段流水，差别只在第 2、3 段的格式知识：

```
  制品字节（Buffer / 磁盘文件快照）
        │
        ▼
  ┌───────────────────────────┐   格式声明：magic / header / container
  │ A. 容器与格式识别          │   例：MZ + PE signature（dotnet）
  │    readXxx(bytes)          │       FOR1 + BEAM tag（erlang）
  └───────────────────────────┘       ff20 476f 2062 7569 6c64 696e 663a（go）
        │  失败：格式类 failure（抛）
        ▼
  ┌───────────────────────────┐   元数据表：流目录 / chunk / section / 表行
  │ B. 元数据结构与边界校验    │   例：#~ root + stream headers（dotnet）
  │    每处读取都带 range 守卫  │       AtU8/Atom/ExpT/ImpT/FunT/Code（erlang）
  └───────────────────────────┘
        │  失败：resource/capacity 类 failure（带 budget）
        ▼
  ┌───────────────────────────┐   归一化：token/行 → 名字、类型、限制
  │ C. 语义化 inspection       │   例：ManagedArtifactInspection
  └───────────────────────────┘       ErlangBeam
        │
        ▼
  ┌───────────────────────────┐   createAnalysisExecution(result, PROVIDER, {
  │ D. Evidence 化（application│     limitations, subject, locations })
  │    层负责，不在本族内）     │   locations 由 reader 侧算出的 file-offset
  └───────────────────────────┘
        │
        ▼
   调用方（CLI / MCP adapter）拿到带溯源的 Evidence
```

**四个 owner 的分工**（本族内部只做 A~C）：

| 段 | owner | 代表锚点 |
|---|---|---|
| A 字节获取与快照 | `src/dotnet/ManagedSnapshot.ts`、`src/artifacts/ArtifactReader.ts` | `src/dotnet/ManagedStaticProvider.ts` 函数：execute 偏移：+34（`readManagedSnapshot` 调用点） |
| B 格式/边界 | 各目录自己的 `*Reader` / `*Parser` | `src/dotnet/ManagedPeReader.ts` 函数：readManagedPeLayout；`src/erlang/BeamParser.ts` 函数：parseErlangBeam |
| C 语义归一化 | `Managed*Inspector.ts` / `ErlangBeam` 产出 | `src/dotnet/ManagedArtifactInspector.ts`、`src/erlang/BeamProvider.ts` |
| D Evidence | application/provider 边界 | `src/dotnet/ManagedStaticProvider.ts` 函数：execute 偏移：+60（`createAnalysisExecution(...)`） |

**字节的来源在本族内部有三种，且互不通用**（`[推导]`，判据是各 provider 门面的 import 行）：

| 取字节方式 | 成员 | 证据 |
|---|---|---|
| 整块快照进 `Buffer`，走 `src/artifacts/readStableArtifact.ts` | erlang、go（`src/erlang/BeamProvider.ts` 第 2 行、`src/go/GoBinaryProvider.ts` 第 3 行 import `readStableArtifact`） | erlang/go 门面顶部 import 块 |
| 自研快照 + 身份三连（`readManagedSnapshot` / `hashManagedSource` / `verifyManagedSourceIdentity`），快照在 client 内复用 | dotnet | `src/dotnet/ManagedStaticProvider.ts` 函数：execute 偏移：+35 |
| 只开 `FileHandle` 读**有界头部**，不整块进内存 | model、gpu（两文件的第 1 行都 import `lstat, type FileHandle`；`src/model/SafetensorsHeader.ts` 函数：readSafetensorsHeader 是 `async`） | `src/model/ModelArtifactProvider.ts`、`src/gpu/GpuCodeObjectsProvider.ts` 顶部 import |

⇒ 本族对「输入是字节还是磁盘文件」确实**不统一**，`src/dotnet/ManagedSnapshot.ts` 是 dotnet 自己造的第三套（未逐行读，见已知缺口）。

**Evidence location 是 reader 侧算出来的**，不是 application 层猜的：`src/dotnet/ManagedStaticProvider.ts` 函数：managedLocations 偏移：+4 起，`pe.cli === null` 时退化成一个 `{ kind: "file-offset", offset: 0 }`，否则把 CLI header 的 `[header_offset, header_offset+header_size)` 与 Module/Assembly 行偏移逐个映射成 `file-offset` / `file-offset-range`（+22 之后的分支按结果形态分三路：`"pe" in result` / `"methods" in result` / 其余走 native boundary）。

---

## 2 逐层走读之一：dotnet（33 文件 / 10,557 行，最大）

### 2.1 入口：一个 operation 三分支

`ManagedStaticProvider` 是 `AnalysisProvider` 实现，`identity()` 返回 `MANAGED_STATIC_PROVIDER`（`src/domain/investigationProviders.ts`）。`execute` 的判定顺序（`src/dotnet/ManagedStaticProvider.ts` 函数：execute）：

- `operation === "health"` 直接 `ok(createAnalysisExecution(null, ...))`，不读文件。
- 不在 `MANAGED_TOOL_CONTRACTS` 里的 operation ⇒ `AnalysisCapabilityUnavailableError`（"Operation is not implemented by the managed static provider."）。
- `this.target.format !== "pe"` ⇒ `AnalysisUnsupportedTargetError`，注释明确区分二者：非 PE 目标「outside this operation's formats, not a missing provider capability」（函数：execute 偏移：+16）。

三个受支持的 operation 由 `inspectManagedOperation` 分派（`src/dotnet/ManagedStaticProvider.ts` 函数：inspectManagedOperation 偏移：+9）：`inspect_managed_members`（可带 `type_names` 过滤）、`inspect_managed_artifact`、其余走 native boundary 检查。输入校验用 `managedMembersInputSchema.parse` / `managedTargetInputSchema.parse`，即 **schema 校验发生在字节解析之前**。

字节快照有 client 生命周期内的复用：`#snapshotBytes` 一旦填充，后续 operation 只做 `hashManagedSource`（重新验证身份）而不重读文件（函数：execute 偏移：+33~+42）。

### 2.2 PE 容器与 CLI header

`src/dotnet/ManagedPeReader.ts` 函数：readManagedPeLayout 偏移：+1 起要求 MZ；`readCoffHeader` 读 `0x3c` 处的 PE 指针并校验 `0x00004550`；`readOptionalHeader` 只认 magic `0x010b`（pe32）/`0x020b`（pe32-plus），其它一律 "PE optional header magic is unsupported"。

CLI header 是 **数据目录第 15 项**（`directoryOffset + 14 * 8`，见 `src/dotnet/ManagedPeReader.ts` 函数：readCliDirectory 偏移：+32），并且把「目录不存在」与「目录存在但读不动」分开：返回类型 `CliDirectoryRead` 是三态 `"absent" | "present" | "unreadable"`（`ManagedPeLayout` 的 `cliDirectoryState` 字段也是这三态）。**这是一个「保留未知」的具体落点**：`unreadable` 会把 issue 存进 `cliIssue` 而不抛（函数：readManagedPeLayout 偏移：+16）。

`readCliHeader` 的硬约束：目录声明 size 小于 72 字节直接 `invalid-cli-header`；header 内自报的 `headerSize` 必须落在 `72..directory.size` 之间；metadata 目录 RVA/size 任一为 0 ⇒ "CLI metadata directory is absent"。ReadyToRun 判定靠读 managed-native-header 处的 4 字节 magic `0x00525452`（`RTR`），并由此派生两个口径：

- `managedCli32BitRequirement`：`32BITREQUIRED`/`32BITPREFERRED` 当作**一个两位字段**处理，只置 required ⇒ x86-only，两者都置 ⇒ 「平台中立但偏好 32 位」，只置 preferred ⇒ reserved、不约束（`src/dotnet/ManagedPeReader.ts` 函数：managedCli32BitRequirement 偏移：+3）。
- `managedCliIsMixedClrNative`：注释给出理由——"crossgen2 clears ILONLY on ReadyToRun output"，所以必须「ILONLY 为 0 **且** 没有 RTR 签名」才算混合 CLR/native。

### 2.3 RVA 映射：本族最严格的边界代码

`resolveRva`（`src/dotnet/ManagedPeReader.ts` 函数：resolveRva）做四件事，每件都对应一个 failure 消息：

1. RVA/size 必须是 safe integer、RVA ≤ `0xffffffff`、且不跨 4 GiB 边界。
2. 选节以 `virtualSize` 为准（raw size 含对齐填充）。
3. **重叠节直接拒绝**：遍历所有其它节，只要与请求区间相交就抛 "ambiguous overlapping PE section mappings"，注释还说明「未来的重叠也会终结唯一映射区间」——该逻辑同时用于 `rvaAvailableBytes` 的 `available` 收缩。
4. 虚拟区间必须有文件背书：`within > rawSize` 或 `size > rawSize - within` ⇒ "occupies virtual bytes without file-backed data"。

算术保护集中在两个小函数：`requireRange`（"leaves the artifact byte range"）与 `add`（"offset arithmetic overflowed"）。`[推导]` 这两处是全族少见的「把偏移溢出当独立 failure 消息」的做法。

### 2.4 metadata root、流表与 heaps

`src/dotnet/ManagedMetadataLayout.ts` 是元数据布局的唯一 owner：`Const：METADATA_TABLE_NAMES`（表名清单）、`MetadataTableLayout`/`ManagedMetadataLayout` 两个导出接口、`Const：CODED_INDEXES`（`CodedIndexName = keyof typeof CODED_INDEXES`）、入口 `函数：readManagedMetadataLayout`、行定位 `函数：metadataRowOffset`。流目录规则：

- 流名字必须「有界终止 + 可打印 ASCII」，否则 `invalid-stream` / `metadata.stream-name`（`src/dotnet/ManagedMetadataLayout.ts` 函数：readStreamName）。
- 流数量必须 `1..64`（函数：readMetadataStreams 偏移：+24，消息 "Metadata stream count is outside the admitted range"），重复流名 ⇒ `Duplicate metadata stream`（同函数 偏移：+39）。
- **必需流 vs 可选流是硬分的**：`#Strings` 与 `#GUID` 走 `requireStream`（缺失 ⇒ `missing-stream`，函数：requireStream 偏移：+9 "Required metadata stream ${name} is absent"）；`#Blob` 与 `#US` 是 `streams.get(...) ?? null`，接口字段类型 `MetadataStream | null`，两条注释分别写作 "Empty blob heaps may omit the stream; index zero remains the empty blob." 与 "Optional: assemblies without `ldstr` literals may omit #US."（`src/dotnet/ManagedMetadataLayout.ts` 函数：readManagedMetadataLayout 偏移：+50~+53）。
- **表流名接受 `#~` 与 `#-` 两种**：`src/dotnet/ManagedMetadataLayout.ts` 函数：readTablesHeader 偏移：+4 写作 `streamByName(streams, ["#~", "#-"])`，两者都缺才抛 `missing-stream` / `metadata.tables`（同函数 偏移：+8，消息原文 "Required metadata table stream #~ or #- is absent"）。`[推导]`（`#~`/`#-` 对应 sorted/unsorted 变体是 ECMA-335 常识，源码只给出「两者都接受」）
- `#JTD` 被识别为 **Minimal Edit-and-Continue** 元数据：置 `minimalDeltaOffset`，并给出限定消息 "Minimal Edit-and-Continue metadata (#JTD) requires its baseline and prior generations; standalone metadata identities and inventories are unknown."，另一条注释写作 "Runtime v9.0.0 MetadataReader recognizes #JTD before sizing references."（`src/dotnet/ManagedMetadataLayout.ts` 函数：readManagedMetadataLayout 偏移：+19~+28）⇒ **这是本族「不认识就不猜、直接标 unknown」的样板**。

heap 层在 `src/dotnet/ManagedMetadataHeaps.ts`，导出的是**通用原语**而非业务语义：`readManagedCompressedUnsigned`（ECMA-335 compressed unsigned）、`readMetadataString`、`readMetadataBlob`、`readMetadataUserString`、`readMetadataGuid`、`metadataToken` / `metadataTokenFact`、`metadataRowCursor`、`metadataCodedIndexCoordinate`、`decodeMetadataCodedIndex`、`sha256Bytes`。行宽（表行大小）由 `src/dotnet/ManagedMetadataRowSizes.ts` 单独持有，`src/dotnet/ManagedTypeNameDigests.ts`、`ManagedTypeNames.ts`、`ManagedTypeNesting.ts`、`ManagedTypeReferences.ts`、`ManagedUserStrings.ts` 分别把名字、嵌套、TypeRef、UserStrings 拆成独立 owner。

表行读取按语义分文件：`ManagedMetadataInventory.ts` + `ManagedMetadataInventoryRows.ts`（清单）、`ManagedMethodDefinitionRows.ts`、`ManagedMethodSpecs.ts`、`ManagedMemberRows.ts`、`ManagedExceptionRegionValidation.ts`（SEH 区域校验）、`ManagedMethodBodyReader.ts`（IL 方法体）、`ManagedMemberInstructionDecoder.ts`（694 行 IL 指令解码）、`ManagedDecodeBudget.ts`（解码预算）。**注意**：IL 指令解码在本族内完成，不需要外部反编译器。

`src/dotnet/ManagedNativeBoundaryInspector.ts` + `ManagedNativeBoundaryHelpers.ts` 是 P/Invoke 边界面，输出 `pinvoke_imports` 及其行偏移（`managedLocations` 第三分支消费）。

### 2.5 截断与 partial facts

dotnet 族的截断处理是「**每处读取都要求范围，越界即抛带 scope 的 `ManagedReaderFailure`**」，而不是「读到哪算哪」。真正的降级发生在 `readManagedValue`：`partial` 类 failure 会 `throw cause`（向上传播成资源上限），`malformed` 类 failure 则被 `issues.push(cause.issue)` 收下并返回 `undefined`，让**同批其它条目继续读**（`src/dotnet/ManagedReaderFailure.ts` 函数：readManagedValue 偏移：+7~+13）。配套的 `uniqueManagedParseIssues` 用于「同一 malformed 事实跨多个 facet 折叠去重但保留顺序」；`appendManagedParseIssues` 的注释是一条实测经验：不要用展开 `push(...list)`，「one argument per issue, which overflows the stack on large malformed inputs」。

`ManagedReaderFailure` 还能携带 `metadataHeader: ManagedMetadataHeaderFacts | null`（字段注释 "Header facts admitted before an unsupported table layout was identified"），即**在认出表布局失败之后仍保留 version + streamNames**——本族里最明确的「保留部分事实」结构。

---

## 3 逐层走读之二：erlang（3 文件 / 699 行，可读完）

`src/erlang/BeamParser.ts` 函数：parseErlangBeam 偏移：+6 起校验 FOR1 IFF 容器：前 4 字节必须是 `"FOR1"`，`u32(bytes,4)` 是 form size（必须 ≥ 4 且落在制品内），第 9..12 字节必须是 `"BEAM"`。chunk 遍历按 4 字节对齐推进，且**先判 `padded > formEnd` 再接受**（同函数 偏移：+30），所以尾部填充越界会整体失败而不是静默截断。

三条口径值得单独记：

1. **同名 chunk 取最后一次出现**：`payloads.set(name, ...)` 在循环里覆盖，注释原文 "OTP's loader replaces the selected payload on each matching chunk. Keep every occurrence above; decode the last occurrence of each name."——注意 `chunks` 数组保留**全部** occurrence（含各自 location 与 payload sha256），只有解码选最后一个。`[推导]`（覆盖行为由 Map.set 得出，OTP 语义由注释断言、本仓库不验证）
2. **原子表有两套编码**：`AtU8`（UTF-8）优先，legacy `Atom`（latin1）兜底；选择规则在 `useUtf8Atoms`，注释解释历史 OTP「AtU8 无 payload 时选 Atom」，因此**存在但为空的 AtU8 仍会走 UTF-8 路径并因缺 4 字节计数头而失败**（偏移：+48~+55）。
3. **OTP 28+ 的紧凑原子长度**：`parseAtoms` 读 `readInt32BE(0)`，负数即宣告 compact 编码并取绝对值当计数；`atomLength` 与 `compactUnsigned` 解 OTP 的 `u` tag，包含 size-of-size 分支，并在 `byteCountCode === 7` 时抛 "BEAM atom length encoding overflows."——注释给出理由（"unpack_varint rejects any value wider than SWord"）。`readCompactUnsignedBytes` 用 `9223372036854775807n` 做**有界 bigint 累加**，注释明确「REA 支持的 64 位运行目标 ⇒ 至多八字节」。

容量与失败分两类（都在 `ArtifactReaderFailure` 之下）：

- `BeamCapacityFailure`（`src/erlang/BeamParser.ts` 类注释 "The producing parser names its count allowance independently of diagnostic text"）带 `resource: "atoms" | "chunks" | "table-rows"` 与 `maximum`，构造时传 `{ boundary: "capacity" }`。
- 普通格式失败走 `fail()`，即 `new ArtifactReaderFailure("format", message)`。

表行预算是**跨三张表求和**的：`declaredRows("ExpT")+declaredRows("ImpT")+declaredRows("FunT") > MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS` 才抛（偏移：+61~+71），常量来自 `src/domain/erlang/beam.ts`。`FunT` 还有一个显式的「零字节 chunk ⇒ null，四字节零计数 ⇒ 已解码的空表」区分（偏移：+85~+88）。

输出侧固定带 `coverage: { status: "complete", examined_chunks, atoms }` 与两条 `limitations`（`Const：LIMITATIONS`，`src/erlang/BeamParser.ts`）：原文声明「不执行 BEAM 字节码、不 inflate LitT 字面量、不解 Attr/CInf 外部项载荷」「原子名是结构表条目，不认证编译器/模块校验和」。⇒ **erlang reader 的 coverage 只在「预算未超且没抛」时是 complete**；容量失败是抛异常而不是降级返回 partial coverage。`[推导]`

`src/erlang/BeamProvider.ts` 是本族的**磁盘文件型**入口（`BEAM_PROVIDER_IDENTITY`、类 `BeamProvider`），与 dotnet 的「先快照成 Buffer」路径不同，说明本族内部对「输入是字节还是磁盘文件」并不统一（见 §6 只读边界与已知缺口）。

---

## 4 il2cpp：与 dotnet 的关系，以及唯一的写点

`src/il2cpp/` 14 文件 / 4,947 行分两半：

- **GlobalMetadata 侧**（Il2CppMetadata 格式）：`Il2cppMetadataFormat.ts` 持有版本与宽度知识——`il2cppMetadataHeaderBytes(version)`、`il2cppIndexWidth(entries)`（按表项数决定索引宽度）、`il2cppMetadataRecordBytes(...)`；`Il2cppMetadataFile.ts`、`Il2cppMetadataMembers.ts` 读表；`Il2cppMetadataAdmission.ts` 提供 `createIl2cppMetadataAdmission` 与常量 `IL2CPP_GENERIC_INSTANCE_MINIMUM_BYTES`（值是 `JSON.stringify` 出来的字符串，说明它同时用于消息与阈值）。`Il2cppMetadataProvider.ts` 是 provider 门面。
- **二进制镜像侧**（`global-metadata.dat` 之外的 native image）：`Il2cppBinaryFormat.ts` 定义 `NativeImage` 与地址算术，导出 `isMapped`、`isZeroFilled`、`hasPointerArrayCoverage`、`isExecutable`、`readSlot`、`readPointer`（都是 `(image, address, size)` 形态的**映射守卫**），以及 `hexAddress`；`Il2cppBinaryTypes.ts` 有 `il2cppTypeKind(attributes)` 与 `IL2CPP_TYPE_KIND_MAX = 0x1e`、`isDefinitionTypeKind`；`Il2cppBinaryGenerics.ts` 有 `genericMethodLayouts(version)` 与 `GENERIC_TABLE_LIMIT = 0x1000000`；`Il2cppBinaryImage.ts` / `Il2cppBinaryRegistration.ts` 处理镜像与类型注册；`ElfRelocations.ts` 处理 ELF 重定位。

**与 dotnet 的关系**：二者是**同一目标（CLR 程序集）的两套元数据表示**——dotnet 读的是 ECMA-335 `#~` 表流，il2cpp 读的是 Unity 的 Il2CppMetadata/GlobalMetadata 二进制布局加 native image 指针校验。它们不共享解析代码：`src/il2cpp/` 没有 import `src/dotnet/`（grep `from "../dotnet` 无命中）；共享的是「先声明映射、再按映射读槽位」这类纪律。gcref 映射：`Il2cppBinaryRegistration.ts` 与 `Il2cppGhidraSeeds.ts` 是把符号/引用位置导出给下游的两处（见下一段与已知缺口）。

**为什么需要一个 Ghidra 侧协作者**：`src/il2cpp/Il2cppGhidraSeeds.ts` 导出 `ghidraDefaultBase`（根据输入挑默认基址）与 `il2cppGhidraSeeds`（把已解析的类型/方法/地址整理成 seed 记录）。Il2Cpp 的 native image 里「哪个地址是哪个方法」这类事实本地 reader 能给，但把符号灌进反编译器是 Ghidra 侧的动作，所以端口是 `Il2cppSeedWriterPort`（`src/application/il2cpp/Il2cppSeedWriterPort.ts`），本族只提供 writer 实现，引擎侧归 15 篇。装配上 `il2cpp.ts` 是 11 篇 §2.4 表里**唯一注入第二个协作者的小工厂**（回链：[11 篇 §2.4](11-Composition层-生产装配根.md)）。

---

## 5 各语言 reader 的口径差异（逐个给锚点）

| reader | 解析什么 | 主要符号锚点 | 外部依赖 |
|---|---|---|---|
| **dotnet** (`src/dotnet`, 33/10,557) | PE + CLI header + `#~` 元数据表流（流目录、heaps、coded index、行宽）、IL 方法体与指令、P/Invoke 边界 | `readManagedPeLayout 偏移：+0`；`src/dotnet/ManagedMetadataLayout.ts` 函数：readMetadataStreams；`src/dotnet/ManagedMetadataHeaps.ts` 函数：decodeMetadataCodedIndex；`src/dotnet/ManagedMethodBodyReader.ts` | 无 |
| **il2cpp** (14/4,947) | Il2Cpp GlobalMetadata（版本→头长度/索引宽度/记录长度）+ native image 映射校验 + 类型/方法命名 + Ghidra seed | `src/il2cpp/Il2cppMetadataFormat.ts` 函数：il2cppIndexWidth；`src/il2cpp/Il2cppBinaryFormat.ts` 函数：hasPointerArrayCoverage；`src/il2cpp/Il2cppBinaryTypes.ts` 函数：il2cppTypeKind | 无（写 seed 文件，见 §8） |
| **go** (4/1,080) | 不是 gopclntab：走 `readBinaryContainer` 拿 elf/pe/macho 容器身份，再按**内嵌 buildinfo magic** 搜索 `go` 版本串与模块文本 | `src/go/GoBinaryImage.ts` 函数：readGoBinaryImage 偏移：+1（`Const：MAGIC` 是其 hex 字面量）；`src/go/GoBuildInfoSearch.ts` 函数：goBuildInfoSearch 偏移：+7（ELF 段名 `.go.buildinfo`）偏移：+46（Mach-O 段名 `__go_buildinfo`）；`src/go/GoModuleText.ts` 函数：parseGoModuleBytes | 无 |
| **rust** (3/1,061) | 容器身份 + `.rustc`/auditable 依赖段（zlib 压缩的 JSONC）+ 从 `/rustc/<40hex>` 路径**推断** rustc commit | `src/rust/RustBinaryImage.ts` 函数：readRustBinaryImage 偏移：+1；`src/rust/RustAuditableReader.ts` 函数：readAuditableSection 偏移：+9；`Const：RUST_INFLATE_RATIO` | 无（用 `node:zlib` inflateSync 与 `jsonc-parser`） |
| **python** (5/2,632) | `.pyc` 头 + marshal 编译码对象（code/consts），字节码身份比较 | `src/python/PythonPycParser.ts 函数：parsePythonPyc 偏移：+12~+37`（头校验与 marshal 读取在同一体内）；`src/python/PythonPycProvider.ts Class：PythonPycProvider` | 无（`src/composition/pythonPyc.ts` 注释："without invoking CPython or writing files"） |
| **erlang** (3/699) | FOR1/BEAM IFF 容器、chunk 目录、AtU8/Atom 原子表（含 OTP 28 compact `u`）、ExpT/ImpT/FunT 表行、Code 头 | `parseErlangBeam 偏移：+2`；`src/erlang/BeamParser.ts` 函数：compactUnsigned；`src/erlang/BeamProvider.ts` | 无（`src/composition/erlang.ts` 注释："no Erlang installation or any child process"） |
| **wasm** (10/1,889) | WAT 文本与 wasm 模块接口面：由 **wabt** 产出物解析接口，另有 wasm glue 关联与接口预算 | `src/wasm/WabtInterface.ts` 函数：parseWabtInterface；`src/wasm/WabtWat.ts` 函数：watStringEnd；`src/wasm/WabtRuntime.ts` 类 `WabtRuntime`；`src/wasm/WasmGlueAdapter.ts` 函数：associateWasmGlue；`src/wasm/WabtArtifactProvider.ts` 类 `WabtArtifactProvider` | `[待确认→§5.1]` `WabtRuntime` 的运行方式（见已知缺口） |
| **evm** (8/1,789) | 字节码载体解码 + Solidity metadata section + 合约接口（函数/事件）投影；接口解析由 evmole 侧完成 | `src/evm/EvmBytecodeCarrier.ts` 函数：decodeEvmBytecodeCarrier；`src/evm/SolidityMetadata.ts` 函数：inspectSolidityMetadata；`src/evm/EvmoleInterfaceAdapter.ts` 函数：projectEvmoleFunctions；`src/evm/EvmoleInterfaceProvider.ts` 类 `EvmoleInterfaceProvider` | `[待确认→§5.1]` worker/子进程形态（见已知缺口） |
| **gpu** (14/3,319) | GPU code object 容器：AMD（bundle id / note / ELF processor flags / metadata JSON）、CUDA（fatbinary、`__CLANG_OFFLOAD_BUNDLE__`、`CCOB`）、PTX kernel、ELF kernel、LZ4 块解压 | `src/gpu/ClangOffloadBundle.ts 函数：readClangBundleDirectory、Const：CCOB_MAGIC`；`src/gpu/AmdGpuMetadata.ts` 函数：readAmdMetadata；`src/gpu/GpuElfKernels.ts` 函数：readGpuElfKernels；`src/gpu/PtxKernels.ts`；`src/gpu/Lz4Block.ts`；`src/gpu/GpuCodeObjectsProvider.ts` 类 `GpuCodeObjectsProvider` | 无外部工具；LZ4 由 `src/gpu/Lz4Block.ts` 自带实现 |
| **model** (6/1,635) | 模型制品头部：GGUF（KV 与 tensor 类型表）与 Safetensors（JSON header + dtype 位宽） | `src/model/GgufHeader.ts` 类 `GgufHeader`；`src/model/SafetensorsHeader.ts` 函数：readSafetensorsHeader、函数：safetensorsBits；`src/model/ModelTensorTypes.ts` 函数：ggmlType；`src/model/ModelHeaderReader.ts` 类 `ModelHeaderReader`；`src/model/ModelArtifactProvider.ts` 类 `ModelArtifactProvider` | 无 |
| **flutter** (6/2,835) | AOT ELF 镜像（ELF 头/符号/build-id/加载映射）+ Dart snapshot magic 与 hash 扫描 + payload 扫描 | `src/flutter/DartElf.ts` 函数：readElfHeader、`Const：DART_SNAPSHOT_MAGIC`；`src/flutter/FlutterPayloadScan.ts` 类 `SnapshotHashScanner`、类 `LabeledStringScanner`；`src/flutter/ElfBuildId.ts` 函数：readElfBuildIds；`src/flutter/ElfLoadMap.ts` 函数：createElfLoadMap；`src/flutter/FlutterBuildProvider.ts` 类 `FlutterBuildProvider` | 无 |

### 5.1 「不需要外部引擎」在本族的三个层次

`[推导]` 由 §5 表与下列锚点组合得出：

1. **纯字节 reader（无进程、无工具）**：dotnet、il2cpp（读侧）、go、rust、python、erlang、model、flutter、gpu。判据：入口是 `readXxx(bytes: Buffer)` / `readXxxAsync` + 只 import `node:*` 与 `src/` 内部。
2. **需要主机侧外部可执行文件**：evm（`src/evm/EvmoleInterfaceProvider.ts` 函数：evmHostSupported 偏移：+1 起按 `platform`/`arch` 判定；同文件 `Const：EVM_PRLIMIT_COMMAND_DEFAULT` = `/usr/bin/prlimit`；`evmLimiterAvailability` 是一个 async 探测）。
3. **需要 wabt 产出物**：wasm（`src/wasm/WabtRelease.ts` `Const：WABT_VERSION = "1.0.42"`、`WabtRuntime.ts` 类 `WabtRuntime`、`src/wasm/WabtFailures.ts` 函数：`wabtFailure` 与 `wabtConfigurationRecoveryAction` 存在「配置缺失 ⇒ 恢复动作」的分支）。⇒ **本篇任务书把 wasm/evm 归入「managed reader」时，「不需要外部引擎」这一条对这两个成员不成立**；它们更接近「本地 reader + 可执行后端」的混合，`WabtRuntime` 究竟是 in-process 还是子进程、以及 `EvmoleInterfaceWorker.ts` 用不用 `node:worker_threads`，见「已知缺口」。

---

## 6 host 支持判定

11 个 `*HostSupported` 定义点（grep `src` 排除 `*.test.ts`）分三种判据：

| 符号 | 签名形态 | 判据 | 消费点 |
|---|---|---|---|
| `evmHostSupported` | `(platform, arch)` | 平台 + CPU 架构白名单 | `src/evm/EvmoleInterfaceProvider.ts` 函数：evmHostSupported；同文件 函数：`createEvmoleInterfaceProvider`-like 工厂 偏移：+1 `if (!evmHostSupported(platform, arch)) return undefined`；provider 内 `execute` 再判一次 `process.platform/process.arch` |
| `wakaruHostSupported` | `(platform, arch)` | 平台 + 架构，并与「命令是否可获得」并列（`WakaruCommand.ts` 的 `!wakaruHostSupported(...) \|\| ...` 复合条件） | `src/javascript/recovery/WakaruCommand.ts` 函数：wakaruHostSupported；re-export 自 `src/composition/javascriptRecovery.ts` |
| `tsharkHostSupported` | `(platform: NodeJS.Platform)` | 只看平台 | `src/captures/TsharkCaptureProvider.ts` 函数：tsharkHostSupported；provider 内 `if (!tsharkHostSupported(this.platform))` |
| `sigrokHostSupported` / `firmwareHostSupported` / `pwntoolsHostSupported` / `pcapCaptureHostSupported` | 平台（pwntools 带 arch） | 平台（+arch） | `src/signals/SigrokRecordingProvider.ts`、`src/firmware/FirmwareCommand.ts`、`src/native/pwntools/PwntoolsDecoder.ts`、`src/domain/pcap/pcapAnalysis.ts` |

`[推导]` 共同规律：**`*HostSupported` 只判「这台主机的形状是否可能支持」，不判「工具装没装」**——装没装是在执行路径上另行判定（`WakaruCommand.ts` 把两者用 `||` 串在同一条件里；`firmwareHostSupported` 与 `wakaruHostSupported` 同形）。`createServer.ts` 一次性把它们汇成 capability 布尔表（`src/server/createServer.ts` 函数：`createServer` 内的 `packetCapture: tsharkHostSupported(platform)` 等连续 7 行），这是「能力广告」与「实际可用性」的分离点，细节归 09 篇。

本族纯字节 reader 之所以**没有** `HostSupported`：可用性不依赖主机形状，只依赖目标制品本身。

---

## 7 失败与降级：本族怎么「保留部分事实」

| 成员 | 格式类失败 | 资源/容量类失败 | partial 落点 |
|---|---|---|---|
| dotnet | `ManagedReaderFailure`，code 如 `invalid-directory`/`invalid-cli-header`/`invalid-stream`/`missing-stream`，带 `scope` 与可空 `offset` | `resource-limit`（同一 issue 代数） | `readManagedValue 偏移：+12` 收 issue 继续读；`ManagedMetadataHeaderFacts` 保住 version+streamNames；`cliDirectoryState="unreadable"` + `cliIssue` 保住「读不动但知道有」 |
| erlang | `ArtifactReaderFailure("format", msg)`（`fail()`） | `BeamCapacityFailure`（`{boundary:"capacity"}`，三类 resource） | `chunks` 保留全部 occurrence（含 sha256）即使某表为 null；`ExpT/ImpT/FunT` 缺失映射为 `null` 而非 0 行；`atom_encoding` 可为 null |
| go | `BinaryFormatFailure`（来自 `src/native/metadata/BinaryContainer.ts`） | `BinaryResourceFailure("search", MAX_HEADER_SEARCH_BYTES, ...)`（256 MiB 累计搜索预算） | `build_info: null` 是合法结果；`section_names_limitation` 字段专门把「段名覆盖不全」带出去（`GoBinaryImage` 接口注释："absence is not a language verdict"） |
| rust | `RustAuditableFormatFailure("malformed"\|"unsupported")` | `RustAuditableResourceFailure`，`constraint` 三档：`memory`/`transport`/`capacity`，各带 `reported_limits` | `auditable_metadata: null`；`rustc_commit` 是 **inferred** 且 `RustBinaryProvider.ts` 的 limitation 原文强调「不能单靠它证明是哪个编译器产出」 |
| python | `PythonPycFormatFailure` | `PythonPycResourceFailure` | 见 `src/python/PythonPyc.errors.ts`（2 个 failure 类定义点） |
| il2cpp | `Il2cppBinaryFormatFailure` + `src/il2cpp/Il2cppBinaryFormat.ts Const：IL2CPP_BINARY_FAILURE_REASONS`（把 reason 收成常量表） | 版本门槛 `Il2cppMetadataAdmission.ts` | 待补读（见已知缺口） |
| model | `ModelFormatFailure` + `rejectModel` / `rejectPickle` | `Const：MODEL_CAPACITY_LIMITS` + `modelCapacityRemediation`（每个上限配一句补救建议）+ `ModelReportBudget` | `rejectPickle` 存在 ⇒ pickle 载荷被**拒绝**而非尝试解析 |
| gpu | 待补 | 待补 | `CudaMetadataBudget` 类存在 ⇒ CUDA metadata 有独立预算 |

三个跨成员观察：

1. **失败语义都带「资源名 + 上限 + 人类可读消息」三元组**（`BeamCapacityFailure(resource, maximum, message)`、`BinaryResourceFailure("search", 256MiB, ...)`、`RustAuditableResourceFailure({resource, reported_limits}, message)`）——这是本族最一致的纪律。`[推导]`
2. **「不认识」和「坏掉」在部分成员里被显式区分**：rust 的 `kind: "malformed" | "unsupported"`、dotnet 的 `partial`/`malformed`、model 的 remediation 文案；而 erlang 的 compact 编码分支只有 `fail()`（格式错），没有 unsupported ⇒ `[未知]` 当前源码无法确定「erlang reader 遇到未来编码」是否被当作 malformed 归类；查证方向：`src/erlang/Beam.fixture.ts` 是否含未来版本 fixture。
3. **限制（limitations）不是可选装饰**：erlang 固定两条、rust 固定一条推断声明、dotnet 由 `createAnalysisExecution({ limitations: result.limitations })` 直接透传。

---

## 8 只读边界：本族到底写不写文件

**结论：本族唯一确认的写文件动作是 `Il2cppGhidraSeedWriter`；其余成员在本次读取范围内没有出现写点。**

- `src/il2cpp/Il2cppGhidraSeedWriter.ts` 类 `Il2cppGhidraSeedWriter`（注释原文 "Atomic create-only publication, with failed cleanup retained for close retry"）实现 `Il2cppSeedWriterPort`，操作名常量 `Const：OPERATION` = `"inspect_il2cpp_metadata"`。它的边界由 `check(output, options)` 建立：路径必须 `isAbsolute`，否则 `AnalysisInputError` + reason `invalid_value`，消息原文 "Seed output needs an absolute filesystem path."；`output.base` 若提供必须匹配 `/^0x[0-9a-fA-F]{1,16}$/u`，否则 "Seed base must be a 64-bit hexadecimal address."。写入本身通过 `writeTextParts`（`src/application/JsonFiles.ts`）完成，资源注册在 `ArtifactResourceScope`，并由 `AnalysisCleanupLease.forCloseOwner(this.#resources, "IL2CPP seed output resources")` 持有 close-owner lease ⇒ 清理失败的残留由 close 重试拥有（符合 AGENTS.md「Retain ownership of resources whose cleanup failed」）。`#writing` 布尔字段表示有并发/重入守卫。`[推导]`（字段与注释为证，未逐行读完写路径）
- **是否需要用户批准**：当前源码无法确定。`Il2cppGhidraSeedWriter.ts` 内没有 approval/confirm 类符号（grep `approval|confirm` 无命中，范围 `src/il2cpp/Il2cppGhidraSeedWriter.ts`）；输出路径与是否请求 seed 由调用方（CLI/MCP 参数 `ghidra_seeds`）决定，审批语义若存在应在 application/CLI 层，归 10/12 篇。
- 其余「看着像写」的符号都不是写点：`ManagedPe.fixture.ts`、`PythonPyc.fixture.ts`、`Beam.fixture.ts`、`FlutterBuild.fixture.ts` 是测试 fixture 构造器（生成字节，不落盘）；`src/dotnet/ManagedSnapshot.ts` 导出 `readManagedSnapshot`/`hashManagedSource`/`verifyManagedSourceIdentity`/`managedCleanupError`，是读侧身份与清理错误归一化。
- 反向证据：本族里唯一显式声明「不写文件」的装配注释是 `src/composition/pythonPyc.ts` 的 "without invoking CPython or writing files"（由 11 篇 §2.4 表转述；回源码见该文件首行注释）。

---

## 9 与契约层的一致性

本族 reader 的返回结构不是自己声明的，而是**三段分工**（回链 [08 篇](08-契约层-工具契约与Schema.md)）：

1. **工具名 + 入参 schema** 在 `src/contracts/`：`src/contracts/managed/managedToolContracts.ts` 导出 `MANAGED_TOOL_CONTRACTS`、`managedTargetInputSchema`、`managedMembersInputSchema`、类型 `ManagedToolName`（一个锚点足够：`src/dotnet/ManagedStaticProvider.ts` 函数：isManagedOperation 偏移：+3 用 `MANAGED_TOOL_CONTRACTS.some(({ name }) => name === operation)` 作为「该 operation 是否属于本 provider」的唯一判据 ⇒ 契约目录就是路由真相源，契约里没有 ⇒ `AnalysisCapabilityUnavailableError`）。
2. **返回结构（inspection 类型）** 在 `src/domain/`：`ManagedArtifactInspection` / `ManagedMemberInspection` / `ManagedNativeBoundaryInspection` 来自 `src/domain/managed/managedArtifact.ts`（也是 `ManagedParseIssue` 的定义处）；`ErlangBeam` / `InspectErlangBeamInput` / `MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS` 来自 `src/domain/erlang/beam.ts`；go/rust 的类型来自 `src/domain/go/goBinary.ts`、`src/domain/rust/rustBinary.ts`。
3. **端口/service 类型**在 `src/application/`：`GoBinaryPort`、`RustBinaryPort`、`PythonPycPort`、`ModelArtifactPort`、`GpuCodeObjectsPort`、`WasmArtifactPort`、`EvmInterfacePort`、`Il2cppSeedWriterPort`、`BeamService`。reader 实现端口、service 消费端口，所以 provider 专有代码没有渗进 domain/application。

⇒ `[推导]` 本族的「契约一致性」是**被动成立**的：reader 侧只 import 契约与 domain 类型，从不自带 schema；反过来 provider 门面负责把 `ManagedParseIssue` 之类的 reader 私有事实翻译成契约层错误代数（`managedInspectionInputFailure` 就是把 malformed 元数据映射成 `AnalysisInputError` + `reason: "invalid_format"` 的那一层，`src/dotnet/ManagedReaderFailure.ts` 函数：managedInspectionInputFailure 偏移：+5）。

---

## 边界与失败模式（何时会静默出错）

| # | 场景 | 实际行为 | 锚点 |
|---|---|---|---|
| 1 | PE 节表虚拟区间互相重叠 | **不静默**：抛 `invalid-directory` "ambiguous overlapping PE section mappings" | `src/dotnet/ManagedPeReader.ts` 函数：resolveRva 偏移：+34 |
| 2 | RVA 落在虚拟区间但无文件背书 | 抛 "occupies virtual bytes without file-backed data" | 同上 偏移：+49 |
| 3 | CLI 目录存在但 optional header 装不下目录计数 | 降级为 `cliDirectoryState="unreadable"` + `cliIssue`，**不抛** | 函数：readCliDirectory 偏移：+14 |
| 4 | CLI header 自报 size 大于目录声明 size | `invalid-cli-header`，且 `ManagedCliHeader.headerSize` 与 `headerOffset` 都保真 | 函数：readCliHeader 偏移：+19 |
| 5 | 元数据流数量声明为 0 或 > 64 | `invalid-stream` "outside the admitted range"（上限 64 是本族自设，不是 ECMA 约束） | `src/dotnet/ManagedMetadataLayout.ts` 函数：readMetadataStreams 偏移：+24 |
| 6 | 必需流缺失 vs 可选 blob 流缺失 | 前者 `missing-stream` 抛；后者 `blob: null` 且 index 0 仍是空 blob | 同上 函数：requireStream 偏移：+6；Type：`MetadataLayout` 注释 |
| 7 | BEAM 原子数超过预算 | 抛 `BeamCapacityFailure("atoms", max, ...)`，coverage 不产出 | `src/erlang/BeamParser.ts` 函数：parseAtoms 偏移：+11 |
| 8 | BEAM 同名 chunk 多份 | 全部保留在 `chunks`，解码取最后一份 | 函数：parseErlangBeam 偏移：+41 |
| 9 | AtU8 存在但 0 字节、且无 legacy Atom | 走 UTF-8 路径并因缺计数头而格式失败 | 同上 偏移：+50 |
| 10 | Go buildinfo 搜索累计超 256 MiB | `BinaryResourceFailure("search", ...)`，**同一身份（offset:size:address%16）去重不重复计预算** | `src/go/GoBinaryImage.ts` 函数：readGoBinaryImage 偏移：+12~+22 |
| 11 | Rust auditable 段 inflate 后超比例/上限 | `RustAuditableResourceFailure(memory/transport/capacity)`，PE 路径额外带 `peFileAlignment` 例外 | `src/rust/RustAuditableReader.ts` 函数：readAuditableSection 偏移：+11 |
| 12 | 制品被截断（末尾少几字节） | 每族都在读侧 `requireRange` 拒绝；erlang 的 `padded > formEnd` 保证填充不越界 | `src/erlang/BeamParser.ts` 函数：parseErlangBeam 偏移：+30 |

---

## 问题清单

### P1（会直接影响正确性）

1. **wasm/evm 与「managed reader 不需外部引擎」的表述冲突**。文档与 `src/composition/` 注释若把十一个目录一律说成 "without ... starting any process"，而 `src/evm/EvmoleInterfaceProvider.ts` 函数：evmHostSupported 与 `src/wasm/WabtRuntime.ts` 类 `WabtRuntime` 说明有外部/后端依赖，则族定义需要按 §5.1 的三层划分改写。**待拍板**：本篇按三层写（已写），11 篇 §2.4 表格的「备注」列是否补一列区分。
2. **erlang 的容量失败不产出 partial coverage**：`BeamCapacityFailure` 抛出后整个 inspection 消失，而 dotnet 同档（`resource-limit`）会被归类为 `partial` 并保留 header facts。两个成员对「资源上限」的对外表现不一致。锚点：`src/erlang/BeamParser.ts` 函数：parseErlangBeam 偏移：+64；`src/dotnet/ManagedReaderFailure.ts` 函数：managedMetadataFailureStatus 偏移：+3。

### P2（口径/所有权）

3. **`ManagedDecodeBudget.ts`（175 行）与 `RUST_*` 常量、`MODEL_CAPACITY_LIMITS`、`WABT_LIMITS`、`CudaMetadataBudget` 是五套独立预算体系**，没有共享的预算类型 ⇒ 同一类「上限」在五处各自定义单位与消息。锚点：`src/model/ModelFormat.ts` `Const：MODEL_CAPACITY_LIMITS`；`src/gpu/CudaFatbinary.ts` 类 `CudaMetadataBudget`。待拍板：是否值得统一到 `src/domain/` 的一个预算代数。
4. **dotnet 族文件粒度**：`ManagedMemberInspectorCore.ts`（1,180 行）与 `ManagedMemberInspector.ts`（439 行）拆分、`ManagedMetadataInventory.ts` 与 `...Rows.ts` 拆分，边界是「core 与门面」还是「清单与行」需要读侧确认；本篇只观察到文件名与行数，未验证 import 方向。`[未知]`
5. **`Il2cppGhidraSeedWriter` 的 `#writing` 重入守卫语义**未逐行确认（并发写同一 output 路径时是拒绝还是排队）。锚点：`src/il2cpp/Il2cppGhidraSeedWriter.ts` 类 `Il2cppGhidraSeedWriter` 内字段 `#writing`。

### P3（可读性/文档）

6. **本族 failure 类没有共同的 `boundary` 约定**：erlang 用 `ArtifactReaderFailure` 的 `{ boundary: "capacity" }` 选项，dotnet 用 issue code 字符串，rust 用 `constraint.resource`。三套词汇需要在 06 篇（域层错误代数）里对齐或明确「有意不同」。
7. **`src/dotnet/ManagedPe.fixture.ts` 有 1,501 行**，是 `src/dotnet` 里最大的单文件；本篇未读，其中可能藏着格式变体覆盖清单（ReadyToRun/`#JTD` 的真实样例），对 §2.4 的 `[推导]` 结论是决定性证据。

### 待拍板

- **A. 族名**：「Managed 与语言元数据 Reader」把 model（GGUF/Safetensors）与 gpu（code object）也纳入，但这两者不是「managed runtime 元数据」。是否改名或在 02 篇模块地图里注明「按实现形态归族，不按目标归族」。锚点：`src/model/ModelFormat.ts` 函数：`modelCapacityRemediation`；`src/gpu/GpuInventory.ts` 类 `GpuInventory`。
- **B. 是否要求每个 managed reader 都提供 `HostSupported`**（现状：只有需要外部工具的成员提供）。锚点见 §6。

---

## 已知缺口

诚实列出本篇**未读**部分（行数来自 `wc -l`）：

1. **dotnet 只读了 4 个文件**（`ManagedPeReader.ts` 全、`ManagedReaderFailure.ts` 全、`ManagedStaticProvider.ts` 全、`ManagedMetadataLayout.ts`/`ManagedMetadataHeaps.ts` 为 grep 摘要）。未逐行读：`ManagedMemberInspectorCore.ts`(1,180)、`ManagedMemberInstructionDecoder.ts`(694)、`ManagedMetadataInventoryRows.ts`(617)、`ManagedMemberRows.ts`(594)、`ManagedArtifactInspector.ts`(470)、`ManagedMemberInspector.ts`(439)、`ManagedMethodBodyReader.ts`(364)、`ManagedNativeBoundaryHelpers.ts`(456)、`ManagedSnapshot.ts`(284)、`ManagedTypeNameDigests.ts`(227) 及其余小文件与 `ManagedPe.fixture.ts`(1,501)。⇒ §2.4 的表流/行宽结论是**符号级**，不是逐行；`#JTD` 与 `blob: null` 的语义细节未验证。
2. **il2cpp 14 文件全部只做了 export 符号 grep**，未读实现 ⇒ gcref 映射的具体机制、`Il2cppGhidraSeeds.ts`(117 行起) 的输出结构、`Il2cppMetadataAdmission.ts` 的版本准入矩阵都**无法从本篇证实**。
3. **wasm(10/1,889)、evm(8/1,789)、gpu(14/3,319)、model(6/1,635)、python(5/2,632)、flutter(6/2,835) 未逐行读**；§5 表的「解析什么」列对这些成员来自**符号名 + 导出名 + `Const` 值的直接观察**，其中 gpu 的 AMD/CUDA 格式族谱、wasm 的 `WabtRuntime` 运行方式、evm 的 `EvmoleInterfaceWorker.ts` worker 模型、python 的 marshal 类型覆盖、model 的 GGUF KV 类型表都**未证实**。
4. **go 的 gopclntab：源码中无此符号**。grep 范围与结果：`grep -rn "gopclntab\|pclntab" src --include='*.ts'`（本篇执行）无任何命中；go reader 实际做的是容器身份 + buildinfo magic 搜索。⇒ 任务书里「go（gopclntab？）」的猜测**被证伪**。
5. **rust 的 `.symtab`/DWARF：同样未出现**。`grep -rn "symtab\|DWARF" src/rust`（本篇执行）无命中；rust 读的是 auditable 依赖段与 `/rustc/<40hex>` 路径推断。⇒ 任务书猜测**被证伪**；`src/rust/RustBinaryProvider.ts` 的 limitation 文案本身也声明了推断性质。
6. **`Il2cppGhidraSeedWriter` 的完整写路径（`writeTextParts` 原子性实现、目标目录是否需预先存在、是否覆盖）未读**，`src/application/JsonFiles.ts` 归 12 篇。
7. **erlang `BeamProvider.ts`(217 行) 只读了导出符号清单**，未证实它读磁盘的具体方式（`node:fs/promises` 直读还是复用 `src/artifacts/ArtifactReader.ts`）⇒ 本族「输入是字节 vs 磁盘文件」的所有权差异未定性。
8. **未实测任何成本数字**（token/耗时/内存）——按规范需环境标注，本篇无。

---

## 源码索引

<!-- 行号由 grep -n 实测 -->

---

## 相关篇

- [02-模块地图与依赖方向.md](02-模块地图与依赖方向.md)：本族在 provider 层的目录归属。
- [08-契约层-工具契约与Schema.md](08-契约层-工具契约与Schema.md)：`MANAGED_TOOL_CONTRACTS` 等契约与入参 schema 的宿主。
- [11-Composition层-生产装配根.md](11-Composition层-生产装配根.md)：§2.4 小工厂表（本族全部装配点）。
- [15-深度Provider-Hopper与Ghidra.md](15-深度Provider-Hopper与Ghidra.md)：`Il2cppSeedWriterPort` 的另一端、wabt/evm 后端如何与引擎协作。
- [17-Native与调试器Provider族.md](17-Native与调试器Provider族.md)：相邻的 native reader 族（同一「外部引擎 + owned 进程」形态的对照组）。
- [21-固件抓包与存储格式.md](21-固件抓包与存储格式.md)：相邻的容器/归档 reader 族（`sqlite`、pcap、firmware）。
