/**
 * The unified retrieval and memory service: one consumer-facing surface over the authoritative
 * vector store, the embedding provider, and the optional accelerator. It resolves authorization,
 * routes queries, re-ranks through the accelerator, calibrates and packs results, and owns memory
 * lifecycle including expiry and supersession.
 * @module @deepseek-ai/dsh-retrieval
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RetrievalError, throwIfAborted } from './errors.ts'
import { calibrate, mergeCandidates, pack, renderInjection, scaleFor, toCandidates } from './fusion.ts'
import { assertValidVector, contentHash, newMemoryId, normalizeVector, spaceKeyOf } from './records.ts'
import type {
  AcceleratorStats,
  BackendHit,
  Candidate,
  ContextPacket,
  MemoryRecord,
  ReadFilter,
  RecordKind,
  RecordScope,
  RetrievalQuery,
  RetrievalStatus,
  StoredRecord,
  StoreStats,
  TrustedIdentity,
  RecordId,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    retrieval: RetrievalService
  }
}

/** Deployment choices for retrieval and memory behavior. */
export interface Config {
  /** Reject searches and memory mutations when false; profile rows control provider activation. */
  enabled: boolean
  /** Persist explicit `user` scope memories. Off by default: personal memory is opt-in. */
  persistentMemory: boolean
  /** Read another session's records when the host grants the caller that authority. */
  crossSessionRead: boolean
  /** Re-rank authorized candidates through the mounted accelerator. */
  useAccelerator: boolean
  /** Candidate-set multiplier handed to the store before accelerator re-ranking. */
  recallMultiplier: number
  /** Relevance floor applied when a caller leaves `minScore` at zero. */
  defaultMinScore: number
  /** Token ceiling applied when a caller leaves `budgetTokens` at zero. */
  defaultBudgetTokens: number
  /** Days a memory stays current when the caller asks for retention but gives no expiry. */
  defaultMemoryRetentionDays: number
  /** Maximum memories one workspace identity may hold. */
  maxMemories: number
  /** Maximum characters in one query or memory. */
  maxTextChars: number
  /** Maximum number of passages in one response. */
  maxTopK: number
  /** Maximum queued memory mutations before applying backpressure. */
  maxPendingWrites: number
  /** Records embedded per batch during explicit accelerator recovery. */
  rebuildBatchSize: number
  /** Maximum authorized records accepted by one accelerator rebuild. */
  maxRebuildRecords: number
  /** Maximum remembered authorization scopes whose startup recovery has completed. */
  maxRecoveryScopes: number
}

/** Loader schema for {@link Config}. */
export const Config: z<Partial<Config>, Config> = z.object({
  enabled: z.boolean().default(true),
  persistentMemory: z.boolean().default(false),
  crossSessionRead: z.boolean().default(false),
  useAccelerator: z.boolean().default(false),
  recallMultiplier: z.natural().min(1).default(4),
  defaultMinScore: z.number().min(0).max(1).default(0.2),
  defaultBudgetTokens: z.natural().min(256).default(1200),
  defaultMemoryRetentionDays: z.natural().default(0),
  maxMemories: z.natural().min(1).default(2000),
  maxTextChars: z.natural().min(256).default(32_768),
  maxTopK: z.natural().min(1).default(100),
  maxPendingWrites: z.natural().min(1).default(32),
  rebuildBatchSize: z.natural().min(1).default(64),
  maxRebuildRecords: z.natural().min(1).default(100_000),
  maxRecoveryScopes: z.natural().min(1).default(128),
})

/** Text plus placement for a new memory. */
export interface RememberInput {
  text: string
  scope: RecordScope
  tags?: readonly string[]
  /** Milliseconds of validity from now; `0` means no expiry. */
  ttlMs?: number
  /** Ids this memory replaces; each becomes superseded by the new record. */
  supersedes?: readonly RecordId[]
  attribution: MemoryRecord['attribution']
}

/** Editable memory fields. */
export interface MemoryPatch {
  text?: string
  tags?: readonly string[]
  /** Absolute expiry in milliseconds since the epoch; `null` clears expiry. */
  expiresAt?: number | null
}

/** Selection for a forget operation. */
export interface ForgetSelector {
  /** Explicit record ids. */
  ids?: readonly RecordId[]
  /** Additionally drop every expired memory the caller can read. */
  includeExpired?: boolean
  /** Additionally drop all memories in these scopes. */
  scopes?: readonly RecordScope[]
}

/** Counters for one memory population. */
export interface MemoryCounts {
  pending: number
  active: number
  expired: number
  superseded: number
}

const SCOPES: readonly RecordScope[] = ['user', 'workspace', 'session', 'agent']

/**
 * Unified retrieval and memory service. Providers must mount `vectorStore` and `embeddings` before
 * this service is used; an accelerator is optional and only ever re-ranks candidates the store
 * already authorized.
 */
export class RetrievalService extends Service {
  static inject = ['vectorStore', 'embeddings']

  /** Loader schema applied to the config passed to `ctx.plugin()`. */
  static Config: z<Partial<Config>, Config> = Config

  /** Most recent backend or accelerator failure, reported through {@link status}. */
  private lastError: string | null = null

  /** Accelerator availability, kept so one crash degrades the rest of the session. */
  private acceleratorDown = false

  private writing: Promise<void> = Promise.resolve()
  private pendingWrites = 0
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly searches = new Set<Promise<ContextPacket>>()
  private readonly readers = new Set<Promise<void>>()
  private readonly recovered = new Map<string, Promise<void>>()
  private recoveryEpoch = 0

