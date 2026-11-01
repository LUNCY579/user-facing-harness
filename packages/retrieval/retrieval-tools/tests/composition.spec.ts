/** Synthetic memory workflows through a real Loader tree, model stream, AgentLoop, and native store. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { boot } from '@deepseek-ai/dsh-app-boot'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { IndexingService, RecordId, RetrievalService, estimateTokens } from '@deepseek-ai/dsh-retrieval'
import * as embed from '@deepseek-ai/dsh-retrieval-embed'
import * as zvec from '@deepseek-ai/dsh-retrieval-zvec'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { afterEach, describe, expect, it } from 'vitest'
import * as retrievalTools from '../src/index.ts'
import { RetrievalFixtureModel } from './model.ts'

const roots: string[] = []
const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface Deployment {
  ctx: Context
  model: RetrievalFixtureModel
  toolCalls: number
}

/** One observed native AgentLoop query; token values are estimates, never provider usage. */
interface AgentRetrievalSample {
  send_to_evidence_ms: number
  retrieval_mode: 'keyword'
  initial_model_input_estimated_tokens: number
  evidence_model_input_estimated_tokens: number
  model_requests: number
  tool_calls: number
  source_linked_evidence: boolean
}

async function deployment(root: string, workspace: string): Promise<Deployment> {
  const config = join(root, 'cordis.yml')
  const definitions: [string, string, object][] = [
    ['llm', 'fixture-llm', {}],
    ['session', 'fixture-sessions', {}],
    ['projections', 'fixture-projections', {}],
    ['system-prompt', 'fixture-prompt', {}],
    ['tools', 'fixture-tools', {}],
    ['tool-executor-native', 'fixture-executor', {}],
    ['fs', 'fixture-fs', {}],
    ['working-directory', 'fixture-cwd', {}],
    ['agents', 'fixture-agents', {}],
    ['embeddings', 'fixture-embed', { dimension: 64 }],
    ['vector-store', 'fixture-zvec', { indexDir: join(root, 'index'), queryThreads: 1, optimizeThreads: 1, acceleratorEnabled: true, turbovecPython: join(root, 'missing-python') }],
    ['retrieval', 'fixture-retrieval', { enabled: true, persistentMemory: true, crossSessionRead: true, useAccelerator: true }],
    ['indexing', 'fixture-indexing', { roots: [workspace], statePath: join(root, 'state.json'), indexSessions: true }],
    ['retrieval-tools', 'fixture-retrieval-tools', { localPrincipal: 'synthetic-operator', autoRetrieval: false }],
    ['model', 'fixture-model', {}],
    ['agent-loop', 'fixture-loop', { agents: [] }],
  ]
  const rows = definitions.map(([id, name, config]) => ({ id, name: `cordis:${name}`, config }))
  await writeFile(config, `${JSON.stringify(rows)}\n`)
  const model = new RetrievalFixtureModel()
  const ctx = await boot('retrieval-composition-test', config, [], (ctx) => {
    contexts.add(ctx)
    Object.assign(ctx.loader.builtins, {
      'fixture-llm': LlmRuntime,
      'fixture-sessions': SessionStore,
      'fixture-projections': SessionProjections,
      'fixture-prompt': SystemPrompt,
      'fixture-tools': Tools,
      'fixture-executor': NativeExecutor,
      'fixture-fs': FsLocal,
      'fixture-cwd': WorkingDirectory,
      'fixture-agents': AgentRegistry,
      'fixture-embed': embed,
      'fixture-zvec': zvec,
      'fixture-retrieval': RetrievalService,
      'fixture-indexing': IndexingService,
      'fixture-retrieval-tools': retrievalTools,
      'fixture-loop': AgentLoop,
      'fixture-model': {
        name: 'retrieval-fixture-model',
        inject: ['llm'],
        apply: (ctx: Context) => ctx.effect(() => ctx.llm.registerAdapter(['retrieval-fixture'], model)),
      },
    })
  })
  return { ctx, model, toolCalls: 0 }
}

