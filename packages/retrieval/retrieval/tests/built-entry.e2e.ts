/** Published indexing entry identity and structured errors, checked by plain Node after artifact build. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))

const probe = String.raw`
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Indexing from '@deepseek-ai/dsh-retrieval/indexing'
import {
  Embeddings, IndexingService, OwnerKey, RetrievalError, VectorStore, WorkspaceKey, classifyFailure,
} from '@deepseek-ai/dsh-retrieval'

const space = { provider: 'fixture', model: 'fixture', dimension: 8, normalized: true }
class Store extends VectorStore { get space() { return space } }
class Embedder extends Embeddings { get space() { return space } }

const root = await realpath(await mkdtemp(join(tmpdir(), 'retrieval-built-entry-')))
try {
  const ctx = new Context()
  try {
    const configuredRoot = join(root, 'configured')
    const callerRoot = join(root, 'caller')
    await mkdir(configuredRoot)
    await mkdir(callerRoot)
    new Store(ctx)
    new Embedder(ctx)
    await ctx.plugin(Indexing, Indexing.Config({ roots: [configuredRoot], statePath: join(root, 'state.json') }))
    let observed
    try {
      await ctx.retrievalIndexing.syncWorkspace({
        ownerKey: OwnerKey('fixture-owner'),
        workspaceRoot: callerRoot,
        workspaceKey: WorkspaceKey('fixture-workspace'),
        sessionKey: null,
        agentKey: null,
        allowCrossSession: false,
        allowUserScope: false,
      })
    } catch (error) {
      const failure = classifyFailure(error)
      observed = {
        sameConstructor: Indexing === IndexingService,
        structured: error instanceof RetrievalError,
        code: failure.code,
        retryable: failure.retryable,
      }
    }
    if (observed === undefined) throw new Error('indexer accepted an unauthorized root')
    console.log(JSON.stringify(observed))
  } finally {
    await ctx.fiber.dispose()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
`

it('shares the public indexing class and preserves its structured authorization error', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: packageRoot,
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 65_536,
  })
  expect(JSON.parse(stdout)).toEqual({ sameConstructor: true, structured: true, code: 'unauthorized', retryable: false })
})

const sourceProbe = String.raw`
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const content = [{ type: 'text', text: 'Synthetic retrieved context remains ordinary recorded text.' }]
const source = {
  kind: 'retrieval-tools',
  fingerprint: 'a'.repeat(64),
  form: 'snapshot',
  sections: [{ name: 'retrieval', text: content[0].text }],
}
const legacy = createUserMessage({ content: [{ type: 'text', text: 'Synthetic original request' }], source: { kind: 'user' } })
const retrieved = createUserMessage({ content, source })
const developer = createDeveloperMessage({ content, source })
const events = JSON.parse(JSON.stringify([
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 2, time: 1, surfaceOp: 'append', data: legacy },
  { type: 'user/message', seq: 3, time: 1, surfaceOp: 'append', data: retrieved },
  { type: 'developer/message', seq: 4, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: developer } },
  { type: 'step/end', seq: 5, time: 1, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 6, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
]))
const id = SessionId('retrieval-source-without-producer')
const restored = Session.fromRestore(id, events, {
  version: SESSION_FORMAT_VERSION,
  id,
  createdAt: 1,
  isSeeded: false,
}, SessionLogOffset(0), 'detached')
const messages = restored.deriveMessages()
console.log(JSON.stringify({
  legacyPreserved: JSON.stringify(messages[0]) === JSON.stringify(legacy),
  userSourcePreserved: JSON.stringify(messages[1]?.source) === JSON.stringify(source),
  developerSourcePreserved: JSON.stringify(messages[2]?.source) === JSON.stringify(source),
  contentsPreserved: JSON.stringify(messages.slice(1).map(message => message.content)) === JSON.stringify([content, content]),
  roles: messages.map(message => message.role),
}))
`

it('restores retrieval source metadata and mixed legacy messages without the retrieval producer', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', sourceProbe], {
    cwd: packageRoot,
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 65_536,
  })
  expect(JSON.parse(stdout)).toEqual({
    legacyPreserved: true,
    userSourcePreserved: true,
    developerSourcePreserved: true,
    contentsPreserved: true,
    roles: ['user', 'user', 'developer'],
  })
})
