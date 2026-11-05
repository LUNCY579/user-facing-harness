/** Synthetic callers over the production AgentLoop and native local store. */

import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { IndexingService, PASSAGE_INTRO, RetrievalError, RetrievalService, estimateTokens, renderPassage, tokenOf } from '@deepseek-ai/dsh-retrieval'
import * as embedPlugin from '@deepseek-ai/dsh-retrieval-embed'
import * as zvecPlugin from '@deepseek-ai/dsh-retrieval-zvec'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { identityOf } from '../src/identity.ts'
import * as toolsPlugin from '../src/index.ts'

/** Synthetic workspaces, each owned by its own caller. */
const WORKSPACES = ['alpha'] as const

type Workspace = (typeof WORKSPACES)[number]

/** Symbol written into one workspace's file, so a query names its owner. */
const SYMBOLS: Record<Workspace, string> = { alpha: 'refundPayment' }

const contexts: Context[] = []
const roots: string[] = []

/** One mounted deployment: its scope, the caller the host attributes, the agent factory, and its workspace directory. */
interface Mount {
  ctx: Context
  agent: Agent
  dir: string
  loop: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
}

/**
 * Mount the agent-loop prerequisites, embed, store, engine, indexing, and the tools for one workspace,
 * and optionally index workspace evidence. Each case owns its native index directory.
 * @param name - workspace selector, which decides the file symbol and session identity.
 * @param options - engine and tool config overrides, plus whether to walk and index the files.
 * @returns the live scope, its production caller, and the canonical workspace directory.
 */
async function mount(name: Workspace, options: {
  retrieval?: Record<string, unknown>
  tools?: Record<string, unknown>
  index?: boolean
  history?: boolean
} = {}): Promise<Mount> {
  const prefix = await mkdtemp(join(tmpdir(), 'dsh-tools-'))
  roots.push(prefix)
  const dir = join(prefix, name)
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'core.ts'), [
    `export function ${SYMBOLS[name]}(input: string): boolean {`,
    '  const ledger = openLedger(input)',
    '  return ledger.write(new Entry(input, -ledger.balance))',
    '}',
    '',
  ].join('\n'), 'utf8')
  const workspace = await realpath(dir)
  const indexDir = join(prefix, 'index')

  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  if (options.tools?.['autoRetrieval'] === true && options.history !== false) {
    await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
  }
  await ctx.plugin(embedPlugin, embedPlugin.Config({ dimension: 128 }))
  await ctx.plugin(zvecPlugin, zvecPlugin.Config({ indexDir, collectionName: 'tools-test', queryThreads: 1, optimizeThreads: 1 }))
  await ctx.plugin(RetrievalService, RetrievalService.Config({ persistentMemory: true, ...options.retrieval }))
  await ctx.plugin(IndexingService, IndexingService.Config({
    roots: options.index === true ? [workspace] : [],
    statePath: join(indexDir, 'index-state.json'),
    chunkSize: 400,
    chunkOverlap: 40,
    maxChunksPerDocument: 8,
  }))
  await ctx.plugin(toolsPlugin, toolsPlugin.Config(options.tools ?? {}))
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId(`sess-${name}`), {}, { cwd: workspace })
  if (options.index === true) {
    await ctx.retrievalIndexing.syncWorkspace(await identity(agent, ctx))
  }
  return { ctx, agent, loop, dir: workspace }
}

/**
 * Take the caller's identity from the host directory owner and the mounted engine's grants.
 * @param agent - production caller.
 * @param ctx - scope owning the retrieval engine.
 * @returns the trusted identity used to index before any tool runs.
 */
function identity(agent: Agent, ctx: Context) {
  return identityOf(ctx, agent, {
    ownerKey: tokenOf('user', userInfo().username),
    crossSessionRead: ctx.retrieval.config.crossSessionRead,
    persistentMemory: ctx.retrieval.config.persistentMemory,
  })
}

let counter = 0

/**
 * Invoke one tool through the execution pipeline.
 * @param ctx - scope owning the registrations.
 * @param agent - calling agent, or none to prove a host identity is required.
 * @param name - tool name.
 * @param args - JSON arguments as the model would send them.
 * @returns the settled result.
 */
async function call(ctx: Context, agent: Agent | undefined, name: string, args: unknown): Promise<ToolExecutionResult> {
  return await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++counter}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/**
 * @param value - settled tool result, message, or a missing element of a message array.
 * @returns its model-facing text.
 */
