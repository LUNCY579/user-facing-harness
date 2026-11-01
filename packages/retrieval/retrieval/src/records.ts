/**
 * Deterministic record identity: content hashing, chunking with overlap, stable ids, vector
 * validation and normalization, and token estimation. Every function here is pure so an index
 * rebuilt from the same inputs produces the same ids.
 * @module @deepseek-ai/dsh-retrieval/records
 */

import { createHash, randomUUID } from 'node:crypto'
import { RetrievalError } from './errors.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RecordId, SpaceKey } from './ids.ts'
import type { OwnerKey, WorkspaceKey, SessionKey, AgentKey } from './ids.ts'
import type { EmbeddingSpace, RecordScope } from './types.ts'

/** Chunk sizing chosen by deployment. */
export interface ChunkPolicy {
  /** Maximum characters in one chunk. */
  size: number
  /** Characters repeated from the previous chunk; must be smaller than `size`. */
  overlap: number
  /** Maximum chunks produced from one document. */
  maxChunks: number
}

/**
 * Hash text to a lowercase hex digest used for change detection and deduplication.
 * @param text - exact stored content.
 * @returns SHA-256 hex digest.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Identity of one embedding space. Two spaces may never share an index.
 *
 * The key is a digest rather than a readable join because it is interpolated into a store filter
 * expression, which has no string-escape mechanism, and model or provider names may contain
 * separators.
 * @param space - provider, model, dimension, and normalization facts.
 * @returns the composite key stored on every record.
 */
export function spaceKeyOf(space: EmbeddingSpace): SpaceKey {
  const revision = space.revision === undefined ? '' : `\u0000${space.revision}`
  return SpaceKey(`sp:${tokenDigest(`${space.provider}\u0000${space.model}\u0000${space.dimension}\u0000${space.normalized ? 'l2' : 'raw'}${revision}`)}`)
}

/**
 * A short lowercase hex digest of an identity value.
 * @param value - the value to fold.
 * @returns 24 hex characters.
 */
function tokenDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)
}

type TokenKeys = { user: OwnerKey; ws: WorkspaceKey; se: SessionKey; ag: AgentKey }

/**
 * Turn a host-owned identifier into a filter-safe record key. Workspace paths and session ids carry
 * characters a store filter expression cannot quote, so the store keys on this digest instead.
 * @param prefix - identifier class, kept so principal, workspace, session, and agent keys cannot collide.
 * @param value - the host-supplied identifier.
 * @returns `<prefix>:<digest>`.
 */
export function tokenOf<K extends keyof TokenKeys>(prefix: K, value: string): TokenKeys[K] {
  return brandString<TokenKeys[K]>(`${prefix}:${tokenDigest(value)}`)
}

/**
 * Stable id for one chunk. The id is a function of the record's owning scope, workspace, source
 * locator, and position, so re-indexing unchanged content replaces the same row and a moved or
 * renamed file yields a different id that the indexer removes under the old value.
 * @param input - scope, principal, workspace, source locator, and zero-based chunk position.
 * @param hash - content digest of the chunk text.
 * @returns the `chunk:`-prefixed id.
 */
