/**
 * The create-or-open decision that gates one index directory, driven against the real Zvec binding.
 * Every case is about a live collection handle: a directory whose collection was built for a different
 * embedding space, a read-only open with nothing to open, and a path the SDK cannot read as a
 * collection. Refusing an open has to release the handle it just took, or the next writer in the
 * process inherits a locked collection, so a refused open is followed by a successful one.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRetrievalError, type EmbeddingSpace } from '@deepseek-ai/dsh-retrieval'
import type { ZVecFtsIndexParams, ZVecHnswIndexParams } from '@zvec/zvec'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PATHS, ensureInitialized, openCollection } from '../src/gateway.ts'
import { VECTOR_FIELD, collectionLayout } from '../src/schema.ts'

const SPACE: EmbeddingSpace = { provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 64, normalized: true }
const WRITABLE = { readOnly: false, enableMMAP: false, collectionName: 'gateway-open' } as const

/** The SDK module, loaded here rather than at module scope so the optional native stays optional. */
let native: typeof import('@zvec/zvec')

const roots: string[] = []

/** One throwaway index root, removed with its collection after the run. */
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-retrieval-open-'))
  roots.push(dir)
  return dir
}

/** The column declarations the store itself creates, for the given dense width. */
function layout(dimension: number) {
  const fts: ZVecFtsIndexParams = { indexType: native.ZVecIndexType.FTS, tokenizerName: 'standard', filters: ['lowercase'] }
  const hnsw: ZVecHnswIndexParams = {
    indexType: native.ZVecIndexType.HNSW, metricType: native.ZVecMetricType.COSINE, m: 16, efConstruction: 200,
  }
  return collectionLayout(dimension, fts, hnsw, native)
}

beforeAll(async () => {
  native = await import('@zvec/zvec')
  // The plugin's own default level, so the SDK's per-column logging stays out of the test output.
  ensureInitialized({ queryThreads: 0, optimizeThreads: 0, logDir: '', logLevel: 3 }, native)
})

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('openCollection', () => {
  it('creates the collection once and reopens it at the same dimension', () => {
    const dir = root()
    const created = openCollection(dir, SPACE, layout(64), WRITABLE, native)
    expect(created.schema.vector(VECTOR_FIELD).dimension).toBe(64)
    created.closeSync()
    expect(existsSync(join(dir, PATHS.collection))).toBe(true)
    const reopened = openCollection(dir, SPACE, layout(64), WRITABLE, native)
    expect(reopened.schema.vector(VECTOR_FIELD).dimension).toBe(64)
    reopened.closeSync()
  })

  it('refuses a collection whose dense column is narrower than the space asked for', () => {
    const dir = root()
    openCollection(dir, SPACE, layout(64), WRITABLE, native).closeSync()
    const wider: EmbeddingSpace = { ...SPACE, dimension: 128 }
    try {
      openCollection(dir, wider, layout(128), WRITABLE, native)
      expect.unreachable('a 64-column collection must not open for a 128-wide space')
    } catch (error) {
      expect(isRetrievalError(error) && error.code).toBe('space_mismatch')
      expect(isRetrievalError(error) && error.message).toMatch(/collection dimension 64 does not match 128/u)
    }
    openCollection(dir, SPACE, layout(64), WRITABLE, native).closeSync()
  })

  it('refuses a read-only open when no collection was ever created', () => {
    const dir = root()
    try {
      openCollection(dir, SPACE, layout(64), { ...WRITABLE, readOnly: true }, native)
      expect.unreachable('a read-only open must not create a collection')
    } catch (error) {
      expect(isRetrievalError(error) && error.code).toBe('not_found')
      expect(isRetrievalError(error) && error.message).toMatch(/to open read-only/u)
    }
    expect(existsSync(join(dir, PATHS.collection))).toBe(false)
  })

  it('reports a collection path the SDK cannot read as an index failure that names the path', () => {
    const dir = root()
    writeFileSync(join(dir, PATHS.collection), 'not a zvec collection\n', 'utf8')
    try {
      openCollection(dir, SPACE, layout(64), WRITABLE, native)
      expect.unreachable('a plain file cannot open as a collection')
    } catch (error) {
      expect(isRetrievalError(error) && error.code).toBe('init_failed')
      expect(isRetrievalError(error) && error.message).toContain(join(dir, PATHS.collection))
    }
  })

  it('refuses a collection whose dense column is named for another build', () => {
    const dir = root()
    const schema = new native.ZVecCollectionSchema({
      name: 'gateway-other',
      vectors: [{ name: 'embedding', dataType: native.ZVecDataType.VECTOR_FP32, dimension: 64 }],
    })
    native.ZVecCreateAndOpen(join(dir, PATHS.collection), schema, { readOnly: false, enableMMAP: false }).closeSync()
    try {
      openCollection(dir, SPACE, layout(64), WRITABLE, native)
      expect.unreachable('a collection without a dense column cannot serve the store')
    } catch (error) {
      expect(isRetrievalError(error) && error.code).toBe('init_failed')
    }
  })

  it('refuses to create a collection in an index directory this process cannot write', () => {
    const dir = root()
    chmodSync(dir, 0o500)
    try {
      expect(() => openCollection(dir, SPACE, layout(64), WRITABLE, native)).toThrow(/cannot open the retrieval index at/u)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})

describe('collectionLayout', () => {
  it.each([0, -1, 1.5, Number.NaN])('refuses to declare a dense column of width %s', (dimension) => {
    const fts: ZVecFtsIndexParams = { indexType: native.ZVecIndexType.FTS, tokenizerName: 'standard', filters: ['lowercase'] }
    const hnsw: ZVecHnswIndexParams = {
      indexType: native.ZVecIndexType.HNSW, metricType: native.ZVecMetricType.COSINE, m: 16, efConstruction: 200,
    }
    expect(() => collectionLayout(dimension, fts, hnsw, native)).toThrow(/vector dimension must be positive/u)
  })
})
