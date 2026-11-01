/**
 * Index synchronization: workspace file discovery, change detection by content hash, incremental
 * upsert and removal, session-transcript projection, and the source-state ledger that makes a
 * rebuild or a rename resolvable. The ledger is a rebuildable derivative; the session log and the
 * files themselves stay authoritative.
 * @module @deepseek-ai/dsh-retrieval/indexing
 */

import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import ignore, { type Ignore } from 'ignore'
import { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { RetrievalError, throwIfAborted } from './errors.ts'
import { chunkIdOf, chunkText, contentHash, sourceKeyOf, spaceKeyOf, tokenOf, assertValidVector, normalizeVector } from './records.ts'
import type { ChunkRecord, TrustedIdentity, OwnerKey, WorkspaceKey, SessionKey, RecordId, SpaceKey } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    retrievalIndexing: IndexingService
  }
}

/** Indexing scope and limits. */
export interface Config {
  /** Absolute or home-relative workspace roots to index. Empty disables workspace indexing. */
  roots: string[]
  /** Directory names skipped at any depth. Credentials and runtime data stay out of the index. */
  excludedDirectories: string[]
  /** File names skipped at any depth. */
  excludedFiles: string[]
  /** Lowercase extensions accepted, without the dot. Empty accepts any text file that passes the binary check. */
  extensions: string[]
  /** Files larger than this are skipped rather than chunked. */
  maxFileBytes: number
  /** Ceiling on documents discovered per root in one sync. */
  maxDocuments: number
  /** Characters per chunk. */
  chunkSize: number
  /** Characters repeated from the previous chunk. */
  chunkOverlap: number
  /** Ceiling on chunks kept from one document. */
  maxChunksPerDocument: number
  /** Follow symbolic links when their resolved target stays inside an authorized root. */
  followSymlinks: boolean
  /** Index live session transcripts alongside workspace files. */
  indexSessions: boolean
  /** Path of the source-state ledger. */
  statePath: string
  /** Records written per batch; bounds memory and gives cancellation a checkpoint. */
  batchSize: number
  /** Maximum indexing operations accepted before applying backpressure. */
  maxQueuedSyncs: number
}

/** Loader schema for indexing {@link Config}. */
export const Config: z<Partial<Config>, Config> = z.object({
  roots: z.array(z.string()).default([]),
  excludedDirectories: z.array(z.string()).default(['.git', 'node_modules', '.testingplatform', '.dsh', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.config', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', 'out']),
  excludedFiles: z.array(z.string()).default(['.env', '.netrc', 'id_rsa', 'credentials.json', '.npmrc', '.pypirc', 'auth.json']),
  extensions: z.array(z.string()).default(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'css', 'scss', 'html', 'sql', 'txt', 'vue', 'swift']),
  maxFileBytes: z.natural().min(1024).default(512_000),
  maxDocuments: z.natural().min(1).default(20_000),
  chunkSize: z.natural().min(64).default(1600),
  chunkOverlap: z.natural().default(200),
  maxChunksPerDocument: z.natural().min(1).default(64),
  followSymlinks: z.boolean().default(false),
  indexSessions: z.boolean().default(false),
  statePath: z.string().default('.testingplatform/retrieval/index-state.json'),
  batchSize: z.natural().min(1).default(64),
  maxQueuedSyncs: z.natural().min(1).default(4),
})

/** Ledger entry for one indexed source. */
export interface SourceState {
  /** Composite key of scope, workspace, session, and source locator. */
  sourceKey: string
  ownerKey: OwnerKey
  workspaceKey: WorkspaceKey
  source: string
  scope: ChunkRecord['scope']
  sessionKey: SessionKey | null
  contentHash: string
  mtimeMs: number
  size: number
  /** Chunk record ids written for this source, in chunk order. */
  chunkIds: RecordId[]
}

/** On-disk ledger shape. */
export interface IndexState {
  version: number
  spaceKey: SpaceKey
  sources: Record<string, SourceState>
  /** Incomplete source writes, reconciled before subsequent indexing. */
  pending: Record<string, SourceState>
}

/** Counts reported by one sync pass. */
export interface SyncReport {
  scanned: number
  added: number
  updated: number
  removed: number
  skipped: number
  chunksWritten: number
  /** Bytes read while hashing; bounded by `maxFileBytes` per document. */
  bytesRead: number
  elapsedMs: number
}

const STATE_VERSION = 2

