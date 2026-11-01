/**
 * The Zvec-backed authoritative store: one persistent collection holding every record's columns and
 * dense vector, filter-first reads, batched writes, and hybrid fusion. Zvec durably owns explicit
 * memories; source files and Session logs remain authoritative for their materialized chunks.
 * @module @deepseek-ai/dsh-retrieval-zvec/store
 */

import {
  RetrievalError,
  RecordId,
  VectorStore,
  assertValidVector,
  classifyFailure,
  spaceKeyOf,
  throwIfAborted,
  type BackendHit,
  type EmbeddingSpace,
  type ReadFilter,
  type StoredRecord,
  type StoreStats,
  type WriteOutcome,
  type SpaceKey,
} from '@deepseek-ai/dsh-retrieval'
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type {
  ZVecCollection,
  ZVecDoc,
  ZVecFtsIndexParams,
  ZVecHnswIndexParams,
  ZVecStatus,
} from '@zvec/zvec'
import {
  PATHS,
  acquireLock,
  openCollection,
  releaseLock,
  resolveManifest,
  resolvePrefixes,
} from './gateway.ts'
import {
  F,
  OUTPUT_FIELDS,
  VECTOR_FIELD,
  buildFilterExpression,
  documentToRecord,
  matchesPathPrefix,
  collectionLayout,
  recordToDocument,
  underPrefix,
} from './schema.ts'

/** Deployment choices for one Zvec-backed store. */
export interface ZvecStoreOptions {
  /** Index root directory; holds the collection, its manifest, and the writer lock. */
  indexDir: string
  /** Collection name recorded in the Zvec schema. */
  collectionName: string
  /** Open the collection without write access, for a read-only Host sharing an index directory. */
  readOnly: boolean
  /** Memory-map data files instead of reading them. */
  enableMMAP: boolean
  queryThreads: number
  optimizeThreads: number
  /** Directory for Zvec's own log files; empty selects console logging. */
  logDir: string
  logLevel: number
  hnswM: number
  hnswEfConstruction: number
  /** Query-time candidate list size; larger trades latency for recall. */
  hnswEf: number
  /** Tokenizer passed to the full-text index: `standard`, `ngram`, `jieba`, or `whitespace`. */
  ftsTokenizer: string
  /** Token filters passed to the full-text index, e.g. `lowercase`, `ascii_folding`, `stemmer`. */
  ftsFilters: string[]
  /** Ceiling on record ids in one explicit-id filter expression. */
  maxFilterIds: number
  /** Documents per write batch, bounding how much a cancelled batch can commit. */
  writeBatchSize: number
  /** Weight of the vector half in the store's hybrid fusion; `1` subtracts it from the term half. */
  hybridVectorWeight: number
}

/** Store backend name reported through {@link StoreStats}. */
const BACKEND = 'zvec'

/** Zvec 0.8.0 rejects every query whose topk exceeds this protocol limit. */
const MAX_SCAN = 100_000

/** One record paired with the vector its write carries. */
interface VectorWrite {
  readonly record: StoredRecord
  readonly vector: readonly number[]
}

/**
 * Authoritative store over one persistent Zvec collection. The collection opens on first use and the
 * writer lock is held for the life of the service, so a second Host on the same index directory is
 * refused instead of silently corrupting it.
 */
export class ZvecStore extends VectorStore {
  private collection: ZVecCollection | null = null

  private lockDescriptor: DatabaseSync | null = null

  private resolvedSpace: EmbeddingSpace | null = null

  private closed = false

  private writing: Promise<void> = Promise.resolve()

  /**
   * @param ctx - registrant context providing the embedding provider.
   * @param options - resolved store configuration.
   * @param native - SDK loaded by the provider with optional-dependency handling.
   */
  constructor(
    ctx: Context,
    private readonly options: ZvecStoreOptions,
    private readonly native: typeof import('@zvec/zvec'),
  ) {
    super(ctx)
  }

  /** @inheritdoc */
  override get space(): EmbeddingSpace | null {
    return this.resolvedSpace
  }

