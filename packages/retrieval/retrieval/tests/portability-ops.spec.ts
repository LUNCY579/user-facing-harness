/** Coverage for the staged export and import protocol and for its wiring through the retrieval service. */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Accelerator, AgentKey, Embeddings, OwnerKey, RecordId, RetrievalService, SessionKey, SpaceKey,
  VectorStore, WorkspaceKey, contentHash, spaceKeyOf,
  type BackendHit, type ChunkRecord, type EmbeddingSpace, type MemoryRecord, type ReadFilter,
  type RetrievalConfig, type StoredRecord, type TrustedIdentity, type WriteOutcome,
} from '../src/index.ts'
import { exportMemories, importMemories, type PortabilityHost } from '../src/portability-ops.ts'
import {
  MEMORY_EXPORT_VERSION, decodeMemoryExport, encodeMemoryExport, journalPathOf, ledgerPathOf,
  memoryExportOf, writePortabilityJson,
} from '../src/portability.ts'

const SPACE: EmbeddingSpace = { provider: 'test', model: 'test-v1', dimension: 8, normalized: true }
const SOURCE = SpaceKey('source-space')
const TARGET = spaceKeyOf(SPACE)
const VECTOR: readonly number[] = [1, 0, 0, 0, 0, 0, 0, 0]
const NOW = Date.now()
const IDENTITY: TrustedIdentity = {
  ownerKey: OwnerKey('owner-a'), workspaceRoot: '/fixture', workspaceKey: WorkspaceKey('workspace-a'),
  sessionKey: SessionKey('session-a'), agentKey: AgentKey('agent-a'), allowUserScope: true, allowCrossSession: true,
}

const contexts: Context[] = []
const directories: string[] = []
let sequence = 0

/** Engine configuration the protocol reads, with the production defaults for every field it ignores. */
const CONFIG: RetrievalConfig = {
  enabled: true, persistentMemory: true, crossSessionRead: true, useAccelerator: false, recallMultiplier: 4,
  defaultMinScore: 0.2, defaultBudgetTokens: 1200, defaultMemoryRetentionDays: 0, maxMemories: 100,
  maxTextChars: 32_768, maxTopK: 100, maxPendingWrites: 32, rebuildBatchSize: 64, maxRebuildRecords: 100_000,
  maxRecoveryScopes: 128, portabilityEnabled: true, portabilityDir: '/test/portability', maxPortabilityRecords: 10,
}

function config(over: Partial<RetrievalConfig> = {}): RetrievalConfig {
  return Object.assign({}, CONFIG, over)
}

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'retrieval-portability-ops-'))
  directories.push(path)
  return path
}

/** One committed memory with the fixture ownership defaults, its digest recomputed from its text. */
function memory(over: Partial<MemoryRecord> = {}): MemoryRecord {
  const text = over.text ?? `Synthetic memory ${String(sequence)}`
  const record: MemoryRecord = {
    kind: 'memory', pending: false, id: RecordId(`mem-${String(sequence++)}`), scope: 'workspace',
    ownerKey: IDENTITY.ownerKey, workspaceKey: IDENTITY.workspaceKey, sessionKey: null, agentKey: null,
    text, tags: ['preference'], attribution: { actor: 'user', ref: 'fixture' }, version: 1, supersedes: [],
    supersededBy: null, createdAt: NOW, updatedAt: NOW, expiresAt: null,
    contentHash: contentHash(text), spaceKey: SOURCE, ...over,
  }
  return { ...record, contentHash: over.contentHash ?? contentHash(record.text) }
}

/** A stored passage standing in for an id collision with indexed source text. */
function passage(id: RecordId): ChunkRecord {
  return {
    kind: 'chunk', id, scope: 'workspace', ownerKey: IDENTITY.ownerKey, workspaceKey: IDENTITY.workspaceKey,
    sessionKey: null, agentKey: null, source: '/fixture/src.ts', startLine: 0, endLine: 1,
    text: 'indexed source text', contentHash: contentHash('indexed source text'), updatedAt: NOW, spaceKey: SOURCE,
  }
}

/** The lifecycle predicate a native backend applies to memories under a non-null `activeAt`. */
function current(record: MemoryRecord, at: number): boolean {
  return !record.pending && record.supersededBy === null && (record.expiresAt === null || record.expiresAt > at)
}

/** In-memory store that applies the read-filter rules a native backend documents, with fault injection. */
class TestStore extends VectorStore {
  readonly records: Map<RecordId, StoredRecord>
  path: string
  failWrites = false
  removeThrows = false
  surviveRemove = false
  swallowWrites = false
  passageSwap = false
  rewriteStored = false
  unsearchable = false
  ignoreLifecycle = false
  optimizeCount = 0
  searchFilters: ReadFilter[] = []
  acknowledge: (count: number) => WriteOutcome = count => ({ written: count, rejected: 0, spaceConflict: null })

  constructor(ctx: Context, records = new Map<RecordId, StoredRecord>(), path = '/test/store') {
    super(ctx)
    this.records = records
    this.path = path
  }

  override get space(): EmbeddingSpace { return SPACE }

  override async write(records: readonly StoredRecord[], _vectors?: ReadonlyMap<RecordId, readonly number[]>): Promise<WriteOutcome> {
    if (this.failWrites) throw new Error('store write interrupted')
    if (!this.swallowWrites) {
      for (const record of records) {
        if (this.passageSwap) this.records.set(record.id, passage(record.id))
        else if (this.rewriteStored && record.kind === 'memory') this.records.set(record.id, { ...record, text: `${record.text} changed` })
        else this.records.set(record.id, record)
      }
    }
    return this.acknowledge(records.length)
  }

