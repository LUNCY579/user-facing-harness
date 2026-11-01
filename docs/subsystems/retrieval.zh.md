# 本地检索和显式记忆

[English](retrieval.md) | 中文

[检索包组](../../packages/retrieval/README.zh.md)通过原生服务提供上下文检索，无需修改智能体循环。[用户指南](../user/guide/local-retrieval.zh.md)负责安装、启用和恢复说明。

## 服务和职责

| 服务 | 职责 |
|---|---|
| `ctx.retrieval` | 作用域授权、查询路由、上下文预算和显式记忆生命周期。 |
| `ctx.vectorStore` | 主记录、向量、元数据过滤、词项和稠密向量检索。 |
| `ctx.embeddings` | 唯一标识的嵌入空间及有界文本向量转换批次。 |
| `ctx.accelerator` | 可选的主向量临时压缩副本。 |
| `ctx.retrievalIndexing` | 工作区同步和授权只读会话投影。 |

## 权限和标识符

`TrustedIdentity` 包含宿主主体、规范化的原始工作区、会话、智能体和宿主授权。工具从调用智能体和部署配置中解析这些值。工具不能指定其他主体或工作区。[记录和查询类型](../../packages/retrieval/retrieval/src/types.ts)定义这些字段及其过滤规则。

| 类型 | 含义 |
|---|---|
| `OwnerKey`, `WorkspaceKey`, `SessionKey`, `AgentKey` | 相互区分的品牌化权限标识符；只有主体相同且已获授权时，用户记忆才能跨工作区访问。 |
| `RecordId`, `SpaceKey` | 记录和嵌入空间的品牌化标识符，不能替代权限标识符。 |
| `RecordScope`, `RecordKind` | 所有权作用域（`user`、`workspace`、`session`、`agent`）和内容类别（`chunk`、`memory`）。 |
| `ReadFilter` | 评分前应用的所有权、作用域、记录类别、来源路径和 ID 限制；`activeAt` 选择当前记忆，`pendingOnly` 选择待恢复的暂存记忆。 |

[标识符构造函数](../../packages/retrieval/retrieval/src/ids.ts)验证从解析或存储接口读入的字面值是否可安全用于存储过滤。原生过滤要求主体和允许的作用域匹配；智能体记录还要求精确匹配智能体和会话。个人记忆需要显式持久记忆授权。

此功能面向单用户本地宿主，不是经过租户认证的服务。不同操作系统用户需要独立的 Harness 主目录和存储。历史会话头标识工作区，而非已认证的远程用户。

## 记录和记忆生命周期

工作区文件和原始会话日志始终是权威证据。索引片段和同步日志可以重建。显式记忆是 Zvec 中的主记录；未备份就替换集合会丢失记忆。

| 类型 | 含义 |
|---|---|
| `StoredRecord`, `ChunkRecord`, `MemoryRecord` | 存储联合类型包含带来源链接的片段或显式事实，各自具有所有权、内容哈希和嵌入空间键；记忆还保留生命周期状态和版本。 |
| `MemoryAttribution` | 创建显式事实的行为主体及原始引用；归属信息不授予权限。 |
| `RememberInput`, `MemoryPatch`, `ForgetSelector` | 创建、更正和删除请求；按作用域删除包含过期和被替代的记录，显式 ID 则选择对应记录。 |
| `MemoryCounts` | 已授权的有效、过期、被替代和待处理记忆数量，待处理意图不计入有效事实。 |

[记忆服务](../../packages/retrieval/retrieval/src/engine.ts)先暂存替代意图，再停用旧事实并激活替代记录。授权读取会先协调被中断的意图，再返回当前事实。`outcome_pending` 表示写入或删除结果不确定或尚未完成，并不表示操作已回滚。遗忘操作会验证主存储中的记录已删除；记忆操作不能删除已索引的源片段。

## 搜索请求和上下文包

[查询和结果类型](../../packages/retrieval/retrieval/src/types.ts)区分后端评分和返回给消费方的有界片段。

| 类型 | 含义 |
|---|---|
| `RetrievalQuery`, `QueryMode` | 词项、语义或混合检索意图，包括作用域和路径限制、结果上限、相关度阈值、估算词元预算及可选取消信号。 |
| `BackendHit`, `Candidate`, `CandidateOrigin` | 后端命中标识记录及原始评分；候选包含对应主记录、归一化相关度和生成方。 |
| `ContextPacket` | 选中片段、渲染后的证据、估算词元数、截断和去重计数、实际服务后端及耗时。 |
| `ScoreScale` | [融合函数](../../packages/retrieval/retrieval/src/fusion.ts)使用的各生成方评分解释方式；不同评分尺度的原始值不能互换。 |

