/**
 * Process-level Zvec setup: one global initialization, an exclusive writer lock, and the
 * create-or-open step that refuses a collection built for a different embedding space. Zvec opens a
 * writable collection for a single process, so the lock turns a second Host on the same index into a
 * clear failure instead of a corrupt store.
 * @module @deepseek-ai/dsh-retrieval-zvec/gateway
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { RetrievalError, type EmbeddingSpace } from '@deepseek-ai/dsh-retrieval'
import type { ZVecCollection } from '@zvec/zvec'
import { VECTOR_FIELD, type CollectionLayout } from './schema.ts'

/** Directory layout under one configured index root. */
export const PATHS = {
  collection: 'collection',
  manifest: 'manifest.json',
  lock: 'writer.sqlite',
} as const

/** On-disk record of the space a collection was built for. */
export interface Manifest {
  version: number
  provider: string
  model: string
  dimension: number
  normalized: boolean
  revision?: string
}

/** Manifest format this build writes. */
const MANIFEST_VERSION = 3

/**
 * Configure the upstream SDK when this provider activates. Its thread and log settings apply to
 * the hosting process; one application mounts a single authoritative Zvec provider.
 * @param options - deployment-wide thread and logging choices.
 * @param native - the SDK's initialization surface, loaded by the plugin with optional-dependency error handling.
 * @returns when the SDK is configured.
 */
export function ensureInitialized(options: {
  queryThreads: number
  optimizeThreads: number
  logDir: string
  logLevel: number
}, native: Pick<typeof import('@zvec/zvec'), 'ZVecInitialize' | 'ZVecLogLevel' | 'ZVecLogType'>): void {
  const logDir = options.logDir
  const logToFile = logDir.length > 0
  if (logToFile) mkdirSync(options.logDir, { recursive: true, mode: 0o700 })
  const levels = [
    native.ZVecLogLevel.DEBUG, native.ZVecLogLevel.INFO, native.ZVecLogLevel.WARN,
    native.ZVecLogLevel.ERROR, native.ZVecLogLevel.FATAL,
  ]
  native.ZVecInitialize({
    ...(options.queryThreads > 0 ? { queryThreads: options.queryThreads } : {}),
    ...(options.optimizeThreads > 0 ? { optimizeThreads: options.optimizeThreads } : {}),
    logType: logToFile ? native.ZVecLogType.FILE : native.ZVecLogType.CONSOLE,
    ...(logToFile ? { logDir } : {}),
    logLevel: levels[options.logLevel] ?? native.ZVecLogLevel.WARN,
  })
}

/**
 * Acquire an OS-managed SQLite exclusive transaction for this index directory. The operating system
 * releases the transaction after a crash; no stale PID file may be mistaken for a current writer.
 * @param indexDir - the private index directory.
 * @returns the connection holding the writer transaction.
 */
export function acquireLock(indexDir: string): DatabaseSync {
  mkdirSync(indexDir, { recursive: true, mode: 0o700 })
  const path = join(indexDir, PATHS.lock)
  const lock = new DatabaseSync(path)
  try {
    chmodSync(path, 0o600)
    lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE')
    return lock
  } catch (error) {
    lock.close()
    throw RetrievalError.from('unavailable', `index ${indexDir} is locked or its writer lease is unavailable`, error)
  }
}

/**
 * Release the writer transaction. The lease file remains reusable by the next process.
 * @param _indexDir - index directory, retained for the provider cleanup call.
 * @param lock - connection acquired by {@link acquireLock}.
 * @returns nothing.
 */
export function releaseLock(_indexDir: string, lock: DatabaseSync): void {
  lock.close()
}

/**
 * Read the manifest, or write this build's manifest when the index root is new.
 * @param indexDir - the index root.
 * @param space - the embedding space the caller is opening the store for.
 * @returns the manifest that governs this directory.
 */
