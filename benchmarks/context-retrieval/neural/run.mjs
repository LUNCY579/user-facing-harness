/** Supervise neural relevance diagnostics in isolated built-JavaScript children; record pending routes honestly. */
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { cpus, totalmem, platform, arch, release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
if (platform() === 'win32') throw new Error('The neural relevance supervisor requires POSIX process groups and ps. Run it on macOS, Linux, or WSL.')
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...parts] = value.replace(/^--/, '').split('=')
  return [key, parts.join('=')]
}))
const requested = (options.routes ?? 'keyword,hashed,dense,hybrid').split(',')
const allRoutes = ['keyword', 'hashed', 'dense', 'hybrid']
if (requested.some(route => !allRoutes.includes(route))) throw new Error(`Expected routes from ${allRoutes.join(', ')}.`)
const runs = Number(options.runs ?? 1)
const topK = Number(options.topK ?? 10)
const minScore = Number(options.minScore ?? 0.2)
const hnswEf = Number(options.hnswEf ?? 2048)
if (!Number.isInteger(runs) || runs < 1 || runs > 5 || !Number.isInteger(topK) || topK < 5 || topK > 50
  || !Number.isInteger(hnswEf) || hnswEf < 16 || hnswEf > 2048 || Number.isNaN(minScore) || minScore < 0 || minScore > 1) {
  throw new Error('Expected runs 1..5, topK 5..50, minScore 0..1, hnswEf 16..2048.')
}
const selftest = options.selftest === 'true'
const neural = { baseUrl: options.baseUrl ?? 'http://127.0.0.1:11434/v1', model: options.model ?? 'bge-m3:567m',
  modelRevision: options.modelRevision ?? '5617a9f61b028005a4858fdac845db406aefb181', dimension: Number(options.dimension ?? 1024) }
const output = resolve(options.output ?? '.testingplatform/retrieval-neural/results.json')
const worker = resolve('benchmarks/.dsh-build/context-retrieval-neural/eval.worker.js')
const reportRoot = await mkdtemp(join(tmpdir(), 'dsh-neural-run-'))
const report = {
  version: 1, createdAt: new Date().toISOString(),
  machine: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version },
  recipe: { provider: 'local-openai-compatible', transport: 'loopback OpenAI-compatible /v1/embeddings', ...neural,
    upstream: { modelCard: 'https://huggingface.co/BAAI/bge-m3', license: 'MIT', denseDimensions: 1024,
      maxSequenceTokens: 8192, languages: 'more than 100', queryInstructionRequired: false,
      ollamaTags: ['bge-m3:latest', 'bge-m3:567m'], ollamaPackageBytes: 1_200_000_000,
      openaiEndpointFields: ['model', 'input', 'dimensions'] } },
  selftest, conditions: { runs, topK, minScore, hnswEf, seed: 421337 },
  endpoint: { baseUrl: neural.baseUrl, reachable: false, server: null, models: [], probeError: null },
  routes: [],
  pending: [],
  failures: [],
}

/** Ask the configured loopback endpoint who it is; no credential is ever sent. */
async function probeEndpoint() {
  const target = `${neural.baseUrl.replace(/\/$/, '')}/models`
  const abort = AbortSignal.timeout(4000)
  try {
    const response = await fetch(target, { signal: abort })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    report.endpoint.reachable = true
    report.endpoint.server = response.headers.get('server')
    report.endpoint.models = (body?.data ?? body?.models ?? []).map(entry => entry?.id).filter(Boolean)
    if (report.endpoint.server?.toLowerCase().includes('key') || JSON.stringify(body).length > 65536) {
      report.endpoint.models = report.endpoint.models.slice(0, 64)
    }
  } catch (error) {
    report.endpoint.probeError = `${(error && error.name) || 'Error'}: ${(error && error.message) || 'probe failed'}`
  }
}

let stopping = false
let currentChild
const stop = () => { stopping = true; terminate(currentChild) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
function terminate(child) {
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
}

/** Peak resident set over the child tree, so the Python/helper pages are counted too. */
async function treeRss(child) {
  try {
    const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    const rows = stdout.trim().split('\n').map(row => row.trim().split(/\s+/))
      .map(([pid, ppid, rss]) => ({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss) }))
    const owned = new Set([child.pid])
    for (let pass = 0; pass < 8; pass++) for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid)
    return rows.filter(row => owned.has(row.pid)).reduce((sum, row) => sum + row.rss * 1024, 0)
  } catch { return 0 }
}

