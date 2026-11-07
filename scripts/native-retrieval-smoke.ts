/**
 * Artifact-plane smoke for native retrieval. It imports the built package entry points, mounts the
 * Zvec-backed store, and requires a real write, search, reopen, and scoped deletion on this platform.
 * An installation that succeeded while retrieval stayed disabled never reaches this script, so a green
 * run means the native binding answered, not merely that the dependency tree resolved.
 *
 * Fixtures are synthetic and no model key is read. Run after `pnpm run build:artifacts`.
 * @module
 */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { OwnerKey, RetrievalService, SessionKey, WorkspaceKey, type RetrievalQuery, type TrustedIdentity } from '@deepseek-ai/dsh-retrieval'
import * as embedPlugin from '@deepseek-ai/dsh-retrieval-embed'
import * as zvecPlugin from '@deepseek-ai/dsh-retrieval-zvec'

const OWNER: TrustedIdentity = {
  ownerKey: OwnerKey('smoke-owner'), workspaceRoot: '', workspaceKey: WorkspaceKey('smoke-workspace'),
  sessionKey: SessionKey('smoke-session'), agentKey: null, allowCrossSession: true, allowUserScope: true,
}

/** One search request; the smoke varies only the mode and text. */
const query = (over: Partial<RetrievalQuery>): RetrievalQuery => ({
  mode: 'semantic', text: 'How do refunds settle?', topK: 5, scopes: ['workspace'], pathPrefixes: [], minScore: 0, budgetTokens: 0, ...over,
})

/**
 * Report a platform that cannot run native retrieval, naming the platform so a reader can tell a
 * missing binding from a store that opened and then failed.
 * @param message - what this platform failed to do.
 * @param cause - the underlying error, when one was thrown.
 * @returns never; it always throws.
 */
function fail(message: string, cause?: unknown): never {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  throw new Error(`native retrieval smoke on ${process.platform}-${process.arch}: ${message}${detail}`)
}

/**
 * Mount the embedding provider, the Zvec store, and the retrieval engine over one index directory.
 * @param indexDir - directory holding the Zvec collection.
 * @returns a live context whose disposal releases the store and its writer lease.
 */
async function mount(indexDir: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(embedPlugin, embedPlugin.Config({ dimension: 128 }))
  await ctx.plugin(zvecPlugin, zvecPlugin.Config({ indexDir, collectionName: 'retrieval-smoke' }))
  await ctx.plugin(RetrievalService, RetrievalService.Config({ persistentMemory: true }))
  return ctx
}

const root = await mkdtemp(join(tmpdir(), 'dsh-native-retrieval-smoke-'))
const started = Date.now()
try {
  const indexDir = join(root, 'index')
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'note.md'), 'Refunds settle through the ledger.\n', 'utf8')
  const identity: TrustedIdentity = { ...OWNER, workspaceRoot: await realpath(workspace) }

  let first: Context
  try {
    first = await mount(indexDir)
  } catch (error) {
    fail('the Zvec native SDK did not mount, so this platform has no working native retrieval', error)
  }
  await first.retrieval.remember(
    { text: 'Refunds settle through the ledger.', scope: 'workspace', attribution: { actor: 'user', ref: 'smoke' } }, identity,
  )
  await first.retrieval.remember(
    { text: 'Charts are drawn on a canvas.', scope: 'workspace', attribution: { actor: 'user', ref: 'smoke' } }, identity,
  )
  const opened = await first.vectorStore.stats()
  if (opened.backend !== 'zvec') fail(`the mounted store reported backend ${opened.backend} instead of zvec`)
  if (opened.documents < 2) fail(`only ${String(opened.documents)} records reached the native collection after two writes`)
  const served = await first.retrieval.search(query({}), identity)
  if (served.servedBy !== 'zvec' || served.candidates.length === 0) fail('a semantic query returned no native evidence')
  await first.fiber.dispose()

  const second = await mount(indexDir)
  const reopened = await second.retrieval.search(query({ mode: 'keyword', text: 'ledger' }), identity)
  if (reopened.candidates.length === 0) fail('the collection did not answer a keyword query after a reopen')
  const forgotten = await second.retrieval.forget({ scopes: ['workspace'] }, identity)
  if (forgotten.length === 0) fail('a scoped forget removed nothing from the reopened collection')
  if ((await second.retrieval.listMemories(identity, { includeExpired: true, includeSuperseded: true })).length > 0) {
    fail('records survived a scoped forget')
  }
  await second.fiber.dispose()

  process.stdout.write(`${JSON.stringify({
    platform: `${process.platform}-${process.arch}`, backend: opened.backend, documents: opened.documents,
    reopenedHits: reopened.candidates.length, forgotten: forgotten.length, space: opened.space, ms: Date.now() - started,
  })}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
