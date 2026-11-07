/**
 * Coverage of the deterministic record-identity helpers: chunking with overlap and line ranges,
 * content and chunk digests, embedding-space keys, memory ids, lexical tokenization, token
 * estimation, and vector validation and normalization. Every fixture is synthetic and every expected
 * digest is pinned verbatim so a change in the id scheme fails loudly.
 */

import {
  OwnerKey, WorkspaceKey, SessionKey,
  assertValidVector,
  chunkIdOf,
  chunkText,
  contentHash,
  estimateTokens,
  newMemoryId,
  normalizeVector,
  RetrievalError,
  sourceKeyOf,
  spaceKeyOf,
  tokenize,
  type ChunkPolicy,
  type EmbeddingSpace,
} from '@deepseek-ai/dsh-retrieval'
import { describe, expect, it } from 'vitest'

/** Space of the shipped local provider, used by the space-key expectations. */
const LOCAL_SPACE: EmbeddingSpace = { provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 256, normalized: true }

/** Chunk policy that keeps every chunk of the small fixtures below. */
const POLICY: ChunkPolicy = { size: 4, overlap: 0, maxChunks: 8 }

/**
 * Run an action that must fail, and return its retrieval failure.
 * @param action - the call under test.
 * @returns the thrown {@link RetrievalError}.
 */
function failure(action: () => unknown): RetrievalError {
  try {
    action()
  } catch (error) {
    if (error instanceof RetrievalError) return error
    throw error
  }
  throw new Error('the action completed without a retrieval failure')
}

describe('contentHash', () => {
  it('digests text as UTF-8 SHA-256', () => {
    expect(contentHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(contentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(contentHash('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c')
  })

  it('is stable for identical text and changes with any byte', () => {
    expect(contentHash('Refunds settle through the ledger.')).toBe(contentHash('Refunds settle through the ledger.'))
    expect(contentHash('Refunds settle through the ledger.')).not.toBe(contentHash('Refunds settle through the ledger'))
    expect(contentHash('abc')).toHaveLength(64)
  })
})

describe('chunkText', () => {
  it('splits into overlapping windows in document order', () => {
    expect(chunkText('abcdefghij', { size: 4, overlap: 1, maxChunks: 8 })).toEqual([
      { text: 'abcd', startLine: 1, endLine: 1, position: 0 },
      { text: 'defg', startLine: 1, endLine: 1, position: 1 },
      { text: 'ghij', startLine: 1, endLine: 1, position: 2 },
    ])
  })

  it('reports 1-based inclusive line ranges for each chunk', () => {
    expect(chunkText('aaa\nbbb\nccc', { size: 7, overlap: 0, maxChunks: 4 })).toEqual([
      { text: 'aaa\nbbb', startLine: 1, endLine: 2, position: 0 },
      { text: '\nccc', startLine: 2, endLine: 3, position: 1 },
    ])
  })

  it('takes the whole document in one chunk when it fits', () => {
    expect(chunkText('one\ntwo\nthree', { size: 64, overlap: 8, maxChunks: 4 })).toEqual([
      { text: 'one\ntwo\nthree', startLine: 1, endLine: 3, position: 0 },
    ])
  })

  it('normalizes CRLF and lone CR to LF before splitting', () => {
    const policy: ChunkPolicy = { size: 4, overlap: 0, maxChunks: 8 }
    expect(chunkText('a\r\nb\rc\r\nd', policy)).toEqual(chunkText('a\nb\nc\nd', policy))
    expect(chunkText('a\r\nb\r\nc', { size: 12, overlap: 0, maxChunks: 4 })).toEqual([
      { text: 'a\nb\nc', startLine: 1, endLine: 3, position: 0 },
    ])
  })

  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkText('', POLICY)).toEqual([])
    expect(chunkText('   \n  ', POLICY)).toEqual([])
  })

  it('refuses to mark a truncated document as completely indexed', () => {
    expect(() => chunkText('abcdefghijkl', { size: 2, overlap: 0, maxChunks: 3 })).toThrow('document exceeds maxChunksPerDocument')
    const complete = chunkText('abcdef   ', { size: 2, overlap: 0, maxChunks: 3 })
    expect(complete.map(chunk => chunk.text)).toEqual(['ab', 'cd', 'ef'])
    expect(complete.map(chunk => chunk.position)).toEqual([0, 1, 2])
  })

  it('rejects a non-positive size and an overlap that is not smaller than size', () => {
    const size = failure(() => chunkText('abc', { size: 0, overlap: 0, maxChunks: 4 }))
    expect(size).toBeInstanceOf(RetrievalError)
    expect(size.code).toBe('invalid_input')
    expect(size.message).toContain('chunk size must be positive')
    expect(size.retryable).toBe(false)

    const overlap = failure(() => chunkText('abc', { size: 4, overlap: 4, maxChunks: 4 }))
    expect(overlap.code).toBe('invalid_input')
    expect(overlap.message).toContain('chunk overlap must be smaller than chunk size')
  })
})

