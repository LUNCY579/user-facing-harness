/** Interpreter validation forwards its own deadline without starting model execution. */
import { tmpdir } from 'node:os'
import type { ExecFileSyncOptions } from 'node:child_process'
import { beforeEach, expect, it, vi } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { PythonPtcRuntime } from '../src/index.ts'
import { createRuntimeContext, pythonFixtureConfig } from './setup.ts'

type ProbeCall = { readonly executable: string; readonly args: readonly string[]; readonly options: ExecFileSyncOptions }
const probe = vi.hoisted(() => ({ calls: [] as ProbeCall[], error: undefined as Error | undefined }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync(...args: Parameters<typeof actual.execFileSync>) {
      const [executable, argv, options] = args
      if (argv?.[0] !== '-I' || argv[1] !== '-c') return actual.execFileSync(...args)
      probe.calls.push({ executable, args: argv, options: options ?? {} })
      if (probe.error !== undefined) throw probe.error
      return 'cpython 3 12 6\n'
    },
  }
})
beforeEach(() => { probe.calls.length = 0; probe.error = undefined })

it.each([undefined, 60_000])('forwards the configured probe deadline %s and retains force-kill limits', async (timeout) => {
  const ctx = await createRuntimeContext()
  await ctx.plugin(PythonPtcRuntime, {
    pythonBin: process.execPath,
    ...timeout === undefined ? {} : { pythonProbeTimeoutMs: timeout },
  })
  expect(ctx.get('ptcRuntime')).toBeDefined()
  expect(probe.calls).toHaveLength(1)
  expect(probe.calls[0]).toMatchObject({
    executable: process.execPath,
    options: { timeout: timeout ?? 5_000, killSignal: 'SIGKILL', maxBuffer: 1_024, env: { TMPDIR: tmpdir() } },
  })
  expect(probe.calls[0]?.options.env).toEqual({ TMPDIR: tmpdir() })
})

it.each([0, -1, NaN, Infinity, 1.5, MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER])('rejects invalid probe deadline %s before invoking an interpreter', async (timeout) => {
  const ctx = await createRuntimeContext()
  await expect(ctx.plugin(PythonPtcRuntime, { pythonBin: process.execPath, pythonProbeTimeoutMs: timeout }))
    .rejects.toThrow(/pythonProbeTimeoutMs/)
  expect(probe.calls).toHaveLength(0)
  expect(ctx.get('ptcRuntime')).toBeUndefined()
})

it('fails activation when the bounded interpreter probe fails', async () => {
  const ctx = await createRuntimeContext()
  probe.error = Object.assign(new Error('synthetic interpreter startup timeout'), { code: 'ETIMEDOUT' })
  await expect(ctx.plugin(PythonPtcRuntime, { pythonBin: process.execPath, pythonProbeTimeoutMs: 37_000 }))
    .rejects.toThrow(/failed the CPython version probe: synthetic interpreter startup timeout/)
  expect(probe.calls[0]?.options.timeout).toBe(37_000)
  expect(ctx.get('ptcRuntime')).toBeUndefined()
})

it('reserves completion headroom in the fixture and preserves explicit timeout cases', () => {
  expect(PythonPtcRuntime.Config({}).pythonProbeTimeoutMs).toBe(5_000)
  expect(pythonFixtureConfig({}, undefined).pythonProbeTimeoutMs).toBe(5_000)
  expect(pythonFixtureConfig({}, 90_000).pythonProbeTimeoutMs).toBe(60_000)
  expect(pythonFixtureConfig({}, 30_000).pythonProbeTimeoutMs).toBe(20_000)
  expect(pythonFixtureConfig({ pythonProbeTimeoutMs: 25 }, 90_000).pythonProbeTimeoutMs).toBe(25)
})