function resultText(event: Extract<SessionEvent, { type: 'tool/result' }>): string {
  return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function invoke(
  deploy: Deployment,
  agent: Agent,
  tool: string,
  args: object,
  onEvidence?: (sample: AgentRetrievalSample) => void,
): Promise<string> {
  const before = agent.session.snapshotEvents().length
  const requestStart = deploy.model.requests.length
  deploy.model.call(tool, args)
  const message = createUserMessage({ content: [{ type: 'text', text: `Use ${tool} on the synthetic fixture.` }], source: { kind: 'user' } })
  const started = performance.now()
  agent.followup(message)
  await agent.whenIdle()
  const events = agent.session.snapshotEvents().slice(before)
  const calls = events.filter(event => event.type === 'tool/call').length
  deploy.toolCalls += calls
  const settled = events.find(event => event.type === 'tool/result')
  expect(settled?.type).toBe('tool/result')
  if (settled?.type !== 'tool/result') throw new Error('model tool call did not settle')
  const text = resultText(settled)
  expect(settled.data.message.isError, text).toBe(false)
  expect(deploy.model.requests.at(-1)?.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])).toContain(text)
  if (onEvidence !== undefined) {
    const callId = settled.data.message.toolCallId
    const relativeIndex = deploy.model.requests.slice(requestStart).findIndex(request => request.messages.some(message =>
      message.role === 'tool' && message.toolCallId === callId))
    const evidenceIndex = requestStart + relativeIndex
    const initial = deploy.model.requests[requestStart]
    const evidence = deploy.model.requests[evidenceIndex]
    const received = deploy.model.requestTimes[evidenceIndex]
    if (relativeIndex < 0 || initial === undefined || evidence === undefined || received === undefined) {
      throw new Error('model adapter did not receive the measured tool result')
    }
    onEvidence({
      send_to_evidence_ms: received - started,
      retrieval_mode: 'keyword',
      initial_model_input_estimated_tokens: inputTokenEstimate(initial),
      evidence_model_input_estimated_tokens: inputTokenEstimate(evidence),
      model_requests: deploy.model.requests.length - requestStart,
      tool_calls: calls,
      source_linked_evidence: /\.ts:\d+-\d+/.test(text),
    })
  }
  return text
}

/** Estimate the native request's visible message content and tools, excluding host source metadata. */
function inputTokenEstimate(request: GenerateOptions): number {
  return estimateTokens(JSON.stringify({
    messages: request.messages.map(message => ({
      role: message.role,
      content: message.content,
      ...(message.role === 'tool' ? { toolCallId: message.toolCallId } : {}),
    })),
    tools: request.tools ?? [],
  }))
}