打包会去除重复证据，并将引用和提示说明计入估算词元预算。工具返回带来源链接且明确不可信的片段。可选自动检索通过现有 pre-step 扩展附加有界上下文；获准内容记录为普通用户上下文消息，绝不会成为系统指令。只有相同的选中事实已在该会话中提交时，才抑制重复注入。

提示词中的说明并不能保证所有模型都能抵抗恶意检索文本；后续操作仍受既有工具审批和沙箱规则约束。

## 提供方和健康状态

[提供方接口](../../packages/retrieval/retrieval/src/contract.ts)定义主存储、嵌入和可选加速操作，[共享类型](../../packages/retrieval/retrieval/src/types.ts)描述其结果。

| 类型 | 含义 |
|---|---|
| `EmbeddingSpace` | 与集合绑定的提供方、模型、修订、维度和归一化信息；不兼容的空间需要独立索引。 |
| `WriteOutcome` | 接受和拒绝的数量及嵌入空间冲突；消费方须收到完整确认，才发布索引或记忆写入成功状态。 |
| `StoreStats`, `AcceleratorStats`, `RetrievalStatus` | 主索引计数、可选工作进程的健康和一致性状态、嵌入配置、作用域内记忆计数、索引根目录及最新诊断信息。 |
| `RetrievalError`, `RetrievalErrorCode` | 包含稳定错误码、重试信息和处理详情的[结构化失败](../../packages/retrieval/retrieval/src/errors.ts)。 |

可选 turbovec 不提供权限依据：其查询白名单来自主存储授权候选；缺失、不一致或工作进程故障均回退到 Zvec。显式加速器重建包含已授权的当前记录和记忆；重建期间 Zvec 搜索保持可用，记忆修改则等待重建读取快照完成。

## 索引同步

[索引服务](../../packages/retrieval/retrieval/src/indexing.ts)负责发现文件、按内容哈希同步、管理来源日志及生成已授权的会话投影。

| 类型 | 含义 |
|---|---|
| `SourceState`, `IndexState` | 带所有权的来源哈希和片段 ID，以及为恢复而记录的未完成来源写入；这些文件是可重建的派生数据。 |
| `SyncReport` | 主存储同步过程中扫描、新增、更新、删除、跳过和写入的计数，以及读取字节数和耗时。 |
| `ChunkPolicy` | [分块函数](../../packages/retrieval/retrieval/src/records.ts)使用的大小、重叠量和每文档片段上限；若上限会遗漏非空白内容，操作会明确失败。 |

源文件写入会先记录待处理片段 ID，在主存储确认写入后才发布完成状态。恢复过程删除未完成的新片段，而不会删除其他所有者的记录。清空已授权的片段索引会保留显式记忆。历史会话读取要求匹配原始工作区并获得宿主跨会话授权；挂载的会话存储被视为属于同一受信任本地主体。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccelerator--accelerator-abstract-seam"></a>

### `ctx.accelerator` — `Accelerator` (abstract seam)

Optional rebuildable dense-vector accelerator. It stores quantized copies of vectors already durable in VectorStore under the same record ids, so every failure mode — unavailable, inconsistent, crashed — permits a Zvec-only answer.

Implementers must never return an id absent from ReadFilter.onlyIds: the engine passes the authorized candidate set as an allowlist so a stale accelerator cannot widen access.

```ts cordis-catalog
/**
 * Add or replace quantized copies of vectors.
 * @param ids - record ids matching `vectors` positionally.
 * @param vectors - dense vectors in the store's space.
 * @param signal - cancellation of the in-flight batch.
 * @returns count accepted.
 */
abstract add(ids: readonly RecordId[], vectors: readonly (readonly number[])[], signal?: AbortSignal): Promise<number>

/**
 * Search the accelerator, restricted to an authorized candidate set.
 * @param vector - query vector in the store's space.
 * @param topK - maximum candidate count.
 * @param allowlist - record ids permitted to match; empty means nothing is permitted.
 * @param signal - cancellation of the in-flight worker request; absent means activation lifetime only.
 * @returns hits ordered by accelerator relevance, with accelerator-raw scores.
 */
abstract search(vector: readonly number[], topK: number, allowlist: readonly RecordId[], signal?: AbortSignal): Promise<BackendHit[]>

/**
 * Drop quantized copies of removed records.
 * @param ids - record ids to remove.
 * @returns count removed.
 */
abstract remove(ids: readonly RecordId[]): Promise<number>

/**
 * Persist accelerator state to its own rebuildable file.
 * @returns when written.
 */
abstract sync(): Promise<void>

/**
 * Inspect accelerator availability and synchronization counters.
 * @returns availability, size, and drift against the authoritative store.
 */
abstract stats(): Promise<AcceleratorStats>

/**
 * Rebuild accelerator state from authoritative vectors.
 * @param ids - every record id with a vector in the store.
 * @param vectors - the corresponding vectors, positionally matching `ids`.
 * @param signal - cancellation of the in-flight rebuild.
 * @returns count re-added.
 */
abstract rebuild( ids: readonly RecordId[], vectors: readonly (readonly number[])[], signal?: AbortSignal, ): Promise<number>

/**
 * Release accelerator resources. Idempotent.
 * @returns when released.
 */
abstract close(): Promise<void>
```