/**
 * Discovers, chunks, and stores workspace and session records, and removes records whose source is
 * gone. Writes go to the authoritative store first, so a failed sync leaves the store readable and
 * the ledger unchanged for the sources it did not finish.
 */
export class IndexingService extends Service {
  static inject = ['vectorStore', 'embeddings']

  /** Loader schema applied to the config passed to `ctx.plugin()`. */
  static Config: z<Partial<Config>, Config> = Config

  private state: IndexState | null = null

  private writing: Promise<void> = Promise.resolve()
  private readonly lifetime = new AbortController()
  private closed = false
  private queued = 0

  /**
   * @param ctx - registrant context providing the store and embedding services.
   * @param config - resolved indexing configuration.
   */
  constructor(
    ctx: Context,
    readonly config: Config,
  ) {
    super(ctx, 'retrievalIndexing')
    ctx.effect(() => () => this.close())
  }

  /**
   * @returns the ledger path, resolved against the process working directory when relative.
   */
  private get statePath(): string {
    return isAbsolute(this.config.statePath) ? this.config.statePath : resolve(this.config.statePath)
  }

  /**
   * Load the ledger, or start an empty one when absent or written under a different embedding space.
   * @param spaceKey - the store's current space.
   * @returns the ledger.
   */
  private async load(spaceKey: SpaceKey): Promise<IndexState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (!isIndexState(parsed)) throw new RetrievalError('init_failed', 'index ledger is corrupt or unsupported; remove the derivative ledger and rebuild the index')
      if (parsed.spaceKey !== spaceKey) throw new RetrievalError('space_mismatch', 'index ledger uses another embedding space; select a new index location')
      this.state = parsed
      return parsed
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { version: STATE_VERSION, spaceKey, sources: {}, pending: {} }
        return this.state
      }
      if (error instanceof RetrievalError) throw error
      if (error instanceof SyntaxError) throw RetrievalError.from('init_failed', 'index ledger contains invalid JSON; rebuild the derivative index', error)
      throw RetrievalError.from('backend_error', `cannot read index ledger ${this.statePath}`, error)
    }
  }

  /**
   * Persist the ledger atomically.
   * @param state - ledger to write.
   * @returns when the file is durable.
   */
  private async save(state: IndexState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temp = `${this.statePath}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temp, this.statePath)
    this.state = state
  }

  /**
   * Serialize index mutations so two syncs never interleave ledger writes or store batches.
   * @param run - the mutation.
   * @returns the mutation's result.
   */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new RetrievalError('disabled', 'indexing service is closed'))
    if (this.queued >= this.config.maxQueuedSyncs) return Promise.reject(new RetrievalError('unavailable', 'indexing queue is full; retry after pending indexing completes', true))
    this.queued++
    const next = this.writing.then(run, run)
    this.writing = next.then(() => { this.queued-- }, () => { this.queued-- })
    return next
  }

  /**
   * Reconcile every configured root with the store.
   * @param identity - host-resolved identity that owns the produced records.
   * @param signal - cancellation checked between files and between write batches.
   * @returns the sync report.
   */
  async syncWorkspace(identity: TrustedIdentity, signal?: AbortSignal): Promise<SyncReport> {
    signal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    return this.exclusive(async () => {
      throwIfAborted(signal, 'indexing')
      const started = performance.now()
      const space = this.embeddingSpace()
      const state = await this.load(spaceKeyOf(space))
      await this.recover(state, identity, signal)
      const report: SyncReport = { scanned: 0, added: 0, updated: 0, removed: 0, skipped: 0, chunksWritten: 0, bytesRead: 0, elapsedMs: 0 }
      const seen = new Set<string>()

      for (const raw of this.config.roots) {
        const root = await this.resolveRoot(raw)
        if (!inside(root, identity.workspaceRoot)) {
          throw new RetrievalError('unauthorized', 'configured index root lies outside the calling workspace')
        }
        let files = 0
        for await (const path of this.walk(root, signal)) {
          throwIfAborted(signal, 'indexing')
          if (files >= this.config.maxDocuments) {
            throw new RetrievalError('invalid_input', `workspace exceeds maxDocuments (${this.config.maxDocuments}); select smaller roots or raise the limit`)
          }
          files++
          report.scanned++
          const info = await stat(path)
          if (info.size > this.config.maxFileBytes) {
            report.skipped++
            continue
          }
          const key = `${identity.ownerKey}\u0000${sourceKeyOf('workspace', identity.workspaceKey, path, null)}`
          seen.add(key)
          const previous = state.sources[key]
          const text = await this.readText(path, root, signal)
          throwIfAborted(signal, 'file indexing')
          report.bytesRead += Buffer.byteLength(text, 'utf8')
          if (isBinary(text)) {
            if (previous !== undefined) {
              await this.dropIds(previous.chunkIds, previous, signal)
              Reflect.deleteProperty(state.sources, key)
            }
            report.skipped++
            continue
          }
          const digest = contentHash(text)
          if (previous !== undefined && previous.contentHash === digest
            && (await this.ctx.vectorStore.fetch(previous.chunkIds)).length === previous.chunkIds.length) {
            state.sources[key] = { ...previous, mtimeMs: info.mtimeMs, size: info.size }
            continue
          }
          const chunks = chunkText(text, {
            size: this.config.chunkSize,
            overlap: this.config.chunkOverlap,
            maxChunks: this.config.maxChunksPerDocument,
          })
          const records: ChunkRecord[] = []
          const values: number[][] = []
          if (chunks.length > 0) {
            const vectors = await this.embedChunks(chunks.map(chunk => chunk.text), signal)
            chunks.forEach((chunk, index) => {
              const hash = contentHash(chunk.text)
              const id = chunkIdOf({ scope: 'workspace', ownerKey: identity.ownerKey, workspaceKey: identity.workspaceKey, source: path, position: chunk.position }, hash)
              records.push({
                kind: 'chunk',
                id,
                scope: 'workspace',
                ownerKey: identity.ownerKey,
                workspaceKey: identity.workspaceKey,
                agentKey: null,
                sessionKey: null,
                source: path,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                text: chunk.text,
                contentHash: hash,
                updatedAt: Date.now(),
                spaceKey: spaceKeyOf(space),
              })
              values.push(vectors[index] ?? [])
            })
          }
          const nextSource: SourceState = { sourceKey: key, ownerKey: identity.ownerKey, workspaceKey: identity.workspaceKey, source: path, scope: 'workspace', sessionKey: null, contentHash: digest, mtimeMs: info.mtimeMs, size: info.size, chunkIds: records.map(record => record.id) }
          await this.prepareSource(state, nextSource, previous)
          if (records.length > 0) {
            for (let cursor = 0; cursor < records.length; cursor += this.config.batchSize) {
              throwIfAborted(signal, 'indexing')
              const slice = records.slice(cursor, cursor + this.config.batchSize)
              const map = new Map<RecordId, readonly number[]>()
              slice.forEach((record, offset) => map.set(record.id, values[cursor + offset] ?? []))
              const outcome = await this.ctx.vectorStore.write(slice, map, signal)
              if (outcome.written !== slice.length || outcome.rejected !== 0 || outcome.spaceConflict !== null) {
                throw new RetrievalError('backend_error', 'source batch was not fully accepted; rerun indexing to reconcile the pending source')
              }
              report.chunksWritten += slice.length
            }
            await this.mirrorToAccelerator(records, values)
          }
          await this.commitSource(state, nextSource, previous, signal)
          if (previous === undefined) report.added++
          else report.updated++
        }
      }

      return this.finishSync('workspace', state, identity, seen, report, started, signal)
    })
  }

  /**
   * Index live session transcripts as `session` scope records. The session log stays authoritative;
   * these records are a derivative and are rebuilt from the log whenever the ledger is cleared.
   * @param identity - host-resolved identity; its workspace keys the produced records.
   * @param signal - cancellation between sessions.
   * @returns the sync report.
   */
  async syncSessions(identity: TrustedIdentity, signal?: AbortSignal): Promise<SyncReport> {
    signal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    return this.exclusive(async () => {
      throwIfAborted(signal, 'indexing')
      const started = performance.now()
      const report: SyncReport = { scanned: 0, added: 0, updated: 0, removed: 0, skipped: 0, chunksWritten: 0, bytesRead: 0, elapsedMs: 0 }
      if (!this.config.indexSessions) return report
      const space = this.embeddingSpace()
      const state = await this.load(spaceKeyOf(space))
      await this.recover(state, identity, signal)
      const seen = new Set<string>()
      for await (const session of this.authorizedSessions(identity, signal)) {
        throwIfAborted(signal, 'indexing')
        const sessionKey = tokenOf('se', session.id.toString())
        const turns = projectTranscript(session, this.config.maxFileBytes)
        if (turns === null) {
          report.skipped++
          continue
        }
        report.scanned += turns.length
        const source = `session:${String(session.id)}`
        const key = `${identity.ownerKey}\u0000${sourceKeyOf('session', identity.workspaceKey, source, sessionKey)}`
        seen.add(key)
        const previous = state.sources[key]
        const text = turns.join('\n\n')
        if (Buffer.byteLength(text, 'utf8') > this.config.maxFileBytes) {
          report.skipped++
          continue
        }
        const digest = contentHash(text)
        if (previous !== undefined && previous.contentHash === digest
          && (await this.ctx.vectorStore.fetch(previous.chunkIds)).length === previous.chunkIds.length) continue
        const chunks = chunkText(text, {
          size: this.config.chunkSize,
          overlap: this.config.chunkOverlap,
          maxChunks: this.config.maxChunksPerDocument,
        })
        const vectors = chunks.length > 0 ? await this.embedChunks(chunks.map(chunk => chunk.text), signal) : []
        const records: ChunkRecord[] = chunks.map((chunk) => {
          const hash = contentHash(chunk.text)
          return {
            kind: 'chunk',
            id: chunkIdOf({ scope: 'session', ownerKey: identity.ownerKey, workspaceKey: identity.workspaceKey, source: `${source}#${chunk.position}`, position: chunk.position }, hash),
            scope: 'session',
            ownerKey: identity.ownerKey,
            workspaceKey: identity.workspaceKey,
            agentKey: null,
            sessionKey,
            source: `${source}#turn-${chunk.startLine}`,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            text: chunk.text,
            contentHash: hash,
            updatedAt: Date.now(),
            spaceKey: spaceKeyOf(space),
          }
        })
        const nextSource: SourceState = { sourceKey: key, ownerKey: identity.ownerKey, workspaceKey: identity.workspaceKey, source, scope: 'session', sessionKey, contentHash: digest, mtimeMs: Date.now(), size: text.length, chunkIds: records.map(record => record.id) }
        await this.prepareSource(state, nextSource, previous)
        if (records.length > 0) {
          const map = new Map<RecordId, readonly number[]>()
          records.forEach((record, index) => map.set(record.id, vectors[index] ?? []))
          const outcome = await this.ctx.vectorStore.write(records, map, signal)
          if (outcome.written !== records.length || outcome.rejected !== 0 || outcome.spaceConflict !== null) {
            throw new RetrievalError('backend_error', 'session batch was not fully accepted; rerun indexing to reconcile the pending source')
          }
          await this.mirrorToAccelerator(records, vectors)
          report.chunksWritten += records.length
        }
        await this.commitSource(state, nextSource, previous, signal)
        if (previous === undefined) report.added++
        else report.updated++
      }
      return this.finishSync('session', state, identity, seen, report, started, signal)
    })
  }

  /** Remove unseen sources owned by this caller and scope, saving reconciliation before optimization. */
  private async finishSync(
    scope: 'workspace' | 'session',
    state: IndexState,
    identity: TrustedIdentity,
    seen: ReadonlySet<string>,
    report: SyncReport,
    started: number,
    signal?: AbortSignal,
  ): Promise<SyncReport> {
    for (const [key, previous] of Object.entries(state.sources)) {
      throwIfAborted(signal, 'index source reconciliation')
      if (previous.scope !== scope || !belongsTo(previous, identity)) continue
      if (seen.has(key)) continue
      await this.dropIds(previous.chunkIds, previous, signal)
      Reflect.deleteProperty(state.sources, key)
      report.removed++
    }
    await this.save(state)
    throwIfAborted(signal, 'index optimization')
    if (report.chunksWritten > 0 || (await this.ctx.vectorStore.stats()).pending > 0) await this.ctx.vectorStore.optimize()
    report.elapsedMs = Math.round(performance.now() - started)
    return report
  }

  /**
   * Read sessions from this host installation and workspace; cross-session reads require the host grant.
   * Session logs have no retrieval principal field, so this assumes one trusted local principal owns
   * the mounted session store. Shared stores require a separate authenticated ownership policy.
   */
  private async *authorizedSessions(identity: TrustedIdentity, signal?: AbortSignal): AsyncGenerator<Session> {
    const emitted = new Set<string>()
    const permitted = async (session: { header: { cwd?: string }; id: { toString(): string } }): Promise<boolean> => {
      const sessionKey = tokenOf('se', session.id.toString())
      if (sessionKey !== identity.sessionKey && !identity.allowCrossSession) return false
      if (session.header.cwd === undefined) return false
      return await realpath(session.header.cwd) === identity.workspaceRoot
    }
    for (const session of this.ctx.get('sessions')?.list() ?? []) {
      throwIfAborted(signal, 'session indexing')
      if (!await permitted(session)) continue
      emitted.add(String(session.id))
      yield session
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return
    let scanned = 0
    for (const snapshot of await persistence.list(signal === undefined ? {} : { signal })) {
      throwIfAborted(signal, 'session indexing')
      if (emitted.has(String(snapshot.header.id)) || !await permitted({ header: snapshot.header, id: snapshot.header.id })) continue
      if (++scanned > this.config.maxDocuments) throw new RetrievalError('invalid_input', 'session count exceeds maxDocuments')
      if ((snapshot.sizeBytes ?? 0) > this.config.maxFileBytes) continue
      const handle = await persistence.open(snapshot.header.id, 'read', signal === undefined ? {} : { signal })
      try {
        const restored = await handle.read(0, this.config.maxDocuments + 1, signal === undefined ? {} : { signal })
        if (restored.events.length > this.config.maxDocuments) throw new RetrievalError('invalid_input', 'session event count exceeds maxDocuments')
        yield Session.fromRestore(handle.id, restored.events, handle.header, handle.inheritedEventCount, restored.eventState, this.ctx.get('sessions')?.messageProjections)
      } finally {
        await handle.close()
      }
    }
  }

  /** Validate every provider vector before any source is changed. */
  private async embedChunks(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const space = this.embeddingSpace()
    const out: number[][] = []
    for (let start = 0; start < texts.length; start += this.config.batchSize) {
      throwIfAborted(signal, 'index embedding')
      const batch = texts.slice(start, start + this.config.batchSize)
      const vectors = await this.ctx.embeddings.embed(batch, signal)
      if (vectors.length !== batch.length) throw new RetrievalError('invalid_vector', 'embedding provider returned the wrong batch length')
      for (const vector of vectors) {
        assertValidVector(vector, { ...space, normalized: false })
        const prepared = space.normalized ? normalizeVector(vector) : [...vector]
        assertValidVector(prepared, space)
        out.push(prepared)
      }
    }
    return out
  }

  /** Refuse incompatible provider and store spaces before embedding or writing. */
  private embeddingSpace() {
    const space = this.ctx.embeddings.space
    const stored = this.ctx.vectorStore.space
    if (stored !== null && spaceKeyOf(stored) !== spaceKeyOf(space)) {
      throw new RetrievalError('space_mismatch', 'embedding provider differs from the stored space; choose a new index location')
    }
    return space
  }

  /** Journal new ids before a source write, preserving the previous generation on failure. */
  private async prepareSource(state: IndexState, source: SourceState, previous?: SourceState): Promise<void> {
    const old = new Set(previous?.chunkIds ?? [])
    state.pending[source.sourceKey] = { ...source, chunkIds: source.chunkIds.filter(id => !old.has(id)) }
    await this.save(state)
  }

  /** Commit the new source and then remove the previous generation's obsolete ids. */
  private async commitSource(state: IndexState, source: SourceState, previous?: SourceState, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'index source commit')
    const current = new Set(source.chunkIds)
    if (previous !== undefined) await this.dropIds(previous.chunkIds.filter(id => !current.has(id)), previous, signal)
    state.sources[source.sourceKey] = source
    Reflect.deleteProperty(state.pending, source.sourceKey)
    await this.save(state)
  }

  /** Discard interrupted new records; the next sync rebuilds each affected source. */
  private async recover(state: IndexState, identity: TrustedIdentity, signal?: AbortSignal): Promise<void> {
    for (const [key, source] of Object.entries(state.pending)) {
      if (!belongsTo(source, identity)) continue
      throwIfAborted(signal, 'index recovery')
      await this.dropIds(source.chunkIds, source, signal)
      Reflect.deleteProperty(state.pending, key)
      const previous = state.sources[key]
      if (previous !== undefined) state.sources[key] = { ...previous, contentHash: '', mtimeMs: -1 }
    }
    await this.save(state)
  }

  /** Read a bounded regular file without following a last-component symlink. */
  private async readText(path: string, root: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal, 'file indexing')
    const resolved = await realpath(path)
    if (!inside(resolved, root)) throw new RetrievalError('path_escape', 'index source escaped the authorized root')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      const verifiedPath = await realpath(path)
      const verified = await stat(verifiedPath)
      if (!inside(verifiedPath, root) || verified.dev !== info.dev || verified.ino !== info.ino
        || sensitiveName(basename(verifiedPath))
        || relative(root, verifiedPath).split(sep).some(part => (
          this.config.excludedDirectories.includes(part) || this.config.excludedFiles.includes(part)
        ))) {
        throw new RetrievalError('path_escape', 'index source changed during authorization')
      }
      if (!info.isFile() || info.size > this.config.maxFileBytes) throw new RetrievalError('invalid_input', 'index source is not a bounded regular file')
      const bytes = Buffer.alloc(this.config.maxFileBytes + 1)
      let count = 0
      while (count < bytes.length) {
        throwIfAborted(signal, 'file indexing')
        const read = await file.read(bytes, count, bytes.length - count, null)
        if (read.bytesRead === 0) break
        count += read.bytesRead
      }
      if (count > this.config.maxFileBytes) throw new RetrievalError('invalid_input', 'index source grew beyond maxFileBytes')
      return bytes.subarray(0, count).toString('utf8')
    } finally {
      await file.close()
    }
  }

  /**
   * Delete records and their accelerator mirrors.
   * @param ids - chunk ids to remove.
   * @returns nothing.
   */
  private async dropIds(ids: readonly RecordId[], source: SourceState, signal?: AbortSignal): Promise<number> {
    if (ids.length === 0) return 0
    for (const record of await this.ctx.vectorStore.fetch(ids)) {
      if (record.kind !== 'chunk' || record.ownerKey !== source.ownerKey || record.workspaceKey !== source.workspaceKey || record.scope !== source.scope || record.sessionKey !== source.sessionKey) {
        throw new RetrievalError('unauthorized', 'index ledger names a record owned by another identity')
      }
    }
    throwIfAborted(signal, 'index source deletion')
    const removed = await this.ctx.vectorStore.remove(ids)
    const accelerator = this.ctx.get('accelerator')
    if (accelerator?.available === true) await accelerator.remove(ids).catch(() => undefined)
    return removed
  }

  /**
   * Mirror freshly written vectors into the accelerator when one is mounted.
   * @param records - written records.
   * @param vectors - their vectors, positionally matching `records`.
   * @returns nothing.
   */
  private async mirrorToAccelerator(records: readonly ChunkRecord[], vectors: readonly (readonly number[])[]): Promise<void> {
    const accelerator = this.ctx.get('accelerator')
    if (accelerator === undefined || !accelerator.available) return
    const ids = records.map(record => record.id)
    await accelerator.add(ids, vectors).catch(() => undefined)
    await accelerator.sync().catch(() => undefined)
  }

  /**
   * Resolve and authorize an index root. A root that escapes itself through a symlink is refused.
   * @param raw - configured root path.
   * @returns the real absolute path.
   */
  private async resolveRoot(raw: string): Promise<string> {
    const absolute = isAbsolute(raw) ? raw : resolve(raw)
    let real: string
    try {
      real = await realpath(absolute)
    } catch (error) {
      throw RetrievalError.from('init_failed', `index root ${absolute} is unavailable`, error)
    }
    const info = await stat(real)
    if (!info.isDirectory()) throw new RetrievalError('invalid_input', `index root ${real} is not a directory`)
    return real
  }

  /**
   * Yield eligible files under `root`, refusing any entry whose real path escapes the root.
   * @param root - authorized directory.
   * @param signal - cancellation.
   * @yields absolute file paths.
   */
  private async *walk(root: string, signal?: AbortSignal): AsyncGenerator<string> {
    const realRoot = await realpath(root)
    if (realRoot !== root) throw new RetrievalError('path_escape', 'index root changed during authorization')
    const stack = [realRoot]
    const visited = new Set<string>()
    const ignoredByDirectory = new Map<string, Ignore>()
    const ignored = async (path: string, directory: boolean): Promise<boolean> => {
      let current = realRoot
      let excluded = false
      const pieces = relative(realRoot, dirname(path)).split(sep).filter(Boolean)
      for (let depth = 0; depth <= pieces.length; depth++) {
        let rules = ignoredByDirectory.get(current)
        if (rules === undefined) {
          rules = ignore()
          for (const name of ['.gitignore', '.ignore']) {
            try {
              rules.add(await this.readText(join(current, name), realRoot, signal))
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
            }
          }
          ignoredByDirectory.set(current, rules)
        }
        const result = rules.test(`${relative(current, path).split(sep).join('/')}${directory ? '/' : ''}`)
        if (result.ignored) excluded = true
        else if (result.unignored) excluded = false
        if (depth < pieces.length) current = join(current, pieces[depth] ?? '')
      }
      return excluded
    }
    const allowlist = new Set(this.config.extensions.map(value => value.toLowerCase()))
    const excludedDirs = new Set(this.config.excludedDirectories)
    const excludedFiles = new Set(this.config.excludedFiles)
    while (stack.length > 0) {
      throwIfAborted(signal, 'file discovery')
      const current = stack.pop() as string
      if (visited.has(current)) continue
      visited.add(current)
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch (error) {
        throw RetrievalError.from('backend_error', 'cannot enumerate an indexed directory; previous records are retained', error)
      }
      for (const entry of entries) {
        const path = join(current, entry.name)
        if (excludedDirs.has(entry.name) || excludedFiles.has(entry.name) || sensitiveName(entry.name)) continue
        if (entry.isSymbolicLink() && !this.config.followSymlinks) continue
        const real = await realpath(path).catch(() => null)
        if (real === null || !inside(real, realRoot)) continue
        if (relative(realRoot, real).split(sep).some(part => (
          excludedDirs.has(part) || excludedFiles.has(part) || sensitiveName(part)
        ))) continue
        const info = await stat(real).catch(() => null)
        if (info === null) continue
        if (await ignored(real, info.isDirectory())) continue
        if (info.isDirectory()) {
          stack.push(real)
          continue
        }
        if (!info.isFile()) continue
        if (allowlist.size > 0) {
          const dot = entry.name.lastIndexOf('.')
          const extension = dot < 0 ? '' : entry.name.slice(dot + 1).toLowerCase()
          if (!allowlist.has(extension)) continue
        }
        yield real
      }
    }
  }

  /**
   * Stop admitting indexing work, cancel accepted operations at their next checkpoint, and await them.
   * Interrupted source journals remain available for the next authorized sync.
   * @returns when this service's indexing operations have settled.
   */
  async close(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    await this.writing
  }

  /**
   * Inspect sources from the most recently loaded ledger.
   * @returns ledger entries for diagnostics, or an empty array before the ledger is loaded.
   */
  sources(): SourceState[] {
    return Object.values(this.state?.sources ?? {})
  }

  /**
   * Forget the ledger and every record this service wrote. Memory records are untouched.
   * @param identity - host-resolved identity whose workspace and session records are dropped.
   * @param signal - cancellation between deletion batches; absent means activation lifetime only.
   * @returns count of removed chunk records; explicit memories are preserved.
   */
  async clear(identity: TrustedIdentity, signal?: AbortSignal): Promise<number> {
    signal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    return this.exclusive(async () => {
      throwIfAborted(signal, 'index clearing')
      const space = this.embeddingSpace()
      let state: IndexState
      try {
        state = await this.load(spaceKeyOf(space))
      } catch (error) {
        if (!(error instanceof RetrievalError) || error.code !== 'init_failed') throw error
        const backup = `${this.statePath}.corrupt-${randomUUID()}`
        await rename(this.statePath, backup)
        this.ctx.logger.warn('Retrieval source ledger is invalid and was retained at %s; authorized chunk records are being rebuilt. Other principals must rebuild their indexes.', backup)
        state = { version: STATE_VERSION, spaceKey: spaceKeyOf(space), sources: {}, pending: {} }
      }
      await this.recover(state, identity, signal)
      const filter = {
        activeAt: null,
        scopes: ['workspace', 'session'] as const,
        kinds: ['chunk'] as const,
        ownerKey: identity.ownerKey,
        workspaceKey: identity.workspaceKey,
        sessionKey: identity.sessionKey,
        agentKey: identity.agentKey,
        crossSession: identity.allowCrossSession,
        userScope: false,
        pathPrefixes: [],
        onlyIds: null,
      }
      let removed = 0
      for (;;) {
        throwIfAborted(signal, 'index clearing')
        const ids = await this.ctx.vectorStore.listIds({ ...filter, scopes: [...filter.scopes] }, this.config.batchSize)
        if (ids.length === 0) break
        for (const record of await this.ctx.vectorStore.fetch(ids)) {
          if (record.kind !== 'chunk' || record.ownerKey !== identity.ownerKey || record.workspaceKey !== identity.workspaceKey) {
            throw new RetrievalError('unauthorized', 'store returned records outside the authorized rebuild selection')
          }
        }
        const count = await this.ctx.vectorStore.remove(ids)
        if (count !== ids.length) throw new RetrievalError('backend_error', 'index clearing did not remove every selected record; retry rebuilding')
        removed += count
        const accelerator = this.ctx.get('accelerator')
        if (accelerator?.available === true) await accelerator.remove(ids).catch(() => undefined)
      }
      state.sources = Object.fromEntries(Object.entries(state.sources).filter(([, entry]) => !belongsTo(entry, identity)))
      await this.save(state)
      return removed
    })
  }
}