export function chunkIdOf(
  input: { scope: RecordScope; ownerKey: OwnerKey; workspaceKey: WorkspaceKey; source: string; position: number },
  hash: string,
): RecordId {
  const digest = createHash('sha256')
    .update(`${input.scope}\u0000${input.ownerKey}:${input.workspaceKey}\u0000${input.source}\u0000${input.position}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
  return RecordId(`chunk:${digest}:${hash.slice(0, 8)}`)
}

/**
 * Create an independent identifier for an explicit memory.
 * @returns a fresh unique id for one memory record.
 */
export function newMemoryId(): RecordId {
  return RecordId(`mem:${randomUUID()}`)
}

/**
 * Split text into overlapping chunks that keep line-range correspondence to the source.
 * Newlines normalize to `\n` before splitting, so the same file content always chunks the same way.
 * @param text - file or transcript content.
 * @param policy - chunk size, overlap, and per-document cap.
 * @returns chunks in document order with 1-based inclusive line ranges.
 */
export function chunkText(
  text: string,
  policy: ChunkPolicy,
): { text: string; startLine: number; endLine: number; position: number }[] {
  if (policy.size <= 0) throw new RetrievalError('invalid_input', 'chunk size must be positive')
  if (policy.overlap >= policy.size) {
    throw new RetrievalError('invalid_input', 'chunk overlap must be smaller than chunk size')
  }
  const normalized = text.replace(/\r\n?/g, '\n')
  if (normalized.length === 0) return []
  const starts: number[] = []
  let offset = 0
  for (const line of normalized.split('\n')) {
    starts.push(offset)
    offset += line.length + 1
  }
  const chunks: { text: string; startLine: number; endLine: number; position: number }[] = []
  const step = policy.size - policy.overlap
  for (let cursor = 0; cursor < normalized.length; cursor += step) {
    const slice = normalized.slice(cursor, cursor + policy.size)
    if (slice.trim().length === 0) {
      if (chunks.length >= policy.maxChunks) break
      continue
    }
    const startLine = lineAt(starts, cursor)
    const endLine = lineAt(starts, Math.min(cursor + slice.length, normalized.length - 1))
    chunks.push({ text: slice, startLine, endLine, position: chunks.length })
    if (chunks.length >= policy.maxChunks) {
      if (normalized.slice(cursor + policy.size).trim().length > 0) {
        throw new RetrievalError('invalid_input', 'document exceeds maxChunksPerDocument; raise the chunk limit or select smaller documents')
      }
      break
    }
    if (cursor + policy.size >= normalized.length) break
  }
  return chunks
}

/**
 * 1-based line number containing `offset` in the normalized text.
 * @param starts - ascending character offset of each line's first character.
 * @param offset - character offset.
 * @returns the line number, or the last line when `offset` runs past the final newline.
 */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  let found = 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((starts[mid] ?? Number.POSITIVE_INFINITY) <= offset) {
      found = mid + 1
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/**
 * Validate a produced vector against its space: exact dimension, all values finite, and no
 * all-zero direction. Rejecting here is what keeps a broken provider from poisoning an index.
 * @param vector - candidate values.
 * @param space - expected dimension and normalization.
 * @returns the same array, checked.
 */
export function assertValidVector(
  vector: readonly number[],
  space: EmbeddingSpace,
): readonly number[] {
  if (vector.length !== space.dimension) {
    throw new RetrievalError(
      'invalid_vector',
      `embedding dimension ${vector.length} does not match space dimension ${space.dimension}`,
      false,
      { dimension: space.dimension, actual: vector.length },
    )
  }
  let norm = 0
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RetrievalError('invalid_vector', 'embedding contains a non-finite value')
    }
    norm += value * value
  }
  if (norm === 0) throw new RetrievalError('invalid_vector', 'embedding is a zero vector')
  if (space.normalized && Math.abs(Math.sqrt(norm) - 1) > 1e-3) {
    throw new RetrievalError('invalid_vector', 'embedding is not unit-normalized as its space requires')
  }
  return vector
}

/**
 * L2-normalize a vector so cosine distance is meaningful.
 * @param vector - raw values.
 * @returns a new unit-length array, or the input unchanged when it is a zero vector.
 */
export function normalizeVector(vector: readonly number[]): number[] {
  let scale = 0
  for (const value of vector) scale = Math.max(scale, Math.abs(value))
  if (scale === 0) return [...vector]
  let squared = 0
  for (const value of vector) squared += (value / scale) ** 2
  const norm = Math.sqrt(squared)
  return vector.map(value => (value / scale) / norm)
}

/**
 * Word-like tokens for deduplication and lexical scoring: lowercase alphanumeric runs, with
 * `camelCase`, `snake_case`, and `kebab-case` identifier parts split so code symbols match.
 * @param text - any content.
 * @returns the token list, duplicates kept.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[^\p{L}\p{N}_]+/gu)) {
    if (raw.length === 0) continue
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])|_/g)) {
      const trimmed = part.toLowerCase().trim()
      if (trimmed.length > 0) out.push(trimmed)
    }
  }
  return out
}

/**
 * Cheap token estimate for budget arithmetic. It is deliberately not a tokenizer: budgets bound how
 * much text is injected. ASCII uses four characters per token; non-ASCII reserves one token per
 * UTF-8 byte. This remains an estimate rather than a provider tokenizer.
 * @param text - content that would be injected.
 * @returns estimated token count, rounded up.
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 127) ascii++
    else nonAscii += Buffer.byteLength(character, 'utf8')
  }
  return Math.ceil(ascii / 4) + nonAscii
}

/**
 * Key that makes one stored source unique inside a workspace scope.
 * @param scope - record scope.
 * @param workspaceKey - owning workspace.
 * @param source - path or transcript locator.
 * @param sessionKey - owning session, when scope-bound.
 * @returns the composite source key used for change detection.
 */
export function sourceKeyOf(
  scope: RecordScope,
  workspaceKey: WorkspaceKey,
  source: string,
  sessionKey: SessionKey | null,
): string {
  return `${scope}\u0000${workspaceKey}\u0000${sessionKey ?? '-'}\u0000${source}`
}