Source: [`packages/retrieval/retrieval/src/contract.ts`](../../packages/retrieval/retrieval/src/contract.ts)

<a id="ctxembeddings--embeddings-abstract-seam"></a>

### `ctx.embeddings` — `Embeddings` (abstract seam)

One text-to-vector provider. `space` identifies the vectors it produces; the engine refuses to mix spaces, so a model or dimension change must surface as a new space rather than a silent default.

```ts cordis-catalog
/**
 * Embed a batch of texts.
 * @param texts - inputs in caller order.
 * @param signal - cancellation of the in-flight batch.
 * @returns one vector per input, in the same order, each exactly `space.dimension` long.
 */
abstract embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>

/**
 * Release provider resources such as a model or a remote session. Idempotent.
 * @returns when released.
 */
abstract close(): Promise<void>
```

Source: [`packages/retrieval/retrieval/src/contract.ts`](../../packages/retrieval/retrieval/src/contract.ts)

<a id="ctxretrieval--retrievalservice"></a>

### `ctx.retrieval` — `RetrievalService`

Unified retrieval and memory service. Providers must mount `vectorStore` and `embeddings` before this service is used; an accelerator is optional and only ever re-ranks candidates the store already authorized.

```ts cordis-catalog
/**
 * Resolve which scopes a caller may actually read: the request's scopes intersected with the
 * identity's grants. A model cannot widen this set by asking for a scope.
 * @param requested - scopes the caller asked for.
 * @param identity - host-resolved caller identity.
 * @returns permitted scopes, possibly empty.
 */
authorizeScopes(requested: readonly RecordScope[], identity: TrustedIdentity): RecordScope[]

/**
 * Build the filter-first constraint the store must apply before scoring anything.
 * @param identity - host-resolved caller identity.
 * @param scopes - authorized scopes.
 * @param pathPrefixes - optional path restriction.
 * @param onlyIds - candidate id restriction, used by accelerator re-ranking.
 * @param kinds - record classes to admit, or `null` for both.
 * @param activeAt - current-memory cutoff for search, or `null` to include lifecycle history.
 * @returns the store read filter.
 */
buildFilter( identity: TrustedIdentity, scopes: readonly RecordScope[], pathPrefixes: readonly string[] = [], onlyIds: readonly RecordId[] | null = null, kinds: readonly RecordKind[] | null = null, activeAt: number | null = null, ): ReadFilter

/**
 * Search records under a caller's authority. Keyword mode uses term matching only; semantic mode
 * uses vectors; hybrid mode fuses both inside the store. An mounted accelerator re-ranks the
 * authorized candidate set and never widens it.
 * @param input - query intent, with limits expressed in the same units the model sees.
 * @param identity - host-resolved caller identity.
 * @returns the packed packet; an empty packet when nothing matched.
 */
async search(input: RetrievalQuery, identity: TrustedIdentity): Promise<ContextPacket>

/**
 * Store one explicit memory. Personal (`user` scope) writes require the opt-in configuration.
 * A duplicate of an existing readable memory returns that record instead of writing again.
 * @param input - memory text, scope, tags, optional ttl and supersession list.
 * @param identity - host-resolved caller identity.
 * @param signal - cancellation before the durable write.
 * @returns the stored or reused memory.
 */
async remember(input: RememberInput, identity: TrustedIdentity, signal?: AbortSignal): Promise<MemoryRecord>

/**
 * Rewrite one memory in place, bumping its version. Only the owning identity may write it.
 * @param id - memory id.
 * @param patch - fields to change.
 * @param identity - host-resolved caller identity.
 * @param signal - cancellation before the durable write.
 * @returns the updated record.
 */
async updateMemory(id: RecordId, patch: MemoryPatch, identity: TrustedIdentity, signal?: AbortSignal): Promise<MemoryRecord>

/**
 * Delete memories and prove the deletion by re-reading the store.
 * @param selector - ids, expired sweep, and scope sweep.
 * @param identity - host-resolved caller identity.
 * @param signal - cancellation before deletion; once started, deletion is completed and verified.
 * @returns ids durably removed.
 */
async forget(selector: ForgetSelector, identity: TrustedIdentity, signal?: AbortSignal): Promise<RecordId[]>

/**
 * Read memories the caller may see, newest first, dropping expired and superseded rows by default.
 * @param identity - host-resolved caller identity.
 * @param options - `includeExpired` keeps expired rows, `includeSuperseded` keeps replaced rows.
 * @returns matching records.
 */
async listMemories( identity: TrustedIdentity, options: { includeExpired?: boolean; includeSuperseded?: boolean } = {}, ): Promise<MemoryRecord[]>

/**
 * Count authorized memories by their current lifecycle state.
 * @param identity - host-resolved caller identity.
 * @returns active, expired, superseded, and pending memory counts.
 */
async countMemories(identity: TrustedIdentity): Promise<MemoryCounts>

/**
 * Rebuild the optional accelerator from current authorized records, including explicit memories.
 * The authoritative store remains readable if embedding, worker startup, or synchronization fails.
 * Concurrent source changes invalidate this rebuild and require a retry after indexing completes.
 * @param identity - host-resolved caller identity; only its readable scopes are copied.
 * @param signal - cancellation before or between bounded batches; absent means activation lifetime only.
 * Pending memories are reconciled even when acceleration is disabled or absent. Zvec searches
 * remain available during accelerator rebuilding; memory mutations wait for its snapshot read.
 * @returns number of copied records, or zero when acceleration is disabled or absent.
 */
async rebuildAccelerator(identity: TrustedIdentity, signal?: AbortSignal): Promise<number>

/**
 * Reject a read or write of a record the caller does not own. Ownership is workspace- plus
 * scope-bound: a session record belongs to its own session unless cross-session read was granted.
 * @param record - the record in question.
 * @param identity - host-resolved caller identity.
 * @param mode - `read` or `write`; a write always needs the caller's own session or agent.
 * @returns nothing.
 */
assertOwnership(record: StoredRecord, identity: TrustedIdentity, mode: 'read' | 'write'): void

/**
 * Render a packet for injection, framed so a model reads the passages as data.
 * @param packet - a completed search packet.
 * @returns the injection block, or `''` when the packet is empty.
 */
renderInjection(packet: ContextPacket): string

/**
 * Inspect backend health and authorized memory counters.
 * @param identity - host-resolved caller identity, or `undefined` for a global health view.
 * @param indexedRoots - absolute roots the indexing service currently maintains.
 * @returns store, accelerator, embedding, and memory counters.
 */
async status(identity?: TrustedIdentity, indexedRoots: readonly string[] = []): Promise<RetrievalStatus>

/**
 * Stop accepting mutations and await this service's queued writes. Providers retain ownership of their resources.
 * @returns when resources are released.
 */
async close(): Promise<void>
```

