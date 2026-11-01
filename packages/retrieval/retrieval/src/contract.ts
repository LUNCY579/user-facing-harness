/**
 * Service Definitions for the retrieval seam: the authoritative vector store, the embedding provider,
 * and the optional quantized accelerator. Each is one abstract class a provider package subclasses and
 * mounts; consumers depend only on these declarations.
 * @module @deepseek-ai/dsh-retrieval/contract
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AcceleratorStats,
  BackendHit,
  EmbeddingSpace,
  ReadFilter,
  StoredRecord,
  StoreStats,
  WriteOutcome,
  RecordId,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authoritative persistent record and vector store. */
    vectorStore: VectorStore
    /** Provider that turns text into vectors for one embedding space. */
    embeddings: Embeddings
    /** Optional quantized dense-vector accelerator; absent when no provider is mounted. */
    accelerator: Accelerator
  }
}

/**
 * Authoritative store for records and their vectors. Exactly one provider is mounted; Zvec is the
 * shipped implementation and stays the source of truth for ids, fields, and durability.
 *
 * Implementers must honor these semantics:
 * - A read applies {@link ReadFilter} before scoring, so unauthorized records never enter the
 *   candidate set, and never rely on the caller to post-filter.
 * - A record whose space key differs from the store's is counted in {@link WriteOutcome.rejected},
 *   with {@link WriteOutcome.spaceConflict} set. Compatible records in the same call may commit.
 * - Callers must not publish a source ledger after any rejected record or space conflict. Writes
 *   do not imply batch rollback; interrupted operations require reconciliation.
 * - A failed write leaves previously durable records readable.
 */
export abstract class VectorStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'vectorStore')
  }

  /** Embedding space this store currently accepts. */
  abstract get space(): EmbeddingSpace | null

  /**
   * Write or replace records and their vectors.
   * @param records - records to store, each already carrying a stable id.
   * @param vectors - dense vector per record id; a record with no entry keeps its stored vector.
   * @param signal - cancellation of the in-flight batch.
   * @returns counted writes, including any rejected batch.
   */
  abstract write(
    records: readonly StoredRecord[],
    vectors: ReadonlyMap<RecordId, readonly number[]>,
    signal?: AbortSignal,
  ): Promise<WriteOutcome>

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
  abstract searchVector(
    vector: readonly number[],
    topK: number,
    filter: ReadFilter,
    signal?: AbortSignal,
  ): Promise<BackendHit[]>

  /**
   * Exact keyword or full-text search under a filter.
   * @param text - query text; treated as terms, not as an expression.
   * @param topK - maximum candidate count.
   * @param filter - authorization and scope constraint applied before scoring.
   * @param signal - cancellation of the in-flight query.
   * @returns hits ordered by backend relevance.
   */
  abstract searchKeyword(
    text: string,
    topK: number,
    filter: ReadFilter,
    signal?: AbortSignal,
  ): Promise<BackendHit[]>

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
  abstract searchHybrid(
    vector: readonly number[],
    text: string,
    topK: number,
    filter: ReadFilter,
    signal?: AbortSignal,
  ): Promise<BackendHit[]>

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
}

/**
 * One text-to-vector provider. `space` identifies the vectors it produces; the engine refuses to mix
 * spaces, so a model or dimension change must surface as a new space rather than a silent default.
 */
export abstract class Embeddings extends Service {
  constructor(ctx: Context) {
    super(ctx, 'embeddings')
  }

  /** Space this provider's vectors belong to. */
  abstract get space(): EmbeddingSpace

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
}

/**
 * Optional rebuildable dense-vector accelerator. It stores quantized copies of vectors already
 * durable in {@link VectorStore} under the same record ids, so every failure mode — unavailable,
 * inconsistent, crashed — permits a Zvec-only answer.
 *
 * Implementers must never return an id absent from {@link ReadFilter.onlyIds}: the engine passes the
 * authorized candidate set as an allowlist so a stale accelerator cannot widen access.
 */
export abstract class Accelerator extends Service {
  constructor(ctx: Context) {
    super(ctx, 'accelerator')
  }

  /** Whether the accelerator can currently serve searches. */
  abstract get available(): boolean

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
  abstract rebuild(
    ids: readonly RecordId[],
    vectors: readonly (readonly number[])[],
    signal?: AbortSignal,
  ): Promise<number>

  /**
   * Release accelerator resources. Idempotent.
   * @returns when released.
   */
  abstract close(): Promise<void>
}
