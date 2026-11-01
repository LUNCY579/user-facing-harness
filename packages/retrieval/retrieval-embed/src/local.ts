/**
 * Deterministic local embedder: a signed feature-hashing projection of the token set a chunk or
 * memory contains. It needs no model file, no download, and no network, which keeps the whole
 * retrieval subsystem usable on an 8 GB laptop with nothing configured. Quality is term-overlap
 * grade, not neural grade, so {@link RemoteEmbeddings} exists for deployments that want a stronger
 * space and accept the explicit permission gate.
 * @module @deepseek-ai/dsh-retrieval-embed/local
 */

import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { Embeddings, RetrievalError, normalizeVector, throwIfAborted, tokenize, type EmbeddingSpace } from '@deepseek-ai/dsh-retrieval'
import type { Context } from '@deepseek-ai/cordis'

/** Choices that define one hashed embedding space. */
export interface LocalOptions {
  /** Provider tag recorded in every space key. */
  provider: string
  /** Model tag recorded in every space key; changing it rebuilds the index. */
  model: string
  /** Vector width. Fixed when the collection is created. */
  dimension: number
  /** Texts per pass, so a large indexing run checks cancellation between slices. */
  maxBatch: number
}

/** Bytes of one digest consumed per probe: four for the bucket, one for the sign. */
const PROBE_BYTES = 5

/** Probes per token. Two spreads collisions thin enough that a shared term dominates the score. */
const PROBES = 2

/**
 * Local hashed embedder. Every vector is L2-normalized, so the store's cosine distance is directly
 * a term-overlap measure, and the same text always yields the same vector.
 */
export class HashedEmbeddings extends Embeddings {
  /**
   * @param ctx - registrant context.
   * @param options - resolved space definition.
   */
  constructor(
    ctx: Context,
    private readonly options: LocalOptions,
  ) {
    super(ctx)
    if (!Number.isInteger(options.dimension) || options.dimension < 8) {
      throw new RetrievalError('invalid_input', `embedding dimension must be an integer of at least 8, got ${options.dimension}`)
    }
    if (options.maxBatch < 1) {
      throw new RetrievalError('invalid_input', `embedding maxBatch must be at least 1, got ${options.maxBatch}`)
    }
  }

  /** @inheritdoc */
  override get space(): EmbeddingSpace {
    return {
      provider: this.options.provider,
      model: this.options.model,
      dimension: this.options.dimension,
      normalized: true,
    }
  }

  /**
   * @inheritdoc
   *
   * Hashing is synchronous and bounded by {@link LocalOptions.maxBatch} texts per pass; the abort
   * check between passes is what keeps a large re-index cancellable.
   */
  override async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = []
    for (let start = 0; start < texts.length; start += this.options.maxBatch) {
      if (start > 0) await setImmediate()
      throwIfAborted(signal, 'embedding batch')
      for (const text of texts.slice(start, start + this.options.maxBatch)) out.push(this.project(text))
    }
    return out
  }

  /** @inheritdoc */
  override async close(): Promise<void> {
    // Nothing to release: hashing holds no model, file handle, or socket.
  }

  /**
   * Project one text into the space.
   * @param text - content to embed.
   * @returns a unit-length vector.
   */
  private project(text: string): number[] {
    const vector = new Array<number>(this.options.dimension).fill(0)
    for (const token of tokenize(text)) {
      const digest = createHash('sha256').update(token, 'utf8').digest()
      for (let probe = 0; probe < PROBES; probe++) {
        const at = probe * PROBE_BYTES
        const bucket = digest.readUInt32BE(at) % this.options.dimension
        vector[bucket] = (vector[bucket] ?? 0) + (digest.readUInt8(at + 4) & 1 ? 1 : -1)
      }
    }
    let sum = 0
    for (const value of vector) sum += value * value
    if (sum === 0) {
      vector[0] = 1
      return vector
    }
    return normalizeVector(vector)
  }
}