  /**
   * Open the collection on first use, claiming the writer lock and reading the space manifest.
   * @returns the open collection.
   */
  private opened(): ZVecCollection {
    if (this.closed) throw new RetrievalError('unavailable', 'the vector store is closed')
    if (this.collection !== null) return this.collection
    const { indexDir, collectionName, readOnly, enableMMAP, hnswM, hnswEfConstruction, ftsTokenizer, ftsFilters } = this.options
    const space = this.ctx.embeddings.space
    const fts: ZVecFtsIndexParams = { indexType: this.native.ZVecIndexType.FTS, tokenizerName: ftsTokenizer, filters: [...ftsFilters] }
    const hnsw: ZVecHnswIndexParams = {
      indexType: this.native.ZVecIndexType.HNSW,
      metricType: this.native.ZVecMetricType.COSINE,
      m: hnswM,
      efConstruction: hnswEfConstruction,
    }
    try {
      this.lockDescriptor = readOnly ? null : acquireLock(indexDir)
      if (readOnly && !existsSync(join(indexDir, PATHS.manifest))) throw new RetrievalError('not_found', 'no index manifest to open read-only')
      resolveManifest(indexDir, space)
      const collection = openCollection(
        indexDir, space, collectionLayout(space.dimension, fts, hnsw, this.native),
        { readOnly, enableMMAP, collectionName }, this.native,
      )
      this.resolvedSpace = { ...space }
      this.collection = collection
      return collection
    } catch (error) {
      this.releaseResources()
      throw error instanceof RetrievalError ? error : classifyFailure(error, undefined)
    }
  }

  /**
   * @inheritdoc
   *
   * A record whose vector belongs to another embedding space is refused before anything is written,
   * and a batch that fails as a whole counts as rejected rather than disappearing from the tally.
   */
  override async write(
    records: readonly StoredRecord[],
    vectors: ReadonlyMap<RecordId, readonly number[]>,
    signal?: AbortSignal,
  ): Promise<WriteOutcome> {
    return await this.serializeWrite(async () => await this.writeRecords(records, vectors, signal))
  }

  /** Validate and write one operation while retaining the collection until it settles. */
  private async writeRecords(
    records: readonly StoredRecord[],
    vectors: ReadonlyMap<RecordId, readonly number[]>,
    signal?: AbortSignal,
  ): Promise<WriteOutcome> {
    throwIfAborted(signal, 'store write')
    const collection = this.opened()
    const space = this.requireSpace()
    const key = spaceKeyOf(space)
    const vectorWrites: VectorWrite[] = []
    const fieldWrites: StoredRecord[] = []
    let rejected = 0
    let spaceConflict: SpaceKey | null = null
    for (const record of records) {
      if (record.spaceKey !== key) {
        rejected++
        spaceConflict ??= record.spaceKey
        continue
      }
      const vector = vectors.get(record.id)
      if (vector === undefined) {
        fieldWrites.push(record)
        continue
      }
      try {
        vectorWrites.push({ record, vector: assertValidVector([...vector], space) })
      } catch {
        rejected++
      }
    }
    const upserts = await this.upsert(collection, vectorWrites, signal)
    const updates = await this.updateFields(collection, fieldWrites, signal)
    return {
      written: upserts.written + updates.written,
      rejected: rejected + upserts.failed + updates.failed,
      spaceConflict,
    }
  }

  /**
   * @param collection - the open collection.
   * @param writes - records that each carry a validated vector.
   * @param signal - cancellation.
   * @returns accepted and failed counts.
   */
  private async upsert(
    collection: ZVecCollection,
    writes: readonly VectorWrite[],
    signal?: AbortSignal,
  ): Promise<{ written: number; failed: number }> {
    let written = 0
    let failed = 0
    for (const batch of batches(writes, this.options.writeBatchSize)) {
      await setImmediate()
      throwIfAborted(signal, 'store write')
      const docs = batch.map(({ record, vector }) => ({
        id: record.id,
        fields: recordToDocument(record).fields,
        vectors: { [VECTOR_FIELD]: [...vector] },
      }))
      try {
        const accepted = countOk(collection.upsertSync(docs))
        written += accepted
        failed += batch.length - accepted
      } catch (error) {
        this.translate(error, 'record upsert')
        failed += batch.length
      }
    }
    return { written, failed }
  }

