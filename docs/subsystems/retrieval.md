# Local retrieval and explicit memory

English | [中文](retrieval.zh.md)

The [retrieval packages](../../packages/retrieval/README.md) expose native context retrieval without changing the agent loop. The [user guide](../user/guide/local-retrieval.md) owns installation, enablement, and recovery.

## Services and ownership

| Service | Responsibility |
|---|---|
| `ctx.retrieval` | Scope authorization, query routing, context budgets, and explicit memory lifecycle. |
| `ctx.vectorStore` | Authoritative records, vectors, metadata filtering, lexical and dense search. |
| `ctx.embeddings` | One identified embedding space and bounded text-to-vector batches. |
| `ctx.accelerator` | Optional ephemeral compressed copies of canonical vectors. |
| `ctx.retrievalIndexing` | Workspace synchronization and authorized read-only Session projections. |

## Authority and identifiers

`TrustedIdentity` carries a host principal, canonical original workspace, Session, agent, and host grants. Tools derive these from the calling Agent and deployment configuration. A tool cannot supply another principal or workspace. The [record and query types](../../packages/retrieval/retrieval/src/types.ts) declare these fields and their filtering rules.

| Types | Meaning |
|---|---|
| `OwnerKey`, `WorkspaceKey`, `SessionKey`, `AgentKey` | Distinct branded authority identifiers; user memory may cross workspaces only for the same authorized principal. |
| `RecordId`, `SpaceKey` | Branded record and embedding-space identifiers; they cannot substitute for authority identifiers. |
| `RecordScope`, `RecordKind` | Ownership scope (`user`, `workspace`, `session`, `agent`) and payload class (`chunk`, `memory`). |
| `ReadFilter` | Ownership, scope, record class, source-path, and ID restrictions applied before scoring; `activeAt` selects current memories, while `pendingOnly` selects staged memories for recovery. |

The [identifier constructors](../../packages/retrieval/retrieval/src/ids.ts) validate store-safe literals read at parser or storage interfaces. Native filtering requires the principal and permitted scope; agent records also require the exact agent and Session. Personal memory requires the explicit persistent-memory grant.

This is a single-user local Host capability, not an authenticated tenant service. Distinct operating-system users require separate Harness homes and stores. Historical Session headers identify their workspace, not an authenticated remote user.

## Records and memory lifecycle

Workspace files and original Session logs remain authoritative evidence. Their indexed chunks and synchronization journal can be rebuilt. Explicit memories are authoritative Zvec records; replacing their collection without a backup loses those memories.

| Types | Meaning |
|---|---|
| `StoredRecord`, `ChunkRecord`, `MemoryRecord` | The stored union contains source-linked chunks or explicit facts, each with ownership, a content hash, and an embedding-space key. Memories also retain lifecycle state and version. |
| `MemoryAttribution` | The actor and original reference that created an explicit fact; attribution grants no authority. |
| `RememberInput`, `MemoryPatch`, `ForgetSelector` | Creation, correction, and deletion requests; a scope deletion includes expired and superseded records, while explicit IDs select those records. |
| `MemoryCounts` | Authorized active, expired, superseded, and pending populations, with pending intents excluded from active facts. |

The [memory service](../../packages/retrieval/retrieval/src/engine.ts) stages supersession before retiring previous facts and activating their replacement. Authorized reads reconcile interrupted intents before returning current facts. `outcome_pending` reports an uncertain or incomplete write or deletion; it does not claim rollback. Forgetting verifies removal from canonical storage, and indexed source chunks cannot be deleted through memory operations.

## Search requests and context packets

The [query and result types](../../packages/retrieval/retrieval/src/types.ts) separate backend scores from the bounded passages returned to consumers.

| Types | Meaning |
|---|---|
| `RetrievalQuery`, `QueryMode` | Keyword, semantic, or hybrid intent with scope and path restrictions, result limits, a relevance threshold, an estimated-token budget, and optional cancellation. |
| `BackendHit`, `Candidate`, `CandidateOrigin` | A backend hit identifies a record and raw score; a candidate includes its canonical record, normalized relevance, and producer. |
| `ContextPacket` | Selected passages, rendered evidence, estimated tokens, truncation and deduplication counts, serving backend, and elapsed time. |
| `ScoreScale` | The producer-specific score interpretation used by the [fusion functions](../../packages/retrieval/retrieval/src/fusion.ts); raw scores from different scales are not interchangeable. |

Packing deduplicates evidence and accounts for references and framing in its estimated-token budget. Tools return source-linked, explicitly untrusted passages. Optional automatic retrieval attaches bounded context through the existing pre-step extension; admitted content is committed as a normal user-context message. It never becomes a system instruction. Repeated unchanged evidence is suppressed only when the same selected facts are already committed in that Session.

Prompt framing does not guarantee that every model resists malicious retrieved text. Existing tool approval and sandbox rules continue to govern subsequent actions.

## Providers and health

The [provider interfaces](../../packages/retrieval/retrieval/src/contract.ts) define authoritative storage, embedding, and optional acceleration operations. The [shared types](../../packages/retrieval/retrieval/src/types.ts) describe their results.

| Types | Meaning |
|---|---|
| `EmbeddingSpace` | Provider, model, revision, dimension, and normalization facts bound to the collection; incompatible spaces require separate indexes. |
| `WriteOutcome` | Accepted and rejected counts plus an embedding-space conflict; consumers require a complete acknowledgment before publishing successful indexing or memory writes. |
| `StoreStats`, `AcceleratorStats`, `RetrievalStatus` | Canonical index counters, optional-worker health and consistency, embedding configuration, scoped memory counts, indexed roots, and the latest diagnostic. |
| `RetrievalError`, `RetrievalErrorCode` | [Structured failures](../../packages/retrieval/retrieval/src/errors.ts) with stable codes, retry information, and handling details. |

Optional turbovec never supplies authority: its search allowlist comes from authorized canonical candidates, and absence, inconsistency, or worker failure selects Zvec. Explicit accelerator rebuilding includes authorized current records and memories; Zvec searches remain available while memory mutations wait for the rebuild's read snapshot.

## Index synchronization

The [indexing service](../../packages/retrieval/retrieval/src/indexing.ts) owns discovery, content-hash synchronization, the source journal, and authorized Session projection.

| Types | Meaning |
|---|---|
| `SourceState`, `IndexState` | Owned source hashes and chunk IDs, plus incomplete source writes tracked for recovery; these files are rebuildable derivatives. |
| `SyncReport` | Scanned, added, updated, removed, skipped, and written counts, bytes read, and elapsed time for a canonical synchronization pass. |
| `ChunkPolicy` | Size, overlap, and per-document chunk limits used by the [chunking functions](../../packages/retrieval/retrieval/src/records.ts); a limit that would omit non-whitespace content fails visibly. |

A source write records pending chunk IDs before canonical writes and publishes the completed source only after accepted writes. Recovery removes unfinished new chunks without deleting a different owner's records. Clearing the authorized chunk index preserves explicit memories. Historical Session reads require the matching original workspace and host cross-session grant; the mounted Session store is assumed to belong to the same trusted local principal.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
