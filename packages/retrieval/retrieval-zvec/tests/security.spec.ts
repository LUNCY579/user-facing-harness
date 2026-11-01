/** Authorization and persistence regressions exercised against the real Zvec binding. */
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { AgentKey, OwnerKey, RecordId, SessionKey, WorkspaceKey, contentHash, spaceKeyOf, IndexingService, RetrievalService, type TrustedIdentity, type RetrievalQuery, type ChunkRecord } from '@deepseek-ai/dsh-retrieval'
import * as embedPlugin from '@deepseek-ai/dsh-retrieval-embed'
import { afterEach, describe, expect, it } from 'vitest'
import * as zvecPlugin from '../src/index.ts'
import { acquireLock, releaseLock } from '../src/gateway.ts'

const contexts: Context[] = []
const roots: string[] = []
const owner: TrustedIdentity = {
  ownerKey: OwnerKey('owner-a'), workspaceRoot: realpathSync(tmpdir()), workspaceKey: WorkspaceKey('workspace-a'),
  sessionKey: SessionKey('session-a'), agentKey: AgentKey('agent-a'), allowCrossSession: true, allowUserScope: true,
}
const query: RetrievalQuery = {
  mode: 'semantic', text: 'synthetic release password policy', topK: 10, scopes: ['user', 'workspace', 'session', 'agent'],
  pathPrefixes: [], minScore: 0.01, budgetTokens: 4000,
}