/**
 * @param entry - a ledger entry.
 * @param identity - host-resolved identity.
 * @returns whether this caller may delete the entry's records.
 */
function belongsTo(entry: SourceState, identity: TrustedIdentity): boolean {
  if (entry.ownerKey !== identity.ownerKey || entry.workspaceKey !== identity.workspaceKey) return false
  if (entry.scope !== 'session') return true
  return entry.sessionKey === identity.sessionKey || identity.allowCrossSession
}

/**
 * @param path - resolved absolute path.
 * @param root - resolved absolute root.
 * @returns whether `path` is `root` or beneath it.
 */
function inside(path: string, root: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

/**
 * @param text - decoded file content.
 * @returns whether the content looks binary rather than textual.
 */
function isBinary(text: string): boolean {
  const head = text.slice(0, 8192)
  return head.includes('\u0000')
}

/**
 * Flatten one session's derived history into transcript lines. Tool output and non-text blocks are
 * skipped: an index of decisions and prose is the goal, and a full transcript copy would duplicate
 * the log it derives from.
 * @param session - a live session.
 * @param maxBytes - maximum transcript bytes, checked before joining message blocks.
 * @returns transcript lines in log order, or `null` when the transcript exceeds the limit.
 */
function projectTranscript(session: Session, maxBytes: number): string[] | null {
  const out: string[] = []
  let totalBytes = 0
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const texts: string[] = []
    let messageBytes = Buffer.byteLength(`${message.role}: `, 'utf8')
    for (const block of message.content) {
      if (block.type !== 'text') continue
      messageBytes += Buffer.byteLength(block.text, 'utf8') + 1
      if (totalBytes + messageBytes > maxBytes) return null
      texts.push(block.text)
    }
    if (texts.length === 0) continue
    totalBytes += messageBytes + 2
    if (totalBytes > maxBytes) return null
    out.push(`${message.role}: ${texts.join(' ').trim()}`)
  }
  return out
}