  private rows(filter: ReadFilter): StoredRecord[] {
    const activeAt = this.ignoreLifecycle ? null : filter.activeAt
    return [...this.records.values()].filter((record) => {
      if (record.ownerKey !== filter.ownerKey || !filter.scopes.includes(record.scope)) return false
      if (filter.kinds !== null && !filter.kinds.includes(record.kind)) return false
      if (filter.onlyIds !== null && !filter.onlyIds.includes(record.id)) return false
      if (filter.pendingOnly === true) return record.kind === 'memory' && record.pending
      if (activeAt !== null && record.kind === 'memory' && !current(record, activeAt)) return false
      return true
    })
  }

  private hits(filter: ReadFilter, limit: number): BackendHit[] {
    this.searchFilters.push(filter)
    if (this.unsearchable) return []
    return this.rows(filter).slice(0, limit).map(record => ({ id: record.id, score: 0, record }))
  }

  override async searchVector(_vector: readonly number[], limit: number, filter: ReadFilter): Promise<BackendHit[]> {
    return this.hits(filter, limit)
  }

  override async searchKeyword(_text: string, limit: number, filter: ReadFilter): Promise<BackendHit[]> {
    return this.hits(filter, limit)
  }

  override async searchHybrid(_vector: readonly number[], _text: string, limit: number, filter: ReadFilter): Promise<BackendHit[]> {
    return this.hits(filter, limit)
  }

  override async remove(ids: readonly RecordId[]): Promise<number> {
    if (this.removeThrows) throw new Error('store remove unavailable')
    const snapshot = ids.map(id => this.records.get(id))
    let removed = 0
    for (const id of ids) if (this.records.delete(id)) removed++
    if (this.surviveRemove) {
      ids.forEach((id, index) => {
        const row = snapshot[index]
        if (row !== undefined) this.records.set(id, row)
      })
    }
    return removed
  }

  override async listIds(filter: ReadFilter, limit: number): Promise<RecordId[]> {
    return this.rows(filter).slice(0, limit).map(record => record.id)
  }

  override async fetch(ids: readonly RecordId[]): Promise<StoredRecord[]> {
    return ids.flatMap((id) => {
      const row = this.records.get(id)
      return row === undefined ? [] : [row]
    })
  }

  override async stats() {
    return {
      backend: 'test', documents: this.records.size, pending: 0, indexCompleteness: 1,
      space: spaceKeyOf(SPACE), path: this.path,
    }
  }

  override async optimize(): Promise<void> { this.optimizeCount++ }
  override async close(): Promise<void> {}
}

class TestEmbeddings extends Embeddings {
  shortBatch = false
  override get space(): EmbeddingSpace { return SPACE }
  override async embed(texts: readonly string[]): Promise<number[][]> {
    const vectors = this.shortBatch ? texts.slice(0, 1) : texts
    return vectors.map(() => [...VECTOR])
  }
  override async close(): Promise<void> {}
}

class TestAccelerator extends Accelerator {
  ready = false
  readonly ids = new Set<RecordId>()
  override get available(): boolean { return this.ready }
  override async add(ids: readonly RecordId[]): Promise<number> {
    for (const id of ids) this.ids.add(id)
    return ids.length
  }
  override async search(_vector: readonly number[], topK: number, allowlist: readonly RecordId[]): Promise<BackendHit[]> {
    return allowlist.slice(0, topK).map(id => ({ id, score: 0 }))
  }
  override async remove(ids: readonly RecordId[]): Promise<number> {
    let removed = 0
    for (const id of ids) if (this.ids.delete(id)) removed++
    return removed
  }
  override async sync(): Promise<void> {}
  override async stats() {
    return { backend: 'test', available: this.ready, vectors: this.ids.size, bitWidth: 4, drift: 0, degradedReason: null }
  }
  override async rebuild(ids: readonly RecordId[]): Promise<number> { return await this.add(ids) }
  override async close(): Promise<void> { this.ready = false }
}

/** Filter in the shape the engine's own retrievability probe builds. */
function probeFilter(identity: TrustedIdentity, onlyIds: readonly RecordId[]): ReadFilter {
  return {
    activeAt: Date.now(), scopes: ['user', 'workspace', 'session', 'agent'], kinds: ['memory'],
    ownerKey: identity.ownerKey, workspaceKey: identity.workspaceKey, agentKey: identity.agentKey,
    sessionKey: identity.sessionKey, crossSession: identity.allowCrossSession, userScope: identity.allowUserScope,
    pathPrefixes: [], onlyIds: [...onlyIds],
  }
}

interface Protocol {
  ctx: Context
  dir: string
  store: TestStore
  host: PortabilityHost
  identity: TrustedIdentity
  calls: { mirrored: RecordId[]; invalidated: number }
  journalPath: () => string
}

/** One protocol run over a host double, so every step of the ordering is reachable by overriding a field. */
async function protocol(hostOver: Partial<PortabilityHost> = {}, configOver: Partial<RetrievalConfig> = {}): Promise<Protocol> {
  const dir = await tempDir()
  const ctx = new Context()
  contexts.push(ctx)
  const store = new TestStore(ctx)
  const calls = { mirrored: [] as RecordId[], invalidated: 0 }
  const defaults: PortabilityHost = {
    config: config({ maxMemories: 100, maxPortabilityRecords: 10, ...configOver }),
    store,
    targetSpace: TARGET,
    embed: async records => new Map(records.map(record => [record.id, VECTOR])),
    authorized: async () => [...store.records.values()].flatMap(row => (row.kind === 'memory' ? [row] : [])),
    stored: async ids => await store.fetch(ids),
    duplicate: async () => undefined,
    probeFilter: (identity, onlyIds) => probeFilter(identity, onlyIds),
    assertWritable: () => {},
    mirror: async (vectors) => { calls.mirrored.push(...vectors.keys()) },
    invalidateRecovery: () => { calls.invalidated++ },
  }
  return {
    ctx, dir, store, calls, identity: IDENTITY, journalPath: () => journalPathOf(dir, store.path),
    host: { ...defaults, ...hostOver },
  }
}

