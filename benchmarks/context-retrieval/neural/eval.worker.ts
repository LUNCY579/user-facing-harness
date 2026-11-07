/**
 * Neural relevance diagnostic over built retrieval plugins, the synthetic case
 * set in `cases.ts`, and one embedding provider per route. Prints one
 * `NEURAL_RESULT` JSON line; the supervisor owns the report file and process memory.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RetrievalService, contentHash, spaceKeyOf, OwnerKey, WorkspaceKey, SessionKey, AgentKey,
  RecordId, type RetrievalQuery, type StoredRecord, type TrustedIdentity } from '@deepseek-ai/dsh-retrieval'
import * as embeddings from '@deepseek-ai/dsh-retrieval-embed'
import * as zvec from '@deepseek-ai/dsh-retrieval-zvec'
import { passages, queries, targets, conditions, type CaseCategory, type EvalRoute } from './cases.ts'

interface Settings {
  route: EvalRoute
  provider: 'local-hashed' | 'local-openai-compatible'
  model: string
  modelRevision: string
  baseUrl: string
  dimension: number
  runs: number
  topK: number
  minScore: number
  hnswEf: number
  root?: string
  selftest?: boolean
}

const settings = JSON.parse(process.env.RETRIEVAL_NEURAL ?? '{}') as Settings
const root = settings.root ?? await mkdtemp(join(tmpdir(), 'dsh-neural-bench-'))
const corpusRoot = join(root, 'corpus')
const failures: string[] = []
const latencySamples: number[] = []
const identity: TrustedIdentity = { ownerKey: OwnerKey('eval-owner'), workspaceKey: WorkspaceKey('eval-workspace'),
  workspaceRoot: corpusRoot, sessionKey: SessionKey('eval-session'), agentKey: AgentKey('eval-agent'),
  allowCrossSession: true, allowUserScope: true }
const evidenceClass = settings.provider === 'local-openai-compatible'
  ? (settings.selftest ? 'harness-plumbing' : 'neural-model')
  : 'lexical-baseline'
let ctx: Context | undefined
let closeServer: () => void = () => undefined

/** Ids carry the passage key so a returned citation maps back without text matching. */
const idOf = (passageId: string): RecordId => RecordId(`chunk:${passageId}`)
const passageIdOf = (id: string): string => id.startsWith('chunk:') ? id.slice(6) : id

/** Write every passage to the file its citation names, so disk backs each ranking. */
async function writeCorpus(): Promise<void> {
  await mkdir(corpusRoot, { recursive: true })
  const linesByFile = new Map<string, string[]>()
  for (const passage of passages) {
    const file = join(corpusRoot, passage.source)
    const lines = linesByFile.get(file) ?? []
    while (lines.length < passage.startLine) lines.push('')
    lines[passage.startLine - 1] = passage.text
    linesByFile.set(file, lines)
  }
  for (const [file, lines] of linesByFile) {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, `${lines.join('\n')}\n`)
  }
}

function recordOf(passage: (typeof passages)[number]): StoredRecord {
  const text = passage.text
  return { kind: 'chunk', id: idOf(passage.id), scope: 'workspace', ownerKey: identity.ownerKey, agentKey: null,
    workspaceKey: identity.workspaceKey, sessionKey: null, text, contentHash: contentHash(text), updatedAt: 1,
    spaceKey: spaceKeyOf(ctx!.embeddings.space), source: join(corpusRoot, passage.source),
    startLine: passage.startLine, endLine: passage.endLine }
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] ?? 0
}

/** Normalized discounted cumulative gain over the authored relevance set at depth ten. */
function ndcgAt10(ranked: readonly string[], relevant: readonly string[]): number {
  if (relevant.length === 0) return 0
  const discount = (position: number): number => 1 / Math.log2(position + 2)
  let actual = 0
  for (let at = 0; at < Math.min(10, ranked.length); at++) if (relevant.includes(ranked[at]!)) actual += discount(at)
  let ideal = 0
  for (let at = 0; at < Math.min(10, relevant.length); at++) ideal += discount(at)
  return ideal === 0 ? 0 : actual / ideal
}

/**
 * Deterministic loopback stand-in. It is arithmetic over token digests, not a
 * trained encoder, and exists only to exercise the harness end to end. Its
 * report row is labelled `harness-plumbing` and never counts as neural evidence.
 */