  /**
   * Apply a lifecycle change without touching the stored vector. Zvec requires a vector on every
   * upsert, so an unchanged-vector write has to go through `updateSync`.
   * @param collection - the open collection.
   * @param records - records whose columns changed only.
   * @param signal - cancellation.
   * @returns accepted and failed counts.
   */
  private async updateFields(
    collection: ZVecCollection,
    records: readonly StoredRecord[],
    signal?: AbortSignal,
  ): Promise<{ written: number; failed: number }> {
    let written = 0
    let failed = 0
    for (const batch of batches(records, this.options.writeBatchSize)) {
      await setImmediate()
      throwIfAborted(signal, 'store write')
      try {
        const accepted = countOk(collection.updateSync(batch.map(record => recordToDocument(record))))
        written += accepted
        failed += batch.length - accepted
      } catch (error) {
        this.translate(error, 'record update')
        failed += batch.length
      }
    }
    return { written, failed }
  }

  /**
   * @inheritdoc
   */
  override async remove(ids: readonly RecordId[]): Promise<number> {
    return await this.serializeWrite(async () => await this.removeRecords(ids))
  }

  /** Delete one operation under the writer queue. */
  private async removeRecords(ids: readonly RecordId[]): Promise<number> {
    if (ids.length === 0) return 0
    const collection = this.opened()
    let removed = 0
    for (const batch of batches(ids, this.options.writeBatchSize)) {
      await setImmediate()
      try {
        removed += countOk(collection.deleteSync(batch))
      } catch (error) {
        throw this.translate(error, 'record delete')
      }
    }
    return removed
  }

  /**
   * @inheritdoc
   */
  override async searchVector(
    vector: readonly number[],
    topK: number,
    filter: ReadFilter,
    signal?: AbortSignal,
  ): Promise<BackendHit[]> {
    await setImmediate()
    const collection = this.opened()
    throwIfAborted(signal, 'store search')
    const space = this.requireSpace()
    const prepared = assertValidVector([...vector], space)
    const expression = this.expression(filter)
    if (expression === null) return []
    const limit = positiveTopK(topK)
    try {
      return this.hits(collection.querySync({
        fieldName: VECTOR_FIELD,
        vector: [...prepared],
        topk: limit,
        filter: expression,
        outputFields: [...OUTPUT_FIELDS],
        params: { indexType: this.native.ZVecIndexType.HNSW, ef: Math.max(this.options.hnswEf, limit) },
      }), filter)
    } catch (error) {
      throw this.translate(error, 'vector search')
    }
  }

  /**
   * @inheritdoc
   *
   * The query text goes to `matchString`, never `queryString`: a model-supplied string must not be
   * able to express a full-text query operator.
   */
  override async searchKeyword(
    text: string,
    topK: number,
    filter: ReadFilter,
    signal?: AbortSignal,
  ): Promise<BackendHit[]> {
    await setImmediate()
    const collection = this.opened()
    throwIfAborted(signal, 'store search')
    const trimmed = text.trim()
    if (trimmed.length === 0) return []
    const expression = this.expression(filter)
    if (expression === null) return []
    try {
      return this.hits(collection.querySync({
        fieldName: F.text,
        topk: positiveTopK(topK),
        fts: { matchString: trimmed },
        filter: expression,
        outputFields: [...OUTPUT_FIELDS],
        params: { indexType: this.native.ZVecIndexType.FTS, defaultOperator: 'OR' },
      }), filter)
    } catch (error) {
      throw this.translate(error, 'keyword search')
    }
  }

  /**
   * @inheritdoc
   *
   * Combines cosine relevance and normalized full-text scores with the configured vector weight.
   * Both searches apply the same authorization filter, and the fused result contains at most topK hits.
   */
  override async searchHybrid(
    vector: readonly number[],
    text: string,
    topK: number,
    filter: ReadFilter,
    signal?: AbortSignal,
  ): Promise<BackendHit[]> {
    const recall = positiveTopK(topK)
    const [semantic, lexical] = await Promise.all([
      this.searchVector(vector, recall, filter, signal),
      this.searchKeyword(text, recall, filter, signal),
    ])
    const weight = this.options.hybridVectorWeight
    const merged = new Map<RecordId, { hit: BackendHit; relevance: number }>()
    for (const hit of semantic) {
      merged.set(hit.id, { hit, relevance: weight * cosineRelevance(hit.score) })
    }
    for (const hit of lexical) {
      const current = merged.get(hit.id)
      const contribution = (1 - weight) * termRelevance(hit.score)
      if (current === undefined) merged.set(hit.id, { hit, relevance: contribution })
      else current.relevance += contribution
    }
    return [...merged.values()]
      .sort((left, right) => right.relevance - left.relevance || left.hit.id.localeCompare(right.hit.id))
      .slice(0, recall)
      .map(entry => ({ ...entry.hit, score: entry.relevance }))
  }

