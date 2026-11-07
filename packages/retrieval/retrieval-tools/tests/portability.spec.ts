/**
 * Operator-run memory export and import commands, exercised through the host command registry, the
 * engine's authorization rules, and the native store.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  IndexingService, MEMORY_EXPORT_VERSION, RecordId, RetrievalService, SpaceKey, contentHash, tokenOf,
  type MemoryRecord, type TrustedIdentity,
} from '@deepseek-ai/dsh-retrieval'
import * as embedPlugin from '@deepseek-ai/dsh-retrieval-embed'
import * as zvecPlugin from '@deepseek-ai/dsh-retrieval-zvec'
import { afterEach, describe, expect, it } from 'vitest'
import * as toolsPlugin from '../src/index.ts'
import { identityOf } from '../src/identity.ts'

const PRINCIPAL = 'portability-operator'
const contexts: Context[] = []
const roots: string[] = []

/** One mounted deployment: its scope, the calling Agent, the portability directory, and its identity. */
interface Mount {
  ctx: Context
  agent: Agent
  dir: string
  identity: TrustedIdentity
  plugin: Awaited<ReturnType<Context['plugin']>>
}

async function mount(options: {
  retrieval?: Record<string, unknown>
  tools?: Record<string, unknown>
  commands?: boolean
} = {}): Promise<Mount> {
  const prefix = await mkdtemp(join(tmpdir(), 'dsh-portability-'))
  roots.push(prefix)
  await mkdir(join(prefix, 'workspace'), { recursive: true })
  const workspace = await realpath(join(prefix, 'workspace'))
  const dir = join(prefix, 'portability')
  await mkdir(dir, { recursive: true })
  const indexDir = join(prefix, 'index')
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(embedPlugin, embedPlugin.Config({ dimension: 128 }))
  await ctx.plugin(zvecPlugin, zvecPlugin.Config({ indexDir, collectionName: 'portability-test', queryThreads: 1, optimizeThreads: 1 }))
  await ctx.plugin(RetrievalService, RetrievalService.Config({
    persistentMemory: true, crossSessionRead: true, portabilityEnabled: true, portabilityDir: dir, ...options.retrieval,
  }))
  await ctx.plugin(IndexingService, IndexingService.Config({
    roots: [], statePath: join(indexDir, 'index-state.json'), chunkSize: 400, chunkOverlap: 40, maxChunksPerDocument: 8,
  }))
  if (options.commands !== false) await ctx.plugin(CommandRuntime)
  const plugin = await ctx.plugin(toolsPlugin, toolsPlugin.Config({ localPrincipal: PRINCIPAL, ...options.tools }))
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('sess-portability'), {}, { cwd: workspace })
  const identity = await identityOf(ctx, agent, {
    ownerKey: tokenOf('user', PRINCIPAL), crossSessionRead: true, persistentMemory: true,
  })
  return { ctx, agent, dir, identity, plugin }
}

type Executed = NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>

/**
 * Run one command line as the operator typed it.
 * @param test - mounted deployment with the command registry.
 * @param line - full command text, including the leading slash.
 * @returns the settled execution.
 */
async function run(test: Mount, line: string): Promise<Executed> {
  const execution = await test.ctx.commands.execute(test.agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`${line} was not registered`)
  return execution
}

/**
 * Read the result the command registry durably recorded for the latest command.
 * @param test - mounted deployment whose agent session carries the lifecycle pair.
 * @returns the recorded kind and text.
 */
function settled(test: Mount): { kind: string; text: string | undefined } {
  const done = test.agent.session.snapshotEvents().findLast(event => event.type === 'command/done')
  if (done === undefined || done.type !== 'command/done') throw new Error('no command/done event was recorded')
  return { kind: done.data.kind, text: done.data.text }
}

const remember = (text: string) => ({
  text, scope: 'workspace' as const, attribution: { actor: 'user' as const, ref: 'fixture' },
})

let sequence = 0