async function startStandInServer(): Promise<void> {
  const width = settings.dimension
  const classWidth = Math.max(1, Math.floor(width / 24))
  const vectorOf = (text: string): number[] => {
    const vector = new Array<number>(width).fill(0)
    for (const token of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\u0400-\u04ff]+/).filter(Boolean)) {
      const digest = createHash('sha256').update(token).digest()
      vector[digest.readUInt16BE(0) % width]! += 1
      vector[classWidth + (digest.readUInt16BE(2) % (width - classWidth))]! += 0.4
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
    return vector.map(value => value / norm)
  }
  const http = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/embeddings')) { response.writeHead(404).end('{}'); return }
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { input?: string | string[] }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? '']
      const data = inputs.map((text, index) => ({ index, object: 'embedding', embedding: vectorOf(text) }))
      response.writeHead(200, { 'content-type': 'application/json' }, )
      response.end(JSON.stringify({ object: 'list', model: 'harness-stand-in', data }))
    })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('stand-in embedding server did not bind a TCP port')
  settings.baseUrl = `http://127.0.0.1:${address.port}/v1`
  closeServer = () => http.close()
}

async function activate(): Promise<Context> {
  const context = new Context()
  await context.plugin(embeddings, embeddings.Config({ provider: settings.provider, model: settings.model,
    modelRevision: settings.modelRevision, dimension: settings.dimension, baseUrl: settings.baseUrl,
    timeoutMs: settings.selftest ? 10_000 : 120_000, maxBatch: 32, maxRetries: 1 }))
  await context.plugin(zvec, zvec.Config({ indexDir: join(root, 'index', settings.route), queryThreads: 1,
    optimizeThreads: 1, hnswEf: settings.hnswEf }))
  await context.plugin(RetrievalService, RetrievalService.Config({ persistentMemory: false, crossSessionRead: false,
    useAccelerator: false, defaultMinScore: 0, defaultBudgetTokens: 8000 }))
  return context
}

const modeOf: Record<EvalRoute, RetrievalQuery['mode']> = { keyword: 'keyword', hashed: 'semantic', dense: 'semantic', hybrid: 'hybrid' }
const categories: CaseCategory[] = ['paraphrase', 'hard-negative', 'identifier', 'multilingual', 'missing-evidence']

interface Row { queryId: string; category: CaseCategory; ranked: string[]; topScore: number; firstRank: number | null; elapsedMs: number }
const rows: Row[] = []

function categorySummary(category: CaseCategory) {
  const subset = rows.filter(row => row.category === category)
  const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length)
  const reciprocal = (row: Row): number => (row.firstRank === null ? 0 : 1 / row.firstRank)
  return { queries: subset.length,
    answered: subset.filter(row => (queries.find(query => query.id === row.queryId)?.relevant.length ?? 0) > 0).length,
    recallAt1: mean(subset.map(row => (row.firstRank !== null && row.firstRank <= 1 ? 1 : 0))),
    recallAt5: mean(subset.map(row => (row.firstRank !== null && row.firstRank <= 5 ? 1 : 0))),
    recallAt10: mean(subset.map(row => (row.firstRank !== null && row.firstRank <= 10 ? 1 : 0))),
    mrr: mean(subset.map(reciprocal)),
    ndcgAt10: mean(subset.map(row => ndcgAt10(row.ranked, queries.find(query => query.id === row.queryId)?.relevant ?? []))) }
}

function checks(): { metric: string; category?: CaseCategory; target: number; measured: number; passed: boolean }[] {
  const found: { metric: string; category?: CaseCategory; target: number; measured: number; passed: boolean }[] = []
  for (const category of categories.filter(category => category !== 'missing-evidence')) {
    const target = targets.recallAt10[category]?.[settings.route]
    if (target === undefined) continue
    const measured = categorySummary(category).recallAt10
    found.push({ metric: 'recallAt10', category, target, measured, passed: measured >= target })
  }
  const answered = rows.filter(row => (queries.find(query => query.id === row.queryId)?.relevant.length ?? 0) > 0)
  const mrr = answered.length === 0 ? 0 : answered.reduce((sum, row) => sum + (row.firstRank === null ? 0 : 1 / row.firstRank), 0) / answered.length
  found.push({ metric: 'mrr', target: targets.mrr[settings.route], measured: mrr, passed: mrr >= targets.mrr[settings.route] })
  const missing = rows.filter(row => row.category === 'missing-evidence')
  const abstentionRate = missing.length === 0 ? 0 : missing.filter(row => row.ranked.length === 0).length / missing.length
  const meanTopScore = missing.length === 0 ? 0 : missing.reduce((sum, row) => sum + row.topScore, 0) / missing.length
  found.push({ metric: 'abstentionRate', category: 'missing-evidence', target: targets.missingEvidence.abstentionRate,
    measured: abstentionRate, passed: missing.length > 0 && abstentionRate >= targets.missingEvidence.abstentionRate })
  found.push({ metric: 'maxMeanTopScore', category: 'missing-evidence', target: targets.missingEvidence.maxMeanTopScore,
    measured: meanTopScore, passed: meanTopScore <= targets.missingEvidence.maxMeanTopScore })
  const citations = rows.filter(row => row.ranked.every(id => passages.some(passage => passage.id === id)))
  found.push({ metric: 'citationValidity', target: targets.citationValidity,
    measured: rows.length === 0 ? 0 : citations.length / rows.length, passed: citations.length === rows.length })
  return found
}