Source: [`packages/retrieval/retrieval/src/engine.ts`](../../packages/retrieval/retrieval/src/engine.ts)

<a id="ctxretrievalindexing--indexingservice"></a>

### `ctx.retrievalIndexing` — `IndexingService`

Discovers, chunks, and stores workspace and session records, and removes records whose source is gone. Writes go to the authoritative store first, so a failed sync leaves the store readable and the ledger unchanged for the sources it did not finish.

```ts cordis-catalog
/**
 * Reconcile every configured root with the store.
 * @param identity - host-resolved identity that owns the produced records.
 * @param signal - cancellation checked between files and between write batches.
 * @returns the sync report.
 */
async syncWorkspace(identity: TrustedIdentity, signal?: AbortSignal): Promise<SyncReport>

/**
 * Index live session transcripts as `session` scope records. The session log stays authoritative;
 * these records are a derivative and are rebuilt from the log whenever the ledger is cleared.
 * @param identity - host-resolved identity; its workspace keys the produced records.
 * @param signal - cancellation between sessions.
 * @returns the sync report.
 */
async syncSessions(identity: TrustedIdentity, signal?: AbortSignal): Promise<SyncReport>

/**
 * Stop admitting indexing work, cancel accepted operations at their next checkpoint, and await them.
 * Interrupted source journals remain available for the next authorized sync.
 * @returns when this service's indexing operations have settled.
 */
async close(): Promise<void>

/**
 * Inspect sources from the most recently loaded ledger.
 * @returns ledger entries for diagnostics, or an empty array before the ledger is loaded.
 */
sources(): SourceState[]

/**
 * Forget the ledger and every record this service wrote. Memory records are untouched.
 * @param identity - host-resolved identity whose workspace and session records are dropped.
 * @param signal - cancellation between deletion batches; absent means activation lifetime only.
 * @returns count of removed chunk records; explicit memories are preserved.
 */
async clear(identity: TrustedIdentity, signal?: AbortSignal): Promise<number>
```