async function setup(indexDir?: string, readOnly = false, withWorker = false): Promise<{ ctx: Context; indexDir: string }> {
  if (indexDir === undefined) {
    indexDir = await mkdtemp(join(tmpdir(), 'dsh-retrieval-security-'))
    roots.push(indexDir)
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(embedPlugin, embedPlugin.Config({ dimension: 64 }))
  await ctx.plugin(zvecPlugin, zvecPlugin.Config({
    indexDir, collectionName: 'security', readOnly, acceleratorEnabled: withWorker,
    turbovecPython: process.env.DSH_TEST_TURBOVEC_PYTHON ?? 'python3',
  }))
  await ctx.plugin(RetrievalService, RetrievalService.Config({
    persistentMemory: true, crossSessionRead: true, useAccelerator: withWorker,
  }))
  return { ctx, indexDir }
}

/** Require the single vector a synthetic one-input fixture requests. */
async function embedOne(ctx: Context, text: string): Promise<number[]> {
  const [vector] = await ctx.embeddings.embed([text])
  if (vector === undefined) throw new Error('embedding fixture returned no vector')
  return vector
}

async function remember(ctx: Context, scope: 'user' | 'workspace' | 'session' | 'agent', identity = owner) {
  return await ctx.retrieval.remember({ text: 'Synthetic release password policy: use fixture-Delta.', scope, attribution: { actor: 'user', ref: 'synthetic-test' } }, identity)
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('native authorization filtering', { timeout: 30000 }, () => {
  it('isolates principals even for an identical user-memory query', async () => {
    const { ctx } = await setup()
    await remember(ctx, 'user')
    expect((await ctx.retrieval.search(query, { ...owner, ownerKey: OwnerKey('owner-b') })).candidates).toEqual([])
    expect((await ctx.retrieval.search(query, { ...owner, workspaceKey: WorkspaceKey('workspace-b') })).candidates).toHaveLength(1)
  })

  it('never lets cross-session authority widen exact agent ownership', async () => {
    const { ctx } = await setup()
    await remember(ctx, 'agent')
    expect((await ctx.retrieval.search(query, owner)).candidates).toHaveLength(1)
    expect((await ctx.retrieval.search(query, { ...owner, agentKey: AgentKey('agent-b') })).candidates).toEqual([])
    expect((await ctx.retrieval.search(query, { ...owner, sessionKey: SessionKey('session-b') })).candidates).toEqual([])
  })

  it('excludes expired and superseded memories before their vectors are scored', async () => {
    const { ctx } = await setup()
    const old = await remember(ctx, 'workspace')
    const current = await ctx.retrieval.remember({ text: 'The release now uses fixture-Echo.', scope: 'workspace', supersedes: [old.id], attribution: { actor: 'user', ref: 'synthetic-test' } }, owner)
    await ctx.retrieval.updateMemory(current.id, { expiresAt: Date.now() - 1 }, owner)
    const filter = ctx.retrieval.buildFilter(owner, ['workspace'], [], null, null, Date.now())
    const vector = await embedOne(ctx, query.text)
    expect(await ctx.vectorStore.searchVector(vector, 10, filter)).toEqual([])
    expect(await ctx.vectorStore.listIds({ ...filter, activeAt: null }, 10)).toHaveLength(2)
  })

  it('pushes source restrictions into top-one scoring even for quoted and wildcard paths', async () => {
    const { ctx, indexDir } = await setup()
    const workspace = join(indexDir, 'workspace')
    const selected = join(workspace, "quoted_'_%_中文")
    await mkdir(selected, { recursive: true })
    await writeFile(join(workspace, 'exact.ts'), 'export const nativeNeedle = "exact match"\n')
    await writeFile(join(selected, 'other.ts'), 'export const differentNeedle = "another source"\n')
    await ctx.plugin(IndexingService, IndexingService.Config({ roots: [workspace], statePath: join(indexDir, 'state.json') }))
    await ctx.retrievalIndexing.syncWorkspace(owner)
    const vector = await embedOne(ctx, 'nativeNeedle exact match')
    const filter = ctx.retrieval.buildFilter(owner, ['workspace'], [selected], null, ['chunk'], Date.now())
    const hits = await ctx.vectorStore.searchVector(vector, 1, filter)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.record?.kind).toBe('chunk')
    if (hits[0]?.record?.kind === 'chunk') expect(hits[0].record.source).toContain("quoted_'_%_中文")
  })

  it('retains normalized keyword relevance when a matching vector points opposite the query', async () => {
    const { ctx, indexDir } = await setup()
    const text = 'syntheticAntipodalKeyword'
    const vector = await embedOne(ctx, text)
    const record: ChunkRecord = {
      kind: 'chunk', id: RecordId('chunk-opposite'), scope: 'workspace', ownerKey: owner.ownerKey,
      workspaceKey: owner.workspaceKey, sessionKey: null, agentKey: null,
      source: join(indexDir, 'opposite.ts'), startLine: 1, endLine: 1,
      text, contentHash: contentHash(text), updatedAt: Date.now(), spaceKey: spaceKeyOf(ctx.embeddings.space),
    }
    expect((await ctx.vectorStore.write([record], new Map([[record.id, vector.map(value => -value)]]))).written).toBe(1)
    const filter = ctx.retrieval.buildFilter(owner, ['workspace'], [], null, ['chunk'], Date.now())
    const [semantic] = await ctx.vectorStore.searchVector(vector, 1, filter)
    const [keyword] = await ctx.vectorStore.searchKeyword(text, 1, filter)
    const [hybrid] = await ctx.vectorStore.searchHybrid(vector, text, 1, filter)
    if (semantic === undefined || keyword === undefined || hybrid === undefined) throw new Error('native antipodal fixture returned no hit')
    expect(semantic.score).toBeCloseTo(2, 5)
    expect(keyword.score).toBeGreaterThan(0)
    expect(hybrid.id).toBe(record.id)
    expect(hybrid.score).toBeGreaterThanOrEqual(0)
    expect(hybrid.score).toBeLessThanOrEqual(1)
    const termWeight = 1 - zvecPlugin.Config({}).hybridVectorWeight
    expect(hybrid.score).toBeCloseTo(termWeight * keyword.score / (1 + keyword.score), 8)
  })

  it('caps hybrid output after semantic and lexical candidate fusion', async () => {
    const { ctx } = await setup()
    await ctx.retrieval.remember({ text: 'A red lemon grows on the synthetic tree.', scope: 'workspace', attribution: { actor: 'user', ref: 'synthetic-test' } }, owner)
    await ctx.retrieval.remember({ text: 'A blue orange decorates the fixture.', scope: 'workspace', attribution: { actor: 'user', ref: 'synthetic-test' } }, owner)
    const vector = await embedOne(ctx, 'A red lemon grows on the synthetic tree.')
    const filter = ctx.retrieval.buildFilter(owner, ['workspace'], [], null, null, Date.now())
    expect(await ctx.vectorStore.searchHybrid(vector, 'blue orange', 1, filter)).toHaveLength(1)
  })

  it('forgets expired and superseded workspace memories durably while retaining another principal', async () => {
    const first = await setup()
    const old = await remember(first.ctx, 'workspace')
    const current = await first.ctx.retrieval.remember({
      text: 'Synthetic current release policy uses fixture-Foxtrot.', scope: 'workspace', supersedes: [old.id],
      attribution: { actor: 'user', ref: 'synthetic-test' },
    }, owner)
    const expired = await first.ctx.retrieval.remember({
      text: 'Synthetic temporary release policy.', scope: 'workspace', attribution: { actor: 'user', ref: 'synthetic-test' },
    }, owner)
    await first.ctx.retrieval.updateMemory(expired.id, { expiresAt: Date.now() - 1 }, owner)
    const foreign = await remember(first.ctx, 'workspace', { ...owner, ownerKey: OwnerKey('owner-other') })
    const ids = [old.id, current.id, expired.id]
    expect(new Set(await first.ctx.retrieval.forget({ scopes: ['workspace'] }, owner))).toEqual(new Set(ids))
    expect(await first.ctx.vectorStore.fetch(ids)).toEqual([])
    await first.ctx.fiber.dispose()
    const second = await setup(first.indexDir)
    expect(await second.ctx.vectorStore.fetch(ids)).toEqual([])
    expect(await second.ctx.retrieval.listMemories(owner, { includeExpired: true, includeSuperseded: true })).toEqual([])
    expect((await second.ctx.vectorStore.fetch([foreign.id])).map(record => record.id)).toEqual([foreign.id])
  })

  it('keeps deletion effective after restart and refuses unauthorized mutations', async () => {
    const first = await setup()
    const record = await remember(first.ctx, 'workspace')
    const outsider = { ...owner, ownerKey: OwnerKey('owner-b') }
    await expect(first.ctx.retrieval.updateMemory(record.id, { text: 'changed' }, outsider)).rejects.toThrow()
    await expect(first.ctx.retrieval.forget({ ids: [record.id] }, outsider)).rejects.toThrow()
    expect((await first.ctx.vectorStore.fetch([record.id]))).toHaveLength(1)
    await first.ctx.retrieval.forget({ ids: [record.id] }, owner)
    const store = first.ctx.vectorStore
    await first.ctx.fiber.dispose()
    await expect(store.stats()).rejects.toThrow(/closed/)
    const second = await setup(first.indexDir)
    expect(await second.ctx.vectorStore.fetch([record.id])).toEqual([])
    expect((await second.ctx.retrieval.search(query, owner)).candidates).toEqual([])
  })
})

describe.skipIf(process.env.DSH_TEST_TURBOVEC_PYTHON === undefined)('turbovec memory reconciliation', { timeout: 30000 }, () => {
  it('rebuilds persisted authorized memories after an empty-worker fallback', async () => {
    const first = await setup(undefined, false, true)
    const memory = await remember(first.ctx, 'workspace')
    const other = await remember(first.ctx, 'workspace', { ...owner, ownerKey: OwnerKey('owner-other') })
    await first.ctx.fiber.dispose()
    const second = await setup(first.indexDir, false, true)
    const fallback = await second.ctx.retrieval.search(query, owner)
    expect(fallback.servedBy).toBe('zvec')
    expect(fallback.candidates.map(candidate => candidate.record.id)).toEqual([memory.id])
    const rebuilt = await second.ctx.retrieval.rebuildAccelerator(owner)
    expect(rebuilt).toBe(1)
    const recovered = await second.ctx.retrieval.search(query, owner)
    expect(recovered.servedBy).toBe('zvec+accelerator')
    expect(recovered.candidates.map(candidate => candidate.record.id)).toEqual([memory.id])
    const queryVector = await embedOne(second.ctx, query.text)
    const denied = second.ctx.get('accelerator')?.search(queryVector, 1, [other.id])
    await expect(denied).rejects.toThrow(/missing authoritative candidates/)
  })
})

describe('native recovery', { timeout: 30000 }, () => {
  it('drains an admitted write before closing its native collection', async () => {
    const first = await setup()
    const seed = await remember(first.ctx, 'workspace')
    const vector = await embedOne(first.ctx, seed.text)
    const records = Array.from({ length: 300 }, (_, index) => ({ ...seed, id: RecordId(`mem-drain-${index}`) }))
    const store = first.ctx.vectorStore
    const writing = store.write(records, new Map(records.map(record => [record.id, vector])))
    await setImmediate()
    const closing = store.close()
    expect((await writing).written).toBe(300)
    await closing
    const reopened = await setup(first.indexDir)
    expect((await reopened.ctx.vectorStore.stats()).documents).toBe(301)
  })

  it('rolls forward an interrupted staged memory on an authorized read after restart', async () => {
    const first = await setup()
    const old = await remember(first.ctx, 'workspace')
    const text = 'Synthetic release password policy now uses fixture-Echo.'
    const staged = {
      ...old, id: RecordId('mem-pending-test'), text, contentHash: contentHash(text),
      pending: true, supersedes: [old.id], supersededBy: null,
    }
    const vector = await embedOne(first.ctx, text)
    expect((await first.ctx.vectorStore.write([staged], new Map([[staged.id, vector]]))).written).toBe(1)
    const filter = first.ctx.retrieval.buildFilter(owner, ['workspace'], [], null, null, Date.now())
    expect((await first.ctx.vectorStore.searchVector(vector, 10, filter)).some(hit => hit.id === staged.id)).toBe(false)
    expect(await first.ctx.vectorStore.listIds({ ...filter, pendingOnly: true }, 10)).toEqual([staged.id])
    await first.ctx.fiber.dispose()
    const second = await setup(first.indexDir)
    const packet = await second.ctx.retrieval.search({ ...query, text }, owner)
    expect(packet.candidates.map(candidate => candidate.record.id)).toEqual([staged.id])
    const records = await second.ctx.vectorStore.fetch([staged.id, old.id])
    const current = records.find(record => record.id === staged.id)
    const prior = records.find(record => record.id === old.id)
    expect(current?.kind === 'memory' && current.pending).toBe(false)
    expect(prior?.kind === 'memory' && prior.supersededBy).toBe(staged.id)
  })

  it('refuses a truncated manifest without opening it as a new space', async () => {
    const first = await setup()
    await remember(first.ctx, 'workspace')
    await first.ctx.fiber.dispose()
    await writeFile(join(first.indexDir, 'manifest.json'), '{"version":')
    const second = await setup(first.indexDir)
    await expect(second.ctx.vectorStore.stats()).rejects.toThrow()
    await access(join(first.indexDir, 'collection'))
  })

  it('does not create a missing read-only collection or manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-readonly-'))
    roots.push(root)
    const { ctx } = await setup(join(root, 'absent'), true)
    await expect(ctx.vectorStore.stats()).rejects.toThrow(/manifest/)
    await expect(access(join(root, 'absent'))).rejects.toThrow()
  })

  it('releases the exclusive writer transaction when its process is killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-writer-'))
    roots.push(root)
    const lease = acquireLock(root)
    releaseLock(root, lease)
    const child = spawn(process.execPath, ['--input-type=module', '-e', "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); process.stdout.write('ready'); setInterval(()=>{},1000)", join(root, 'writer.sqlite')], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () =>{  resolve() })
        child.once('error', reject)
        child.once('exit', (code) =>{  reject(new Error(`writer exited ${code}`)) })
      })
      expect(() => acquireLock(root)).toThrow(/locked/)
    } finally {
      const exited = new Promise<void>(resolve => child.once('close', () =>{  resolve() }))
      child.kill('SIGKILL')
      await exited
    }
    const recovered = acquireLock(root)
    releaseLock(root, recovered)
  })
})