  /**
   * @param ctx - registrant context providing the retrieval seam's services.
   * @param config - resolved deployment configuration.
   */
  constructor(
    ctx: Context,
    readonly config: Config,
  ) {
    super(ctx, 'retrieval')
    ctx.effect(() => () => this.close())
  }

  /**
   * @returns the authoritative store.
   */
  private get store() {
    this.assertEnabled()
    return this.ctx.vectorStore
  }

  /**
   * @returns the mounted embedding provider.
   */
  private get embeddings() {
    this.assertEnabled()
    return this.ctx.embeddings
  }

  /**
   * @returns the accelerator when one is mounted, enabled by configuration, and not already degraded.
   */
  private get accelerator() {
    if (!this.config.useAccelerator || this.acceleratorDown) return undefined
    return this.ctx.get('accelerator')
  }

  /**
   * Fail every operation while the subsystem is disabled.
   * @returns when retrieval is enabled.
   */
  private assertEnabled(): void {
    if (!this.config.enabled || this.closed) {
      throw new RetrievalError('disabled', 'retrieval is disabled by configuration')
    }
  }

  /**
   * Resolve which scopes a caller may actually read: the request's scopes intersected with the
   * identity's grants. A model cannot widen this set by asking for a scope.
   * @param requested - scopes the caller asked for.
   * @param identity - host-resolved caller identity.
   * @returns permitted scopes, possibly empty.
   */
  authorizeScopes(requested: readonly RecordScope[], identity: TrustedIdentity): RecordScope[] {
    const allowed = requested.filter(scope => SCOPES.includes(scope))
    const owned = allowed.filter((scope) => {
      if (scope === 'user') return identity.allowUserScope && this.config.persistentMemory
      if (scope === 'session') return identity.sessionKey !== null
      if (scope === 'agent') return identity.agentKey !== null
      return true
    })
    if (identity.sessionKey === null && !identity.allowCrossSession) {
      return owned.filter(scope => scope !== 'session')
    }
    return owned
  }

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
  buildFilter(
    identity: TrustedIdentity,
    scopes: readonly RecordScope[],
    pathPrefixes: readonly string[] = [],
    onlyIds: readonly RecordId[] | null = null,
    kinds: readonly RecordKind[] | null = null,
    activeAt: number | null = null,
  ): ReadFilter {
    const crossSession = identity.allowCrossSession && this.config.crossSessionRead
    return {
      activeAt,
      scopes: [...scopes],
      kinds: kinds === null ? null : [...kinds],
      ownerKey: identity.ownerKey,
      workspaceKey: identity.workspaceKey,
      agentKey: identity.agentKey,
      sessionKey: identity.sessionKey,
      crossSession,
      userScope: identity.allowUserScope && this.config.persistentMemory,
      pathPrefixes: [...pathPrefixes],
      onlyIds: onlyIds === null ? null : [...onlyIds],
    }
  }

  /**
   * Embed one text in the store's current space.
   * @param text - query or record text.
   * @param signal - cancellation.
   * @returns a unit-length vector when the space is normalized.
   */
  private async embedOne(text: string, signal?: AbortSignal): Promise<number[]> {
    const space = this.store.space ?? this.embeddings.space
    if (spaceKeyOf(space) !== spaceKeyOf(this.embeddings.space)) {
      throw new RetrievalError('space_mismatch', 'embedding provider differs from the stored space; rebuild the index with the configured provider')
    }
    throwIfAborted(signal, 'embedding')
    const [vector] = await this.embeddings.embed([text], signal)
    if (vector === undefined) throw new RetrievalError('invalid_vector', 'the provider returned no vector')
    assertValidVector(vector, { ...space, normalized: false })
    const prepared = space.normalized ? normalizeVector(vector) : [...vector]
    assertValidVector(prepared, space)
    return prepared
  }

  /**
   * Search records under a caller's authority. Keyword mode uses term matching only; semantic mode
   * uses vectors; hybrid mode fuses both inside the store. An mounted accelerator re-ranks the
   * authorized candidate set and never widens it.
   * @param input - query intent, with limits expressed in the same units the model sees.
   * @param identity - host-resolved caller identity.
   * @returns the packed packet; an empty packet when nothing matched.
   */
  async search(input: RetrievalQuery, identity: TrustedIdentity): Promise<ContextPacket> {
    const signal = this.signalFor(input.signal)
    const work = this.readCurrent(identity, signal, () => this.searchRecords({ ...input, signal }, identity))
    this.searches.add(work)
    try {
      return await work
    } finally {
      this.searches.delete(work)
    }
  }

