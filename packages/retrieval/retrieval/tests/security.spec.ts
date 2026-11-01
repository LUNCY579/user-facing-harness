/** Regression coverage for host identity, memory mutations, and bounded indexing. */
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq, SessionLogOffset, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionPersistence, SessionPersistenceRevision, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OwnerKey, WorkspaceKey, SessionKey, AgentKey, RecordId,
  Accelerator, Embeddings, IndexingService, RetrievalService, VectorStore, contentHash, spaceKeyOf,
  tokenOf, throwIfAborted, type BackendHit, type ChunkRecord, type EmbeddingSpace, type ReadFilter, type StoredRecord, type TrustedIdentity,
} from '../src/index.ts'

const SPACE: EmbeddingSpace = { provider: 'fixture', model: 'fixture-v1', dimension: 8, normalized: true }
const ROOT_ID: TrustedIdentity = { ownerKey: OwnerKey('owner-a'), workspaceRoot: '/fixture', workspaceKey: WorkspaceKey('workspace-a'), sessionKey: SessionKey('session-a'), agentKey: AgentKey('agent-a'), allowUserScope: true, allowCrossSession: true }
const contexts: Context[] = []
const directories: string[] = []

class FixtureEmbeddings extends Embeddings {
  gate: Promise<void> | null = null
  entered: (() => void) | null = null
  override get space(): EmbeddingSpace { return SPACE }
  override async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    this.entered?.()
    if (this.gate !== null) await this.gate
    throwIfAborted(signal, 'fixture embedding')
    return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0])
  }
  override async close(): Promise<void> {}
}

class FixtureStore extends VectorStore {
  closed = false
  beforeWrite: ((records: readonly StoredRecord[], signal?: AbortSignal) => Promise<void>) | null = null
  constructor(ctx: Context) { super(ctx); ctx.effect(() => () => this.close()) }
  readonly records = new Map<RecordId, StoredRecord>()
  failWrites = false
  rejectWrites = false
  lastFilter: ReadFilter | null = null
  override get space(): EmbeddingSpace { return SPACE }
  override async write(records: readonly StoredRecord[], _vectors?: ReadonlyMap<RecordId, readonly number[]>, signal?: AbortSignal) {
    if (this.closed) throw new Error('fixture store already closed')
    if (this.beforeWrite !== null) await this.beforeWrite(records, signal)
    throwIfAborted(signal, 'fixture store write')
    if (this.closed) throw new Error('fixture store closed before resource use')
    if (this.failWrites) throw new Error('fixture interrupted write')
    if (this.rejectWrites) return { written: 0, rejected: records.length, spaceConflict: null }
    for (const record of records) this.records.set(record.id, record)
    return { written: records.length, rejected: 0, spaceConflict: null }
  }
  override async remove(ids: readonly RecordId[]): Promise<number> {
    let removed = 0
    for (const id of ids) if (this.records.delete(id)) removed++
    return removed
  }
  private hits(filter: ReadFilter, limit: number): BackendHit[] {
    this.lastFilter = filter
    return [...this.records.values()].filter(record => record.ownerKey === filter.ownerKey && filter.scopes.includes(record.scope)
      && (record.scope === 'user' || record.workspaceKey === filter.workspaceKey)
      && (record.scope !== 'agent' || (record.agentKey === filter.agentKey && record.sessionKey === filter.sessionKey))
      && (record.scope !== 'session' || filter.crossSession || record.sessionKey === filter.sessionKey)
      && (filter.kinds === null || filter.kinds.includes(record.kind))
      && (filter.pendingOnly !== true || (record.kind === 'memory' && record.pending)))
      .slice(0, limit).map(record => ({ id: record.id, score: 0, record }))
  }
  override async searchVector(_vector: readonly number[], limit: number, filter: ReadFilter): Promise<BackendHit[]> {
    return this.hits(filter, limit)
  }
  override async searchKeyword(_text: string, limit: number, filter: ReadFilter): Promise<BackendHit[]> {
    return this.hits(filter, limit).map(hit => ({ ...hit, score: 10 }))
  }
  override async searchHybrid(_vector: readonly number[], _text: string, limit: number, filter: ReadFilter): Promise<BackendHit[]> {
    return this.hits(filter, limit).map(hit => ({ ...hit, score: 1 }))
  }
  override async fetch(ids: readonly RecordId[]): Promise<StoredRecord[]> {
    return ids.flatMap((id) => {
      const row = this.records.get(id)
      return row === undefined ? [] : [row]
    })
  }
  override async listIds(filter: ReadFilter, limit: number): Promise<RecordId[]> { return this.hits(filter, limit).map(hit => hit.id) }
  override async stats() { return { backend: 'fixture', documents: this.records.size, pending: 0, indexCompleteness: 1, space: spaceKeyOf(SPACE), path: '/fixture' } }
  override async optimize(): Promise<void> {}
  override async close(): Promise<void> { this.closed = true }
}