/** Export text carrying exactly these records in the source space. */
function exportText(records: readonly MemoryRecord[], sourceSpace = SOURCE): string {
  return encodeMemoryExport({ ...memoryExportOf(records, sourceSpace), records: [...records] })
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

/** Files the operator would recognize, ignoring the transient half-written name an atomic write uses. */
async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(name => !name.endsWith('.tmp')).sort()
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  sequence = 0
})

describe('memory export protocol', () => {
  it('exports active records and leaves expired and superseded rows behind', async () => {
    const run = await protocol()
    const active = memory({ text: 'Keeps tea in the desk drawer' })
    const expired = memory({ text: 'Meeting note from last quarter', expiresAt: NOW - 1000 })
    const superseded = memory({ text: 'Prefers filter coffee', supersededBy: active.id })
    for (const record of [active, expired, superseded]) run.store.records.set(record.id, record)
    const envelope = await exportMemories(run.host, run.identity, {}, run.dir)
    expect(envelope.records.map(record => record.id)).toEqual([active.id])
    expect(envelope.sourceSpace).toBe(TARGET)
    expect(await listDir(run.dir)).toEqual([])
  })

  it('carries expired and superseded rows when asked for lifecycle history', async () => {
    const run = await protocol()
    const records = [
      memory({ text: 'Keeps tea in the desk drawer' }),
      memory({ text: 'Meeting note from last quarter', expiresAt: NOW - 1000 }),
      memory({ text: 'Prefers filter coffee', supersededBy: RecordId('other-1') }),
    ]
    for (const record of records) run.store.records.set(record.id, record)
    const envelope = await exportMemories(run.host, run.identity, { includeInactive: true }, run.dir)
    expect(envelope.records.map(record => record.id)).toEqual(records.map(record => record.id))
  })

  it('writes the export file below the portability directory in a re-decodable form', async () => {
    const run = await protocol()
    const record = memory({ text: 'Runs integration tests on Friday afternoons' })
    run.store.records.set(record.id, record)
    await exportMemories(run.host, run.identity, { path: 'tea.json' }, run.dir)
    const decoded = decodeMemoryExport(await readFile(join(run.dir, 'tea.json'), 'utf8'), 10)
    expect(decoded.records).toEqual([record])
  })

  it('refuses an export larger than maxPortabilityRecords', async () => {
    const run = await protocol({}, { maxPortabilityRecords: 1 })
    for (const text of ['First memory', 'Second memory']) {
      const record = memory({ text })
      run.store.records.set(record.id, record)
    }
    await expect(exportMemories(run.host, run.identity, {}, run.dir)).rejects.toMatchObject({
      code: 'invalid_input', message: /would exceed maxPortabilityRecords/,
    })
  })

  it('stops a cancelled export before reading the store', async () => {
    const run = await protocol()
    await expect(exportMemories(run.host, run.identity, {}, run.dir, AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled', message: /memory export was cancelled/,
    })
  })

  it('reports a file that could not be written instead of a silent export', async () => {
    const blocker = join(await tempDir(), 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const run = await protocol()
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    run.store.records.set(record.id, record)
    await expect(exportMemories(run.host, run.identity, { path: 'tea.json' }, join(blocker, 'sub')))
      .rejects.toMatchObject({ code: 'backend_error', message: /was not written/ })
  })
})

describe('memory import protocol', () => {
  it('stages, verifies, and publishes an owned record rewritten into the target space', async () => {
    const run = await protocol()
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    const report = await importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir)
    expect(report).toEqual({ accepted: 1, reused: 0, recovered: 0, refused: [], sourceSpace: SOURCE, targetSpace: TARGET })
    expect(run.store.records.get(record.id)).toMatchObject({ kind: 'memory', spaceKey: TARGET, pending: false })
    expect(run.store.optimizeCount).toBe(1)
    expect(run.calls.mirrored).toEqual([record.id])
    expect(run.calls.invalidated).toBe(1)
    expect(await readJson(run.journalPath())).toMatchObject({ staged: [], published: true, targetSpace: TARGET })
  })

  it('reuses a record already stored with the same digest without writing a journal', async () => {
    const run = await protocol()
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    run.store.records.set(record.id, { ...record, spaceKey: TARGET })
    const report = await importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir)
    expect(report).toMatchObject({ accepted: 0, reused: 1 })
    expect(await listDir(run.dir)).toEqual([])
    expect(run.calls.invalidated).toBe(0)
  })

  it('reuses a duplicate text held under another id', async () => {
    const held = memory({ text: 'Keeps tea in the desk drawer' })
    const run = await protocol({ duplicate: async () => held })
    const incoming = memory({ text: 'Keeps tea in the desk drawer' })
    const report = await importMemories(run.host, run.identity, { json: exportText([incoming]) }, run.dir)
    expect(report).toMatchObject({ accepted: 0, reused: 1 })
    expect(run.store.records.size).toBe(0)
  })

  it('refuses a record the caller may not write', async () => {
    const run = await protocol({
      assertWritable: (_record, identity) => { throw new Error(`${String(identity.ownerKey)} may not write this record`) },
    })
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    const report = await importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir)
    expect(report.accepted).toBe(0)
    expect(report.refused).toEqual([{ id: record.id, reason: 'Error: owner-a may not write this record' }])
    expect(run.store.records.has(record.id)).toBe(false)
  })

  it('refuses different content already stored under an exported id', async () => {
    const run = await protocol()
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    run.store.records.set(record.id, memory({ id: record.id, text: 'Different text entirely' }))
    const report = await importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir)
    expect(report.refused).toEqual([{ id: record.id, reason: 'the store holds different content under this id' }])
  })

  it('refuses an id that the store holds as an indexed passage', async () => {
    const run = await protocol()
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    run.store.records.set(record.id, passage(record.id))
    const report = await importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir)
    expect(report.refused).toEqual([{ id: record.id, reason: expect.stringMatching(/indexed passage/) }])
  })

  it('refuses an id this host recorded as forgotten', async () => {
    const run = await protocol()
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    await writePortabilityJson(ledgerPathOf(run.dir), {
      version: MEMORY_EXPORT_VERSION,
      entries: [{ id: record.id, contentHash: record.contentHash, forgottenAt: NOW }],
    })
    const report = await importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir)
    expect(report.refused).toEqual([{ id: record.id, reason: expect.stringMatching(/recorded the memory as forgotten/) }])
    expect(run.store.records.size).toBe(0)
  })

  it('refuses records past maxMemories and keeps the ones already admitted', async () => {
    const run = await protocol({}, { maxMemories: 1 })
    const first = memory({ text: 'First imported memory' })
    const second = memory({ text: 'Second imported memory' })
    const report = await importMemories(run.host, run.identity, { json: exportText([first, second]) }, run.dir)
    expect(report.accepted).toBe(1)
    expect(report.refused).toEqual([{ id: second.id, reason: 'memory cap reached (1)' }])
    expect(run.store.records.has(first.id)).toBe(true)
    expect(run.store.records.has(second.id)).toBe(false)
  })

  it('reads an export from the portability directory', async () => {
    const run = await protocol()
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    await writePortabilityJson(join(run.dir, 'tea.json'), JSON.parse(exportText([record])))
    const report = await importMemories(run.host, run.identity, { path: 'tea.json' }, run.dir)
    expect(report.accepted).toBe(1)
  })

  it('requires an export path or export text', async () => {
    const run = await protocol()
    await expect(importMemories(run.host, run.identity, {}, run.dir)).rejects.toMatchObject({
      code: 'not_found', message: /needs an export path/,
    })
    await expect(importMemories(run.host, run.identity, { path: 'missing.json' }, run.dir))
      .rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses an export name that escapes the portability directory', async () => {
    const run = await protocol()
    await expect(importMemories(run.host, run.identity, { path: '../outside.json' }, run.dir))
      .rejects.toMatchObject({ code: 'path_escape' })
  })

  it('refuses an export larger than the configured limit before touching the store', async () => {
    const run = await protocol({}, { maxPortabilityRecords: 1 })
    const text = exportText([memory({ text: 'First imported memory' }), memory({ text: 'Second imported memory' })])
    await expect(importMemories(run.host, run.identity, { json: text }, run.dir))
      .rejects.toMatchObject({ code: 'invalid_input', message: /at most 1 records/ })
    expect(run.store.records.size).toBe(0)
  })

  it('stops a cancelled import before reading the export', async () => {
    const run = await protocol()
    await expect(importMemories(run.host, run.identity, { json: exportText([]) }, run.dir, AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'cancelled', message: /memory import was cancelled/ })
  })

  it('reports the source space separately from the target space of a migration', async () => {
    const run = await protocol()
    const report = await importMemories(run.host, run.identity, { json: exportText([memory({ text: 'Keeps tea in the desk drawer' })]) }, run.dir)
    expect(report.sourceSpace).toBe(SOURCE)
    expect(report.targetSpace).toBe(TARGET)
  })

  it('imports a mixed batch under one retrievability probe per lifecycle state', async () => {
    const run = await protocol()
    const active = memory({ text: 'Keeps tea in the desk drawer' })
    const expired = memory({ text: 'Meeting note from last quarter', expiresAt: NOW - 1000 })
    const superseded = memory({ text: 'Prefers filter coffee', supersededBy: RecordId('other-1') })
    const report = await importMemories(run.host, run.identity, { json: exportText([active, expired, superseded]) }, run.dir)
    expect(report.accepted).toBe(3)
    expect(run.store.searchFilters).toHaveLength(2)
    expect(run.store.records.size).toBe(3)
  })
})