describe('chunkIdOf', () => {
  const empty = contentHash('')

  it('derives the id from scope, workspace, source, and position', () => {
    expect(chunkIdOf({ scope: 'workspace', ownerKey: OwnerKey('owner-test'), workspaceKey: WorkspaceKey('ws-alpha'), source: '/srv/app/payment.ts', position: 0 }, empty))
      .toBe('chunk:1d5cf14a1caf643709c73516a5397ea6:e3b0c442')
    expect(chunkIdOf({ scope: 'workspace', ownerKey: OwnerKey('owner-test'), workspaceKey: WorkspaceKey('ws-alpha'), source: '/srv/app/payment.ts', position: 1 }, empty))
      .toBe('chunk:77521e6b3c2392a117ff889a2370ea4c:e3b0c442')
  })

  it('keeps the position digest and swaps only the content suffix', () => {
    expect(chunkIdOf({ scope: 'workspace', ownerKey: OwnerKey('owner-test'), workspaceKey: WorkspaceKey('ws-alpha'), source: '/srv/app/payment.ts', position: 0 }, contentHash('abc')))
      .toBe('chunk:1d5cf14a1caf643709c73516a5397ea6:ba7816bf')
  })

  it('is stable and separates every identity input', () => {
    const base = { scope: 'workspace' as const, ownerKey: OwnerKey('owner-test'), workspaceKey: WorkspaceKey('ws-alpha'), source: '/srv/app/payment.ts', position: 0 }
    expect(chunkIdOf(base, empty)).toBe(chunkIdOf(base, empty))
    expect(chunkIdOf({ ...base, scope: 'session' }, empty)).not.toBe(chunkIdOf(base, empty))
    expect(chunkIdOf({ ...base, workspaceKey: WorkspaceKey('ws-beta') }, empty)).not.toBe(chunkIdOf(base, empty))
    expect(chunkIdOf({ ...base, source: '/srv/app/render.ts' }, empty)).not.toBe(chunkIdOf(base, empty))
    expect(chunkIdOf({ ...base, position: 3 }, empty)).not.toBe(chunkIdOf(base, empty))
  })
})