Source: [`packages/retrieval/retrieval/src/indexing.ts`](../../packages/retrieval/retrieval/src/indexing.ts)

<a id="ctxvectorstore--vectorstore-abstract-seam"></a>

### `ctx.vectorStore` — `VectorStore` (abstract seam)

Authoritative store for records and their vectors. Exactly one provider is mounted; Zvec is the shipped implementation and stays the source of truth for ids, fields, and durability.

Implementers must honor these semantics:

- A read applies ReadFilter before scoring, so unauthorized records never enter the candidate set, and never rely on the caller to post-filter.
- A record whose space key differs from the store's is counted in WriteOutcome.rejected, with WriteOutcome.spaceConflict set. Compatible records in the same call may commit.
- Callers must not publish a source ledger after any rejected record or space conflict. Writes do not imply batch rollback; interrupted operations require reconciliation.
- A failed write leaves previously durable records readable.

```ts cordis-catalog
/**
 * Write or replace records and their vectors.
 * @param records - records to store, each already carrying a stable id.
 * @param vectors - dense vector per record id; a record with no entry keeps its stored vector.
 * @param signal - cancellation of the in-flight batch.
 * @returns counted writes, including any rejected batch.
 */
abstract write( records: readonly StoredRecord[], vectors: ReadonlyMap<RecordId, readonly number[]>, signal?: AbortSignal, ): Promise<WriteOutcome>

/**
 * Remove records by id; ids that are absent are ignored.
 * @param ids - record ids to delete durably.
 * @returns count actually removed.
 */
abstract remove(ids: readonly RecordId[]): Promise<number>

/**
 * Vector similarity search under a filter.
 * @param vector - query vector in the store's space.
 * @param topK - maximum candidate count.
 * @param filter - authorization and scope constraint applied before scoring.
 * @param signal - cancellation of the in-flight query.
 * @returns hits ordered by backend relevance.
 */
abstract searchVector( vector: readonly number[], topK: number, filter: ReadFilter, signal?: AbortSignal, ): Promise<BackendHit[]>

/**
 * Exact keyword or full-text search under a filter.
 * @param text - query text; treated as terms, not as an expression.
 * @param topK - maximum candidate count.
 * @param filter - authorization and scope constraint applied before scoring.
 * @param signal - cancellation of the in-flight query.
 * @returns hits ordered by backend relevance.
 */
abstract searchKeyword( text: string, topK: number, filter: ReadFilter, signal?: AbortSignal, ): Promise<BackendHit[]>

/**
 * Fused keyword-plus-vector search. The store fuses calibrated vector and term relevance so every
 * hit is reported on one scale.
 * @param vector - query vector in the store's space.
 * @param text - keyword terms.
 * @param topK - maximum candidate count.
 * @param filter - authorization and scope constraint applied before scoring.
 * @param signal - cancellation of the in-flight query.
 * @returns fused hits ordered by relevance.
 */
abstract searchHybrid( vector: readonly number[], text: string, topK: number, filter: ReadFilter, signal?: AbortSignal, ): Promise<BackendHit[]>

/**
 * Enumerate stored record ids that satisfy a filter, without scoring. Used for lifecycle sweeps
 * such as listing memories and reconciling the accelerator.
 * @param filter - authorization and scope constraint applied before an id is returned.
 * @param limit - maximum ids to return.
 * @returns matching ids, in unspecified order.
 */
abstract listIds(filter: ReadFilter, limit: number): Promise<RecordId[]>

/**
 * Read stored records by id, ignoring ids that are absent.
 * @param ids - record ids to fetch.
 * @returns the records that exist, in unspecified order.
 */
abstract fetch(ids: readonly RecordId[]): Promise<StoredRecord[]>

/**
 * Inspect authoritative store counters and its configured location.
 * @returns current store counters and identity.
 */
abstract stats(): Promise<StoreStats>

/**
 * Fold pending writes into the searchable index.
 * @returns when the index reflects stored records.
 */
abstract optimize(): Promise<void>

/**
 * Release the store. Idempotent, and safe to call during disposal.
 * @returns when resources are released.
 */
abstract close(): Promise<void>
```

Source: [`packages/retrieval/retrieval/src/contract.ts`](../../packages/retrieval/retrieval/src/contract.ts)
<!-- END GENERATED cordis-surface -->
