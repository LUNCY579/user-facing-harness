/**
 * Execute the native retrieval platform lane: run the suites that drive the real Zvec binding, run the
 * built-entry smoke over published `lib` files, then print one verdict per
 * `scripts/native-retrieval-verdict.ts`. Keyless and bounded — no model key is read, no benchmark runs.
 * Requires `pnpm run build:artifacts` output because the smoke imports built entries.
 * @module
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { expectationsOf, laneViolations, type LaneRun, type SmokeOutcome } from './native-retrieval-verdict.ts'

/**
 * Run one child process to completion.
 * @param command - executable to spawn without a shell.
 * @param args - arguments for it.
 * @param capture - true to collect stdout and stderr instead of forwarding them.
 * @returns exit code (`null` when signalled) and captured output.
 */
async function runChild(
  command: string,
  args: string[],
  capture: boolean,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    }
    child.once('error', rejectRun)
    child.once('close', (code) => { resolveRun({ status: code, stdout, stderr }) })
  })
}

const root = resolve(import.meta.dirname, '..')
const reportPath = resolve(root, '.dsh-build/native-retrieval-cases.json')
const expectations = expectationsOf(process.env, process.platform, process.arch)
await mkdir(dirname(reportPath), { recursive: true })

const vitest = pnpmInvocation(['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`, 'packages/retrieval/retrieval-zvec/tests'])
const suiteResult = await runChild(vitest.command, vitest.args, false)
let run: LaneRun | null = null
try {
  run = JSON.parse(await readFile(reportPath, 'utf8')) as LaneRun
} catch (error) {
  process.stderr.write(`native retrieval lane: unreadable case report: ${String(error)}\n`)
}

const smoke = await runChild(process.execPath, ['packages/bundle/base/smoke/native-retrieval.mjs'], true)
let outcome: SmokeOutcome | null = null
try {
  outcome = JSON.parse(smoke.stdout.trim().split('\n').at(-1) ?? '') as SmokeOutcome
} catch {
  outcome = null
}
const smokeError = outcome === null || smoke.status !== 0
  ? (smoke.stderr.trim().split('\n').at(-1) ?? `exit code ${String(smoke.status)}`)
  : ''

const violations = laneViolations({ run, suiteExitCode: suiteResult.status, smoke: outcome, smokeError, expectations })
if (violations.length > 0) {
  for (const violation of violations) process.stderr.write(`native retrieval lane: ${violation}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ platform: `${expectations.platform}-${expectations.arch}`, cases: run?.numTotalTests ?? 0, smoke: outcome })}\n`)
}
