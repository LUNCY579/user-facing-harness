/** Run optional retrieval diagnostics in isolated built-JavaScript children; no timing budgets. */
import { spawn, execFile } from 'node:child_process'
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { cpus, totalmem, platform, arch, release, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
if (platform() === 'win32') throw new Error('The benchmark supervisor requires POSIX process groups and ps. Run it on macOS, Linux, or WSL.')
const argumentsOf = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...parts] = value.replace(/^--/, '').split('=')
  return [key, parts.join('=')]
}))
const sizes = (argumentsOf.sizes ?? '1000,10000,100000').split(',').map(Number)
const modes = (argumentsOf.modes ?? 'baseline,zvec,turbovec4,turbovec2,combined,hybrid').split(',')
const runs = Number(argumentsOf.runs ?? 1)
const queries = Number(argumentsOf.queries ?? 64)
const dimension = Number(argumentsOf.dimension ?? 256)
const allowedModes = new Set(['baseline', 'zvec', 'turbovec4', 'turbovec2', 'combined', 'hybrid', 'packing', 'ann-sweep', 'paired'])
if (sizes.some(size => !Number.isInteger(size) || size < 10 || size > 1_000_000)
  || modes.some(mode => !allowedModes.has(mode))
  || !Number.isInteger(runs) || runs < 1 || runs > 10
  || !Number.isInteger(queries) || queries < 10 || queries > 1000
  || !Number.isInteger(dimension) || dimension < 8 || dimension > 4096) {
  throw new Error('Expected sizes 10..1000000, runs 1..10, queries 10..1000, dimension 8..4096.')
}
const output = resolve(argumentsOf.output ?? '.testingplatform/retrieval-benchmark/results.json')
const worker = resolve('benchmarks/.dsh-build/context-retrieval/retrieval.worker.js')
const report = {
  version: 1,
  createdAt: new Date().toISOString(),
  machine: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version },
  settings: { sizes, modes, runs, queries, dimension, concurrency: 1, seed: 421337, python: argumentsOf.python ?? 'python3' },
  samples: [],
}
await mkdir(resolve(output, '..'), { recursive: true })
let stopping = false
let currentChild
const stop = () => { stopping = true; terminate(currentChild) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
function terminate(child) {
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
workloads: for (const size of sizes) {
  for (const mode of modes) {
    for (let iteration = 0; iteration < runs; iteration++) {
      if (stopping) break workloads
      const runRoot = await mkdtemp(join(tmpdir(), 'dsh-retrieval-bench-'))
      const child = spawn(process.execPath, ['--max-old-space-size=2048', worker], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
          RETRIEVAL_BENCH: JSON.stringify({ size, mode, queries, dimension, python: report.settings.python, root: runRoot }) },
      })
      currentChild = child
      let stdout = ''
      let stderr = ''
      let peakTreeRssBytes = 0
      let sampling = false
      let samplingTask = Promise.resolve()
      const cpuByPid = new Map()
      const sample = async () => {
        if (sampling || !child.pid || platform() === 'win32') return
        sampling = true
        try {
          const { stdout: rows } = await execute('ps', ['-axo', 'pid=,ppid=,rss=,time='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
          const processes = rows.trim().split('\n').map(row => row.trim().split(/\s+/)).map(([pid, ppid, rss, time]) => ({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss), time }))
          const owned = new Set([child.pid])
          for (let pass = 0; pass < 8; pass++) for (const process of processes) if (owned.has(process.ppid)) owned.add(process.pid)
          let rss = 0
          for (const process of processes) if (owned.has(process.pid)) {
            rss += process.rss * 1024
            const parts = process.time.split(':').map(Number)
            cpuByPid.set(process.pid, parts.reduce((sum, part) => sum * 60 + part, 0) * 1000)
          }
          peakTreeRssBytes = Math.max(peakTreeRssBytes, rss)
        } catch (error) {
          report.samplingError ??= error.message
        } finally {
          sampling = false
        }
      }
      const interval = setInterval(() => { if (!sampling) samplingTask = sample() }, 100)
      const deadline = setTimeout(() => terminate(child), 20 * 60_000)
      child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 16_000_000) terminate(child) })
      child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16_000) })
      const settlement = await new Promise(resolve => {
        child.once('error', error => resolve({ code: null, signal: null, error: error.message }))
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      clearInterval(interval)
      clearTimeout(deadline)
      await samplingTask
      currentChild = undefined
      await rm(runRoot, { recursive: true, force: true })
      const resultLine = stdout.split('\n').findLast(line => line.startsWith('RETRIEVAL_RESULT '))
      const result = resultLine ? JSON.parse(resultLine.slice('RETRIEVAL_RESULT '.length)) : null
      const sampleResult = { size, mode, iteration, ...settlement, sampledPeakTreeRssBytes: peakTreeRssBytes,
        sampledTreeCpuMs: [...cpuByPid.values()].reduce((a, b) => a + b, 0), result, stderr }
      report.samples.push(sampleResult)
      await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      console.log(JSON.stringify({ size, mode, iteration, code: settlement.code, skipped: result?.skipped,
        p50Ms: result?.latency?.p50, p95Ms: result?.latency?.p95, recall10: result?.quality?.recall10,
        sampledPeakMiB: Math.round(peakTreeRssBytes / 1024 / 1024) }))
    }
  }
}
process.off('SIGINT', stop)
process.off('SIGTERM', stop)
console.log(`Measurements: ${output}`)
if (report.samples.some(sample => sample.code !== 0)) process.exitCode = 1
