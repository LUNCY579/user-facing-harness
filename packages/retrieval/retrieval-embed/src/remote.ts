/**
 * Remote embedder for the OpenAI-compatible `/embeddings` API, which is what self-hosted servers
 * (Ollama, vLLM, llama.cpp server) and hosted APIs both expose. Uploading workspace content to
 * another machine is a privacy decision, so this provider exists only behind the explicit
 * `allowRemoteEmbeddings` opt-in in the plugin configuration, and the API key is read from an
 * environment variable named by configuration rather than stored in it.
 * @module @deepseek-ai/dsh-retrieval-embed/remote
 */

import { Embeddings, RetrievalError, contentHash, normalizeVector, throwIfAborted, type EmbeddingSpace } from '@deepseek-ai/dsh-retrieval'
import type { Context } from '@deepseek-ai/cordis'

/** Choices that define one remote embedding space and its transport limits. */
export interface RemoteOptions {
  /** Provider tag recorded in every space key. */
  provider: string
  /** Model name sent to the server and recorded in the space key. */
  model: string
  /** Operator-supplied weight revision, empty when the server model id already changes with weights. */
  modelRevision: string
  /** Absolute HTTP(S) base URL, with or without a trailing slash. */
  baseUrl: string
  /** Name of the environment variable holding the bearer token. */
  apiKeyEnv: string
  /** Vector width the server must return. */
  dimension: number
  /** Milliseconds per request attempt. */
  timeoutMs: number
  /** Texts per request. */
  maxBatch: number
  /** Retries after a retryable failure, using the configured exponential backoff bounds. */
  maxRetries: number
  /** Maximum response bytes, including error bodies. */
  maxResponseBytes: number
  /** Initial retry delay in milliseconds. */
  retryBackoffMs: number
  /** Maximum retry delay in milliseconds; at least retryBackoffMs. */
  retryMaxBackoffMs: number
}

/** HTTP statuses worth another attempt: rate limiting and transient server faults. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * Remote embedder. Every response vector is checked against the configured dimension, so a server
 * that silently changes models surfaces as `invalid_vector` instead of mixing two spaces into one
 * index.
 */
export class RemoteEmbeddings extends Embeddings {
  private readonly endpoint: URL

  private readonly lifetime = new AbortController()

  private readonly pending = new Set<Promise<number[][]>>()