  private async searchRecords(input: RetrievalQuery, identity: TrustedIdentity): Promise<ContextPacket> {
    this.assertEnabled()
    throwIfAborted(input.signal, 'search')
    this.assertText(input.text, 'query')
    if (!Number.isSafeInteger(input.topK) || input.topK < 0 || input.topK > this.config.maxTopK) {
      throw new RetrievalError('invalid_input', `topK must be between 0 and ${this.config.maxTopK}`)
    }
    const started = performance.now()
    const scopes = this.authorizeScopes(input.scopes, identity)
    this.assertMetadata(input.pathPrefixes, 'path filters')
    if (scopes.length === 0) {
      return {
        candidates: [],
        tokens: 0,
        truncated: false,
        deduplicated: 0,
        servedBy: 'zvec',
        elapsedMs: Math.round(performance.now() - started),
        rendered: '',
      }
    }
    const filter = this.buildFilter(identity, scopes, input.pathPrefixes, null, input.kinds ?? null, Date.now())
    const topK = input.topK > 0 ? input.topK : 8
    const recall = input.mode === 'keyword' ? topK : topK * Math.max(1, this.config.recallMultiplier)
    const groups: Candidate[][] = []
    let queryVector: number[] | undefined

    if (input.mode === 'keyword') {
      groups.push(await this.rank(await this.store.searchKeyword(input.text, recall, filter, input.signal), input.mode, 'keyword'))
    } else if (input.mode === 'hybrid') {
      queryVector = await this.embedOne(input.text, input.signal)
      groups.push(await this.rank(await this.store.searchHybrid(queryVector, input.text, recall, filter, input.signal), input.mode, 'hybrid'))
    } else {
      queryVector = await this.embedOne(input.text, input.signal)
      groups.push(await this.rank(await this.store.searchVector(queryVector, recall, filter, input.signal), input.mode, 'vector'))
    }

    let servedBy: ContextPacket['servedBy'] = 'zvec'
    const accelerator = this.accelerator
    const primary = groups[0] ?? []
    if (accelerator !== undefined && queryVector !== undefined && primary.length > 0) {
      const reranked = await this.rerank(accelerator, primary, queryVector, topK, input.signal)
      if (reranked !== undefined) {
        groups.splice(0, groups.length, reranked)
        servedBy = 'zvec+accelerator'
      }
    }

    throwIfAborted(input.signal, 'search')
    const merged = mergeCandidates(groups).filter((candidate) => {
      this.assertOwnership(candidate.record, identity, 'read')
      const record = candidate.record
      return record.kind !== 'memory' || (!record.pending && record.supersededBy === null && (record.expiresAt === null || record.expiresAt > Date.now()))
    })
    const query: RetrievalQuery = {
      ...input,
      topK,
      minScore: input.minScore > 0 ? input.minScore : this.config.defaultMinScore,
      budgetTokens: input.budgetTokens > 0 ? input.budgetTokens : this.config.defaultBudgetTokens,
    }
    const { packet, text } = pack(merged, query)
    return { ...packet, rendered: text, servedBy, elapsedMs: Math.round(performance.now() - started) }
  }

  /**
   * Calibrate backend scores, fetching only the records a producer did not already return. A store
   * that carries full records on its hits therefore costs one round trip, not two.
   * @param hits - producer hits.
   * @param mode - query mode.
   * @param origin - producer label.
   * @returns candidates with records attached.
   */
  private async rank(hits: readonly BackendHit[], mode: RetrievalQuery['mode'], origin: Candidate['origin']): Promise<Candidate[]> {
    if (hits.length === 0) return []
    const missing = hits.filter(hit => hit.record === undefined).map(hit => hit.id)
    const records = missing.length === 0 ? [] : await this.store.fetch(missing)
    return toCandidates(hits, new Map(records.map(record => [record.id, record])), origin, mode)
  }

  /**
   * Re-rank an already-authorized candidate set through the accelerator. Any accelerator failure
   * marks it degraded for the rest of this activation and returns `undefined`, leaving the store's
   * own ordering in force.
   * @param accelerator - the mounted accelerator.
   * @param candidates - store-authorized candidates.
   * @param queryVector - embedded query.
   * @param topK - result ceiling.
   * @returns re-ranked candidates, or `undefined` when the accelerator failed.
   */
  private async rerank(
    accelerator: NonNullable<Context['accelerator']>,
    candidates: readonly Candidate[],
    queryVector: readonly number[],
    topK: number,
    signal?: AbortSignal,
  ): Promise<Candidate[] | undefined> {
    const allowlist = candidates.map(candidate => candidate.record.id)
    try {
      const hits = await accelerator.search(queryVector, topK, allowlist, signal)
      const byId = new Map(candidates.map(candidate => [candidate.record.id, candidate]))
      const promoted: Candidate[] = []
      const seen = new Set<RecordId>()
      for (const hit of hits) {
        const candidate = byId.get(hit.id)
        // A hit outside the allowlist would mean the accelerator widened access; distrust the accelerator.
        if (candidate === undefined) {
          this.markDegraded(`accelerator returned unauthorized id ${hit.id}`)
          return undefined
        }
        if (!Number.isFinite(hit.score)) {
          this.markDegraded('accelerator returned a non-finite score')
          return undefined
        }
        if (seen.has(hit.id)) continue
        seen.add(hit.id)
        promoted.push({
          ...candidate,
          rawScore: hit.score,
          score: calibrate(hit.score, scaleFor('accelerator', 'semantic')),
          origin: 'accelerator',
        })
      }
      for (const candidate of candidates) if (!seen.has(candidate.record.id)) promoted.push(candidate)
      return promoted
    } catch (error) {
      throwIfAborted(signal, 'accelerator search')
      this.markDegraded(`accelerator search failed: ${String(error instanceof Error ? error.message : error)}`)
      return undefined
    }
  }

  /**
   * Record a degradation and stop using the accelerator for this activation.
   * @param reason - diagnostic text.
   * @returns nothing.
   */
  private markDegraded(reason: string): void {
    this.acceleratorDown = true
    this.lastError = reason
  }