describe('assembled retrieval and memory', () => {
  it('indexes, recalls across sessions, corrects, deletes across restart, falls back, and isolates workspaces', async () => {
    const workflowStarted = performance.now()
    const output = process.env['DSH_RETRIEVAL_BENCH_OUTPUT']
    if (output !== undefined && !isAbsolute(output)) throw new Error('DSH_RETRIEVAL_BENCH_OUTPUT must be an absolute path')
    const samples: AgentRetrievalSample[] = []
    const root = await mkdtemp(join(tmpdir(), 'dsh-retrieval-loader-'))
    roots.push(root)
    const workspace = join(root, 'project')
    const otherWorkspace = join(root, 'other-project')
    await mkdir(workspace)
    await mkdir(otherWorkspace)
    await writeFile(join(workspace, 'ledger.ts'), 'export function refundPayment() { return "refunds must have a receipt" }\n')
    await writeFile(join(workspace, '.env'), 'API_KEY=synthetic-secret-never-index\n')
    const canonical = await realpath(workspace)
    let deploy = await deployment(root, canonical)
    const sessionA = await deploy.ctx.agents.create({ sessionId: SessionId('retrieval-session-a'), meta: { cwd: canonical }, agentOptions: { provider: 'retrieval-fixture', model: 'synthetic' } })
    expect(await invoke(deploy, sessionA.agent, 'context_index', { source: 'workspace' })).toContain('1 added')
    await invoke(deploy, sessionA.agent, 'workspace_semantic_search', { query: 'refundPayment receipt', mode: 'keyword' })
    const evidence = await invoke(deploy, sessionA.agent, 'workspace_semantic_search', { query: 'refundPayment receipt', mode: 'keyword' }, (sample) => { samples.push(sample) })
    expect(evidence).toContain(`${canonical}/ledger.ts:1-1`)
    expect(evidence).toContain('refunds must have a receipt')
    expect(await invoke(deploy, sessionA.agent, 'workspace_semantic_search', { query: 'synthetic-secret-never-index', mode: 'keyword' })).not.toContain('API_KEY=')
    const created = await invoke(deploy, sessionA.agent, 'memory_remember', { text: 'Synthetic project review day is Tuesday.', scope: 'workspace' })
    const id = /Stored memory (\S+) /.exec(created)?.[1]
    expect(id).toBeTruthy()
    await sessionA.dispose()
    const sessionB = await deploy.ctx.agents.create({ sessionId: SessionId('retrieval-session-b'), meta: { cwd: canonical }, agentOptions: { provider: 'retrieval-fixture', model: 'synthetic' } })
    const recalled = await invoke(deploy, sessionB.agent, 'memory_search', { query: 'project review day', mode: 'keyword' })
    expect(recalled).toContain('Tuesday')
    expect(JSON.stringify(deploy.model.requests.at(-1)?.messages)).not.toContain('Use memory_remember')
    const rebuilt = await invoke(deploy, sessionB.agent, 'context_index', { source: 'rebuild' })
    expect(rebuilt).toContain('Optional accelerator unavailable; Zvec remains usable.')
    expect(await invoke(deploy, sessionB.agent, 'memory_search', { query: 'project review day', mode: 'keyword' })).toContain('Tuesday')
    await invoke(deploy, sessionB.agent, 'memory_update', { id, text: 'Synthetic project review day is Thursday.', expires_at: null })
    const corrected = await invoke(deploy, sessionB.agent, 'memory_search', { query: 'project review day', mode: 'keyword' })
    expect(corrected).toContain('Thursday')
    expect(corrected).not.toContain('Tuesday')
    const foreign = await deploy.ctx.agents.create({ sessionId: SessionId('retrieval-foreign'), meta: { cwd: await realpath(otherWorkspace) }, agentOptions: { provider: 'retrieval-fixture', model: 'synthetic' } })
    const denied = await invoke(deploy, foreign.agent, 'memory_search', { query: 'Synthetic project review day Thursday', mode: 'keyword', scopes: ['workspace'] })
    expect(denied).toBe('No memories are visible to this caller.')
    const forgotten = await invoke(deploy, sessionB.agent, 'memory_forget', { ids: [id] })
    expect(forgotten).toContain('Deleted 1 memories')
    expect(await deploy.ctx.vectorStore.fetch([RecordId(id!)])).toEqual([])
    const beforeRestart = { modelRequests: deploy.model.requests.length, toolCalls: deploy.toolCalls }
    await deploy.ctx.fiber.dispose()
    contexts.delete(deploy.ctx)
    deploy = await deployment(root, canonical)
    const restarted = await deploy.ctx.agents.create({ sessionId: SessionId('retrieval-after-restart'), meta: { cwd: canonical }, agentOptions: { provider: 'retrieval-fixture', model: 'synthetic' } })
    expect(await invoke(deploy, restarted.agent, 'memory_search', { query: 'project review day', mode: 'keyword' })).not.toContain('Thursday')
    expect(await deploy.ctx.vectorStore.fetch([RecordId(id!)])).toEqual([])
    const fallback = await invoke(deploy, restarted.agent, 'vector_similarity_search', { query: 'refund receipt' })
    expect(fallback).toContain('refunds must have a receipt')
    expect((await deploy.ctx.retrieval.status()).accelerator?.available).toBe(false)
    expect({ workspace: evidence.replaceAll(canonical, '<workspace>'), recalled: recalled.replaceAll(id!, '<memory-id>'), corrected: corrected.replaceAll(id!, '<memory-id>'), denied }).toMatchSnapshot()
    const sample = samples[0]
    if (sample === undefined) throw new Error('warm workspace measurement is missing')
    expect(sample.source_linked_evidence).toBe(true)
    expect(sample.model_requests).toBe(2)
    expect(sample.tool_calls).toBe(1)
    if (output !== undefined) {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify({
        schema_version: 1,
        model: 'local-scripted-fixture',
        samples: [sample],
        total_workflow_ms: performance.now() - workflowStarted,
        total_model_requests: beforeRestart.modelRequests + deploy.model.requests.length,
        total_tool_calls: beforeRestart.toolCalls + deploy.toolCalls,
        token_estimation: 'Existing estimateTokens heuristic: ceil(ASCII characters/4) plus non-ASCII UTF-8 bytes over serialized native message roles/content/tool-call IDs and tool schemas; excludes host source metadata; not provider usage or a model tokenizer',
        latency_scope: 'Warm user followup send to first scripted adapter request containing that tool call result; excludes index creation and final answer generation',
        scripted_workflow_assertions: {
          workspace_retrieval: true, cross_session_recall: true, memory_correction: true, deletion_from_store: true,
          deletion_after_restart: true, optional_backend_fallback: true, same_store_workspace_isolation: true,
          rebuild_preserves_explicit_memory: true, secret_file_exclusion: true,
        },
        real_model_task_accuracy_measured: false,
      }, null, 2)}\n`, { mode: 0o600 })
    }
  }, 30_000)
})