export function resolveManifest(indexDir: string, space: EmbeddingSpace): Manifest {
  const path = join(indexDir, PATHS.manifest)
  const wanted: Manifest = {
    version: MANIFEST_VERSION,
    provider: space.provider,
    model: space.model,
    dimension: space.dimension,
    normalized: space.normalized,
    ...(space.revision === undefined ? {} : { revision: space.revision }),
  }
  if (!existsSync(path)) {
    if (!space.normalized) {
      throw new RetrievalError('space_mismatch', 'the Zvec COSINE index requires unit-normalized vectors')
    }
    mkdirSync(indexDir, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(wanted)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
    return wanted
  }
  const current = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  if (current.version !== MANIFEST_VERSION) {
    throw new RetrievalError('space_mismatch', `index manifest version ${current.version} is not readable by this build`)
  }
  if (current.provider !== wanted.provider || current.model !== wanted.model || current.dimension !== wanted.dimension
    || current.normalized !== wanted.normalized || current.revision !== wanted.revision) {
    throw new RetrievalError(
      'space_mismatch',
      `index holds ${current.provider}/${current.model}/${current.dimension}, asked for ${wanted.provider}/${wanted.model}/${wanted.dimension}`,
    )
  }
  return current
}

/**
 * Resolve path prefixes to the canonical form the index stores. Indexing records `realpath` output,
 * so a prefix written through a symlink — `/tmp` on macOS, a linked project directory — has to be
 * resolved before comparison, otherwise a legitimate restriction would match nothing.
 * @param prefixes - caller-supplied directory prefixes.
 * @returns one resolved prefix per input, keeping the literal when nothing resolves.
 */
export function resolvePrefixes(prefixes: readonly string[]): string[] {
  const out: string[] = []
  for (const prefix of prefixes) {
    try {
      out.push(realpathSync(prefix))
    } catch {
      // A prefix with no entry on disk still restricts reads as written, because nothing can match it.
      out.push(prefix)
    }
  }
  return [...new Set(out)]
}

/**
 * Open, or when absent create, the collection under `indexDir`. Existence of the collection
 * directory, not of the manifest, decides which path runs, so a process that died before the create
 * leaves no directory and the next open creates one. A create interrupted after the directory
 * appeared leaves a directory Zvec cannot open: every later open reports `init_failed`, nothing is
 * deleted, and recovery means restoring a backup or removing the index directory and reindexing.
 * @param indexDir - the index root that already holds a manifest.
 * @param space - the embedding space the collection must serve.
 * @param layout - column declarations to create the collection from.
 * @param options - read-only and memory-mapping choices.
 * @param native - loaded SDK used to open or create the collection.
 * @returns the open collection.
 */
export function openCollection(
  indexDir: string,
  space: EmbeddingSpace,
  layout: CollectionLayout,
  options: { readOnly: boolean; enableMMAP: boolean; collectionName: string },
  native: typeof import('@zvec/zvec'),
): ZVecCollection {
  const collectionPath = join(indexDir, PATHS.collection)
  try {
    if (existsSync(collectionPath)) {
      const collection = native.ZVecOpen(collectionPath, { readOnly: options.readOnly, enableMMAP: options.enableMMAP })
      const stored = collection.schema.vector(VECTOR_FIELD).dimension ?? 0
      if (stored !== space.dimension) {
        collection.closeSync()
        throw new RetrievalError('space_mismatch', `collection dimension ${stored} does not match ${space.dimension}`)
      }
      return collection
    }
    if (options.readOnly) throw new RetrievalError('not_found', `no collection at ${collectionPath} to open read-only`)
    const schema = new native.ZVecCollectionSchema({
      name: options.collectionName,
      fields: layout.fields,
      vectors: layout.vectors,
    })
    // Zvec rejects a create whose target path exists, so no directory is made here.
    return native.ZVecCreateAndOpen(collectionPath, schema, { readOnly: false, enableMMAP: options.enableMMAP })
  } catch (error) {
    if (error instanceof RetrievalError) throw error
    const code = native.isZVecError(error) ? error.code : 'unknown'
    throw RetrievalError.from('init_failed', `cannot open the retrieval index at ${collectionPath} (${code})`, error)
  }
}