  /**
   * @inheritdoc
   */
  override async listIds(filter: ReadFilter, limit: number): Promise<RecordId[]> {
    await setImmediate()
    const collection = this.opened()
    const expression = this.expression(filter)
    if (expression === null || limit <= 0) return []
    try {
      const prefixes = resolvePrefixes(filter.pathPrefixes)
      const count = collection.stats.docCount
      if (count === 0) return []
      const requested = Math.min(Math.floor(limit), count)
      if (requested > MAX_SCAN) throw new RetrievalError('invalid_input', 'Zvec cannot enumerate more than 100000 records in one filtered query; use a smaller index')
      const docs = collection.querySync({
        topk: requested,
        filter: expression,
        outputFields: [F.kind, F.source],
      })
      return docs.filter(doc => pathAllowed(doc, prefixes)).map(doc => RecordId(doc.id))
    } catch (error) {
      throw this.translate(error, 'id listing')
    }
  }

  /**
   * @inheritdoc
   */
  override async fetch(ids: readonly RecordId[]): Promise<StoredRecord[]> {
    if (ids.length === 0) return []
    const out: StoredRecord[] = []
    for (const batch of batches(ids, this.options.writeBatchSize)) {
      await setImmediate()
      const collection = this.opened()
      try {
        const docs = collection.fetchSync({ ids: [...batch], outputFields: [...OUTPUT_FIELDS] })
        for (const id of batch) {
          const doc = docs[id]
          if (doc !== undefined) out.push(documentToRecord(doc))
        }
      } catch (error) {
        throw this.translate(error, 'record fetch')
      }
    }
    return out
  }

  /**
   * @inheritdoc
   */
  override async stats(): Promise<StoreStats> {
    await setImmediate()
    const collection = this.opened()
    const stats = collection.stats
    const completeness = Math.min(...Object.values(stats.indexCompleteness), 1)
    return {
      backend: BACKEND,
      documents: stats.docCount,
      pending: completeness < 1 ? stats.docCount : 0,
      indexCompleteness: Number.isFinite(completeness) ? completeness : 0,
      space: this.resolvedSpace === null ? null : spaceKeyOf(this.resolvedSpace),
      path: `${this.options.indexDir}/${PATHS.collection}`,
    }
  }

  /**
   * @inheritdoc
   */
  override async optimize(): Promise<void> {
    await setImmediate()
    try {
      this.opened().optimizeSync()
    } catch (error) {
      throw this.translate(error, 'index optimize')
    }
  }

  /**
   * @inheritdoc
   */
  override async close(): Promise<void> {
    this.closed = true
    await this.writing
    this.releaseResources()
  }