describe('import failure handling', () => {
  it('rolls the staged batch back when the store write fails', async () => {
    const run = await protocol()
    run.store.failWrites = true
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    await expect(importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir))
      .rejects.toThrow('store write interrupted')
    expect(run.store.records.size).toBe(0)
    expect(await readJson(run.journalPath())).toMatchObject({ staged: [], published: false })
  })

  it('refuses a batch the store did not fully acknowledge', async () => {
    const acknowledgements: [string, (count: number) => WriteOutcome][] = [
      ['short', count => ({ written: count - 1, rejected: 0, spaceConflict: null })],
      ['rejected', count => ({ written: count, rejected: 1, spaceConflict: null })],
      ['conflict', count => ({ written: count, rejected: 0, spaceConflict: SpaceKey('other-space') })],
    ]
    for (const [name, acknowledge] of acknowledgements) {
      const run = await protocol()
      run.store.acknowledge = acknowledge
      await expect(importMemories(run.host, run.identity, { json: exportText([memory({ text: `Memory for the ${name} case` })]) }, run.dir))
        .rejects.toMatchObject({ code: 'backend_error', message: /not fully acknowledged/ })
      expect(run.store.records.size).toBe(0)
    }
  })

  it('keeps the journal when a rolled-back batch cannot be removed', async () => {
    const run = await protocol()
    run.store.swallowWrites = true
    run.store.removeThrows = true
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    await expect(importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir))
      .rejects.toMatchObject({ code: 'outcome_pending', message: /could not be removed/, detail: { ids: [record.id] } })
    expect(await readJson(run.journalPath())).toMatchObject({ staged: [record.id], published: false })
  })

  it('keeps the journal when a rolled-back batch survives removal', async () => {
    const run = await protocol()
    run.store.unsearchable = true
    run.store.surviveRemove = true
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    await expect(importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir))
      .rejects.toMatchObject({ code: 'outcome_pending', message: /staged records remain in the store/ })
    expect(await readJson(run.journalPath())).toMatchObject({ staged: [record.id] })
    expect(run.store.records.has(record.id)).toBe(true)
  })

  it('rejects staged rows that are missing, replaced by a passage, or rewritten', async () => {
    const faults: [(store: TestStore) => void, string][] = [
      [(store) => { store.swallowWrites = true }, 'absent'],
      [(store) => { store.passageSwap = true }, 'a passage'],
      [(store) => { store.rewriteStored = true }, 'rewritten'],
    ]
    for (const [inject, name] of faults) {
      const run = await protocol()
      inject(run.store)
      const record = memory({ text: `Keeps tea in the desk drawer ${name}` })
      await expect(importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir))
        .rejects.toMatchObject({ code: 'backend_error', message: /not stored exactly as exported/ })
      expect(run.store.records.has(record.id)).toBe(false)
    }
  })

  it('rejects a staged record the target space never received a vector for', async () => {
    const run = await protocol({ embed: async () => new Map<RecordId, readonly number[]>() })
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    await expect(importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir))
      .rejects.toMatchObject({ code: 'backend_error', message: /staged without a vector in the target space/ })
    expect(run.store.records.size).toBe(0)
  })

  it('rejects an active record that the finished index cannot retrieve', async () => {
    const run = await protocol()
    run.store.unsearchable = true
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    await expect(importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir))
      .rejects.toMatchObject({ code: 'backend_error', message: /stored but is not retrievable/ })
    expect(run.store.records.size).toBe(0)
  })

  it('rejects an expired record that the finished index still retrieves', async () => {
    const run = await protocol()
    run.store.ignoreLifecycle = true
    const record = memory({ text: 'Meeting note from last quarter', expiresAt: NOW - 1000 })
    await expect(importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir))
      .rejects.toMatchObject({ code: 'backend_error', message: /retrievable although it is expired or superseded/ })
    expect(run.store.records.size).toBe(0)
  })

  it('never publishes vectors it could not verify into the accelerator', async () => {
    const run = await protocol()
    run.store.unsearchable = true
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    await expect(importMemories(run.host, run.identity, { json: exportText([record]) }, run.dir)).rejects.toThrow()
    expect(run.calls.mirrored).toEqual([])
    expect(run.calls.invalidated).toBe(1)
  })
})