  /**
   * @param ctx - registrant context.
   * @param options - resolved remote space and transport limits.
   */
  constructor(
    ctx: Context,
    private readonly options: RemoteOptions,
  ) {
    super(ctx)
    if (!Number.isInteger(options.dimension) || options.dimension < 8) {
      throw new RetrievalError('invalid_input', `embedding dimension must be an integer of at least 8, got ${options.dimension}`)
    }
    if (!Number.isSafeInteger(options.maxBatch) || options.maxBatch < 1
      || !Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
      || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) {
      throw new RetrievalError('invalid_input', 'embedding batch, retry, and timeout limits must be positive')
    }
    if (!Number.isSafeInteger(options.retryBackoffMs) || options.retryBackoffMs < 0
      || !Number.isSafeInteger(options.retryMaxBackoffMs) || options.retryMaxBackoffMs < options.retryBackoffMs) {
      throw new RetrievalError('invalid_input', 'retryMaxBackoffMs must be at least retryBackoffMs, and both must be non-negative integers')
    }
    try {
      this.endpoint = new URL(embeddingsPath(options.baseUrl))
    } catch (error) {
      throw RetrievalError.from('invalid_input', 'embedding baseUrl must be an absolute HTTP(S) URL', error)
    }
    if (this.endpoint.protocol !== 'http:' && this.endpoint.protocol !== 'https:') {
      throw new RetrievalError('invalid_input', `embedding endpoint must be HTTP(S), got ${this.endpoint.protocol}`)
    }
    if (options.provider === 'local-openai-compatible' && !['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname)) {
      throw new RetrievalError('unauthorized', 'local-openai-compatible requires a loopback endpoint')
    }
    if (this.endpoint.username.length > 0 || this.endpoint.password.length > 0) {
      throw new RetrievalError('invalid_input', 'embedding endpoint credentials must use the configured environment variable')
    }
    if (options.provider !== 'local-openai-compatible' && options.apiKeyEnv.trim().length === 0) {
      throw new RetrievalError('unauthorized', 'remote embeddings require apiKeyEnv naming the credential environment variable')
    }
    if (options.provider !== 'local-openai-compatible' && readKey(options.apiKeyEnv) === null) {
      throw new RetrievalError('unauthorized', `no embedding credential in environment variable ${options.apiKeyEnv}`)
    }
    ctx.effect(() => async () => { await this.close() }, 'remote embedding teardown')
  }

  /** @inheritdoc */
  override get space(): EmbeddingSpace {
    return {
      provider: this.options.provider,
      model: this.options.model,
      dimension: this.options.dimension,
      normalized: true,
      revision: contentHash(`${this.endpoint.href}${this.options.modelRevision.length === 0 ? '' : `\u0000${this.options.modelRevision}`}`),
    }
  }

  /**
   * @inheritdoc
   *
   * Batches go out one at a time: a shared embedding server rate-limits concurrent traffic from one
   * client. Disposal aborts active requests and retry waits, awaits every admitted operation, and
   * refuses subsequent calls with `cancelled`.
   */
  override async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    throwIfAborted(this.lifetime.signal, 'embedding provider')
    const cancellation = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const operation = this.embedBatch(texts, cancellation)
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  /** Embed one admitted operation under caller and provider cancellation. */
  private async embedBatch(texts: readonly string[], signal: AbortSignal): Promise<number[][]> {
    const out: number[][] = []
    for (let start = 0; start < texts.length; start += this.options.maxBatch) {
      throwIfAborted(signal, 'embedding batch')
      const batch = texts.slice(start, start + this.options.maxBatch)
      const vectors = await this.request(batch, signal)
      /* v8 ignore next 3 -- vectorsFrom emits one vector per input, so a count mismatch is an internal fault. */
      if (vectors.length !== batch.length) {
        throw new RetrievalError('protocol_error', `embedding server returned ${vectors.length} vectors for ${batch.length} inputs`)
      }
      out.push(...vectors)
    }
    return out
  }

  /** @inheritdoc */
  override async close(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.pending)
  }

  /**
   * Send one batch with bounded retries.
   * @param texts - inputs in caller order.
   * @param signal - caller cancellation.
   * @returns one vector per input, in the same order.
   */
  private async request(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    let attempt = 0
    for (;;) {
      try {
        return await this.send(texts, signal)
      } catch (error) {
        if (!(error instanceof RetrievalError) || !error.retryable || attempt >= this.options.maxRetries) throw error
        await sleep(backoffFor(attempt, this.options.retryBackoffMs, this.options.retryMaxBackoffMs), signal)
        attempt++
      }
    }
  }