describe('newMemoryId', () => {
  it('mints unique UUID-valued memory ids', () => {
    const id = newMemoryId()
    expect(id).toMatch(/^mem:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    const ids = new Set<string>()
    for (let i = 0; i < 64; i++) ids.add(newMemoryId())
    expect(ids.size).toBe(64)
  })
})

describe('sourceKeyOf', () => {
  it('joins scope, workspace, session, and source with NUL separators', () => {
    expect(sourceKeyOf('workspace', WorkspaceKey('ws-alpha'), '/srv/app/payment.ts', SessionKey('sess-1')))
      .toBe('workspace\u0000ws-alpha\u0000sess-1\u0000/srv/app/payment.ts')
    expect(sourceKeyOf('workspace', WorkspaceKey('ws-alpha'), '/srv/app/payment.ts', null))
      .toBe('workspace\u0000ws-alpha\u0000-\u0000/srv/app/payment.ts')
  })

  it('separates the same source under a different scope, workspace, or session', () => {
    const same = sourceKeyOf('workspace', WorkspaceKey('ws-alpha'), '/srv/app/payment.ts', null)
    expect(sourceKeyOf('session', WorkspaceKey('ws-alpha'), '/srv/app/payment.ts', null)).not.toBe(same)
    expect(sourceKeyOf('workspace', WorkspaceKey('ws-beta'), '/srv/app/payment.ts', null)).not.toBe(same)
    expect(sourceKeyOf('workspace', WorkspaceKey('ws-alpha'), '/srv/app/render.ts', null)).not.toBe(same)
    expect(sourceKeyOf('workspace', WorkspaceKey('ws-alpha'), '/srv/app/payment.ts', SessionKey('sess-1'))).not.toBe(same)
  })
})

describe('spaceKeyOf', () => {
  it('digests the whole space definition', () => {
    expect(spaceKeyOf(LOCAL_SPACE)).toBe('sp:1a432a5391e0f78270fa3912')
    expect(spaceKeyOf({ provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 64, normalized: true }))
      .toBe('sp:5105fb89324e4616907f839f')
    expect(spaceKeyOf({ provider: 'local-hashed', model: 'other-model', dimension: 64, normalized: true }))
      .toBe('sp:30b99c182b1e0f4321043b26')
    expect(spaceKeyOf({ provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 64, normalized: false }))
      .toBe('sp:b7619c7bbb69583f35e101f1')
  })

  it('is a 24-hex key that changes with any space field', () => {
    expect(spaceKeyOf(LOCAL_SPACE)).toBe(spaceKeyOf({ ...LOCAL_SPACE }))
    expect(spaceKeyOf(LOCAL_SPACE)).toMatch(/^sp:[0-9a-f]{24}$/u)
    expect(spaceKeyOf({ ...LOCAL_SPACE, provider: 'openai-compatible' })).not.toBe(spaceKeyOf(LOCAL_SPACE))
    expect(spaceKeyOf({ ...LOCAL_SPACE, model: 'other-model' })).not.toBe(spaceKeyOf(LOCAL_SPACE))
    expect(spaceKeyOf({ ...LOCAL_SPACE, dimension: 128 })).not.toBe(spaceKeyOf(LOCAL_SPACE))
    expect(spaceKeyOf({ ...LOCAL_SPACE, normalized: false })).not.toBe(spaceKeyOf(LOCAL_SPACE))
  })

  it('separates two weight generations of one model id', () => {
    // `@deepseek-ai/dsh-retrieval-embed` fills this field from its endpoint and the operator's
    // `modelRevision`, so a server that swaps weights under the same model id yields a different key,
    // and a portability import into that key re-embeds instead of reusing vectors the old weights made.
    expect(spaceKeyOf({ ...LOCAL_SPACE, revision: 'rev-2' })).not.toBe(spaceKeyOf(LOCAL_SPACE))
    expect(spaceKeyOf({ ...LOCAL_SPACE, revision: 'rev-2' })).toBe(spaceKeyOf({ ...LOCAL_SPACE, revision: 'rev-2' }))
    expect(spaceKeyOf({ ...LOCAL_SPACE, revision: 'rev-2' })).not.toBe(spaceKeyOf({ ...LOCAL_SPACE, revision: 'rev-3' }))
  })
})

describe('tokenize', () => {
  it('splits identifier casing, underscores, and separators', () => {
    expect(tokenize('drawChart')).toEqual(['draw', 'chart'])
    expect(tokenize('refund_payment_entry')).toEqual(['refund', 'payment', 'entry'])
    expect(tokenize('kebab-case-symbol')).toEqual(['kebab', 'case', 'symbol'])
    expect(tokenize('refund2Fa')).toEqual(['refund2', 'fa'])
    expect(tokenize('  Hello, world! openLedger(orderId)  ')).toEqual(['hello', 'world', 'open', 'ledger', 'order', 'id'])
  })

  it('keeps accented letters and digit runs inside one token', () => {
    expect(tokenize('café')).toEqual(['café'])
    expect(tokenize('abc123def')).toEqual(['abc123def'])
  })

  it('keeps repeated tokens and drops empty runs', () => {
    expect(tokenize('refunds refunds')).toEqual(['refunds', 'refunds'])
    expect(tokenize('__')).toEqual([])
    expect(tokenize('_private')).toEqual(['private'])
    expect(tokenize('!!! ???')).toEqual([])
    expect(tokenize('')).toEqual([])
  })

  it('only splits at a lowercase-or-digit followed by an uppercase letter', () => {
    expect(tokenize('HTTPServer')).toEqual(['httpserver'])
    expect(tokenize('Payment')).toEqual(['payment'])
  })
})

describe('estimateTokens', () => {
  it('estimates one token per four characters, rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('reserves non-ASCII UTF-8 bytes when no provider tokenizer is available', () => {
    expect(estimateTokens('你好')).toBe(6)
    expect(estimateTokens('😀')).toBe(4)
  })
})