describe('interrupted import recovery', () => {
  it('removes the staged records of an interrupted import before planning again', async () => {
    const run = await protocol()
    const stale = memory({ text: 'Half-imported note from an interrupted run' })
    run.store.records.set(stale.id, stale)
    await writePortabilityJson(run.journalPath(), {
      version: MEMORY_EXPORT_VERSION, staged: [stale.id], targetSpace: TARGET, startedAt: NOW, published: false,
    })
    const incoming = memory({ text: 'Keeps tea in the desk drawer' })
    const report = await importMemories(run.host, run.identity, { json: exportText([incoming]) }, run.dir)
    expect(report.recovered).toBe(1)
    expect(run.store.records.has(stale.id)).toBe(false)
    expect(run.store.records.has(incoming.id)).toBe(true)
  })

  it('treats a published journal as nothing to recover', async () => {
    const run = await protocol()
    await writePortabilityJson(run.journalPath(), {
      version: MEMORY_EXPORT_VERSION, staged: [], targetSpace: TARGET, startedAt: NOW, published: true,
    })
    const report = await importMemories(run.host, run.identity, { json: exportText([memory({ text: 'Keeps tea in the desk drawer' })]) }, run.dir)
    expect(report.recovered).toBe(0)
  })

  it('refuses to read a journal this release cannot interpret', async () => {
    const run = await protocol()
    await writePortabilityJson(run.journalPath(), {
      version: MEMORY_EXPORT_VERSION + 1, staged: [], targetSpace: TARGET, startedAt: NOW, published: false,
    })
    await expect(importMemories(run.host, run.identity, { json: exportText([]) }, run.dir))
      .rejects.toMatchObject({ code: 'invalid_input', message: /import journal version 2 is not supported/ })
  })

  it('keeps the journal when the store cannot remove an interrupted batch', async () => {
    const run = await protocol()
    run.store.removeThrows = true
    const stale = memory({ text: 'Half-imported note from an interrupted run' })
    run.store.records.set(stale.id, stale)
    await writePortabilityJson(run.journalPath(), {
      version: MEMORY_EXPORT_VERSION, staged: [stale.id], targetSpace: TARGET, startedAt: NOW, published: false,
    })
    await expect(importMemories(run.host, run.identity, { json: exportText([]) }, run.dir))
      .rejects.toMatchObject({ code: 'outcome_pending', message: /could not be removed; the journal at .* is kept/ })
    expect(await readJson(run.journalPath())).toMatchObject({ staged: [stale.id] })
  })

  it('keeps the journal when an interrupted batch survives removal', async () => {
    const run = await protocol()
    run.store.surviveRemove = true
    const stale = memory({ text: 'Half-imported note from an interrupted run' })
    run.store.records.set(stale.id, stale)
    await writePortabilityJson(run.journalPath(), {
      version: MEMORY_EXPORT_VERSION, staged: [stale.id], targetSpace: TARGET, startedAt: NOW, published: false,
    })
    await expect(importMemories(run.host, run.identity, { json: exportText([]) }, run.dir))
      .rejects.toMatchObject({ code: 'outcome_pending', message: /still in the store/ })
    expect(run.store.records.has(stale.id)).toBe(true)
  })
})

