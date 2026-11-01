/** Optional diagnostic over built retrieval plugins, synthetic text, and exact cosine ground truth. */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { RetrievalService, contentHash, spaceKeyOf, pack, OwnerKey, WorkspaceKey, SessionKey, AgentKey, RecordId, type Candidate, type RetrievalQuery, type StoredRecord, type TrustedIdentity, type BackendHit } from '@deepseek-ai/dsh-retrieval'
import * as embeddings from '@deepseek-ai/dsh-retrieval-embed'
import * as zvec from '@deepseek-ai/dsh-retrieval-zvec'

const execute = promisify(execFile)
const settings: { size: number; mode: string; queries: number; dimension: number; python: string; root?: string } = JSON.parse(process.env.RETRIEVAL_BENCH ?? '{}')
const { size, mode, queries, dimension, python } = settings
const root = settings.root ?? await mkdtemp(join(tmpdir(), 'dsh-retrieval-bench-'))
const sourceRoot = join(root, 'corpus')
await mkdir(sourceRoot)
const identity: TrustedIdentity = { ownerKey: OwnerKey('bench-owner'), workspaceKey: WorkspaceKey('bench-workspace'), workspaceRoot: sourceRoot,
  sessionKey: SessionKey('bench-session'), agentKey: AgentKey('bench-agent'), allowCrossSession: true, allowUserScope: true }
const matrix = new Float32Array(size * dimension)
let ctx: Context | undefined
const started = performance.now()
const cpuStarted = process.cpuUsage()
const memoryBefore = process.memoryUsage()
const diagnostics: Record<string, unknown> = {}