/** Reject common private key, credential, and runtime names even with extension allowlists. */
function sensitiveName(name: string): boolean {
  return (
    /^(?:\.env(?:\..*)?|\.?id_(?:rsa|ed25519|ecdsa)(?:\..*)?|\.?credentials?(?:[._-].*)?|\.?secrets?(?:[._-].*)?|\.?auth(?:[._-].*)?)$/i
      .test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name)
  )
}

/** Validate the derivative ledger before it can name records for deletion. */
function isIndexState(value: unknown): value is IndexState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record['version'] !== STATE_VERSION || typeof record['spaceKey'] !== 'string') return false
  for (const field of ['sources', 'pending']) {
    const entries = record[field]
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return false
    for (const [key, raw] of Object.entries(entries)) {
      if (typeof raw !== 'object' || raw === null) return false
      const item = raw as Record<string, unknown>
      if (item['sourceKey'] !== key || typeof item['source'] !== 'string' || typeof item['ownerKey'] !== 'string' || typeof item['workspaceKey'] !== 'string'
        || (item['scope'] !== 'workspace' && item['scope'] !== 'session')
        || !(item['sessionKey'] === null || typeof item['sessionKey'] === 'string')
        || typeof item['contentHash'] !== 'string' || typeof item['mtimeMs'] !== 'number' || typeof item['size'] !== 'number'
        || !Array.isArray(item['chunkIds']) || !item['chunkIds'].every(id => typeof id === 'string' && id.startsWith('chunk:'))) return false
    }
  }
  return true
}

export default IndexingService