describe('assertValidVector', () => {
  const space: EmbeddingSpace = { provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 2, normalized: false }

  it('returns the checked vector unchanged', () => {
    const vector = [3, 4]
    expect(assertValidVector(vector, space)).toBe(vector)
    expect(assertValidVector([0.6, 0.8], { ...space, normalized: true })).toHaveLength(2)
  })

  it('rejects a dimension that is not the space dimension', () => {
    const error = failure(() => assertValidVector([1, 2, 3], space))
    expect(error.code).toBe('invalid_vector')
    expect(error.message).toContain('embedding dimension 3 does not match space dimension 2')
    expect(error.retryable).toBe(false)
    expect(error.detail).toEqual({ dimension: 2, actual: 3 })
  })

  it('rejects a non-finite component', () => {
    expect(failure(() => assertValidVector([Number.NaN, 1], space)).message).toContain('non-finite value')
    expect(failure(() => assertValidVector([1, Number.POSITIVE_INFINITY], space)).code).toBe('invalid_vector')
  })

  it('rejects an all-zero direction', () => {
    expect(failure(() => assertValidVector([0, 0], space)).message).toContain('zero vector')
    expect(failure(() => assertValidVector([], { ...space, dimension: 0 })).message).toContain('zero vector')
  })

  it('requires unit length only from a normalized space, within one thousandth', () => {
    const unit: EmbeddingSpace = { ...space, normalized: true }
    expect(failure(() => assertValidVector([3, 4], unit)).message).toContain('not unit-normalized')
    expect(() => assertValidVector([0.6, 0.8004], unit)).not.toThrow()
    expect(() => assertValidVector([0.6, 0.8], unit)).not.toThrow()
    expect(() => assertValidVector([3, 4], space)).not.toThrow()
  })
})

describe('normalizeVector', () => {
  it('divides by the L2 norm', () => {
    expect(normalizeVector([3, 4])).toEqual([0.6, 0.8])
    expect(normalizeVector([-3, 0])).toEqual([-1, 0])
  })

  it('returns a new array and leaves the input alone', () => {
    const vector = [3, 4]
    const unit = normalizeVector(vector)
    expect(unit).not.toBe(vector)
    expect(vector).toEqual([3, 4])
  })

  it('copies a zero vector instead of dividing by zero', () => {
    const vector = [0, 0, 0]
    const result = normalizeVector(vector)
    expect(result).toEqual([0, 0, 0])
    expect(result).not.toBe(vector)
    expect(normalizeVector([])).toEqual([])
  })

  it('produces a unit length for any direction', () => {
    for (const vector of [[1, 2, 2], [0.25, -7, 3.5, 0], [5, 12]]) {
      const unit = normalizeVector(vector)
      const norm = Math.sqrt(unit.reduce((sum, value) => sum + value * value, 0))
      expect(Math.abs(norm - 1)).toBeLessThan(1e-12)
    }
  })

  it('preserves the direction of an already-unit vector', () => {
    const unit = normalizeVector([0.6, 0.8])
    expect(unit[0]).toBeCloseTo(0.6, 12)
    expect(unit[1]).toBeCloseTo(0.8, 12)
  })
})