  /**
   * Store one explicit memory. Personal (`user` scope) writes require the opt-in configuration.
   * A duplicate of an existing readable memory returns that record instead of writing again.
   * @param input - memory text, scope, tags, optional ttl and supersession list.
   * @param identity - host-resolved caller identity.
   * @param signal - cancellation before the durable write.
   * @returns the stored or reused memory.
   */
  async remember(input: RememberInput, identity: TrustedIdentity, signal?: AbortSignal): Promise<MemoryRecord> {
    const cancellation = this.signalFor(signal)
    return this.exclusive(async () => {
      await this.reconcilePending(identity, cancellation)
      return await this.writeMemory(input, identity, cancellation)
    }, cancellation)
  }

  private async writeMemory(input: RememberInput, identity: TrustedIdentity, signal?: AbortSignal): Promise<MemoryRecord> {
    this.assertEnabled()
    this.assertText(input.text, 'memory')
    this.assertMetadata([...(input.tags ?? []), ...(input.supersedes ?? []), input.attribution.ref], 'memory metadata')
    const text = input.text.trim()
    if (text.length === 0) throw new RetrievalError('invalid_input', 'memory text must not be empty')
    if (!SCOPES.includes(input.scope)) throw new RetrievalError('invalid_input', `unknown memory scope ${input.scope}`)
    if (this.authorizeScopes([input.scope], identity).length === 0) {
      throw new RetrievalError('unauthorized', `scope ${input.scope} is not granted to this caller`)
    }
    const superseded: MemoryRecord[] = []
    for (const id of new Set(input.supersedes ?? [])) {
      const [record] = await this.store.fetch([id])
      if (record === undefined || record.kind !== 'memory') throw new RetrievalError('not_found', `no memory ${id}`)
      this.assertOwnership(record, identity, 'write')
      if (record.scope !== input.scope) throw new RetrievalError('invalid_input', 'a replacement memory must keep the previous memory scope')
      superseded.push(record)
    }
    const existing = await this.findDuplicate(text, identity, input.scope)
    if (existing !== undefined) {
      if (superseded.length === 0) return existing
      this.assertOwnership(existing, identity, 'write')
      if (!superseded.some(record => record.id === existing.id)) superseded.push(existing)
    }
    const population = await this.listMemoryRecords(identity, { includeExpired: true, includeSuperseded: true })
    if (population.length >= this.config.maxMemories) {
      throw new RetrievalError('invalid_input', `memory cap reached (${this.config.maxMemories}); forget before remembering`)
    }
    const now = Date.now()
    const ttl = input.ttlMs ?? this.config.defaultMemoryRetentionDays * 86_400_000
    const record: MemoryRecord = {
      kind: 'memory',
      pending: superseded.length > 0,
      id: newMemoryId(),
      scope: input.scope,
      ownerKey: identity.ownerKey,
      agentKey: input.scope === 'agent' ? identity.agentKey : null,
      workspaceKey: identity.workspaceKey,
      sessionKey: input.scope === 'workspace' || input.scope === 'user' ? null : identity.sessionKey,
      text,
      tags: [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(tag => tag.length > 0))],
      attribution: input.attribution,
      version: 1,
      supersedes: superseded.map(record => record.id),
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: ttl > 0 ? now + ttl : null,
      contentHash: contentHash(text),
      spaceKey: spaceKeyOf(this.store.space ?? this.embeddings.space),
    }
    if (!Number.isFinite(ttl) || ttl < 0) throw new RetrievalError('invalid_input', 'memory ttl must be a finite non-negative number')
    const vector = await this.embedOne(text, signal)
    throwIfAborted(signal, 'remember')
    let staged = false
    try {
      await this.writeComplete([record], new Map([[record.id, vector]]), signal)
      staged = true
      const current = record.pending ? await this.finishSupersession(record, superseded, signal) : record
      await this.syncAccelerator(current, vector)
      return current
    } catch (error) {
      this.invalidateRecovery()
      if (!staged && error instanceof RetrievalError && error.code === 'cancelled') throw error
      throw new RetrievalError('outcome_pending', `memory ${record.id} may have been stored; the next authorized retrieval or context rebuild reconciles pending supersession before returning facts`, false, { id: record.id, cause: String(error instanceof Error ? error.message : error) })
    }
  }

  /**
   * Rewrite one memory in place, bumping its version. Only the owning identity may write it.
   * @param id - memory id.
   * @param patch - fields to change.
   * @param identity - host-resolved caller identity.
   * @param signal - cancellation before the durable write.
   * @returns the updated record.
   */
  async updateMemory(id: RecordId, patch: MemoryPatch, identity: TrustedIdentity, signal?: AbortSignal): Promise<MemoryRecord> {
    const cancellation = this.signalFor(signal)
    return this.exclusive(async () => {
      await this.reconcilePending(identity, cancellation)
      return await this.rewriteMemory(id, patch, identity, cancellation)
    }, cancellation)
  }

  private async rewriteMemory(id: RecordId, patch: MemoryPatch, identity: TrustedIdentity, signal?: AbortSignal): Promise<MemoryRecord> {
    this.assertEnabled()
    const [current] = await this.store.fetch([id])
    if (current === undefined || current.kind !== 'memory') throw new RetrievalError('not_found', `no memory ${id}`)
    this.assertOwnership(current, identity, 'write')
    const text = patch.text === undefined ? current.text : patch.text.trim()
    this.assertText(text, 'memory')
    this.assertMetadata(patch.tags ?? [], 'memory tags')
    if (patch.expiresAt !== undefined && patch.expiresAt !== null && (!Number.isFinite(patch.expiresAt) || patch.expiresAt < 0)) {
      throw new RetrievalError('invalid_input', 'memory expiry must be a finite non-negative timestamp or null')
    }
    const updated: MemoryRecord = {
      ...current,
      text,
      tags: patch.tags === undefined ? current.tags : [...new Set(patch.tags.map(tag => tag.trim()).filter(tag => tag.length > 0))],
      version: current.version + 1,
      updatedAt: Date.now(),
      expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
      contentHash: contentHash(text),
    }
    const vector = await this.embedOne(text, signal)
    throwIfAborted(signal, 'memory update')
    const outcome = await this.store.write([updated], new Map([[updated.id, vector]]), signal)
    if (outcome.written !== 1 || outcome.rejected !== 0 || outcome.spaceConflict !== null) {
      throw new RetrievalError('outcome_pending', `memory ${updated.id} update may have committed; retrieve the current version before retrying`, false, { id: updated.id })
    }
    await this.syncAccelerator(updated, vector)
    return updated
  }

  /**
   * Delete memories and prove the deletion by re-reading the store.
   * @param selector - ids, expired sweep, and scope sweep.
   * @param identity - host-resolved caller identity.
   * @param signal - cancellation before deletion; once started, deletion is completed and verified.
   * @returns ids durably removed.
   */
  async forget(selector: ForgetSelector, identity: TrustedIdentity, signal?: AbortSignal): Promise<RecordId[]> {
    const cancellation = this.signalFor(signal)
    return this.exclusive(async () => {
      await this.reconcilePending(identity, cancellation)
      return await this.deleteMemories(selector, identity, cancellation)
    }, cancellation)
  }

  private async deleteMemories(selector: ForgetSelector, identity: TrustedIdentity, signal?: AbortSignal): Promise<RecordId[]> {
    this.assertEnabled()
    if ((selector.ids?.length ?? 0) > this.config.maxMemories) throw new RetrievalError('invalid_input', 'forget selection exceeds maxMemories')
    const targets = new Set<RecordId>(selector.ids ?? [])
    if (selector.includeExpired === true || (selector.scopes?.length ?? 0) > 0) {
      for (const record of await this.listMemoryRecords(identity, { includeExpired: true, includeSuperseded: true })) {
        if (selector.includeExpired === true && record.expiresAt !== null && record.expiresAt <= Date.now()) targets.add(record.id)
        if (selector.scopes?.includes(record.scope) === true) targets.add(record.id)
      }
    }
    if (targets.size === 0) return []
    const owned: RecordId[] = []
    for (const record of await this.store.fetch([...targets])) {
      if (record.kind !== 'memory') throw new RetrievalError('unauthorized', 'memory forgetting cannot delete indexed source records')
      this.assertOwnership(record, identity, 'write')
      owned.push(record.id)
    }
    throwIfAborted(signal, 'memory deletion')
    let removed: number
    try {
      removed = await this.store.remove(owned)
    } catch (error) {
      throw new RetrievalError('outcome_pending', 'memory deletion may have partially completed; retry forgetting the same ids after the store is available', false, { ids: owned, cause: String(error instanceof Error ? error.message : error) })
    }
    if (this.lifetime.signal.aborted) throw new RetrievalError('outcome_pending', 'memory deletion was acknowledged but shutdown prevented verification; retry forgetting the same ids after restart', false, { ids: owned })
    const accelerator = this.ctx.get('accelerator')
    if (accelerator?.available === true) {
      try {
        await accelerator.remove(owned)
      } catch (error) {
        this.markDegraded(`accelerator delete failed: ${String(error instanceof Error ? error.message : error)}`)
      }
    }
    const survivors = await this.store.fetch(owned)
    if (survivors.length > 0) {
      throw new RetrievalError('outcome_pending', `${survivors.length} memories remain after deletion; retry forgetting the same ids`, false, { ids: owned })
    }
    if (removed !== owned.length) throw new RetrievalError('outcome_pending', 'memory deletion counters disagree with verified storage; inspect memory_status before retrying', false, { ids: owned })
    return owned
  }

  /**
   * Read memories the caller may see, newest first, dropping expired and superseded rows by default.
   * @param identity - host-resolved caller identity.
   * @param options - `includeExpired` keeps expired rows, `includeSuperseded` keeps replaced rows.
   * @returns matching records.
   */
  async listMemories(
    identity: TrustedIdentity,
    options: { includeExpired?: boolean; includeSuperseded?: boolean } = {},
  ): Promise<MemoryRecord[]> {
    return await this.readCurrent(identity, this.lifetime.signal, () => this.listMemoryRecords(identity, options))
  }

  private async listMemoryRecords(
    identity: TrustedIdentity,
    options: { includeExpired?: boolean; includeSuperseded?: boolean; includePending?: boolean } = {},
  ): Promise<MemoryRecord[]> {
    const scopes = this.authorizeScopes(['user', 'workspace', 'session', 'agent'], identity)
    if (scopes.length === 0) return []
    const filter = this.buildFilter(identity, scopes, [], null, ['memory'])
    const ids = await this.store.listIds(filter, this.config.maxMemories * 2)
    const records = await this.store.fetch(ids)
    const now = Date.now()
    return records
      .filter((record): record is MemoryRecord => record.kind === 'memory')
      .filter(record => options.includePending === true || !record.pending)
      .filter(record => options.includeExpired === true || record.expiresAt === null || record.expiresAt > now)
      .filter(record => options.includeSuperseded === true || record.supersededBy === null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Count authorized memories by their current lifecycle state.
   * @param identity - host-resolved caller identity.
   * @returns active, expired, superseded, and pending memory counts.
   */
  async countMemories(identity: TrustedIdentity): Promise<MemoryCounts> {
    const all = await this.withRead(() => this.listMemoryRecords(identity, {
      includeExpired: true, includeSuperseded: true, includePending: true,
    }))
    const now = Date.now()
    return {
      pending: all.filter(record => record.pending).length,
      active: all.filter(record => !record.pending && record.supersededBy === null
        && (record.expiresAt === null || record.expiresAt > now)).length,
      expired: all.filter(record => !record.pending && record.expiresAt !== null && record.expiresAt <= now).length,
      superseded: all.filter(record => !record.pending && record.supersededBy !== null).length,
    }
  }

  /**
   * Find an already-stored memory whose text is a duplicate of `text` under the same scope.
   * @param text - proposed memory text.
   * @param identity - host-resolved caller identity.
   * @param scope - scope to search within.
   * @returns the existing record, or `undefined`.
   */
  private async findDuplicate(text: string, identity: TrustedIdentity, scope: RecordScope): Promise<MemoryRecord | undefined> {
    const hash = contentHash(text)
    for (const record of await this.listMemoryRecords(identity)) {
      if (record.scope !== scope) continue
      if (scope === 'session' && record.sessionKey !== identity.sessionKey) continue
      if (scope === 'agent' && (record.sessionKey !== identity.sessionKey || record.agentKey !== identity.agentKey)) continue
      if (record.contentHash === hash) return record
    }
    return undefined
  }

  /**
   * Mirror a written memory into the accelerator, ignoring failures so the authoritative write stands.
   * @param record - the stored record.
   * @param vector - its dense vector.
   * @returns nothing.
   */
  private async syncAccelerator(record: MemoryRecord, vector: readonly number[]): Promise<void> {
    const accelerator = this.accelerator
    if (accelerator === undefined || !accelerator.available) return
    try {
      await accelerator.add([record.id], [vector])
    } catch (error) {
      this.markDegraded(`accelerator add failed: ${String(error instanceof Error ? error.message : error)}`)
    }
  }

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
  async rebuildAccelerator(identity: TrustedIdentity, signal?: AbortSignal): Promise<number> {
    const cancellation = this.signalFor(signal)
    this.invalidateRecovery()
    return this.readCurrent(identity, cancellation, async () => {
      const accelerator = this.ctx.get('accelerator')
      if (!this.config.useAccelerator || accelerator === undefined) return 0
      const space = this.store.space ?? this.embeddings.space
      if (spaceKeyOf(space) !== spaceKeyOf(this.embeddings.space)) {
        throw new RetrievalError('space_mismatch', 'accelerator rebuild requires the configured embedding provider to match the authoritative store')
      }
      const scopes = this.authorizeScopes(SCOPES, identity)
      const filter = this.buildFilter(identity, scopes, [], null, null, Date.now())
      const ids = await this.store.listIds(filter, this.config.maxRebuildRecords + 1)
      if (ids.length > this.config.maxRebuildRecords) throw new RetrievalError('invalid_input', 'accelerator rebuild exceeds maxRebuildRecords; select smaller scopes or raise the configured limit')
      this.acceleratorDown = true
      let copied = 0
      try {
        if (ids.length === 0) await this.acceleratorOperation(() => accelerator.rebuild([], [], cancellation))
        for (let start = 0; start < ids.length; start += this.config.rebuildBatchSize) {
          throwIfAborted(cancellation, 'accelerator rebuild')
          const batch = ids.slice(start, start + this.config.rebuildBatchSize)
          const records = await this.store.fetch(batch)
          if (records.length !== batch.length) throw new RetrievalError('unavailable', 'source records changed during accelerator rebuild; retry after indexing finishes', true)
          for (const record of records) this.assertOwnership(record, identity, 'read')
          const vectors = await this.embeddings.embed(records.map(record => record.text), cancellation)
          if (vectors.length !== records.length) throw new RetrievalError('invalid_vector', 'embedding provider returned the wrong rebuild batch length')
          const prepared = vectors.map((vector) => {
            assertValidVector(vector, { ...space, normalized: false })
            const result = space.normalized ? normalizeVector(vector) : [...vector]
            assertValidVector(result, space)
            return result
          })
          const recordIds = records.map(record => record.id)
          const count = start === 0
            ? await this.acceleratorOperation(() => accelerator.rebuild(recordIds, prepared, cancellation))
            : await this.acceleratorOperation(() => accelerator.add(recordIds, prepared, cancellation))
          if (count !== recordIds.length) throw new RetrievalError('unavailable', 'accelerator did not accept every rebuild record', true, { component: 'accelerator' })
          copied += count
        }
        const current = await this.store.listIds({ ...filter, activeAt: Date.now() }, this.config.maxRebuildRecords + 1)
        const expected = new Set(ids)
        if (current.length !== ids.length || current.some(id => !expected.has(id))) {
          throw new RetrievalError('unavailable', 'source records changed during accelerator rebuild; retry after indexing finishes', true)
        }
        await this.acceleratorOperation(() => accelerator.sync())
        throwIfAborted(cancellation, 'accelerator rebuild')
        this.acceleratorDown = false
        this.lastError = null
        return copied
      } catch (error) {
        this.markDegraded('accelerator rebuild failed; authoritative Zvec retrieval remains available')
        throw error
      }
    })
  }

  /**
   * Reject a read or write of a record the caller does not own. Ownership is workspace- plus
   * scope-bound: a session record belongs to its own session unless cross-session read was granted.
   * @param record - the record in question.
   * @param identity - host-resolved caller identity.
   * @param mode - `read` or `write`; a write always needs the caller's own session or agent.
   * @returns nothing.
   */
  assertOwnership(record: StoredRecord, identity: TrustedIdentity, mode: 'read' | 'write'): void {
    if (record.ownerKey !== identity.ownerKey) {
      throw new RetrievalError('unauthorized', `record ${record.id} belongs to another principal`)
    }
    if (record.workspaceKey !== identity.workspaceKey && record.scope !== 'user') {
      throw new RetrievalError('unauthorized', `record ${record.id} belongs to another workspace`)
    }
    if (record.scope === 'user' && (!identity.allowUserScope || !this.config.persistentMemory)) {
      throw new RetrievalError('unauthorized', 'user-scope memory requires enabled personal memory and the host authority grant')
    }
    if (record.scope === 'session' && record.sessionKey !== identity.sessionKey) {
      const allowed = mode === 'read' && identity.allowCrossSession && this.config.crossSessionRead
      if (!allowed) throw new RetrievalError('unauthorized', `record ${record.id} belongs to another session`)
    }
    if (record.scope === 'agent' && (record.agentKey !== identity.agentKey || record.sessionKey !== identity.sessionKey || identity.agentKey === null)) {
      throw new RetrievalError('unauthorized', `record ${record.id} belongs to another agent`)
    }
  }

  /**
   * Render a packet for injection, framed so a model reads the passages as data.
   * @param packet - a completed search packet.
   * @returns the injection block, or `''` when the packet is empty.
   */
  renderInjection(packet: ContextPacket): string {
    return renderInjection(packet.candidates, packet.rendered)
  }

  /**
   * Inspect backend health and authorized memory counters.
   * @param identity - host-resolved caller identity, or `undefined` for a global health view.
   * @param indexedRoots - absolute roots the indexing service currently maintains.
   * @returns store, accelerator, embedding, and memory counters.
   */
  async status(identity?: TrustedIdentity, indexedRoots: readonly string[] = []): Promise<RetrievalStatus> {
    if (!this.config.enabled || this.closed) {
      return {
        enabled: false, store: null, accelerator: null, embedding: null,
        memories: { active: 0, expired: 0, superseded: 0, pending: 0 }, indexedRoots: [], lastError: this.lastError,
      }
    }
    let store: StoreStats | null = null
    let accelerator: AcceleratorStats | null = null
    try {
      store = await this.ctx.vectorStore.stats()
    } catch (error) {
      this.lastError = `store stats failed: ${String(error instanceof Error ? error.message : error)}`
    }
    const mounted = this.ctx.get('accelerator')
    if (mounted !== undefined) {
      try {
        accelerator = await mounted.stats()
      } catch (error) {
        accelerator = {
          backend: 'unknown',
          available: false,
          vectors: 0,
          bitWidth: 0,
          drift: -1,
          degradedReason: String(error instanceof Error ? error.message : error),
        }
      }
    }
    let memories = { active: 0, expired: 0, superseded: 0, pending: 0 }
    if (identity !== undefined) {
      try {
        memories = await this.countMemories(identity)
      } catch (error) {
        this.lastError = `memory counts unavailable: ${String(error instanceof Error ? error.message : error)}`
      }
    }
    const space = this.ctx.get('embeddings')?.space
    return {
      enabled: this.config.enabled,
      store,
      accelerator,
      embedding: space === undefined ? null : { provider: space.provider, model: space.model, dimension: space.dimension },
      memories,
      indexedRoots: [...indexedRoots],
      lastError: this.lastError,
    }
  }

  /** Identify optional worker failures without relabeling failures in the authoritative store. */
  private async acceleratorOperation<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw new RetrievalError(error instanceof RetrievalError ? error.code : 'unavailable', 'optional accelerator operation failed', error instanceof RetrievalError && error.retryable, { component: 'accelerator', cause: String(error instanceof Error ? error.message : error) })
    }
  }

  /** Reject partial native writes without reporting an unverified commit. */
  private async writeComplete(
    records: readonly StoredRecord[], vectors: ReadonlyMap<RecordId, readonly number[]>, signal?: AbortSignal,
  ): Promise<void> {
    const outcome = await this.store.write(records, vectors, signal)
    if (outcome.written !== records.length || outcome.rejected !== 0 || outcome.spaceConflict !== null) {
      throw new RetrievalError('backend_error', 'memory batch was not fully acknowledged')
    }
  }

  /** Complete a staged intent; its original scope determines the permitted predecessor records. */
  private async finishSupersession(record: MemoryRecord, previous: readonly MemoryRecord[], signal?: AbortSignal): Promise<MemoryRecord> {
    throwIfAborted(signal, 'memory supersession')
    if (previous.length > 0) {
      await this.writeComplete(previous.map(prior => ({ ...prior, supersededBy: record.id, updatedAt: Date.now() })), new Map(), signal)
    }
    throwIfAborted(signal, 'memory supersession')
    const current = { ...record, pending: false }
    await this.writeComplete([current], new Map(), signal)
    return current
  }

  /** Roll forward only intents already accepted under this principal's original owning scope. */
  private async reconcilePending(identity: TrustedIdentity, signal?: AbortSignal): Promise<void> {
    this.assertEnabled()
    throwIfAborted(signal, 'memory recovery')
    const scopes = this.authorizeScopes(SCOPES, identity)
    const filter = { ...this.buildFilter(identity, scopes, [], null, ['memory']), pendingOnly: true }
    const ids = await this.store.listIds(filter, this.config.maxMemories + 1)
    if (ids.length > this.config.maxMemories) throw new RetrievalError('outcome_pending', 'pending memory count exceeds maxMemories; inspect the configured index before recovery')
    for (const record of await this.store.fetch(ids)) {
      if (record.kind !== 'memory' || !record.pending) continue
      this.assertOwnership(record, identity, 'read')
      const origin = { ...identity, workspaceKey: record.workspaceKey, sessionKey: record.sessionKey, agentKey: record.agentKey }
      const previous = await this.store.fetch(record.supersedes)
      const predecessors: MemoryRecord[] = []
      for (const prior of previous) {
        if (prior.kind !== 'memory' || prior.scope !== record.scope || prior.pending) throw new RetrievalError('outcome_pending', 'pending memory refers to an incompatible predecessor; inspect the index before recovery')
        this.assertOwnership(prior, origin, 'write')
        if (prior.supersededBy !== null && prior.supersededBy !== record.id) throw new RetrievalError('outcome_pending', 'pending memory predecessor already has another replacement; inspect the index before recovery')
        predecessors.push(prior)
      }
      try {
        await this.finishSupersession(record, predecessors, signal)
      } catch (error) {
        this.invalidateRecovery()
        throw new RetrievalError('outcome_pending', `memory ${record.id} supersession is pending; retry authorized retrieval after the provider is available`, false, { id: record.id, cause: String(error instanceof Error ? error.message : error) })
      }
    }
  }

  /** Invalidate completed recovery scopes after an operation can leave a durable staged intent. */
  private invalidateRecovery(): void {
    this.recovered.clear()
    this.recoveryEpoch++
  }

  /** Recover once per authorization scope and activation; failed operations invalidate these entries. */
  private async ensureRecovered(identity: TrustedIdentity, signal: AbortSignal): Promise<void> {
    const key = JSON.stringify([
      identity.ownerKey, identity.workspaceKey, identity.sessionKey, identity.agentKey, identity.allowCrossSession, identity.allowUserScope,
    ])
    let recovered = this.recovered.get(key)
    if (recovered === undefined) {
      recovered = this.exclusive(() => this.reconcilePending(identity, signal), signal)
      this.recovered.set(key, recovered)
      if (this.recovered.size > this.config.maxRecoveryScopes) {
        const oldest = this.recovered.keys().next().value
        if (oldest !== undefined) this.recovered.delete(oldest)
      }
      void recovered.catch(() => { if (this.recovered.get(key) === recovered) this.recovered.delete(key) })
    }
    await recovered
  }

  /** Admit concurrent readers while preventing a memory mutation from changing their current facts. */
  private async withRead<T>(run: () => Promise<T>): Promise<T> {
    this.assertEnabled()
    const predecessor = this.writing
    let release: () => void = () => undefined
    const settled = new Promise<void>((resolve) => { release = resolve })
    this.readers.add(settled)
    try {
      await predecessor
      this.assertEnabled()
      return await run()
    } finally {
      this.readers.delete(settled)
      release()
    }
  }

  /** Retry recovery if a preceding mutation left an intent after this reader's initial check. */
  private async readCurrent<T>(identity: TrustedIdentity, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    for (;;) {
      await this.ensureRecovered(identity, signal)
      const epoch = this.recoveryEpoch
      const result = await this.withRead(async () => {
        throwIfAborted(signal, 'memory read')
        if (epoch !== this.recoveryEpoch) return { retry: true as const }
        return { retry: false as const, value: await run() }
      })
      if (!result.retry) return result.value
    }
  }

  /** Combine caller cancellation with this activation's lifetime. */
  private signalFor(signal?: AbortSignal): AbortSignal {
    return signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
  }

  /** Reject oversized text before embedding or storage. */
  private assertText(text: string, kind: string): void {
    if (text.trim().length === 0 || text.length > this.config.maxTextChars) {
      throw new RetrievalError('invalid_input', `${kind} text must contain 1 to ${this.config.maxTextChars} characters`)
    }
  }

  /** Bound metadata before it can produce a large filter or stored record. */
  private assertMetadata(values: readonly string[], name: string): void {
    let size = 0
    for (const value of values) {
      size += value.length
      if (size > this.config.maxTextChars || values.length > this.config.maxMemories) {
        throw new RetrievalError('invalid_input', `${name} exceeds the configured memory limits`)
      }
    }
  }

  /** Serialize read-modify-write memory operations and bound the pending queue. */
  private exclusive<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertEnabled()
    throwIfAborted(signal, 'memory mutation')
    if (this.pendingWrites >= this.config.maxPendingWrites) {
      return Promise.reject(new RetrievalError('unavailable', 'memory write queue is full; retry after pending writes finish', true))
    }
    this.pendingWrites++
    const readers = [...this.readers]
    const next = this.writing.then(async () => {
      await Promise.all(readers)
      throwIfAborted(signal, 'memory mutation')
      return await run()
    })
    this.writing = next.then(() => { this.pendingWrites-- }, () => { this.pendingWrites-- })
    return next
  }

  /**
   * Stop accepting mutations and await this service's queued writes. Providers retain ownership of their resources.
   * @returns when resources are released.
   */
  async close(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    await Promise.allSettled([this.writing, ...this.searches, ...this.readers])
  }
}

export default RetrievalService