async function runRoute(route) {
  const useNeural = route === 'dense' || route === 'hybrid'
  const settings = { route, provider: useNeural ? 'local-openai-compatible' : 'local-hashed',
    model: useNeural ? neural.model : 'dsh-hashed-v1',
    modelRevision: useNeural ? neural.modelRevision : '',
    baseUrl: useNeural ? neural.baseUrl : '', dimension: useNeural ? neural.dimension : 256,
    runs, topK, minScore, hnswEf, root: join(reportRoot, route), selftest }
  const child = spawn(process.execPath, ['--max-old-space-size=4096', worker], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, RETRIEVAL_NEURAL: JSON.stringify(settings) } })
  currentChild = child
  let stdout = ''
  let stderr = ''
  let peakTreeRssBytes = 0
  let samplingTask = Promise.resolve()
  let sampling = false
  const sampler = setInterval(() => {
    if (sampling || !child.pid) return
    sampling = true
    samplingTask = treeRss(child)
      .then(rss => { peakTreeRssBytes = Math.max(peakTreeRssBytes, rss) })
      .finally(() => { sampling = false })
  }, 100)
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise(resolveExit => { child.on('close', resolveExit) })
  clearInterval(sampler)
  await samplingTask
  currentChild = undefined
  const line = stdout.split('\n').find(row => row.startsWith('NEURAL_RESULT '))
  if (!line) {
    report.failures.push({ route, reason: `worker exited ${exitCode} without a result: ${stderr.slice(0, 400)}` })
    return null
  }
  const parsed = JSON.parse(line.slice('NEURAL_RESULT '.length))
  parsed.peakTreeRssBytes = peakTreeRssBytes
  return parsed
}

await mkdir(resolve(output, '..'), { recursive: true })
if (!selftest) await probeEndpoint()
for (const route of requested) {
  if (stopping) break
  const useNeural = route === 'dense' || route === 'hybrid'
  if (useNeural && !selftest && !report.endpoint.reachable) {
    report.pending.push({ route, reason: `no usable loopback embedding endpoint at ${neural.baseUrl} (${report.endpoint.probeError})`,
      requiredToClear: `Start the pinned recipe: ollama pull ${neural.model}, then re-run with --baseUrl, or pass --selftest=true only to exercise the harness.` })
    continue
  }
  const result = await runRoute(route)
  if (result) report.routes.push(result)
}

const measured = report.routes.filter(row => !row.error)
const byMetric = {}
for (const route of measured) {
  byMetric[route.route] = Object.fromEntries(Object.entries(route.byCategory ?? {})
    .map(([category, values]) => [category, { recallAt10: values.recallAt10, mrr: values.mrr, ndcgAt10: values.ndcgAt10 }]))
}
const dense = measured.find(row => row.route === 'dense')
const hashed = measured.find(row => row.route === 'hashed')
const margins = { denseOverHashedParaphraseRecallAt10: null, hybridOverDenseHardNegativeMrr: null }
if (dense && hashed) {
  margins.denseOverHashedParaphraseRecallAt10 = (dense.byCategory.paraphrase?.recallAt10 ?? 0) - (hashed.byCategory.paraphrase?.recallAt10 ?? 0)
  margins.meetsDenseMargin = margins.denseOverHashedParaphraseRecallAt10 >= 0.15
}
const hybrid = measured.find(row => row.route === 'hybrid')
if (hybrid && dense) {
  margins.hybridOverDenseHardNegativeMrr = (hybrid.byCategory['hard-negative']?.mrr ?? 0) - (dense.byCategory['hard-negative']?.mrr ?? 0)
}
report.comparison = { byMetric, margins }
report.targetVerdicts = measured.map(row => ({ route: row.route, evidenceClass: row.evidenceClass,
  failed: (row.targetChecks ?? []).filter(check => !check.passed),
  failures: row.failures ?? [] }))
report.recommendation = {
  store: 'zvec',
  accelerator: 'opt-in',
  rationale: report.pending.length > 0
    ? 'Neural dense and hybrid routes were not measured, so no representative evidence supports changing the Zvec default or enabling turbovec.'
    : 'Compared on one corpus with identical query settings; the store default changes only when the declared margins are met.',
  embeddingProvider: selftest ? 'unchanged: harness plumbing check only, not neural evidence'
    : report.pending.length > 0 ? 'unchanged: local-hashed, neural validation pending'
      : (margins.meetsDenseMargin ? 'neural dense met the declared paraphrase margin; review before changing any default' : 'local-hashed remains the shipped default; neural dense missed its margin'),
}
report.status = report.pending.length > 0 ? 'partial-pending-live-neural-endpoint' : (selftest ? 'harness-plumbing-only' : 'measured')
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
await rm(reportRoot, { recursive: true, force: true })
const summaryLine = { status: report.status, measured: measured.map(row => row.route), pending: report.pending.map(row => row.route),
  output, failures: report.failures.length }
console.log(`NEURAL_BENCH ${JSON.stringify(summaryLine)}`)
if (!stopping && report.failures.length > 0) process.exitCode = 1