function textOf(index: number): string {
  let state = (index ^ 421337) >>> 0
  const words = []
  for (let term = 0; term < 18; term++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    words.push(`term${state % 32749}`)
  }
  const domain = ['source function', 'documentation policy', 'conversation decision', 'memory preference'][index % 4]
  return `${domain} topic${index % 97} symbol${index.toString().padStart(7, '0')} ${words.join(' ')} Evidence record ${index}.`
}
function queryOf(index: number): string { return textOf(index).split(' ').slice(0, 9).join(' ') }
function idOf(index: number): RecordId { return RecordId(`bench-${index.toString().padStart(8, '0')}`) }
function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] ?? 0
}
function summary(values: readonly number[]) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), samplesMs: values }
}
async function bytesUnder(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    total += entry.isDirectory() ? await bytesUnder(child) : (await stat(child)).size
  }
  return total
}
async function activate(hnswEf = 64, combined = mode === 'combined'): Promise<Context> {
  const context = new Context()
  await context.plugin(embeddings, embeddings.Config({ dimension }))
  if (mode === 'baseline' || mode === 'packing') return context
  await context.plugin(zvec, zvec.Config({ indexDir: join(root, 'index'), queryThreads: 1, optimizeThreads: 1, hnswEf,
    acceleratorEnabled: combined || mode.startsWith('turbovec'),
    acceleratorBitWidth: mode === 'turbovec2' ? 2 : 4,
    turbovecPython: python, workerMaxVectors: Math.max(100_000, size), workerTimeoutMs: 120_000 }))
  await context.plugin(RetrievalService, RetrievalService.Config({ persistentMemory: true, crossSessionRead: true, useAccelerator: combined,
    defaultMinScore: 0, defaultBudgetTokens: 4000 }))
  return context
}
function recordOf(index: number): StoredRecord {
  const text = textOf(index)
  const common = { id: idOf(index), scope: 'workspace' as const, ownerKey: identity.ownerKey, agentKey: null,
    workspaceKey: identity.workspaceKey, sessionKey: null, text, contentHash: contentHash(text), updatedAt: 1,
    spaceKey: spaceKeyOf(ctx!.embeddings.space) }
  if (index % 4 === 3) return { ...common, kind: 'memory', pending: false, tags: ['synthetic'], attribution: { actor: 'user', ref: 'benchmark' },
    version: 1, supersedes: [], supersededBy: null, createdAt: 1, expiresAt: null }
  return { ...common, kind: 'chunk', source: join(sourceRoot, `part-${Math.floor(index / 128)}.txt`),
    startLine: index % 128 + 1, endLine: index % 128 + 1 }
}
function exact(vector: readonly number[]): RecordId[] {
  const best: { id: RecordId; score: number }[] = []
  for (let index = 0; index < size; index++) {
    let score = 0
    const offset = index * dimension
    for (let component = 0; component < dimension; component++) score += matrix[offset + component]! * vector[component]!
    if (best.length === 10 && score <= best[9]!.score) continue
    best.push({ id: idOf(index), score })
    best.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    if (best.length > 10) best.pop()
  }
  return best.map(hit => hit.id)
}
try {
  ctx = await activate()
  if (mode === 'packing') {
    const candidates: Candidate[] = Array.from({ length: size }, (_, index) => {
      const record = recordOf(index)
      if (record.kind === 'chunk') record.source = `/synthetic/source-${index}.txt`
      return { record, rawScore: index / size, score: 1 - index / (2 * size), origin: 'vector' }
    })
    const query: RetrievalQuery = { mode: 'semantic', text: 'synthetic context query', topK: 6, scopes: ['workspace'], pathPrefixes: [], minScore: 0.2, budgetTokens: 1200 }
    for (let warmup = 0; warmup < 5; warmup++) pack(candidates, query)
    const samples: number[] = []
    let output = pack(candidates, query)
    for (let sample = 0; sample < queries; sample++) {
      const before = performance.now()
      output = pack(candidates, query)
      samples.push(performance.now() - before)
    }
    console.log('RETRIEVAL_RESULT ' + JSON.stringify({ skipped: false, workload: 'production context packing over fixed authorized candidates', latency: summary(samples),
      outputHash: contentHash(JSON.stringify(output)), memoryAfter: process.memoryUsage(), peakNodeRssBytes: process.resourceUsage().maxRSS * 1024 }))
  } else {
  const creationStart = performance.now()
  let embeddingMs = 0
  let insertionMs = 0
  let accelerationBuildMs = 0
  let totalInputTokens = 0
  for (let offset = 0; offset < size; offset += 256) {
    const count = Math.min(256, size - offset)
    const texts = Array.from({ length: count }, (_, at) => textOf(offset + at))
    totalInputTokens += texts.reduce((sum, text) => sum + Math.ceil(Buffer.byteLength(text) / 4), 0)
    const embeddingStart = performance.now()
    const vectors = await ctx.embeddings.embed(texts)
    embeddingMs += performance.now() - embeddingStart
    for (let at = 0; at < count; at++) matrix.set(vectors[at]!, (offset + at) * dimension)
    if (mode === 'baseline') {
      for (let at = 0; at < count; at += 128) await writeFile(join(sourceRoot, `part-${Math.floor((offset + at) / 128)}.txt`), texts.slice(at, at + 128).join('\n') + '\n')
    } else if (!mode.startsWith('turbovec')) {
      const writeStart = performance.now()
      const records = Array.from({ length: count }, (_, at) => recordOf(offset + at))
      const outcome = await ctx.vectorStore.write(records, new Map(records.map((record, at) => [record.id, vectors[at]!])) )
      if (outcome.written !== count || outcome.rejected !== 0) throw new Error('Incomplete canonical write')
      insertionMs += performance.now() - writeStart
    }
    if (mode === 'combined' || mode.startsWith('turbovec')) {
      const acceleratorStart = performance.now()
      await ctx.accelerator!.add(Array.from({ length: count }, (_, at) => idOf(offset + at)), vectors)
      accelerationBuildMs += performance.now() - acceleratorStart
      if (!(await ctx.accelerator!.stats()).available) {
        console.log('RETRIEVAL_RESULT ' + JSON.stringify({ skipped: true, reason: (await ctx.accelerator!.stats()).degradedReason }))
        process.exitCode = 0
        break
      }
    }
  }
  if ((mode.startsWith('turbovec') || mode === 'combined') && !(await ctx.accelerator!.stats()).available) {
    // Optional Python/native installation failures are explicit skips, never a Zvec measurement.
  } else {
    const optimizeStart = performance.now()
    if (mode !== 'baseline' && !mode.startsWith('turbovec')) await ctx.vectorStore.optimize()
    const optimizeMs = performance.now() - optimizeStart
    const creationMs = performance.now() - creationStart
    const targets = Array.from({ length: queries }, (_, query) => Math.floor(query * (size - 1) / queries))
    const queryTexts = targets.map(queryOf)
    const queryVectors = await ctx.embeddings.embed(queryTexts)
    const truthStart = performance.now()
    const groundTruth = queryVectors.map(exact)
    const exactGroundTruthMs = performance.now() - truthStart
    const allowlist = Array.from({ length: size }, (_, index) => idOf(index))
    const filter = mode === 'baseline' ? null : ctx.retrieval.buildFilter(identity, ['workspace'])
    const search = async (query: number): Promise<BackendHit[]> => {
      if (mode === 'baseline') {
        try {
          const { stdout } = await execute('rg', ['--fixed-strings', '--line-number', '--no-heading', '--', queryTexts[query]!, sourceRoot], { maxBuffer: 1024 * 1024, timeout: 30_000 })
          return stdout.trim().split('\n').slice(0, 10).flatMap(line => {
            const match = /symbol(\d{7})/.exec(line)
            return match ? [{ id: idOf(Number(match[1])), score: 1 }] : []
          })
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) return []
          throw error
        }
      }
      if (mode.startsWith('turbovec')) return ctx!.accelerator!.search(queryVectors[query]!, 10, allowlist)
      if (mode === 'hybrid') return ctx!.vectorStore.searchHybrid(queryVectors[query]!, queryTexts[query]!, 10, filter!)
      if (mode === 'combined') {
        const packet = await ctx!.retrieval.search({ mode: 'semantic', text: queryTexts[query]!, topK: 10, scopes: ['workspace'], pathPrefixes: [], minScore: 0, budgetTokens: 4000 }, identity)
        return packet.candidates.map(candidate => ({ id: candidate.record.id, score: candidate.score }))
      }
      return ctx!.vectorStore.searchVector(queryVectors[query]!, 10, filter!)
    }
    const firstStart = performance.now()
    await search(0)
    const firstSearchMs = performance.now() - firstStart
    const latency: number[] = []
    let recall1 = 0, recall5 = 0, recall10 = 0, mrr = 0, intendedSourceAt1 = 0, intendedSourceAt10 = 0
    const batchStarted = performance.now()
    const queryCpuStart = process.cpuUsage()
    for (let query = 0; query < queries; query++) {
      const queryStart = performance.now()
      const hits = await search(query)
      latency.push(performance.now() - queryStart)
      const expected = groundTruth[query]!
      if (hits[0]?.id === idOf(targets[query]!)) intendedSourceAt1++
      if (hits.slice(0, 10).some(hit => hit.id === idOf(targets[query]!))) intendedSourceAt10++
      for (const k of [1, 5, 10]) {
        const wanted = new Set(expected.slice(0, k))
        const recall = hits.slice(0, k).filter(hit => wanted.has(hit.id)).length / k
        if (k === 1) recall1 += recall
        else if (k === 5) recall5 += recall
        else recall10 += recall
      }
      const rank = hits.findIndex(hit => hit.id === expected[0])
      mrr += rank < 0 ? 0 : 1 / (rank + 1)
    }
    const batchMs = performance.now() - batchStarted
    const queryCpu = process.cpuUsage(queryCpuStart)
    const ipcRoundtripMs: number[] = []
    if (mode === 'combined' || mode.startsWith('turbovec')) {
      for (let call = 0; call < 16; call++) {
        const before = performance.now()
        await ctx.accelerator!.stats()
        ipcRoundtripMs.push(performance.now() - before)
      }
    }
    const contextLatency: number[] = []
    const contextTokens: number[] = []
    const contextServedBy: Record<string, number> = {}
    if (mode !== 'baseline' && !mode.startsWith('turbovec')) {
      for (let query = 0; query < queries; query++) {
        const before = performance.now()
        const packet = await ctx.retrieval.search({ mode: mode === 'hybrid' ? 'hybrid' : 'semantic', text: queryTexts[query]!, topK: 6,
          scopes: ['workspace'], pathPrefixes: [], minScore: 0.2, budgetTokens: 1200 }, identity)
        contextLatency.push(performance.now() - before)
        contextTokens.push(packet.tokens)
        contextServedBy[packet.servedBy] = (contextServedBy[packet.servedBy] ?? 0) + 1
      }
    }
    let coldActivationQueryMs: number | null = null
    let coldCompressedRebuildMs: number | null = null
    if (mode !== 'baseline') {
      await ctx.fiber.dispose()
      const coldStart = performance.now()
      ctx = await activate()
      if (mode.startsWith('turbovec')) {
        const rebuildStart = performance.now()
        for (let offset = 0; offset < size; offset += 256) {
          const count = Math.min(256, size - offset)
          await ctx.accelerator!.add(Array.from({ length: count }, (_, at) => idOf(offset + at)),
            Array.from({ length: count }, (_, at) => Array.from(matrix.subarray((offset + at) * dimension, (offset + at + 1) * dimension))))
        }
        coldCompressedRebuildMs = performance.now() - rebuildStart
      }
      await search(0)
      coldActivationQueryMs = performance.now() - coldStart
    }
    const annSweep: { hnswEf: number; latency: ReturnType<typeof summary>; recall1: number; recall10: number; mrr: number }[] = []
    if (mode === 'ann-sweep') {
      diagnostics.annSweep = annSweep
      for (const hnswEf of [128, 256, 512, 1024, 2048]) {
        await ctx.fiber.dispose()
        ctx = await activate(hnswEf)
        await search(0)
        const samples: number[] = []
        let first = 0, recall = 0, reciprocal = 0
        for (let query = 0; query < queries; query++) {
          const before = performance.now()
          const hits = await search(query)
          samples.push(performance.now() - before)
          const expected = groundTruth[query]!
          const wanted = new Set(expected)
          if (hits[0]?.id === expected[0]) first++
          recall += hits.filter(hit => wanted.has(hit.id)).length / 10
          const rank = hits.findIndex(hit => hit.id === expected[0])
          if (rank >= 0) reciprocal += 1 / (rank + 1)
        }
        annSweep.push({ hnswEf, latency: summary(samples), recall1: first / queries, recall10: recall / queries, mrr: reciprocal / queries })
      }
    }
    const pairedContext: { hnswEf: number; backend: string; compressedBuildMs: number; latency: ReturnType<typeof summary>; servedBy: Record<string, number>; intendedSourceAt1: number; tokens: number[] }[] = []
    if (mode === 'paired' || mode === 'ann-sweep') {
      diagnostics.pairedContext = pairedContext
      for (const hnswEf of [64, 1024]) {
        for (const backend of ['zvec', 'combined']) {
          await ctx.fiber.dispose()
          ctx = await activate(hnswEf, backend === 'combined')
          const compressedStart = performance.now()
          if (backend === 'combined') {
            for (let offset = 0; offset < size; offset += 256) {
              const count = Math.min(256, size - offset)
              await ctx.accelerator!.add(Array.from({ length: count }, (_, at) => idOf(offset + at)),
                Array.from({ length: count }, (_, at) => Array.from(matrix.subarray((offset + at) * dimension, (offset + at + 1) * dimension))))
            }
          }
          const compressedBuildMs = backend === 'combined' ? performance.now() - compressedStart : 0
          const contextQuery = (query: number): RetrievalQuery => ({ mode: 'semantic', text: queryTexts[query]!, topK: 6,
            scopes: ['workspace'], pathPrefixes: [], minScore: 0.2, budgetTokens: 1200 })
          for (let warmup = 0; warmup < 5; warmup++) await ctx.retrieval.search(contextQuery(warmup % queries), identity)
          const samples: number[] = []
          const tokens: number[] = []
          const servedBy: Record<string, number> = {}
          let correct = 0
          for (let query = 0; query < queries; query++) {
            const before = performance.now()
            const packet = await ctx.retrieval.search(contextQuery(query), identity)
            samples.push(performance.now() - before)
            tokens.push(packet.tokens)
            servedBy[packet.servedBy] = (servedBy[packet.servedBy] ?? 0) + 1
            if (packet.candidates[0]?.record.id === idOf(targets[query]!)) correct++
          }
          pairedContext.push({ hnswEf, backend, compressedBuildMs, latency: summary(samples), servedBy, intendedSourceAt1: correct / queries, tokens })
        }
      }
    }
    const incrementalStart = performance.now()
    const changed = Math.max(1, Math.floor(size / 100))
    for (let offset = 0; offset < changed; offset += 256) {
      const count = Math.min(256, changed - offset)
      const ids = Array.from({ length: count }, (_, at) => idOf(size - changed + offset + at))
      const texts = ids.map(id => `Updated synthetic decision ${id} retry policy revision two.`)
      const vectors = await ctx.embeddings.embed(texts)
      if (mode !== 'baseline' && !mode.startsWith('turbovec')) {
        const records = ids.map((id, at) => ({ ...recordOf(size - changed + offset + at), id, text: texts[at]!, contentHash: contentHash(texts[at]!) }))
        const result = await ctx.vectorStore.write(records, new Map(ids.map((id, at) => [id, vectors[at]!])) )
        if (result.written !== count) throw new Error('Incomplete incremental write')
      }
      if (mode === 'combined' || mode.startsWith('turbovec')) await ctx.accelerator!.add(ids, vectors)
    }
    const incrementalMs = performance.now() - incrementalStart
    const usage = process.cpuUsage(cpuStarted)
    console.log('RETRIEVAL_RESULT ' + JSON.stringify({ skipped: false, workload: 'four-domain synthetic feature-hash embeddings; exact cosine ground truth',
      creationMs, embeddingMs, insertionMs, accelerationBuildMs, optimizeMs, firstSearchMs, coldActivationQueryMs, coldCompressedRebuildMs,
      latency: summary(latency), sequentialQueriesPerSecond: queries / (batchMs / 1000),
      queryNodeCpuMs: { user: queryCpu.user / 1000, system: queryCpu.system / 1000 }, ipcRoundtrip: summary(ipcRoundtripMs),
      quality: { recall1: recall1 / queries, recall5: recall5 / queries, recall10: recall10 / queries, mrr: mrr / queries,
        intendedSourceAt1: intendedSourceAt1 / queries, intendedSourceAt10: intendedSourceAt10 / queries },
      contextLatency: summary(contextLatency), contextTokens, contextServedBy, corpusTokenEstimate: totalInputTokens,
      incremental: { changed, elapsedMs: incrementalMs }, exactGroundTruthMs,
      annSweep,
      pairedContext,
      diskBytes: await bytesUnder(root), cpuMs: { user: usage.user / 1000, system: usage.system / 1000 },
      memoryBefore, memoryAfter: process.memoryUsage(), peakNodeRssBytes: process.resourceUsage().maxRSS * 1024,
      totalMs: performance.now() - started,
      exclusions: ['language understanding and model task accuracy', 'OS page-cache cold start', 'network/model generation', 'parallel batch search', 'physical secure erasure'] }))
  }
  }
} catch (error) {
  console.error(error)
  console.log('RETRIEVAL_RESULT ' + JSON.stringify({ failed: true, error: error instanceof Error ? error.message : String(error), ...diagnostics }))
  process.exitCode = 1
} finally {
  if (ctx) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
