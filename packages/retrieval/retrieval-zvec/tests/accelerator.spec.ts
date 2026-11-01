/** Real turbovec integration plus unavailable, malformed, crashed, and timed-out worker coverage. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RecordId } from '@deepseek-ai/dsh-retrieval'
import * as embedPlugin from '@deepseek-ai/dsh-retrieval-embed'
import { afterEach, describe, expect, it } from 'vitest'
import { TurboVecAccelerator, type TurboVecOptions } from '../src/turbovec.ts'
import * as zvecPlugin from '../src/index.ts'

const python = process.env.DSH_TEST_TURBOVEC_PYTHON
const contexts: Context[] = []
const accelerators: TurboVecAccelerator[] = []
const roots: string[] = []
const options: TurboVecOptions = {
  pythonExecutable: python ?? 'python3', bitWidth: 4, timeoutMs: 10000,
  maxQueue: 8, maxMessageBytes: 1024 * 1024, maxVectors: 1000, threads: 1,
}

async function setup(overrides: Partial<TurboVecOptions> = {}): Promise<TurboVecAccelerator> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(embedPlugin, embedPlugin.Config({ dimension: 64 }))
  const accelerator = new TurboVecAccelerator(ctx, { ...options, ...overrides })
  accelerators.push(accelerator)
  return accelerator
}

function vectors(): [number[], number[], number[]] {
  const vectorAt = (column: number): number[] => Array.from({ length: 64 }, (_, row) => row === column ? 1 : 0)
  return [vectorAt(0), vectorAt(1), vectorAt(2)]
}

async function fixtureWorker(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tv-worker-'))
  roots.push(root)
  const executable = join(root, 'worker.mjs')
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 })
  await chmod(executable, 0o700)
  return executable
}

afterEach(async () => {
  await Promise.all(accelerators.splice(0).map(accelerator => accelerator.close()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(python === undefined)('real turbovec', { timeout: 30000 }, () => {
  it('adds, updates, filters before scoring, and removes stable ids', async () => {
    const accelerator = await setup()
    const [a, b, c] = vectors()
    expect(await accelerator.add(['a', 'b', 'c'].map(id => RecordId(id)), [a, b, c])).toBe(3)
    expect((await accelerator.stats()).backend).toBe('turbovec')
    const hits = await accelerator.search(a, 2, ['b', 'c'].map(id => RecordId(id)))
    expect(hits).toHaveLength(2)
    expect(hits.every(hit => hit.id === 'b' || hit.id === 'c')).toBe(true)
    expect((await accelerator.search(a, 1, ['a', 'b', 'c'].map(id => RecordId(id))))[0]?.id).toBe('a')
    await accelerator.add(['b'].map(id => RecordId(id)), [a])
    expect((await accelerator.stats()).vectors).toBe(3)
    expect(await accelerator.remove(['a', 'absent'].map(id => RecordId(id)))).toBe(1)
    expect((await accelerator.search(a, 1, ['b', 'c'].map(id => RecordId(id))))[0]?.id).toBe('b')
    await accelerator.sync()
    expect((await accelerator.stats()).vectors).toBe(2)
  })

  it('rebuilds a lost derivative and refuses incomplete authorized candidates', async () => {
    const accelerator = await setup()
    const [a, b, c] = vectors()
    await accelerator.add(['old'].map(id => RecordId(id)), [c])
    expect(await accelerator.rebuild(['a', 'b'].map(id => RecordId(id)), [a, b])).toBe(2)
    expect((await accelerator.stats()).vectors).toBe(2)
    await expect(accelerator.search(a, 1, ['a', 'missing'].map(id => RecordId(id)))).rejects.toThrow(/missing authoritative candidates/)
    expect(accelerator.available).toBe(false)
    expect(await accelerator.rebuild(['a', 'b', 'missing'].map(id => RecordId(id)), [a, b, c])).toBe(3)
    expect(accelerator.available).toBe(true)
    expect((await accelerator.search(a, 3, ['a', 'b', 'missing'].map(id => RecordId(id))))).toHaveLength(3)
  })

  it('supports experimental two-bit quantization separately', async () => {
    const accelerator = await setup({ bitWidth: 2 })
    const [a, b] = vectors()
    await accelerator.add(['a', 'b'].map(id => RecordId(id)), [a, b])
    expect((await accelerator.search(a, 1, ['a', 'b'].map(id => RecordId(id))))[0]?.id).toBe('a')
    expect((await accelerator.stats()).bitWidth).toBe(2)
  })

  it('checks cancellation and input dimensions before mutation', async () => {
    const accelerator = await setup()
    await expect(accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]], AbortSignal.abort())).rejects.toThrow(/cancel|abort/i)
    expect((await accelerator.stats()).vectors).toBe(0)
    await expect(accelerator.add(['a'].map(id => RecordId(id)), [[NaN]])).rejects.toThrow()
    await expect(accelerator.add(['a', 'a'].map(id => RecordId(id)), [vectors()[0], vectors()[1]])).rejects.toThrow(/unique/)
  })
})

describe('turbovec isolation and supervision', { timeout: 30000 }, () => {
  it('contains missing native dependencies and can be closed repeatedly', async () => {
    const accelerator = await setup({ pythonExecutable: '/nonexistent/dsh-python' })
    await expect(accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]])).rejects.toThrow(/worker/)
    expect(accelerator.available).toBe(false)
    expect((await accelerator.stats()).degradedReason).toBeTruthy()
    await accelerator.close()
    await accelerator.close()
    await expect(accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]])).rejects.toThrow(/closed/)
  })

  it.skipIf(process.platform === 'win32')('rejects a worker response carrying an unrelated request id', async () => {
    const executable = await fixtureWorker('process.stdin.on(\'data\', () => process.stdout.write(\'{"requestId":99999,"ok":true,"data":{}}\\n\'))')
    const accelerator = await setup({ pythonExecutable: executable })
    await expect(accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]])).rejects.toThrow(/response id/)
    expect(accelerator.available).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('kills an oversized response before retaining unlimited output', async () => {
    const executable = await fixtureWorker('process.stdin.on(\'data\', () => process.stdout.write(\'x\'.repeat(10000)))')
    const accelerator = await setup({ pythonExecutable: executable, maxMessageBytes: 1024 })
    await expect(accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]])).rejects.toThrow(/byte limit/)
  })

  it.skipIf(process.platform === 'win32')('times out a hung worker and bounds the queue', async () => {
    const executable = await fixtureWorker('process.stdin.resume()')
    const accelerator = await setup({ pythonExecutable: executable, timeoutMs: 50, maxQueue: 1 })
    const first = accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]])
    await expect(accelerator.add(['b'].map(id => RecordId(id)), [vectors()[1]])).rejects.toThrow(/queue is full/)
    await expect(first).rejects.toThrow(/timed out/)
    expect(accelerator.available).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects an active operation when the worker crashes', async () => {
    const executable = await fixtureWorker('process.stdin.on(\'data\', () => process.exit(17))')
    const accelerator = await setup({ pythonExecutable: executable })
    await expect(accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]])).rejects.toThrow(/exited/)
    expect(accelerator.available).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('cancels an active worker operation and discards its derivative', async () => {
    const executable = await fixtureWorker('process.stdin.resume()')
    const accelerator = await setup({ pythonExecutable: executable })
    await expect(accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]], AbortSignal.timeout(20))).rejects.toMatchObject({ code: 'cancelled' })
    expect(accelerator.available).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('waits for the owned worker to exit before close resolves', async () => {
    const executable = await fixtureWorker(`
import { writeFileSync } from 'node:fs'
writeFileSync(new URL('./pid', import.meta.url), String(process.pid))
let buffered = ''
process.stdin.on('data', chunk => {
  buffered += chunk.toString()
  const newline = buffered.indexOf('\\n')
  if (newline < 0) return
  const request = JSON.parse(buffered.slice(0, newline))
  buffered = buffered.slice(newline + 1)
  process.stdout.write(JSON.stringify({requestId: request.requestId, ok: true, data: {vectors: 1, count: 1}}) + '\\n')
})
`)
    const accelerator = await setup({ pythonExecutable: executable })
    await accelerator.add(['a'].map(id => RecordId(id)), [vectors()[0]])
    const pid = Number(await readFile(join(dirname(executable), 'pid'), 'utf8'))
    expect(() => process.kill(pid, 0)).not.toThrow()
    await accelerator.close()
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('requires a supported bit width when an accelerator is enabled', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(embedPlugin, embedPlugin.Config({ dimension: 64 }))
    await expect(ctx.plugin(zvecPlugin, zvecPlugin.Config({
      acceleratorEnabled: true, acceleratorBitWidth: 8,
    }))).rejects.toThrow(/bit width/)
  })
})
