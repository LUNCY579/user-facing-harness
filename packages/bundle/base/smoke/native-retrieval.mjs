/**
 * Native retrieval over built package entry points. It mounts the embedding provider, the Zvec-backed
 * store, and the retrieval engine the way `packages/bundle/base/cordis.patch.yml` declares them, then
 * requires the collection to accept writes, answer a semantic and a keyword query, survive a reopen,
 * stay private to its workspace, and honor a scoped forget. Every assertion reads a fact the native
 * binding produced, so an install that resolved its dependency tree while retrieval stayed disabled
 * fails here rather than passing.
 *
 * Node resolves these imports through this bundle's `node_modules` to each package's published `lib`
 * entry, which is why the script runs under plain `node` after `pnpm run build:artifacts` and lives in
 * the package that carries the retrieval rows. Fixtures are synthetic and no model key is read.
 * @module
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { OwnerKey, RetrievalService, SessionKey, WorkspaceKey } from '@deepseek-ai/dsh-retrieval'
import * as embedPlugin from '@deepseek-ai/dsh-retrieval-embed'
import * as zvecPlugin from '@deepseek-ai/dsh-retrieval-zvec'

/** Caller with full authority over one workspace, granted cross-session reads. */
const OWNER = {
  ownerKey: OwnerKey('smoke-owner'), workspaceRoot: '', workspaceKey: WorkspaceKey('smoke-workspace'),
  sessionKey: SessionKey('smoke-session'), agentKey: null, allowCrossSession: true, allowUserScope: true,
}

/** Caller in another workspace; must never see `smoke-workspace` records. */
const OUTSIDER = { ...OWNER, workspaceKey: WorkspaceKey('smoke-other-workspace') }

/** One retrieval request; each case varies only the mode and text. */
function query(over) {
  return { mode: 'semantic', text: 'How do refunds settle?', topK: 5, scopes: ['workspace'], pathPrefixes: [], minScore: 0, budgetTokens: 0, ...over }
}

/**
 * Refuse a platform whose native retrieval cannot serve the shipped store.
 * @param message - what this platform failed to do.
 * @param cause - the underlying error, when one was thrown.
 * @returns never; it always throws.
 */
function fail(message, cause) {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  throw new Error(`native retrieval on ${process.platform}-${process.arch}: ${message}${detail}`)
}

/**
 * Mount the provider pair and the engine over one index directory.
 * @param indexDir - directory holding the Zvec collection.
 * @returns a live context whose disposal closes the store and releases its writer lease.
 */
async function mount(indexDir) {
  const ctx = new Context()
  await ctx.plugin(embedPlugin, embedPlugin.Config({ dimension: 128 }))
  await ctx.plugin(zvecPlugin, zvecPlugin.Config({ indexDir, collectionName: 'retrieval-smoke' }))
  await ctx.plugin(RetrievalService, RetrievalService.Config({ persistentMemory: true }))
  return ctx
}

/**
 * Write one workspace-scoped memory.
 * @param ctx - mounted context.
 * @param text - memory text.
 * @param identity - caller that owns the record.
 * @returns when the record reached the store.
 */
async function remember(ctx, text, identity) {
  await ctx.retrieval.remember({ text, scope: 'workspace', attribution: { actor: 'user', ref: 'native-smoke' } }, identity)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-native-retrieval-smoke-'))
const started = Date.now()
try {
  const indexDir = join(root, 'index')
  const identity = { ...OWNER, workspaceRoot: await realpath(root) }

  let first
  try {
    first = await mount(indexDir)
  } catch (error) {
    fail('the Zvec native SDK did not mount, so no collection could be opened on this platform', error)
  }
  await remember(first, 'Refunds settle through the ledger.', identity)
  await remember(first, 'Charts are drawn on a canvas element.', identity)
  const stats = await first.vectorStore.stats()
  if (stats.backend !== 'zvec') fail(`the mounted store reported backend ${stats.backend} instead of zvec`)
  if (stats.space === null) fail('the store reported no embedding space after two writes')
  if (stats.documents < 2) fail(`only ${String(stats.documents)} records reached the native collection after two writes`)
  const semantic = await first.retrieval.search(query({}), identity)
  if (semantic.servedBy !== 'zvec') fail(`the engine served the query from ${semantic.servedBy} instead of zvec`)
  if (semantic.candidates.length === 0) fail('a semantic query returned no native evidence')
  const foreign = await first.retrieval.search(query({}), OUTSIDER)
  if (foreign.candidates.length > 0) fail(`another workspace read ${String(foreign.candidates.length)} records it does not own`)
  await first.fiber.dispose()

  const second = await mount(indexDir)
  const reopened = await second.retrieval.search(query({ mode: 'keyword', text: 'ledger' }), identity)
  if (reopened.candidates.length === 0) fail('the reopened collection answered no keyword query')
  const forgotten = await second.retrieval.forget({ scopes: ['workspace'] }, identity)
  if (forgotten.length === 0) fail('a scoped forget removed nothing from the reopened collection')
  if ((await second.retrieval.listMemories(identity, { includeExpired: true, includeSuperseded: true })).length > 0) {
    fail('records survived a scoped forget')
  }
  await second.fiber.dispose()

  process.stdout.write(`${JSON.stringify({
    platform: `${process.platform}-${process.arch}`, node: process.version, backend: stats.backend,
    documents: stats.documents, space: stats.space, semanticHits: semantic.candidates.length,
    reopenedHits: reopened.candidates.length, forgotten: forgotten.length, ms: Date.now() - started,
  })}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
