/**
 * Embedding provider plugin: mounts `ctx.embeddings` with either the deterministic local hash space
 * or an OpenAI-compatible remote space. Remote embedding uploads every indexed text to another
 * machine, so it is refused unless `allowRemoteEmbeddings` is set explicitly.
 * @module @deepseek-ai/dsh-retrieval-embed
 */

import { RetrievalError } from '@deepseek-ai/dsh-retrieval'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HashedEmbeddings } from './local.ts'
import { RemoteEmbeddings } from './remote.ts'

export const name = 'retrieval-embed'
export const inject: string[] = []

/** Deployment choices for the embedding space. */
export interface Config {
  /** Which provider produces vectors. `openai-compatible` sends text to another machine. */
  provider: 'local-hashed' | 'local-openai-compatible' | 'openai-compatible'
  /** Model tag recorded in the space key; changing it makes every stored vector unreadable until re-index. */
  model: string
  /** Local model-weight revision; change it when a server replaces weights under the same model id. */
  modelRevision: string
  /** Vector width, fixed when the collection is created. */
  dimension: number
  /** Required affirmative to send any text to a remote embedding server. */
  allowRemoteEmbeddings: boolean
  /** Server root for `openai-compatible`, for example `http://127.0.0.1:11434/v1`. */
  baseUrl: string
  /** Explicit credential environment variable; empty sends no token and is valid only for local providers. */
  apiKeyEnv: string
  /** Milliseconds per remote request attempt. */
  timeoutMs: number
  /** Texts per remote request, and per local cancellation check. */
  maxBatch: number
  /** Retries after a retryable remote failure. */
  maxRetries: number
  /** Maximum bytes read from one embedding response. */
  maxResponseBytes: number
  /** Initial delay between retry attempts. */
  retryBackoffMs: number
  /** Maximum delay between retry attempts. */
  retryMaxBackoffMs: number
}

/** Loader schema for {@link Config}. */
export const Config: z<Partial<Config>, Config> = z.object({
  provider: z.union([z.const('local-hashed'), z.const('local-openai-compatible'), z.const('openai-compatible')]).default('local-hashed'),
  model: z.string().default('dsh-hashed-v1'),
  modelRevision: z.string().default(''),
  dimension: z.natural().min(8).default(256),
  allowRemoteEmbeddings: z.boolean().default(false),
  baseUrl: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  timeoutMs: z.natural().min(1).default(20_000),
  maxBatch: z.natural().min(1).default(64),
  maxRetries: z.natural().default(2),
  maxResponseBytes: z.natural().min(1024).default(8_388_608),
  retryBackoffMs: z.natural().default(250),
  retryMaxBackoffMs: z.natural().default(8_000),
})

/**
 * Mount `ctx.embeddings`.
 * @param ctx - registrant context.
 * @param config - resolved deployment configuration.
 * @returns when the provider is mounted.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.model.trim().length === 0) throw new RetrievalError('invalid_input', 'embedding model tag must not be empty')
  if (config.provider === 'local-hashed') {
    new HashedEmbeddings(ctx, {
      provider: 'local-hashed',
      model: config.model.trim(),
      dimension: config.dimension,
      maxBatch: config.maxBatch,
    })
    return
  }
  if (config.provider === 'openai-compatible' && !config.allowRemoteEmbeddings) {
    throw new RetrievalError(
      'unauthorized',
      'provider "openai-compatible" indexes text on another machine; set allowRemoteEmbeddings: true to accept that',
    )
  }
  if (config.baseUrl.trim().length === 0) throw new RetrievalError('invalid_input', 'openai-compatible needs a baseUrl')
  new RemoteEmbeddings(ctx, {
    provider: config.provider,
    model: config.model.trim(),
    modelRevision: config.modelRevision,
    baseUrl: config.baseUrl.trim(),
    apiKeyEnv: config.apiKeyEnv.trim(),
    dimension: config.dimension,
    timeoutMs: config.timeoutMs,
    maxBatch: config.maxBatch,
    maxRetries: config.maxRetries,
    maxResponseBytes: config.maxResponseBytes,
    retryBackoffMs: config.retryBackoffMs,
    retryMaxBackoffMs: config.retryMaxBackoffMs,
  })
}