function text(value: ToolExecutionResult | UserMessage | undefined): string {
  if (value === undefined) return ''
  return value.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('retrieval tool registration', () => {
  it('registers indexing, retrieval, and memory tools with model-facing descriptions', async () => {
    const { ctx } = await mount('alpha', { index: false })
    for (const name of [
      'memory_search', 'memory_remember', 'memory_update', 'memory_forget',
      'context_search', 'workspace_semantic_search', 'vector_similarity_search', 'memory_status',
      'context_index',
    ]) {
      const definition = ctx.tools.get(name)
      expect(definition, name).toBeDefined()
      expect(definition?.description, name).toMatch(/[A-Z].{20,}/)
    }
  })

  it('presents every retrieval tool as a typed call card', async () => {
    const { ctx } = await mount('alpha', { index: false })
    const cards: [string, Record<string, unknown>, string][] = [
      ['context_index', { source: 'workspace' }, 'edit'],
      ['context_search', { query: 'refund ledger' }, 'search'],
      ['workspace_semantic_search', { query: 'refund ledger' }, 'search'],
      ['vector_similarity_search', { query: 'refund ledger' }, 'search'],
      ['memory_search', { query: 'refund ledger' }, 'search'],
      ['memory_remember', { text: 'Prefers concise reports.', scope: 'workspace' }, 'edit'],
      ['memory_update', { id: 'mem-1', text: 'Rewritten.' }, 'edit'],
      ['memory_forget', { ids: ['mem-1', 'mem-2'] }, 'delete'],
      ['memory_status', {}, 'read'],
    ]
    for (const [name, args, kind] of cards) {
      const definition = ctx.tools.get(name)
      expect(definition, name).toBeDefined()
      expect(definition?.presentCall?.(args), name).toMatchObject({ card: 'generic', kind })
    }
    expect(ctx.tools.get('memory_search')?.presentCall?.({})).toMatchObject({ rawInput: '(recent)' })
    expect(ctx.tools.get('memory_forget')?.presentCall?.({})).toMatchObject({ rawInput: 'expired or scoped sweep' })
    expect(ctx.tools.get('memory_status')?.presentCall?.({})).not.toHaveProperty('rawInput')
    expect(ctx.tools.get('context_search')?.isConcurrencySafe?.({ query: 'refund ledger' })).toBe(true)
    expect(ctx.tools.get('memory_status')?.isConcurrencySafe?.({})).toBe(true)
  })

  it('unregisters its tools when the consumer fiber is disposed', async () => {
    const { ctx } = await mount('alpha', { index: false, tools: { enableTools: false } })
    const fiber = ctx.plugin(toolsPlugin)
    await fiber
    expect(ctx.tools.get('context_index')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('context_index')).toBeUndefined()
    expect(ctx.tools.get('memory_remember')).toBeUndefined()
  })

  it('keeps the app mountable with the tool surface disabled', async () => {
    const { ctx } = await mount('alpha', { tools: { enableTools: false }, index: false })
    expect(ctx.tools.get('memory_search')).toBeUndefined()
    expect(ctx.retrieval.config.enabled).toBe(true)
  })

  it('rejects automatic retrieval whose item count exceeds the engine ceiling', async () => {
    await expect(mount('alpha', {
      index: false,
      retrieval: { maxTopK: 8 },
      tools: { autoRetrieval: true, autoTopK: 9 },
    })).rejects.toThrow('autoTopK')
  })

  it('requires asynchronous session history when automatic retrieval is enabled', async () => {
    await expect(mount('alpha', { history: false, tools: { autoRetrieval: true } })).rejects.toThrow('sessionQuery')
  })
})

describe('retrieval tools over the native store', () => {
  it.each([
    { budget_tokens: -1 }, { budget_tokens: 1 }, { budget_tokens: 63 }, { min_score: -0.1 }, { min_score: 1.01 },
  ])('rejects unsupported search limits %j before querying', async (limits) => {
    const { ctx, agent } = await mount('alpha', { index: false })
    const search = vi.spyOn(ctx.retrieval, 'search')
    try {
      const result = await call(ctx, agent, 'context_search', { query: 'synthetic project', ...limits })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('invalid_input')
      expect(search).not.toHaveBeenCalled()
    } finally {
      search.mockRestore()
    }
  })

  it('counts the complete empty notice within a valid 64-token budget', async () => {
    const { ctx, agent } = await mount('alpha', { index: false })
    await call(ctx, agent, 'memory_remember', { text: 'Synthetic budget evidence '.repeat(40), scope: 'workspace' })
    const result = await call(ctx, agent, 'context_search', { query: 'Synthetic budget evidence', budget_tokens: 64 })
    expect(result.isError, text(result)).toBe(false)
    if (result.isError) throw new Error('bounded search failed')
    const rendered = text(result)
    expect(rendered).toBe(`${PASSAGE_INTRO}\nNo passages qualify under the current query and retrieval limits.`)
    expect(estimateTokens(rendered)).toBeGreaterThan(0)
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(64)
    expect(result.value).toMatchObject({ rendered, tokens: estimateTokens(rendered), findings: [], truncated: true })
  })

  it('reports indexing disabled when no source collection is configured', async () => {
    const { ctx, agent } = await mount('alpha', { index: false })
    const workspace = await call(ctx, agent, 'context_index', { source: 'workspace' })
    expect(workspace.isError).toBe(true)
    expect(text(workspace)).toContain('configured roots')
    const sessions = await call(ctx, agent, 'context_index', { source: 'sessions' })
    expect(sessions.isError).toBe(true)
    expect(text(sessions)).toContain('indexSessions')
  })

  it('reports canonical recovery failure instead of treating it as optional worker fallback', async () => {
    const { ctx, agent } = await mount('alpha', { index: false })
    const rebuild = vi.spyOn(ctx.retrieval, 'rebuildAccelerator').mockRejectedValue(new RetrievalError('backend_error', 'Canonical memory recovery failed'))
    try {
      const result = await call(ctx, agent, 'context_index', { source: 'rebuild' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('Canonical memory recovery failed')
      expect(text(result)).not.toContain('Zvec remains usable')
    } finally {
      rebuild.mockRestore()
    }
  })

  it('searches indexed workspace files and cites path plus line range', async () => {
    const { ctx, agent, dir } = await mount('alpha', { index: true })
    const result = await call(ctx, agent, 'workspace_semantic_search', { query: `${SYMBOLS.alpha} ledger balance` })
    expect(result.isError, text(result)).toBe(false)
    expect(text(result), text(result)).toContain(join(dir, 'src', 'core.ts'))
    expect(text(result)).toMatch(/:\d+-\d+/)
  })

  it('refuses a call the host did not attribute to an agent', async () => {
    const { ctx } = await mount('alpha')
    const result = await call(ctx, undefined, 'memory_search', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/calling agent/i)
    expect((await call(ctx, undefined, 'memory_status', {})).isError).toBe(true)
  })

  it('keeps retrieval authority at the original workspace after a working-directory change', async () => {
    const { ctx, agent, dir } = await mount('alpha')
    const original = await identity(agent, ctx)
    const another = join(dir, '..', 'another')
    await mkdir(another)
    await ctx.workingDirectory.set(agent, another)
    expect(await identity(agent, ctx)).toEqual(original)
  })

  it('requires the original session workspace to use its canonical path', async () => {
    const { ctx, dir } = await mount('alpha', { index: false })
    const link = join(dir, '..', 'workspace-link')
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(dir, link, kind)
    await expect(ctx.agentLoop.create(SessionId('symlink-caller'), {}, { cwd: link })).rejects.toThrow('canonical original workspace')
    await unlink(link)
  })

  it('rejects a canonical workspace replaced by a symlink after agent creation', async () => {
    const { ctx, agent, dir } = await mount('alpha', { index: false })
    const original = join(dir, '..', 'original')
    const other = join(dir, '..', 'other')
    await mkdir(other)
    await rename(dir, original)
    try {
      await symlink(other, dir, process.platform === 'win32' ? 'junction' : 'dir')
      try {
        const result = await call(ctx, agent, 'memory_search', {})
        expect(result.isError).toBe(true)
        expect(text(result)).toContain('workspace target changed')
      } finally {
        await unlink(dir)
      }
    } finally {
      await rename(original, dir)
    }
  })

  it.each([undefined, '/a-different-execution-world'])('rejects a filesystem mapping %s before retrieval or memory writes', async (mapping) => {
    const { ctx, agent } = await mount('alpha', { index: false })
    const mapped = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(mapping)
    const searched = vi.spyOn(ctx.retrieval, 'search')
    const remembered = vi.spyOn(ctx.retrieval, 'remember')
    try {
      const read = await call(ctx, agent, 'context_search', { query: 'synthetic local context' })
      const write = await call(ctx, agent, 'memory_remember', { text: 'Must remain unwritten.', scope: 'workspace' })
      expect(read.isError).toBe(true)
      expect(write.isError).toBe(true)
      expect(searched).not.toHaveBeenCalled()
      expect(remembered).not.toHaveBeenCalled()
    } finally {
      mapped.mockRestore()
      searched.mockRestore()
      remembered.mockRestore()
    }
  })

  it('honors a requested memory scope when listing without a query', async () => {
    const { ctx, agent } = await mount('alpha', { index: false })
    await call(ctx, agent, 'memory_remember', { text: 'Workspace color is blue.', scope: 'workspace' })
    await call(ctx, agent, 'memory_remember', { text: 'Session color is green.', scope: 'session' })
    const listed = text(await call(ctx, agent, 'memory_search', { scopes: ['session'] }))
    expect(listed).toContain('Session color is green')
    expect(listed).not.toContain('Workspace color is blue')
  })

  it('refuses another workspace update and deletion in the same store', async () => {
    const { ctx, agent, dir } = await mount('alpha', { index: false })
    const own = await call(ctx, agent, 'memory_remember', { text: 'Private ledger rule.', scope: 'workspace' })
    const id = /Stored memory (\S+) /.exec(text(own))?.[1]
    expect(id).toBeTruthy()
    const foreignDir = join(dir, '..', 'foreign')
    await mkdir(foreignDir)
    const foreign = await ctx.agentLoop.create(SessionId('foreign-caller'), {}, { cwd: await realpath(foreignDir) })
    expect((await call(ctx, foreign, 'memory_update', { id, text: 'Overwritten.' })).isError).toBe(true)
    expect((await call(ctx, foreign, 'memory_forget', { ids: [id], workspace_id: dir })).isError).toBe(true)
    expect(text(await call(ctx, foreign, 'memory_search', { query: 'Private ledger rule', workspace_id: dir }))).not.toContain('Private ledger rule')
    expect(text(await call(ctx, agent, 'memory_search', {}))).toContain('Private ledger rule')
  })

  it('runs remember, search, update, and forget through the tools', async () => {
    const { ctx, agent } = await mount('alpha')
    const stored = await call(ctx, agent, 'memory_remember', {
      text: 'The refund ledger rejects negative balances.',
      scope: 'workspace',
      tags: ['refunds'],
    })
    expect(stored.isError, text(stored)).toBe(false)
    const id = /Stored memory (\S+) /.exec(text(stored))?.[1]
    expect(id).toBeTruthy()

    expect(text(await call(ctx, agent, 'memory_search', {}))).toContain('rejects negative balances')
    const searched = await call(ctx, agent, 'memory_search', { query: 'negative balances' })
    expect(searched.isError, text(searched)).toBe(false)

    const updated = await call(ctx, agent, 'memory_update', { id, text: 'The refund ledger rejects negative balances and zero amounts.' })
    expect(text(updated), text(updated)).toContain('v2')

    const forgotten = await call(ctx, agent, 'memory_forget', { ids: [id] })
    expect(text(forgotten), text(forgotten)).toContain('Deleted 1 memories')

    expect(text(await call(ctx, agent, 'memory_search', {}))).not.toContain('zero amounts')
  })

  it('refuses user scope when persistent personal memory is off', async () => {
    const { ctx, agent } = await mount('alpha', { retrieval: { persistentMemory: false } })
    const result = await call(ctx, agent, 'memory_remember', { text: 'Prefers concise reports.', scope: 'user' })
    expect(result.isError).toBe(true)
    expect(text(result), text(result)).toMatch(/unauthorized|not granted/)
  })

  it('reports health through memory_status', async () => {
    const { ctx, agent } = await mount('alpha', { index: true })
    const result = await call(ctx, agent, 'memory_status', {})
    expect(result.isError, text(result)).toBe(false)
    expect(text(result), text(result)).toMatch(/store: zvec, [1-9]\d* documents/)
    expect(text(result)).toMatch(/embedding: /)
    expect(text(result)).toMatch(/indexed roots: /)
  })
})

describe('automatic retrieval', () => {
  /** How one pre-step drive is shaped. */
  interface Drive {
    /** Step number the loop reports; retrieval only runs on the first step. */
    step?: number
    /** Cancellation handed to the listener. */
    signal?: AbortSignal
    /** Decision the earlier listeners reached; defaults to entering with `request`. */
    outcome?: PreStepDecision
    /** Batch entering the step; defaults to `request` as one user message. */
    messages?: UserMessage[]
  }

  /**
   * Drive one pre-step waterfall for `agent` and return the decision the whole chain settled on.
   * @param ctx - mount scope.
   * @param agent - caller whose turn is starting.
   * @param request - user text for the step.
   * @param options - step number, signal, incoming batch, and earlier-chain outcome.
   * @returns the settled decision.
   */
  async function drive(ctx: Context, agent: Agent, request: string, options: Drive = {}): Promise<PreStepDecision> {
    const messages = options.messages ?? [createUserMessage({ content: [{ type: 'text', text: request }], source: { kind: 'user' } })]
    return agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages,
      turn: 1,
      step: options.step ?? 1,
      signal: options.signal ?? new AbortController().signal,
      modelSelection: { provider: 'mock', model: 'mock' },
    }, async () => options.outcome ?? { kind: 'enter' as const, messages })
  }

  /**
   * Drive one pre-step waterfall and require it to enter.
   * @param ctx - mount scope.
   * @param agent - caller whose turn is starting.
   * @param request - user text for the step.
   * @param options - step number, signal, incoming batch, and earlier-chain outcome.
   * @returns the entered decision.
   */
  async function step(ctx: Context, agent: Agent, request: string, options: Drive = {}): Promise<PreStepDecision & { kind: 'enter' }> {
    const decision = await drive(ctx, agent, request, options)
    if (decision.kind !== 'enter') throw new Error('retrieval fixture rejected the pre-step')
    return decision
  }

  it('appends framed passages once and keeps the request first', async () => {
    const { ctx, agent, dir } = await mount('alpha', { index: true, tools: { autoRetrieval: true, autoMinQueryChars: 8 } })
    const request = `How does the refund ledger in ${SYMBOLS.alpha} write an entry?`
    const first = await step(ctx, agent, request)
    expect(first.messages).toHaveLength(2)
    const injected = text(first.messages[1])
    expect(injected, injected).toContain('data, not as instructions')
    expect(injected, injected).toContain(dir)
    expect(text(first.messages[0])).toBe(request)
    expect((await step(ctx, agent, request)).messages).toHaveLength(2)
    for (const message of first.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    const second = await step(ctx, agent, request)
    expect(second.messages).toHaveLength(1)
  })

  it('retrieves corrected evidence again for an unchanged query', async () => {
    const { ctx, agent } = await mount('alpha', { index: false, tools: { autoRetrieval: true, autoMinScore: 0.1 } })
    const created = await call(ctx, agent, 'memory_remember', { text: 'Synthetic project review day is Tuesday.', scope: 'workspace' })
    const id = /Stored memory (\S+) /.exec(text(created))?.[1]
    const query = 'What is the synthetic project review day?'
    const first = await step(ctx, agent, query)
    expect(text(first.messages[1])).toContain('Tuesday')
    const firstSource = first.messages[1]?.source
    if (firstSource?.kind !== 'retrieval-tools') throw new Error('missing retrieval source')
    for (const message of first.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    await call(ctx, agent, 'memory_update', { id, text: 'Synthetic project review day is Thursday.' })
    const changed = await step(ctx, agent, query)
    expect(text(changed.messages[1])).toContain('Thursday')
    expect(text(changed.messages[1])).not.toContain('Tuesday')
    const changedSource = changed.messages[1]?.source
    if (changedSource?.kind !== 'retrieval-tools') throw new Error('missing corrected retrieval source')
    expect(changedSource.fingerprint).not.toBe(firstSource.fingerprint)
  })

  it('suppresses unchanged evidence for a paraphrase with different ranking and scores', async () => {
    const { ctx, agent } = await mount('alpha', { index: false, tools: { autoRetrieval: true } })
    await call(ctx, agent, 'memory_remember', { text: 'Synthetic project review day is Tuesday.', scope: 'workspace' })
    await call(ctx, agent, 'memory_remember', { text: 'Synthetic project review owner is the ledger team.', scope: 'workspace' })
    const baseline = await ctx.retrieval.search({
      mode: 'keyword', text: 'Synthetic project', topK: 2, scopes: ['workspace'], pathPrefixes: [], minScore: 0, budgetTokens: 1200,
    }, await identity(agent, ctx))
    expect(baseline.candidates).toHaveLength(2)
    const question = 'What are the synthetic project review day and owner?'
    const paraphrase = 'Which day and owner does the synthetic project use for its review?'
    const reordered = baseline.candidates.toReversed().map((candidate, index) => ({ ...candidate, score: 0.7 - index / 10 }))
    const changedRendering = reordered.map(renderPassage).join('')
    expect(changedRendering).not.toBe(baseline.rendered)
    const search = vi.spyOn(ctx.retrieval, 'search').mockImplementation(async query => query.text === question
      ? baseline
      : { ...baseline, candidates: reordered, rendered: changedRendering })
    try {
      const first = await step(ctx, agent, question)
      const source = first.messages[1]?.source
      if (source?.kind !== 'retrieval-tools') throw new Error('missing retrieval fingerprint')
      expect(source.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(text(first.messages[1])).not.toContain(source.fingerprint)
      for (const message of first.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
      expect((await step(ctx, agent, paraphrase)).messages).toHaveLength(1)
      expect(search.mock.calls.map(([query]) => query.text)).toEqual([question, paraphrase])
    } finally {
      search.mockRestore()
    }
  })

  it('leaves a short request untouched', async () => {
    const { ctx, agent } = await mount('alpha', { tools: { autoRetrieval: true } })
    const decision = await step(ctx, agent, 'hi')
    expect(decision.messages).toHaveLength(1)
  })

  it('injects nothing when the subsystem is disabled by config', async () => {
    const { ctx, agent } = await mount('alpha', {
      retrieval: { enabled: false },
      tools: { autoRetrieval: true, autoMinQueryChars: 1 },
    })
    const decision = await step(ctx, agent, `How does the refund ledger in ${SYMBOLS.alpha} write an entry?`)
    expect(decision.messages).toHaveLength(1)
  })

  it('retrieves nothing for a rejected, cancelled, or later step', async () => {
    const { ctx, agent } = await mount('alpha', { index: true, tools: { autoRetrieval: true, autoMinQueryChars: 8 } })
    const request = `How does the refund ledger in ${SYMBOLS.alpha} write an entry?`
    const cancelled = new AbortController()
    cancelled.abort()
    const search = vi.spyOn(ctx.retrieval, 'search')
    try {
      expect((await drive(ctx, agent, request, { outcome: { kind: 'reject' } })).kind).toBe('reject')
      expect((await step(ctx, agent, request, { signal: cancelled.signal })).messages).toHaveLength(1)
      expect((await step(ctx, agent, request, { step: 2 })).messages).toHaveLength(1)
      expect(search).not.toHaveBeenCalled()
    } finally {
      search.mockRestore()
    }
  })

  it('searches only the text blocks of the incoming batch', async () => {
    const { ctx, agent } = await mount('alpha', { index: true, tools: { autoRetrieval: true, autoMinQueryChars: 8 } })
    const request = `How does the refund ledger in ${SYMBOLS.alpha} write an entry?`
    const batch = [createUserMessage({
      content: [{ type: 'reasoning', text: 'pondering the ledger' }, { type: 'text', text: request }],
      source: { kind: 'user' },
    })]
    const search = vi.spyOn(ctx.retrieval, 'search')
    try {
      const decision = await step(ctx, agent, request, { messages: batch })
      expect(search.mock.calls.map(([query]) => query.text)).toEqual([request])
      expect(decision.messages).toHaveLength(2)
    } finally {
      search.mockRestore()
    }
  })

  it('injects nothing when no record clears the relevance floor', async () => {
    const { ctx, agent } = await mount('alpha', { index: false, tools: { autoRetrieval: true, autoMinQueryChars: 8 } })
    const decision = await step(ctx, agent, `How does the refund ledger in ${SYMBOLS.alpha} write an entry?`)
    expect(decision.messages).toHaveLength(1)
  })

  it('keeps the request when the backend fails with a value that is not an Error', async () => {
    const { ctx, agent } = await mount('alpha', { index: true, tools: { autoRetrieval: true, autoMinQueryChars: 8 } })
    const search = vi.spyOn(ctx.retrieval, 'search').mockRejectedValue('the backend said no')
    try {
      const decision = await step(ctx, agent, `How does the refund ledger in ${SYMBOLS.alpha} write an entry?`)
      expect(decision.messages).toHaveLength(1)
    } finally {
      search.mockRestore()
    }
  })
})