/** One committed record written under a legacy embedding space, as an earlier host would export it. */
function legacyRecord(identity: TrustedIdentity, over: Partial<MemoryRecord> = {}): MemoryRecord {
  const at = Date.now()
  const text = over.text ?? 'Prefers oolong over green tea'
  const record: MemoryRecord = {
    kind: 'memory', pending: false, id: RecordId(`mem-legacy-${String(sequence++)}`), scope: 'workspace',
    ownerKey: identity.ownerKey, workspaceKey: identity.workspaceKey, sessionKey: null, agentKey: null,
    text, tags: ['taste'], attribution: { actor: 'user', ref: 'operator' }, version: 1, supersedes: [],
    supersededBy: null, createdAt: at, updatedAt: at, expiresAt: null,
    contentHash: contentHash(text), spaceKey: SpaceKey('legacy-space'), ...over,
  }
  return { ...record, contentHash: over.contentHash ?? contentHash(record.text) }
}

/** Write export text the operator brought from another installation. */
async function writeExport(test: Mount, name: string, records: readonly MemoryRecord[]): Promise<string> {
  const path = join(test.dir, name)
  await writeFile(path, JSON.stringify({
    version: MEMORY_EXPORT_VERSION, exportedAt: Date.now(), sourceSpace: 'legacy-space', records,
  }), 'utf8')
  return path
}

afterEach(async () => {
  sequence = 0
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('memory portability command registration', () => {
  it('registers the export and import commands and removes them with the consumer fiber', async () => {
    const test = await mount()
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-retrieval-tools/memory-export',
      name: 'memory-export',
      description: 'Export the memories this caller may read to a file below the portability directory',
      input: { hint: '<file-name> [--include-inactive]' },
    })
    expect(test.ctx.commands.find(test.agent, 'memory-import')?.description)
      .toBe('Import one export file, re-embedding it into the current store')

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'memory-export')).toBeUndefined()
    expect(test.ctx.commands.find(test.agent, 'memory-import')).toBeUndefined()
  })

  it('registers no portability command while the engine has portability disabled', async () => {
    const test = await mount({ retrieval: { portabilityEnabled: false } })
    expect(test.ctx.commands.find(test.agent, 'memory-export')).toBeUndefined()
    expect(test.ctx.tools.get('memory_remember')).toBeDefined()
  })

  it('keeps the tool surface mountable on a host without a command registry', async () => {
    const test = await mount({ commands: false })
    expect(test.ctx.get('commands')).toBeUndefined()
    expect(test.ctx.tools.get('memory_remember')).toBeDefined()
  })

  it('registers the commands on a host whose model-facing tool surface is disabled', async () => {
    const test = await mount({ tools: { enableTools: false } })
    expect(test.ctx.tools.get('memory_search')).toBeUndefined()
    expect(test.ctx.commands.find(test.agent, 'memory-export')).toBeDefined()
    expect((await run(test, '/memory-export notes.json')).result)
      .toEqual({ kind: 'success', text: 'Exported 0 memories to notes.json.' })
  })

  it('keeps the mount free of tools and commands when both surfaces are off', async () => {
    const test = await mount({ retrieval: { portabilityEnabled: false }, tools: { enableTools: false } })
    expect(test.ctx.tools.get('memory_search')).toBeUndefined()
    expect(test.ctx.retrieval.config.portabilityEnabled).toBe(false)
  })
})