class FixtureAccelerator extends Accelerator {
  ready = false
  readonly ids = new Set<RecordId>()
  override get available(): boolean { return this.ready }
  override async add(ids: readonly RecordId[]): Promise<number> { for (const id of ids) this.ids.add(id); return ids.length }
  override async search(_vector: readonly number[], topK: number, allowlist: readonly RecordId[]): Promise<BackendHit[]> {
    if (!this.ready) throw new Error('fixture worker unavailable')
    if (allowlist.some(id => !this.ids.has(id))) throw new Error('fixture worker missing an authorized vector')
    return allowlist.slice(0, topK).map(id => ({ id, score: 0 }))
  }
  override async remove(ids: readonly RecordId[]): Promise<number> {
    let removed = 0
    for (const id of ids) if (this.ids.delete(id)) removed++
    return removed
  }
  override async sync(): Promise<void> {}
  override async stats() { return { backend: 'fixture', available: this.ready, vectors: this.ids.size, bitWidth: 4, drift: 0, degradedReason: this.ready ? null : 'fixture unavailable' } }
  override async rebuild(ids: readonly RecordId[]): Promise<number> { this.ids.clear(); this.ready = true; return await this.add(ids) }
  override async close(): Promise<void> { this.ready = false }
}

class FixturePersistence extends SessionPersistence {
  readonly saved = new Map<SessionId, { header: SessionHeader; text: string }>()
  readonly opened: SessionId[] = []
  closed = 0
  override async create(): Promise<SessionHandle> { throw new Error('fixture is read-only') }
  override async flush(): Promise<void> {}
  override async stat(id: SessionId) {
    const item = this.saved.get(id)
    return item === undefined ? undefined : { header: item.header, revision: SessionPersistenceRevision('fixture') }
  }
  override async list() { return [...this.saved.values()].map(item => ({ header: item.header, revision: SessionPersistenceRevision('fixture') })) }
  override async open(id: SessionId): Promise<SessionHandle> {
    const item = this.saved.get(id)
    if (item === undefined) throw new Error('fixture session missing')
    this.opened.push(id)
    const close = async (): Promise<void> => { this.closed++ }
    return {
      id,
      header: item.header,
      inheritedEventCount: SessionLogOffset(0),
      access: 'read',
      async read() {
        const events: SessionEvent[] = [
          { seq: SessionSeq(0), time: 1, type: 'turn/start', data: { turn: 1 } },
          { seq: SessionSeq(1), time: 1, type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: item.text }], source: { kind: 'user' } }), surfaceOp: 'append' },
          { seq: SessionSeq(2), time: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ]
        return { eventState: 'detached', events }
      },
      async append() { throw new Error('fixture is read-only') },
      async flush() { throw new Error('fixture is read-only') },
      close,
      async [Symbol.asyncDispose](this: SessionHandle) { await this.close() },
    }
  }
}

async function fixture(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const store = new FixtureStore(ctx)
  const embeddings = new FixtureEmbeddings(ctx)
  await ctx.plugin(RetrievalService, RetrievalService.Config({ persistentMemory: true, crossSessionRead: true, ...config }))
  return { ctx, store, embeddings }
}

