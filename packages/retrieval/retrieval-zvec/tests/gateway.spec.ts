/**
 * Gateway decisions that gate an index directory: the manifest that pins an embedding space to a
 * collection, the prefix canonicalization an authorization restriction depends on, and the payload
 * handed to the SDK when this process configures it. Each case drives the gateway directly so the
 * refusal is observed without a native collection behind it.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmbeddingSpace } from '@deepseek-ai/dsh-retrieval'
import type { ZVecInitOptions, ZVecLogLevel, ZVecLogType } from '@zvec/zvec'
import { describe, expect, it } from 'vitest'
import { PATHS, ensureInitialized, resolveManifest, resolvePrefixes } from '../src/gateway.ts'

const SPACE: EmbeddingSpace = { provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 64, normalized: true }
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 } as const satisfies typeof ZVecLogLevel
const LOG_TYPES = { CONSOLE: 'console', FILE: 'file' } as const satisfies typeof ZVecLogType

/** Create one throwaway index root; the gateway writes its manifest and log directory inside it. */
function root(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-retrieval-gateway-'))
}

/** Run {@link ensureInitialized} against a recording SDK and return the payload it received. */
function initialize(options: Parameters<typeof ensureInitialized>[0]): ZVecInitOptions {
  let payload: ZVecInitOptions | undefined
  const initializeSpy = (input: ZVecInitOptions): void => {
    payload = input
  }
  ensureInitialized(options, {
    ZVecInitialize: initializeSpy,
    ZVecLogLevel: LOG_LEVELS,
    ZVecLogType: LOG_TYPES,
  })
  if (payload === undefined) throw new Error('the gateway did not configure the SDK')
  return payload
}

describe('resolveManifest', () => {
  it('writes the space it opens for and keeps the file readable only by this user', () => {
    const dir = root()
    const manifest = resolveManifest(dir, SPACE)
    expect(manifest).toEqual({ version: 3, provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 64, normalized: true })
    expect(JSON.parse(readFileSync(join(dir, PATHS.manifest), 'utf8'))).toEqual(manifest)
    expect(statSync(join(dir, PATHS.manifest)).mode & 0o777).toBe(0o600)
  })

  it('refuses to create a COSINE index for vectors that are not unit-normalized', () => {
    const dir = root()
    expect(() => resolveManifest(dir, { ...SPACE, normalized: false })).toThrowError(/requires unit-normalized vectors/u)
    expect(() => readFileSync(join(dir, PATHS.manifest), 'utf8')).toThrow()
  })

  it('refuses a manifest this build cannot read instead of reinterpreting it', () => {
    const dir = root()
    mkdirSync(join(dir, 'collection'), { recursive: true })
    writeFileSync(join(dir, PATHS.manifest), `${JSON.stringify({ version: 2, ...SPACE })}\n`, 'utf8')
    expect(() => resolveManifest(dir, SPACE)).toThrowError(/version 2 is not readable by this build/u)
  })

  it('refuses an index that holds another provider, model, dimension, or normalization', () => {
    const dir = root()
    resolveManifest(dir, SPACE)
    for (const other of [
      { ...SPACE, provider: 'openai-compatible' },
      { ...SPACE, model: 'other-model' },
      { ...SPACE, dimension: 128 },
      { ...SPACE, normalized: false },
    ]) {
      expect(() => resolveManifest(dir, other)).toThrowError(/index holds local-hashed\/dsh-hashed-v1\/64, asked for/u)
    }
  })

  it('refuses the same model id when its weight revision differs', () => {
    const dir = root()
    expect(resolveManifest(dir, { ...SPACE, revision: 'rev-2' }).revision).toBe('rev-2')
    expect(() => resolveManifest(dir, { ...SPACE, revision: 'rev-3' })).toThrowError(/space_mismatch/u)
    expect(() => resolveManifest(dir, SPACE)).toThrowError(/space_mismatch/u)
  })

  it('keeps a space without a revision distinct from one that carries it', () => {
    const dir = root()
    resolveManifest(dir, SPACE)
    expect(() => resolveManifest(dir, { ...SPACE, revision: 'rev-2' })).toThrowError(/space_mismatch/u)
  })
})

describe('resolvePrefixes', () => {
  it('keeps a prefix that has no entry on disk, because nothing can match it', () => {
    const missing = join(root(), 'absent')
    expect(resolvePrefixes([missing])).toEqual([missing])
    expect(resolvePrefixes([])).toEqual([])
  })

  it('canonicalizes a symlinked prefix and drops the duplicate spelling', () => {
    const base = root()
    const real = join(base, 'real')
    mkdirSync(real, { recursive: true })
    const link = join(base, 'link')
    symlinkSync(real, link)
    const resolved = resolvePrefixes([link, realpathSync(real)])
    expect(resolved).toEqual([realpathSync(real)])
  })
})

describe('ensureInitialized', () => {
  it('creates a private log directory and switches the SDK to file logging', () => {
    const dir = root()
    const logDir = join(dir, 'native-logs')
    const payload = initialize({ queryThreads: 4, optimizeThreads: 2, logDir, logLevel: 3 })
    expect(statSync(logDir).mode & 0o777).toBe(0o700)
    expect(payload).toEqual({ queryThreads: 4, optimizeThreads: 2, logType: 'file', logDir, logLevel: LOG_LEVELS.ERROR })
  })

  it('omits zero thread counts and log directory so the SDK keeps its own defaults', () => {
    const payload = initialize({ queryThreads: 0, optimizeThreads: 0, logDir: '', logLevel: 0 })
    expect(payload).toEqual({ logType: 'console', logLevel: LOG_LEVELS.DEBUG })
    expect(Object.hasOwn(payload, 'queryThreads')).toBe(false)
    expect(Object.hasOwn(payload, 'optimizeThreads')).toBe(false)
    expect(Object.hasOwn(payload, 'logDir')).toBe(false)
  })

  it('falls back to the SDK default level when the configured one is out of range', () => {
    expect(initialize({ queryThreads: 0, optimizeThreads: 0, logDir: '', logLevel: 99 }).logLevel)
      .toBe(LOG_LEVELS.WARN)
  })

  it('maps every configured level onto the SDK value', () => {
    const expected: readonly ZVecLogLevel[] = [LOG_LEVELS.DEBUG, LOG_LEVELS.INFO, LOG_LEVELS.WARN, LOG_LEVELS.ERROR, LOG_LEVELS.FATAL]
    expected.forEach((value, index) => {
      expect(initialize({ queryThreads: 0, optimizeThreads: 0, logDir: '', logLevel: index }).logLevel).toBe(value)
    })
  })
})