describe('portability through the retrieval service', () => {
  interface EngineRun {
    ctx: Context
    store: TestStore
    embeddings: TestEmbeddings
    accelerator: TestAccelerator
    dir: string
    identity: TrustedIdentity
    journalPath: () => string
  }

  async function engine(
    configOver: Partial<RetrievalConfig> = {},
    records = new Map<RecordId, StoredRecord>(),
    shared?: string,
  ): Promise<EngineRun> {
    const dir = shared ?? await tempDir()
    const ctx = new Context()
    contexts.push(ctx)
    const store = new TestStore(ctx, records, '/test/engine')
    const embeddings = new TestEmbeddings(ctx)
    const accelerator = new TestAccelerator(ctx)
    await ctx.plugin(RetrievalService, RetrievalService.Config({
      persistentMemory: true, crossSessionRead: true, useAccelerator: true,
      portabilityEnabled: true, portabilityDir: dir, ...configOver,
    }))
    return { ctx, store, embeddings, accelerator, dir, identity: IDENTITY, journalPath: () => journalPathOf(dir, store.path) }
  }

  const remember = (text: string, scope: 'workspace' | 'user' = 'workspace') => ({
    text, scope, attribution: { actor: 'user' as const, ref: 'fixture' },
  })

  it('refuses portability while it is disabled by configuration', async () => {
    const run = await engine({ portabilityEnabled: false })
    await expect(run.ctx.retrieval.exportMemories(run.identity))
      .rejects.toMatchObject({ code: 'disabled', message: /portability is disabled/ })
    await expect(run.ctx.retrieval.importMemories(run.identity, { json: exportText([]) }))
      .rejects.toMatchObject({ code: 'disabled' })
  })

  it('refuses portability while retrieval itself is disabled', async () => {
    const run = await engine({ enabled: false })
    await expect(run.ctx.retrieval.exportMemories(run.identity))
      .rejects.toMatchObject({ code: 'disabled', message: /retrieval is disabled/ })
  })

  it('refuses a relative portability directory when the service loads', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    new TestStore(ctx)
    new TestEmbeddings(ctx)
    await expect(ctx.plugin(RetrievalService, RetrievalService.Config({ portabilityEnabled: true, portabilityDir: 'exports' })))
      .rejects.toThrow(/portabilityDir must be an absolute directory/)
  })

  it('round trips memories through an export file into a fresh store', async () => {
    const source = await engine()
    const texts = ['Keeps tea in the desk drawer', 'Runs integration tests on Friday afternoons']
    for (const text of texts) await source.ctx.retrieval.remember(remember(text), source.identity)
    const envelope = await source.ctx.retrieval.exportMemories(source.identity, { path: 'memories.json' })
    expect(envelope.records).toHaveLength(2)

    const target = await engine({}, new Map<RecordId, StoredRecord>(), source.dir)
    const report = await target.ctx.retrieval.importMemories(target.identity, { path: 'memories.json' })
    expect(report).toMatchObject({ accepted: 2, reused: 0, refused: [], sourceSpace: TARGET, targetSpace: TARGET })
    expect((await target.ctx.retrieval.listMemories(target.identity)).map(record => record.text).sort())
      .toEqual([...texts].sort())
    expect([...target.store.records.values()].map(record => (record.kind === 'memory' ? record.spaceKey : null)))
      .toEqual([TARGET, TARGET])
    expect(await readJson(target.journalPath())).toMatchObject({ staged: [], published: true })
  })

  it('keeps a memory exported and retrievable after a restart over the same store', async () => {
    const records = new Map<RecordId, StoredRecord>()
    const first = await engine({}, records)
    await first.ctx.retrieval.remember(remember('Keeps tea in the desk drawer'), first.identity)
    const reopened = await engine({}, records)
    expect((await reopened.ctx.retrieval.listMemories(reopened.identity)).map(record => record.text))
      .toEqual(['Keeps tea in the desk drawer'])
    const envelope = await reopened.ctx.retrieval.exportMemories(reopened.identity, { path: 'after-restart.json' })
    expect(envelope.records).toHaveLength(1)
  })

  it('rolls a pending supersession forward before exporting', async () => {
    const run = await engine()
    const prior = memory({ text: 'Prefers filter coffee' })
    const staged = memory({ text: 'Prefers tea now', supersedes: [prior.id], pending: true })
    run.store.records.set(prior.id, prior)
    run.store.records.set(staged.id, staged)
    const envelope = await run.ctx.retrieval.exportMemories(run.identity)
    expect(envelope.records.map(record => record.id)).toEqual([staged.id])
    expect(run.store.records.get(prior.id)).toMatchObject({ supersededBy: staged.id })
    expect(run.store.records.get(staged.id)).toMatchObject({ pending: false })
  })

  it('keeps an imported expired memory inactive in the target store', async () => {
    const source = await engine()
    const active = memory({ text: 'Keeps tea in the desk drawer' })
    const expired = memory({ text: 'Meeting note from last quarter', expiresAt: NOW - 1000 })
    for (const record of [active, expired]) source.store.records.set(record.id, record)
    const envelope = await source.ctx.retrieval.exportMemories(source.identity, { path: 'history.json', includeInactive: true })
    expect(envelope.records).toHaveLength(2)

    const target = await engine({}, new Map<RecordId, StoredRecord>(), source.dir)
    const report = await target.ctx.retrieval.importMemories(target.identity, { path: 'history.json' })
    expect(report.accepted).toBe(2)
    expect((await target.ctx.retrieval.listMemories(target.identity)).map(record => record.id)).toEqual([active.id])
    const withHistory = await target.ctx.retrieval.listMemories(target.identity, { includeExpired: true })
    expect(withHistory.map(record => record.id).sort()).toEqual([active.id, expired.id].sort())
  })

  it('refuses to restore a memory this host already forgot', async () => {
    const run = await engine()
    const forgotten = await run.ctx.retrieval.remember(remember('Prefers filter coffee'), run.identity)
    const envelope = await run.ctx.retrieval.exportMemories(run.identity, { path: 'before-forget.json' })
    expect(envelope.records.map(record => record.id)).toEqual([forgotten.id])
    await run.ctx.retrieval.forget({ ids: [forgotten.id] }, run.identity)
    expect(await readJson(ledgerPathOf(run.dir))).toMatchObject({ entries: [{ id: forgotten.id }] })
    expect(run.store.records.has(forgotten.id)).toBe(false)

    const restored = await engine({ maxMemories: 50 }, run.store.records, run.dir)
    const report = await restored.ctx.retrieval.importMemories(restored.identity, { path: 'before-forget.json' })
    expect(report.accepted).toBe(0)
    expect(report.refused).toEqual([{ id: forgotten.id, reason: expect.stringMatching(/recorded the memory as forgotten/) }])
    expect(run.store.records.has(forgotten.id)).toBe(false)
  })

  it('keeps memories when the forgotten ledger is written in a format this release cannot read', async () => {
    const run = await engine()
    const kept = await run.ctx.retrieval.remember(remember('Prefers filter coffee'), run.identity)
    await writePortabilityJson(ledgerPathOf(run.dir), { version: MEMORY_EXPORT_VERSION + 1, entries: [] })
    await expect(run.ctx.retrieval.forget({ ids: [kept.id] }, run.identity))
      .rejects.toMatchObject({ code: 'invalid_input', message: /forgotten ledger version 2 is not supported/ })
    expect(run.store.records.has(kept.id)).toBe(true)
  })

  it('keeps memories when the forgotten ledger cannot be written', async () => {
    const run = await engine()
    const kept = await run.ctx.retrieval.remember(remember('Prefers filter coffee'), run.identity)
    await mkdir(`${ledgerPathOf(run.dir)}.${String(process.pid)}.tmp`, { recursive: true })
    await expect(run.ctx.retrieval.forget({ ids: [kept.id] }, run.identity))
      .rejects.toMatchObject({ code: 'backend_error', message: /ledger at .* is unwritable; no memory was deleted/ })
    expect(run.store.records.has(kept.id)).toBe(true)
  })

  it('refuses a user-scope memory when the caller lacks that authority', async () => {
    const source = await engine()
    const personal = await source.ctx.retrieval.remember(remember('Prefers tea over coffee', 'user'), source.identity)
    const envelope = await source.ctx.retrieval.exportMemories(source.identity, { path: 'personal.json' })
    expect(envelope.records.map(record => record.id)).toEqual([personal.id])

    const target = await engine({}, new Map<RecordId, StoredRecord>(), source.dir)
    const report = await target.ctx.retrieval.importMemories({ ...IDENTITY, allowUserScope: false }, { path: 'personal.json' })
    expect(report.accepted).toBe(0)
    expect(report.refused).toEqual([{ id: personal.id, reason: expect.stringMatching(/user-scope memory requires/) }])
  })

  it('mirrors published vectors into the mounted accelerator', async () => {
    const run = await engine()
    run.accelerator.ready = true
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    expect((await run.ctx.retrieval.importMemories(run.identity, { json: exportText([record]) })).accepted).toBe(1)
    expect([...run.accelerator.ids]).toEqual([record.id])
  })

  it('completes an import while the accelerator is unavailable', async () => {
    const run = await engine()
    run.accelerator.ready = false
    const report = await run.ctx.retrieval.importMemories(run.identity, { json: exportText([memory({ text: 'Keeps tea in the desk drawer' })]) })
    expect(report.accepted).toBe(1)
    expect(run.accelerator.ids.size).toBe(0)
  })

  it('refuses an import whose provider returns fewer vectors than records, leaving no journal', async () => {
    const run = await engine()
    run.embeddings.shortBatch = true
    const text = exportText([memory({ text: 'First imported memory' }), memory({ text: 'Second imported memory' })])
    await expect(run.ctx.retrieval.importMemories(run.identity, { json: text }))
      .rejects.toMatchObject({ code: 'invalid_vector', message: /returned no vector for memory/ })
    expect(run.store.records.size).toBe(0)
    expect(await listDir(run.dir)).toEqual([])
  })

  it('preserves the source store when a migration target fails verification', async () => {
    const source = await engine()
    await source.ctx.retrieval.remember(remember('Keeps tea in the desk drawer'), source.identity)
    const envelope = await source.ctx.retrieval.exportMemories(source.identity, { path: 'memories.json' })
    const before = new Map(source.store.records)

    const target = await engine({}, new Map<RecordId, StoredRecord>(), source.dir)
    target.store.unsearchable = true
    await expect(target.ctx.retrieval.importMemories(target.identity, { path: 'memories.json' }))
      .rejects.toMatchObject({ code: 'backend_error', message: /not retrievable/ })
    expect(target.store.records.size).toBe(0)
    expect(source.store.records).toEqual(before)
    expect(envelope.records).toHaveLength(1)
  })

  it('refuses an export name that reaches outside the directory through a link', async () => {
    const run = await engine()
    const outside = await tempDir()
    await writeFile(join(outside, 'elsewhere.json'), 'written outside the portability directory')
    await symlink(join(outside, 'elsewhere.json'), join(run.dir, 'link.json'))
    await run.ctx.retrieval.remember(remember('Keeps tea in the desk drawer'), run.identity)
    await expect(run.ctx.retrieval.exportMemories(run.identity, { path: 'link.json' }))
      .rejects.toMatchObject({ code: 'path_escape' })
    expect(await readFile(join(outside, 'elsewhere.json'), 'utf8')).toBe('written outside the portability directory')
  })

  it('refuses an import name that reads outside the directory through a link', async () => {
    const run = await engine()
    const outside = await tempDir()
    const elsewhere = memory({ text: 'Prefers filter coffee' })
    await writeFile(join(outside, 'elsewhere.json'), exportText([elsewhere]))
    await symlink(join(outside, 'elsewhere.json'), join(run.dir, 'link.json'))
    await expect(run.ctx.retrieval.importMemories(run.identity, { path: 'link.json' }))
      .rejects.toMatchObject({ code: 'path_escape' })
    expect(run.store.records.size).toBe(0)
  })

  it('refuses a nested name under a linked directory that leaves the portability directory', async () => {
    const run = await engine()
    const outside = await tempDir()
    await mkdir(join(outside, 'staged'), { recursive: true })
    await symlink(join(outside, 'staged'), join(run.dir, 'nested'))
    await run.ctx.retrieval.remember(remember('Keeps tea in the desk drawer'), run.identity)
    await expect(run.ctx.retrieval.exportMemories(run.identity, { path: join('nested', 'memories.json') }))
      .rejects.toMatchObject({ code: 'path_escape' })
    expect(await listDir(outside)).toEqual(['staged'])
  })

  it('refuses an export file whose version this release does not implement, leaving no journal', async () => {
    const run = await engine()
    await writeFile(join(run.dir, 'future.json'),
      JSON.stringify({ version: MEMORY_EXPORT_VERSION + 1, exportedAt: NOW, sourceSpace: TARGET, records: [] }))
    await expect(run.ctx.retrieval.importMemories(run.identity, { path: 'future.json' }))
      .rejects.toMatchObject({ code: 'invalid_input', message: /version 2 is not supported/ })
    expect(await listDir(run.dir)).toEqual(['future.json'])
  })

  it('refuses a truncated export file, leaving no journal and no records', async () => {
    const run = await engine()
    const text = exportText([memory({ text: 'Keeps tea in the desk drawer' })])
    await writeFile(join(run.dir, 'half.json'), text.slice(0, Math.floor(text.length / 2)))
    await expect(run.ctx.retrieval.importMemories(run.identity, { path: 'half.json' }))
      .rejects.toMatchObject({ code: 'invalid_input', message: /not valid JSON/ })
    expect(await listDir(run.dir)).toEqual(['half.json'])
    expect(run.store.records.size).toBe(0)
  })

  it('refuses an export file whose record text no longer matches its recorded digest', async () => {
    const run = await engine()
    const record = memory({ text: 'Keeps tea in the desk drawer' })
    const tampered = exportText([record]).replace(record.text, 'Keeps coffee in the desk drawer')
    await writeFile(join(run.dir, 'tampered.json'), tampered)
    await expect(run.ctx.retrieval.importMemories(run.identity, { path: 'tampered.json' }))
      .rejects.toMatchObject({ code: 'invalid_input', message: /content digest/ })
    expect(run.store.records.size).toBe(0)
  })

  it('refuses an import larger than maxPortabilityRecords before writing anything', async () => {
    const source = await engine()
    const texts = ['First synthetic memory', 'Second synthetic memory', 'Third synthetic memory']
    for (const text of texts) await source.ctx.retrieval.remember(remember(text), source.identity)
    await source.ctx.retrieval.exportMemories(source.identity, { path: 'three.json' })

    const target = await engine({ maxPortabilityRecords: 2 }, new Map<RecordId, StoredRecord>(), source.dir)
    await expect(target.ctx.retrieval.importMemories(target.identity, { path: 'three.json' }))
      .rejects.toMatchObject({ code: 'invalid_input', message: /at most 2 records/ })
    expect(target.store.records.size).toBe(0)
  })

  it('reports a portability directory that cannot hold files as a backend failure and keeps the memory', async () => {
    const root = await tempDir()
    const blocker = join(root, 'not-a-directory')
    await writeFile(blocker, 'a file where the portability directory must be')
    const run = await engine({ portabilityDir: blocker })
    const kept = await run.ctx.retrieval.remember(remember('Keeps tea in the desk drawer'), run.identity)
    await expect(run.ctx.retrieval.exportMemories(run.identity, { path: 'memories.json' }))
      .rejects.toMatchObject({ code: 'backend_error', message: /was not written/ })
    expect(run.store.records.has(kept.id)).toBe(true)
  })

  it('imports one export requested twice at once without duplicating the population', async () => {
    const source = await engine()
    await source.ctx.retrieval.remember(remember('Runs integration tests on Friday afternoons'), source.identity)
    await source.ctx.retrieval.exportMemories(source.identity, { path: 'memories.json' })

    const target = await engine({}, new Map<RecordId, StoredRecord>(), source.dir)
    const reports = await Promise.all([
      target.ctx.retrieval.importMemories(target.identity, { path: 'memories.json' }),
      target.ctx.retrieval.importMemories(target.identity, { path: 'memories.json' }),
    ])
    expect(reports.reduce((total, report) => total + report.accepted, 0)).toBe(1)
    expect(reports.reduce((total, report) => total + report.reused, 0)).toBe(1)
    expect((await target.ctx.retrieval.listMemories(target.identity)).map(record => record.text))
      .toEqual(['Runs integration tests on Friday afternoons'])
  })

  it('keeps a forgotten memory out of search after a restart that follows a refused restore', async () => {
    const run = await engine()
    const forgotten = await run.ctx.retrieval.remember(remember('Prefers filter coffee'), run.identity)
    await run.ctx.retrieval.exportMemories(run.identity, { path: 'before-forget.json' })
    await run.ctx.retrieval.forget({ ids: [forgotten.id] }, run.identity)

    const reopened = await engine({}, run.store.records, run.dir)
    const report = await reopened.ctx.retrieval.importMemories(reopened.identity, { path: 'before-forget.json' })
    expect(report.accepted).toBe(0)
    const packet = await reopened.ctx.retrieval.search(
      { mode: 'keyword', text: 'filter coffee', topK: 5, scopes: ['workspace'], pathPrefixes: [], minScore: 0, budgetTokens: 0 },
      reopened.identity,
    )
    expect(packet.candidates).toHaveLength(0)
    expect(packet.rendered).toBe('')
    expect(await readJson(ledgerPathOf(run.dir))).toMatchObject({ entries: [{ id: forgotten.id }] })
  })

  it('creates the portability directory and its nested names when the first export writes a file', async () => {
    const root = await tempDir()
    const run = await engine({ portabilityDir: join(root, 'exports') })
    await run.ctx.retrieval.remember(remember('Keeps tea in the desk drawer'), run.identity)
    await run.ctx.retrieval.exportMemories(run.identity, { path: join('nested', 'memories.json') })
    expect(await readFile(join(root, 'exports', 'nested', 'memories.json'), 'utf8')).toContain('Keeps tea in the desk drawer')
  })
})