async function sourceFixture(indexing: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'retrieval-security-')))
  directories.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const { ctx, store } = await fixture()
  await ctx.plugin(IndexingService, IndexingService.Config({ roots: [workspace], statePath: join(root, 'ledger.json'), chunkSize: 64, chunkOverlap: 8, maxChunksPerDocument: 4, ...indexing }))
  const identity: TrustedIdentity = { ...ROOT_ID, workspaceRoot: workspace }
  return { ctx, store, identity, workspace, root }
}

const remember = (text: string, scope: 'workspace' | 'user' | 'agent' | 'session' = 'workspace') => ({ text, scope, attribution: { actor: 'user' as const, ref: 'fixture' } })

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('memory authority and lifecycle', () => {
  it('isolates personal memory by host principal while allowing its owner across workspaces', async () => {
    const { ctx } = await fixture()
    await ctx.retrieval.remember(remember('Synthetic preference: tea', 'user'), ROOT_ID)
    expect(await ctx.retrieval.listMemories({ ...ROOT_ID, workspaceKey: WorkspaceKey('workspace-b') })).toHaveLength(1)
    expect(await ctx.retrieval.listMemories({ ...ROOT_ID, ownerKey: OwnerKey('owner-b') })).toEqual([])
  })

  it('rejects another agent write and deletion before changing authoritative storage', async () => {
    const { ctx, store } = await fixture()
    const row = await ctx.retrieval.remember(remember('Agent alpha task state', 'agent'), ROOT_ID)
    const outsider = { ...ROOT_ID, agentKey: AgentKey('agent-b') }
    await expect(ctx.retrieval.updateMemory(row.id, { text: 'hijacked' }, outsider)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(ctx.retrieval.forget({ ids: [row.id] }, outsider)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(store.records.get(row.id)?.text).toBe('Agent alpha task state')
  })

  it('forgets every retained record in an authorized scope while preserving another principal', async () => {
    const { ctx, store } = await fixture()
    const previous = await ctx.retrieval.remember(remember('Previous retained synthetic fact'), ROOT_ID)
    const current = await ctx.retrieval.remember({ ...remember('Current retained synthetic fact'), supersedes: [previous.id] }, ROOT_ID)
    const expired = await ctx.retrieval.remember(remember('Expired synthetic fact'), ROOT_ID)
    await ctx.retrieval.updateMemory(expired.id, { expiresAt: 1 }, ROOT_ID)
    const foreign = await ctx.retrieval.remember(remember('Foreign retained synthetic fact'), { ...ROOT_ID, ownerKey: OwnerKey('owner-b') })
    const forgotten = await ctx.retrieval.forget({ scopes: ['workspace'] }, ROOT_ID)
    expect(new Set(forgotten)).toEqual(new Set([previous.id, current.id, expired.id]))
    expect(await ctx.vectorStore.fetch([previous.id, current.id, expired.id])).toEqual([])
    expect(await ctx.retrieval.listMemories(ROOT_ID, { includeExpired: true, includeSuperseded: true })).toEqual([])
    expect([...store.records.keys()]).toEqual([foreign.id])
  })

  it('does not turn memory forgetting into arbitrary chunk deletion', async () => {
    const { ctx, store } = await fixture()
    const row: ChunkRecord = { kind: 'chunk', id: RecordId('chunk:synthetic'), ownerKey: OwnerKey('owner-b'), workspaceKey: WorkspaceKey('workspace-b'), agentKey: null, sessionKey: null, scope: 'workspace', text: 'foreign source', source: '/other.ts', startLine: 1, endLine: 1, contentHash: contentHash('foreign source'), spaceKey: spaceKeyOf(SPACE), updatedAt: 1 }
    store.records.set(row.id, row)
    await expect(ctx.retrieval.forget({ ids: [row.id] }, ROOT_ID)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(store.records.has(row.id)).toBe(true)
  })

  it('rejects unauthorized supersession before saving the proposed replacement', async () => {
    const { ctx, store } = await fixture()
    const foreign = await ctx.retrieval.remember(remember('Foreign current value'), { ...ROOT_ID, workspaceKey: WorkspaceKey('workspace-b') })
    await expect(ctx.retrieval.remember({ ...remember('Proposed replacement'), supersedes: [foreign.id] }, ROOT_ID)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(store.records.size).toBe(1)
    expect(store.records.get(foreign.id)).toMatchObject({ supersededBy: null })
  })

  it('keeps a one-word correction distinct and supersedes the old value', async () => {
    const { ctx } = await fixture()
    const previous = await ctx.retrieval.remember(remember('Synthetic configuration flag remains enabled for all local retrieval operations in this fixture'), ROOT_ID)
    const current = await ctx.retrieval.remember({ ...remember('Synthetic configuration flag remains disabled for all local retrieval operations in this fixture'), supersedes: [previous.id] }, ROOT_ID)
    expect(current.id).not.toBe(previous.id)
    expect(await ctx.retrieval.listMemories(ROOT_ID)).toEqual([current])
  })

  it('keeps case-sensitive code facts distinct', async () => {
    const { ctx } = await fixture()
    const upper = await ctx.retrieval.remember(remember('Synthetic branch is Foo'), ROOT_ID)
    const lower = await ctx.retrieval.remember(remember('Synthetic branch is foo'), ROOT_ID)
    expect(upper.id).not.toBe(lower.id)
    expect(new Set((await ctx.retrieval.listMemories(ROOT_ID)).map(record => record.text)))
      .toEqual(new Set(['Synthetic branch is Foo', 'Synthetic branch is foo']))
  })

  it('honors explicit supersession even when the corrected fact already exists', async () => {
    const { ctx } = await fixture()
    const duplicate = await ctx.retrieval.remember(remember('Correct synthetic value'), ROOT_ID)
    const wrong = await ctx.retrieval.remember(remember('Incorrect synthetic value'), ROOT_ID)
    const current = await ctx.retrieval.remember({ ...remember('Correct synthetic value'), supersedes: [wrong.id] }, ROOT_ID)
    expect(current.id).not.toBe(duplicate.id)
    expect(new Set(current.supersedes)).toEqual(new Set([duplicate.id, wrong.id]))
    expect((await ctx.retrieval.listMemories(ROOT_ID)).map(record => record.id)).toEqual([current.id])
  })

  it('serializes concurrent creation and increments updates without losing versions', async () => {
    const { ctx, store } = await fixture()
    const rows = await Promise.all(Array.from({ length: 8 }, () => ctx.retrieval.remember(remember('Same synthetic fact'), ROOT_ID)))
    expect(new Set(rows.map(row => row.id)).size).toBe(1)
    expect(store.records.size).toBe(1)
    await Promise.all(Array.from({ length: 3 }, (_, n) => ctx.retrieval.updateMemory(rows[0]!.id, { text: `Version ${n}` }, ROOT_ID)))
    expect(store.records.get(rows[0]!.id)).toMatchObject({ version: 4 })
  })

  it('recovers an unavailable accelerator using authorized explicit memories and clears degradation', async () => {
    const { ctx } = await fixture({ useAccelerator: true })
    const accelerator = new FixtureAccelerator(ctx)
    const own = await ctx.retrieval.remember(remember('Owner synthetic personal fact', 'user'), ROOT_ID)
    const foreign = await ctx.retrieval.remember(remember('Foreign synthetic workspace fact'), { ...ROOT_ID, ownerKey: OwnerKey('owner-b') })
    const query = { mode: 'semantic' as const, text: 'synthetic personal fact', topK: 5, scopes: ['user', 'workspace'] as ('user' | 'workspace')[], pathPrefixes: [], minScore: 0, budgetTokens: 0 }
    expect((await ctx.retrieval.search(query, ROOT_ID)).servedBy).toBe('zvec')
    expect(await ctx.retrieval.rebuildAccelerator(ROOT_ID)).toBe(1)
    expect(accelerator.ids.has(own.id)).toBe(true)
    expect(accelerator.ids.has(foreign.id)).toBe(false)
    expect((await ctx.retrieval.search(query, ROOT_ID)).servedBy).toBe('zvec+accelerator')
    expect((await ctx.retrieval.status(ROOT_ID)).lastError).toBeNull()
  })

  it('rejects disabled, oversized, and already-cancelled operations without writes', async () => {
    const disabled = await fixture({ enabled: false })
    await expect(disabled.ctx.retrieval.search({ mode: 'keyword', text: 'query', topK: 1, scopes: [], pathPrefixes: [], minScore: 0, budgetTokens: 0 }, ROOT_ID)).rejects.toMatchObject({ code: 'disabled' })
    const { ctx, store } = await fixture({ maxTextChars: 256 })
    await expect(ctx.retrieval.remember(remember('a'.repeat(257)), ROOT_ID)).rejects.toMatchObject({ code: 'invalid_input' })
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.retrieval.remember(remember('cancelled'), ROOT_ID, controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(store.records.size).toBe(0)
  })

  it('rejects memory operations after disposal without closing the provider it does not own', async () => {
    const { ctx, store } = await fixture()
    await ctx.retrieval.close()
    await expect(ctx.retrieval.remember(remember('late write'), ROOT_ID)).rejects.toMatchObject({ code: 'disabled' })
    expect(store.records.size).toBe(0)
  })
})

describe('workspace indexing safety', () => {
  it('honors ignored files, sensitive names, and symlink escapes', async () => {
    const { ctx, store, identity, workspace, root } = await sourceFixture()
    await writeFile(join(workspace, '.gitignore'), 'private.ts\n')
    await writeFile(join(workspace, 'private.ts'), 'private marker')
    await writeFile(join(workspace, 'credentials.json'), 'credential marker')
    await writeFile(join(workspace, 'safe.ts'), 'safe source marker')
    await writeFile(join(root, 'outside.ts'), 'outside marker')
    await symlink(join(root, 'outside.ts'), join(workspace, 'escape.ts'))
    const result = await ctx.retrievalIndexing.syncWorkspace(identity)
    expect(result.added).toBe(1)
    expect([...store.records.values()].map(row => row.text)).toEqual(['safe source marker'])
  })

  it('refuses a caller whose workspace does not contain the configured root', async () => {
    const { ctx, store, identity, root } = await sourceFixture()
    await expect(ctx.retrievalIndexing.syncWorkspace({ ...identity, workspaceRoot: join(root, 'other') })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(store.records.size).toBe(0)
  })

  it('preserves the previous generation when writing an edited source fails, then recovers', async () => {
    const { ctx, store, identity, workspace, root } = await sourceFixture()
    const source = join(workspace, 'safe.ts')
    await writeFile(source, 'previous synthetic source')
    await ctx.retrievalIndexing.syncWorkspace(identity)
    store.failWrites = true
    await writeFile(source, 'updated synthetic source')
    await expect(ctx.retrievalIndexing.syncWorkspace(identity)).rejects.toThrow('fixture interrupted write')
    expect([...store.records.values()].map(row => row.text)).toEqual(['previous synthetic source'])
    expect((await readLedger(join(root, 'ledger.json'))).pending).not.toEqual({})
    store.failWrites = false
    await ctx.retrievalIndexing.syncWorkspace(identity)
    expect([...store.records.values()].map(row => row.text)).toEqual(['updated synthetic source'])
    expect((await readLedger(join(root, 'ledger.json'))).pending).toEqual({})
  })

  it('rebuild clearing removes orphan chunks after ledger corruption while preserving memories', async () => {
    const { ctx, store, identity, workspace, root } = await sourceFixture()
    await writeFile(join(workspace, 'safe.ts'), 'synthetic source')
    await ctx.retrievalIndexing.syncWorkspace(identity)
    const memory = await ctx.retrieval.remember(remember('Explicit synthetic memory'), identity)
    await writeFile(join(root, 'ledger.json'), '{truncated')
    expect(await ctx.retrievalIndexing.clear(identity)).toBe(1)
    expect([...store.records.keys()]).toEqual([memory.id])
    expect((await ctx.retrievalIndexing.syncWorkspace(identity)).added).toBe(1)
    expect(store.records.size).toBe(2)
  })

  it('does not publish a source ledger for a rejected batch', async () => {
    const { ctx, store, identity, workspace, root } = await sourceFixture()
    await writeFile(join(workspace, 'safe.ts'), 'synthetic source')
    store.rejectWrites = true
    await expect(ctx.retrievalIndexing.syncWorkspace(identity)).rejects.toMatchObject({ code: 'backend_error' })
    const ledger = await readLedger(join(root, 'ledger.json'))
    expect(ledger.sources).toEqual({})
    expect(ledger.pending).not.toEqual({})
    store.rejectWrites = false
    expect((await ctx.retrievalIndexing.syncWorkspace(identity)).added).toBe(1)
    expect(store.records.size).toBe(1)
  })

  it('does not clear another principal indexed records', async () => {
    const { ctx, store, identity, workspace } = await sourceFixture()
    await writeFile(join(workspace, 'safe.ts'), 'synthetic source')
    await ctx.retrievalIndexing.syncWorkspace(identity)
    expect(await ctx.retrievalIndexing.clear({ ...identity, ownerKey: OwnerKey('owner-b') })).toBe(0)
    expect(store.records.size).toBe(1)
  })
})


describe('session indexing authorization', () => {
  it('reads only authorized saved transcripts and closes every read handle', async () => {
    const { ctx, store, identity, workspace, root } = await sourceFixture({ indexSessions: true })
    await ctx.plugin(SessionStore)
    const persistence = new FixturePersistence(ctx)
    const otherWorkspace = join(root, 'other-workspace')
    await mkdir(otherWorkspace)
    for (const [id, cwd, text] of [
      ['history-owned', workspace, 'Authorized synthetic previous decision'],
      ['history-foreign', otherWorkspace, 'Foreign synthetic private decision'],
    ]) {
      if (id === undefined || cwd === undefined || text === undefined) throw new Error('fixture tuple missing')
      const sessionId = SessionId(id)
      persistence.saved.set(sessionId, {
        header: { version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: 1, isSeeded: false }, text,
      })
    }
    const report = await ctx.retrievalIndexing.syncSessions(identity)
    expect(report.added).toBe(1)
    expect(persistence.opened).toEqual([SessionId('history-owned')])
    expect(persistence.closed).toBe(1)
    expect([...store.records.values()].map(row => row.text)).toEqual(['user: Authorized synthetic previous decision'])
  })

  it('does not read a different session without the host cross-session grant', async () => {
    const { ctx, identity, workspace } = await sourceFixture({ indexSessions: true })
    await ctx.plugin(SessionStore)
    const persistence = new FixturePersistence(ctx)
    const sessionId = SessionId('history-owned')
    persistence.saved.set(sessionId, { header: { version: SESSION_FORMAT_VERSION, id: sessionId, cwd: workspace, createdAt: 1, isSeeded: false }, text: 'Authorized only with host grant' })
    expect((await ctx.retrievalIndexing.syncSessions({ ...identity, sessionKey: tokenOf('se', 'current'), allowCrossSession: false })).added).toBe(0)
    expect(persistence.opened).toEqual([])
  })
})


/** A barrier whose completion is controlled by the test's owning operation. */
function barrier() {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('durable memory recovery and disposal', () => {
  it.each(['predecessors', 'activation'] as const)('rolls forward a supersession interrupted at %s', async (phase) => {
    const { ctx, store } = await fixture()
    const previous = await ctx.retrieval.remember(remember('Previous synthetic value'), ROOT_ID)
    const entered = barrier()
    const released = barrier()
    const controller = new AbortController()
    store.beforeWrite = async (records, signal) => {
      const pause = records.some(record => record.kind === 'memory' && (phase === 'predecessors'
        ? record.id === previous.id && record.supersededBy !== null
        : record.id !== previous.id && !record.pending))
      if (!pause) return
      entered.release()
      await released.promise
      throwIfAborted(signal, 'fixture supersession')
    }
    const writing = ctx.retrieval.remember({ ...remember('Current synthetic value'), supersedes: [previous.id] }, ROOT_ID, controller.signal)
    await entered.promise
    controller.abort()
    released.release()
    await expect(writing).rejects.toMatchObject({ code: 'outcome_pending' })
    expect([...store.records.values()].filter(record => record.kind === 'memory' && record.pending)).toHaveLength(1)
    store.beforeWrite = null
    const active = await ctx.retrieval.listMemories(ROOT_ID)
    expect(active.map(record => record.text)).toEqual(['Current synthetic value'])
    expect(active[0]?.pending).toBe(false)
    expect(store.records.get(previous.id)).toMatchObject({ supersededBy: active[0]?.id })
  })

  it('cancels a memory embedding during root disposal without using the closed store', async () => {
    const { ctx, store, embeddings } = await fixture()
    const entered = barrier()
    const released = barrier()
    const closing = barrier()
    embeddings.entered = entered.release
    embeddings.gate = released.promise
    const retrieval = ctx.retrieval
    const close = retrieval.close.bind(retrieval)
    retrieval.close = async () => { closing.release(); await close() }
    const writing = retrieval.remember(remember('Never committed synthetic fact'), ROOT_ID)
    await entered.promise
    let disposed = false
    const disposing = ctx.fiber.dispose().then(() => { disposed = true })
    await closing.promise
    expect(disposed).toBe(false)
    released.release()
    await expect(writing).rejects.toMatchObject({ code: 'cancelled' })
    await disposing
    expect(store.closed).toBe(true)
    expect(store.records.size).toBe(0)
  })

  it('retains a valid source journal when disposal cancels a prepared source write', async () => {
    const { ctx, store, identity, workspace, root } = await sourceFixture()
    await writeFile(join(workspace, 'safe.ts'), 'Prepared synthetic source')
    const entered = barrier()
    const released = barrier()
    store.beforeWrite = async (_records, signal) => { entered.release(); await released.promise; throwIfAborted(signal, 'fixture source write') }
    const closing = barrier()
    const indexer = ctx.retrievalIndexing
    const close = indexer.close.bind(indexer)
    indexer.close = async () => { closing.release(); await close() }
    const indexing = indexer.syncWorkspace(identity)
    await entered.promise
    const disposing = ctx.fiber.dispose()
    await closing.promise
    released.release()
    await expect(indexing).rejects.toMatchObject({ code: 'cancelled' })
    await disposing
    const ledger = await readLedger(join(root, 'ledger.json'))
    expect(ledger.version).toBe(2)
    expect(ledger.sources).toEqual({})
    expect(Object.keys(ledger.pending)).toHaveLength(1)
    expect(store.records.size).toBe(0)
    const restarted = await fixture()
    await restarted.ctx.plugin(IndexingService, IndexingService.Config({ roots: [workspace], statePath: join(root, 'ledger.json'), chunkSize: 64, chunkOverlap: 8 }))
    expect((await restarted.ctx.retrievalIndexing.syncWorkspace(identity)).added).toBe(1)
    expect((await readLedger(join(root, 'ledger.json'))).pending).toEqual({})
  })
})


/** Read the JSON ledger fields observed by recovery tests without trusting JSON.parse's return type. */
async function readLedger(path: string) {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  const fields = jsonObject(parsed)
  return { version: fields['version'], sources: jsonObject(fields['sources']), pending: jsonObject(fields['pending']) }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected JSON object in ledger fixture')
  return value as Record<string, unknown>
}