describe('/memory-export', () => {
  it('writes the authorized population and keeps memory text out of the command result', async () => {
    const test = await mount()
    await test.ctx.retrieval.remember(remember('Prefers filter coffee over espresso'), test.identity)
    await test.ctx.retrieval.remember(remember('Reviews pull requests before lunch'), test.identity)

    const execution = await run(test, '/memory-export notes.json')
    expect(execution.result).toEqual({ kind: 'success', text: 'Exported 2 memories to notes.json.' })

    const file = await readFile(join(test.dir, 'notes.json'), 'utf8')
    expect(file).toContain('Prefers filter coffee over espresso')
    const envelope = JSON.parse(file) as { records: { text: string }[] }
    expect(envelope.records).toHaveLength(2)
  })

  it('adds superseded rows only when the inactive flag is present', async () => {
    const test = await mount()
    const replaced = await test.ctx.retrieval.remember(remember('Prefers filter coffee'), test.identity)
    await test.ctx.retrieval.remember({ ...remember('Prefers flat white'), supersedes: [replaced.id] }, test.identity)

    expect((await run(test, '/memory-export active.json')).result)
      .toEqual({ kind: 'success', text: 'Exported 1 memories to active.json.' })
    expect((await run(test, '/memory-export history.json --include-inactive')).result)
      .toEqual({ kind: 'success', text: 'Exported 2 memories to history.json.' })
  })

  it.each([
    ['/memory-export', 'Usage: /memory-export <file-name> [--include-inactive]'],
    ['/memory-export   ', 'Usage: /memory-export <file-name> [--include-inactive]'],
    ['/memory-export one.json two.json', 'Usage: /memory-export <file-name> [--include-inactive]'],
    ['/memory-export --include-inactive', 'Usage: /memory-export <file-name> [--include-inactive]'],
  ])('rejects the argument line %j before reading records', async (line, expected) => {
    const test = await mount()
    await test.ctx.retrieval.remember(remember('Prefers filter coffee'), test.identity)
    const execution = await run(test, line)
    expect(execution.result).toEqual({ kind: 'error', text: expected })
  })

  it('refuses a file name that leaves the portability directory and records the refusal', async () => {
    const test = await mount()
    await test.ctx.retrieval.remember(remember('Prefers filter coffee'), test.identity)
    await expect(run(test, '/memory-export ../escaped.json')).rejects.toThrow(/portability file must name a path below the configured directory/)
    expect(settled(test)).toEqual({
      kind: 'error',
      text: 'retrieval(path_escape): portability file must name a path below the configured directory',
    })
  })
})

describe('/memory-import', () => {
  it('re-imports one export without duplicating the population', async () => {
    const test = await mount()
    await test.ctx.retrieval.remember(remember('Prefers filter coffee over espresso'), test.identity)
    await run(test, '/memory-export notes.json')

    const execution = await run(test, '/memory-import notes.json')
    expect(execution.result).toEqual({
      kind: 'success',
      text: 'Imported notes.json. 0 accepted; 1 already present; 0 staged by an interrupted import and removed before this attempt.',
    })
    expect(await test.ctx.retrieval.listMemories(test.identity)).toHaveLength(1)
  })

  it('re-embeds records exported from another embedding space', async () => {
    const test = await mount()
    const space = (await test.ctx.retrieval.exportMemories(test.identity)).sourceSpace
    await writeExport(test, 'legacy.json', [legacyRecord(test.identity)])

    const execution = await run(test, '/memory-import legacy.json')
    expect(execution.result).toEqual({
      kind: 'success',
      text: 'Imported legacy.json. 1 accepted; 0 already present; '
        + '0 staged by an interrupted import and removed before this attempt; '
        + `re-embedded from legacy-space to ${space}.`,
    })
    const [imported] = await test.ctx.retrieval.listMemories(test.identity)
    expect(imported?.spaceKey).toBe(space)
    expect(imported?.text).toBe('Prefers oolong over green tea')
  })

  it('reports the reason for a record this caller may not write', async () => {
    const test = await mount()
    const foreign = legacyRecord(test.identity, { workspaceKey: tokenOf('ws', '/some-other-checkout') })
    const path = await writeExport(test, 'foreign.json', [foreign])

    const execution = await run(test, '/memory-import foreign.json')
    expect(execution.result?.kind).toBe('success')
    expect(execution.result?.text).toContain(`${foreign.id}: `)
    expect(execution.result?.text).toMatch(/belongs to another workspace/)
    expect(await test.ctx.retrieval.listMemories(test.identity)).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ records: [foreign] })
  })

  it.each([
    ['/memory-import', 'Usage: /memory-import <file-name>'],
    ['/memory-import one.json two.json', 'Usage: /memory-import <file-name>'],
  ])('rejects the argument line %j before reading the store', async (line, expected) => {
    const test = await mount()
    expect(await run(test, line).then(execution => execution.result)).toEqual({ kind: 'error', text: expected })
  })

  it('refuses an export file that is absent from the portability directory', async () => {
    const test = await mount()
    await expect(run(test, '/memory-import missing.json')).rejects.toThrow(/needs an export path below portabilityDir or export text/)
    expect(settled(test).kind).toBe('error')
  })
})