  /** Serialize writes and retain their completion through service disposal. */
  private async serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writing.then(operation)
    this.writing = pending.then(() => undefined, () => undefined)
    return await pending
  }

  /**
   * Close the collection and drop the writer lock. Both are idempotent.
   * @returns nothing.
   */
  private releaseResources(): void {
    const collection = this.collection
    this.collection = null
    if (collection !== null) {
      collection.closeSync()
    }
    if (this.lockDescriptor !== null) {
      releaseLock(this.options.indexDir, this.lockDescriptor)
      this.lockDescriptor = null
    }
  }

  /**
   * @returns the resolved embedding space.
   */
  private requireSpace(): EmbeddingSpace {
    const space = this.resolvedSpace
    if (space === null) throw new RetrievalError('init_failed', 'the store has not resolved its embedding space')
    return space
  }

  /**
   * @param filter - authorization constraints.
   * @returns the pre-scoring expression, or `null` when the filter can match nothing.
   */
  private expression(filter: ReadFilter): string | null {
    if (filter.scopes.length === 0) return null
    if (filter.onlyIds !== null && filter.onlyIds.length === 0) return null
    return buildFilterExpression(
      { ...filter, pathPrefixes: resolvePrefixes(filter.pathPrefixes) },
      spaceKeyOf(this.requireSpace()), this.options.maxFilterIds,
    )
  }

  /**
   * Materialize records onto hits and apply the caller's path restriction.
   * @param docs - backend documents.
   * @param filter - the read the hits answer.
   * @returns hits in backend order.
   */
  private hits(docs: readonly ZVecDoc[], filter: ReadFilter): BackendHit[] {
    const prefixes = resolvePrefixes(filter.pathPrefixes)
    const out: BackendHit[] = []
    for (const doc of docs) {
      const record = documentToRecord(doc)
      if (!matchesPathPrefix(record, prefixes)) continue
      out.push({ id: record.id, score: doc.score, record })
    }
    return out
  }

  /**
   * Map a Zvec failure onto the retrieval error codes, keeping the backend message for diagnostics.
   * @param error - the caught failure.
   * @param operation - what was being attempted.
   * @returns the structured failure.
   */
  private translate(error: unknown, operation: string): RetrievalError {
    if (error instanceof RetrievalError) return error
    if (this.native.isZVecError(error)) {
      const message = `${operation}: ${error.message.replace(/\s+/g, ' ')}`
      switch (error.code) {
        case 'ZVEC_NOT_FOUND':
          return new RetrievalError('not_found', message, false, { code: error.code })
        case 'ZVEC_INVALID_ARGUMENT':
          return new RetrievalError('invalid_input', message, false, { code: error.code })
        case 'ZVEC_PERMISSION_DENIED':
          return new RetrievalError('unauthorized', message, false, { code: error.code })
        case 'ZVEC_UNAVAILABLE':
        case 'ZVEC_RESOURCE_EXHAUSTED':
          return new RetrievalError('unavailable', message, true, { code: error.code })
        default:
          return new RetrievalError('backend_error', message, false, { code: error.code })
      }
    }
    return RetrievalError.from('backend_error', operation, error)
  }
}

/**
 * @param score - Zvec cosine distance for a unit-normalized query.
 * @returns relevance in `[0, 1]`.
 */
function cosineRelevance(score: number): number {
  return Math.max(0, Math.min(1, 1 - score))
}

/**
 * @param score - unbounded full-text term score.
 * @returns relevance in `[0, 1)`, saturating so a rare-term match cannot dominate.
 */
function termRelevance(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0
  return score / (1 + score)
}

/**
 * @param topK - requested candidate count.
 * @returns a value Zvec accepts, which rejects `0`.
 */
function positiveTopK(topK: number): number {
  return Number.isFinite(topK) && topK >= 1 ? Math.min(Math.floor(topK), MAX_SCAN) : 1
}

/**
 * @param items - values to chunk.
 * @param size - maximum chunk length.
 * @returns chunks in input order.
 */
function batches<T>(items: readonly T[], size: number): T[][] {
  const bound = size > 0 ? size : 1
  const out: T[][] = []
  for (let cursor = 0; cursor < items.length; cursor += bound) {
    out.push(items.slice(cursor, cursor + bound))
  }
  return out
}

/**
 * @param statuses - per-document results, or one aggregate status.
 * @returns how many succeeded.
 */
function countOk(statuses: ZVecStatus | ZVecStatus[]): number {
  if (Array.isArray(statuses)) return statuses.filter(status => status.ok).length
  return statuses.ok ? 1 : 0
}

/**
 * Path restriction for an id listing, which does not materialize full records. A memory is owned by a
 * workspace or a session rather than a file, so any path restriction excludes it.
 * @param doc - a document carrying the `kind` and `source` columns.
 * @param prefixes - absolute roots, empty meaning no restriction.
 * @returns whether the record survives the restriction.
 */
function pathAllowed(doc: ZVecDoc, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true
  if (String(doc.fields[F.kind] ?? '') !== 'chunk') return false
  return underPrefix(String(doc.fields[F.source] ?? ''), prefixes)
}