try {
  if (settings.selftest) await startStandInServer()
  await writeCorpus()
  ctx = await activate()
  const vectors = await ctx.embeddings.embed(passages.map(passage => passage.text))
  const records = passages.map(passage => recordOf(passage))
  const vectorsById = new Map(records.map((record, index) => [record.id, vectors[index]!] as const))
  const write = await ctx.vectorStore.write(records, vectorsById)
  if (write.written !== passages.length || write.rejected !== 0)
    failures.push(`canonical write accepted ${write.written} of ${passages.length}, rejected ${write.rejected}${write.spaceConflict ? ' (space conflict)' : ''}`)

  for (let run = 0; run < settings.runs; run++) {
    for (const query of queries) {
      const started = performance.now()
      let ranked: string[] = []
      let topScore = 0
      try {
        const packet = await ctx.retrieval.search({ mode: modeOf[settings.route], text: query.text, topK: settings.topK,
          scopes: ['workspace'], pathPrefixes: [], kinds: ['chunk'], minScore: settings.minScore, budgetTokens: 8000 }, identity)
        ranked = packet.candidates.map(candidate => passageIdOf(candidate.record.id as string))
        topScore = packet.candidates[0]?.score ?? 0
        for (const candidate of packet.candidates) {
          if (candidate.record.kind !== 'chunk') { failures.push(`${query.id}: candidate is not a source chunk`); continue }
          const citation = passages.find(passage => passage.id === passageIdOf(candidate.record.id as string))
          if (!citation || candidate.record.startLine !== citation.startLine || !candidate.record.text.includes(citation.text.slice(0, 40)))
            failures.push(`${query.id}: citation does not resolve to its authored passage`)
        }
      } catch (error) {
        failures.push(`${query.id}: ${(error as Error).message}`)
      }
      const elapsedMs = performance.now() - started
      latencySamples.push(elapsedMs)
      const firstAt = ranked.findIndex(id => query.relevant.includes(id))
      rows.push({ queryId: query.id, category: query.category, ranked, topScore, firstRank: firstAt < 0 ? null : firstAt + 1, elapsedMs })
    }
  }

  const memory = process.memoryUsage()
  console.log('NEURAL_RESULT ' + JSON.stringify({
    route: settings.route,
    provider: settings.provider,
    evidenceClass,
    neuralQualityValidated: evidenceClass === 'neural-model',
    embeddingSpace: { model: settings.model, modelRevision: settings.modelRevision, dimension: settings.dimension,
      spaceKey: spaceKeyOf(ctx.embeddings.space), baseUrl: settings.baseUrl },
    conditions: { topK: settings.topK, minScore: settings.minScore, hnswEf: settings.hnswEf, runs: settings.runs,
      seed: conditions.seed, corpusPassages: passages.length, evalQueries: queries.length },
    byCategory: Object.fromEntries(categories.map(category => [category, categorySummary(category)])),
    targetChecks: checks(),
    latencyMs: { p50: percentile(latencySamples, 0.5), p95: percentile(latencySamples, 0.95), samples: latencySamples.length },
    memory: { rssBytes: memory.rss, heapBytes: memory.heapUsed, peakRssBytes: process.resourceUsage().maxRSS * 1024 },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    failures,
    outcomes: rows.map(row => ({ queryId: row.queryId, category: row.category, ranked: row.ranked.slice(0, 10),
      topScore: Number(row.topScore.toFixed(4)), firstRelevantRank: row.firstRank, elapsedMs: Number(row.elapsedMs.toFixed(3)) })),
  }))
} catch (error) {
  console.log('NEURAL_RESULT ' + JSON.stringify({ route: settings.route, provider: settings.provider,
    evidenceClass, neuralQualityValidated: false,
    error: (error as Error).message, failures: [...failures, `aborted: ${(error as Error).message}`] }))
  process.exitCode = 1
} finally {
  closeServer()
  if (ctx) await ctx.fiber.dispose()
  if (!settings.root) await rm(root, { recursive: true, force: true })
}