  /**
   * One HTTP attempt. Neither the credential nor the request content reaches a log.
   * @param texts - inputs in caller order.
   * @param signal - caller cancellation.
   * @returns vectors ordered by the response's `index` field.
   */
  private async send(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const key = readKey(this.options.apiKeyEnv)
    if (key === null && this.options.provider !== 'local-openai-compatible') throw new RetrievalError('unauthorized', `no embedding credential in environment variable ${this.options.apiKeyEnv}`)
    const controller = new AbortController()
    const onAbort = (): void => {
      controller.abort()
    }
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)
    timer.unref()
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...key === null ? {} : { authorization: `Bearer ${key}` } },
        body: JSON.stringify({ model: this.options.model, input: texts }),
        signal: controller.signal,
        redirect: 'error',
      })
      const text = await readBoundedBody(response, this.options.maxResponseBytes, controller.signal)
      if (!response.ok) {
        const status = response.status
        if (status === 401 || status === 403) throw new RetrievalError('unauthorized', `embedding server refused the credential (${status})`)
        const retryable = RETRYABLE_STATUS.has(status)
        const action = retryable ? 'retry later or check embedding service health' : 'check the embedding service and model configuration'
        throw new RetrievalError(retryable ? 'backend_error' : 'protocol_error', `embedding server returned ${status}; ${action}`, retryable)
      }
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw new RetrievalError('protocol_error', 'embedding server returned no data: invalid JSON; verify its OpenAI-compatible embeddings endpoint')
      }
      return vectorsFrom(body, texts.length, this.options.dimension)
    } catch (error) {
      if (signal?.aborted === true) throw new RetrievalError('cancelled', 'embedding request cancelled')
      if (controller.signal.aborted) throw new RetrievalError('timeout', `embedding request exceeded ${this.options.timeoutMs} ms`, true)
      if (error instanceof RetrievalError) throw error
      throw new RetrievalError('unavailable', `embedding server unreachable: ${String(error instanceof Error ? error.message : error)}`, true)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * @param baseUrl - configured server root.
 * @returns the endpoint URL for the embeddings route.
 */
function embeddingsPath(baseUrl: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${trimmed}/embeddings`
}

/**
 * Read the credential at request time, so a key exported after load is used without a restart.
 * @param name - environment variable name from configuration.
 * @returns the token, or `null` when unset or blank.
 */
function readKey(name: string): string | null {
  const value = process.env[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Extract and validate the vectors of one successful response, ordered by each entry's `index`.
 * @param body - parsed response JSON.
 * @param expected - number of inputs the batch carried.
 * @param dimension - the configured vector width.
 * @returns one unit-length vector per input.
 */
function vectorsFrom(body: unknown, expected: number, dimension: number): number[][] {
  const data = fieldValue(body, 'data')
  if (!Array.isArray(data) || data.length === 0) throw new RetrievalError('protocol_error', 'embedding server returned no data')
  const byIndex = new Map<number, number[]>()
  const entries: readonly unknown[] = data
  for (const entry of entries) {
    const index = fieldValue(entry, 'index')
    const position = typeof index === 'number' && Number.isInteger(index) ? index : -1
    if (position < 0 || position >= expected) {
      throw new RetrievalError('protocol_error', `embedding response index ${String(index)} is outside the batch`)
    }
    if (byIndex.has(position)) throw new RetrievalError('protocol_error', `embedding response repeated index ${position}`)
    byIndex.set(position, vectorFrom(fieldValue(entry, 'embedding'), position, dimension))
  }
  const out: number[][] = []
  for (let position = 0; position < expected; position++) {
    const vector = byIndex.get(position)
    if (vector === undefined) throw new RetrievalError('protocol_error', `embedding server returned no vector for input ${position}`)
    out.push(vector)
  }
  return out
}

/**
 * @param value - one response entry's `embedding`.
 * @param position - batch index, for the failure message.
 * @param dimension - the configured vector width.
 * @returns the unit-length vector.
 */
function vectorFrom(value: unknown, position: number, dimension: number): number[] {
  if (!Array.isArray(value)) throw new RetrievalError('invalid_vector', `embedding response entry ${position} is not a list`)
  const components: readonly unknown[] = value
  if (components.length !== dimension || !components.every((component): component is number => typeof component === 'number' && Number.isFinite(component))) {
    throw new RetrievalError('invalid_vector', `embedding response entry ${position} is not ${dimension} finite numbers`)
  }
  const vector = components
  const unit = normalizeVector(vector)
  if (unit.every(component => component === 0)) throw new RetrievalError('invalid_vector', `embedding response entry ${position} is a zero vector`)
  return unit
}

/**
 * @param attempt - zero-based retry count already spent.
 * @param initial - configured first delay.
 * @param cap - configured maximum delay.
 * @returns capped backoff milliseconds.
 */
function backoffFor(attempt: number, initial: number, cap: number): number {
  return Math.min(initial * 2 ** attempt, cap)
}

/**
 * @param ms - delay to wait.
 * @param signal - caller cancellation.
 * @returns when the delay elapses, or cancellation throws.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  /* v8 ignore next -- send() reports cancellation from the same signal before a retry wait can start. */
  if (signal?.aborted === true) throw new RetrievalError('cancelled', 'embedding retry cancelled')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new RetrievalError('cancelled', 'embedding retry cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * @param value - a value parsed from JSON.
 * @param name - property to read.
 * @returns the property value, or `undefined` when `value` is not an object.
 */
function fieldValue(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[name]
}

/** Read a bounded response while the request timeout and cancellation remain active. */
async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  const onAbort = (): void => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      throwIfAborted(signal, 'embedding response')
      const next = await reader.read()
      throwIfAborted(signal, 'embedding response')
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) throw new RetrievalError('protocol_error', 'embedding response exceeds maxResponseBytes')
      chunks.push(next.value)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally {
    signal.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
