/**
 * Coverage of the embedding providers. The local hashed space is checked for determinism, unit
 * length, width, batch bounds, cancellation, and configuration rejection; the OpenAI-compatible
 * remote client is exercised only through a stubbed `globalThis.fetch`, so no test reaches the
 * network or needs a credential. The plugin's remote opt-in gate is covered last. Every token,
 * model name, endpoint, and vector below is synthetic.
 */

import { Context } from '@deepseek-ai/cordis'
import { Embeddings, RetrievalError, contentHash, spaceKeyOf } from '@deepseek-ai/dsh-retrieval'
import * as embedPlugin from '@deepseek-ai/dsh-retrieval-embed'
import { HashedEmbeddings, type LocalOptions } from '../src/local.ts'
import { RemoteEmbeddings, type RemoteOptions } from '../src/remote.ts'
import { afterEach, describe, expect, it } from 'vitest'

/** Environment variable the remote tests populate with a synthetic bearer token. */
const KEY_ENV = 'DSH_RETRIEVAL_EMBED_TEST_KEY'

/** Synthetic bearer token; never a real credential. */
const FAKE_KEY = 'synthetic-token-not-a-credential'

/** Eight equal components: the smallest accepted width, unit length after normalization. */
const ONES = [1, 1, 1, 1, 1, 1, 1, 1]

/** Normalized form of {@link ONES}, used as an exact remote response expectation. */
const UNIT = ONES.map(value => value / Math.sqrt(8))

/** One recorded request to the stubbed embedding server. */
interface Posted {
  readonly url: string
  readonly init: RequestInit
}

const contexts: Context[] = []
const pristineFetch = globalThis.fetch
const pristineKey = process.env.DSH_RETRIEVAL_EMBED_TEST_KEY

afterEach(async () => {
  globalThis.fetch = pristineFetch
  if (pristineKey === undefined) delete process.env.DSH_RETRIEVAL_EMBED_TEST_KEY
  else process.env.DSH_RETRIEVAL_EMBED_TEST_KEY = pristineKey
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Fresh Cordis context, disposed with every other context after each test. */
function createContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

/**
 * Replace `globalThis.fetch` with a stub that answers from memory.
 * @param answer - produces the response for call number `index`, counting from zero.
 * @returns the requests the stub recorded, in call order.
 */
function stubFetch(answer: (index: number, init: RequestInit) => Response | Promise<Response>): Posted[] {
  const calls: Posted[] = []
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const options: RequestInit = init ?? {}
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init: options })
    return await answer(calls.length - 1, options)
  }
  return calls
}

/**
 * @param body - response body text.
 * @param status - HTTP status code.
 * @returns a response as the stubbed server would send it.
 */
function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/**
 * @param entries - response entries in the order the server sends them.
 * @returns a successful embeddings response.
 */
function embedResponse(entries: readonly { index: number; embedding: readonly number[] }[]): Response {
  const data = entries.map(entry => ({ object: 'embedding', index: entry.index, embedding: [...entry.embedding] }))
  return jsonResponse(JSON.stringify({ data }))
}

/**
 * Body of one posted embedding request.
 * @param init - recorded request options.
 * @returns the `model` tag and the `input` texts.
 */
function postedBody(init: RequestInit): { model: string; input: readonly string[] } {
  if (typeof init.body !== 'string') throw new Error('embedding request body must be JSON text')
  const value: unknown = JSON.parse(init.body)
  if (typeof value !== 'object' || value === null) throw new Error('the embedding request body is not an object')
  const fields = value as Record<string, unknown>
  if (typeof fields['model'] !== 'string' || !Array.isArray(fields['input'])) throw new Error('the embedding request body lacks model or input')
  return { model: fields['model'], input: fields['input'].map(item => String(item)) }
}

/**
 * @param call - a recorded request, or absent because the stub was never reached.
 * @returns the recorded request.
 */
function posted(call: Posted | undefined): Posted {
  if (call === undefined) throw new Error('the provider made no request')
  return call
}

/**
 * Local hashed space options.
 * @param over - fields to replace.
 * @returns a complete provider configuration.
 */
function localOptions(over: Partial<LocalOptions> = {}): LocalOptions {
  return { provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 64, maxBatch: 64, ...over }
}

/**
 * Remote space options pointing at the stubbed server.
 * @param over - fields to replace.
 * @returns a complete remote configuration.
 */
function remoteOptions(over: Partial<RemoteOptions> = {}): RemoteOptions {
  return {
    provider: 'openai-compatible',
    model: 'test-embed-model',
    modelRevision: '',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKeyEnv: KEY_ENV,
    dimension: 8,
    timeoutMs: 5_000,
    maxBatch: 64,
    maxRetries: 0,
    maxResponseBytes: 8_388_608,
    retryBackoffMs: 250,
    retryMaxBackoffMs: 8_000,
    ...over,
  }
}

/**
 * @param over - configuration fields to replace.
 * @returns a complete plugin configuration carrying the documented defaults.
 */
function pluginConfig(over: Partial<embedPlugin.Config> = {}): embedPlugin.Config {
  return {
    provider: 'local-hashed',
    model: 'dsh-hashed-v1',
    modelRevision: '',
    dimension: 256,
    allowRemoteEmbeddings: false,
    baseUrl: '',
    apiKeyEnv: KEY_ENV,
    timeoutMs: 20_000,
    maxBatch: 64,
    maxRetries: 2,
    maxResponseBytes: 8_388_608,
    retryBackoffMs: 250,
    retryMaxBackoffMs: 8_000,
    ...over,
  }
}

/**
 * Construct the remote provider over a fresh context.
 * @param over - configuration fields to replace.
 * @param credential - token to expose through {@link KEY_ENV}; `null` leaves the variable unset.
 * @returns the mounted provider.
 */
function remoteProvider(over: Partial<RemoteOptions> = {}, credential: string | null = FAKE_KEY): RemoteEmbeddings {
  if (credential !== null) process.env[KEY_ENV] = credential
  return new RemoteEmbeddings(createContext(), remoteOptions(over))
}

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

/**
 * Await an operation that must fail, and return its retrieval failure.
 * @param action - the call under test.
 * @returns the thrown {@link RetrievalError}.
 */
async function rejection(action: () => PromiseLike<unknown>): Promise<RetrievalError> {
  try {
    await action()
  } catch (error) {
    if (error instanceof RetrievalError) return error
    throw error
  }
  throw new Error('the operation completed without a retrieval failure')
}

describe('HashedEmbeddings space and configuration', () => {
  it('mounts the local hashed provider and reports its space', async () => {
    const ctx = createContext()
    await ctx.plugin(embedPlugin, pluginConfig({ dimension: 64 }))
    expect(ctx.embeddings).toBeInstanceOf(HashedEmbeddings)
    expect(ctx.embeddings).toBeInstanceOf(Embeddings)
    expect(ctx.embeddings.space).toEqual({ provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 64, normalized: true })
    expect(spaceKeyOf(ctx.embeddings.space)).toBe('sp:5105fb89324e4616907f839f')
  })

  it('derives one space key per model tag and dimension', async () => {
    const base = createContext()
    await base.plugin(embedPlugin, pluginConfig({ dimension: 64 }))
    const renamed = createContext()
    await renamed.plugin(embedPlugin, pluginConfig({ dimension: 64, model: 'other-model' }))
    const wider = createContext()
    await wider.plugin(embedPlugin, pluginConfig({ dimension: 128 }))
    expect(spaceKeyOf(renamed.embeddings.space)).toBe('sp:30b99c182b1e0f4321043b26')
    expect(spaceKeyOf(renamed.embeddings.space)).not.toBe(spaceKeyOf(base.embeddings.space))
    expect(spaceKeyOf(wider.embeddings.space)).not.toBe(spaceKeyOf(base.embeddings.space))
    expect(wider.embeddings.space.dimension).toBe(128)
  })

  it('reports the same identity through the plugin and a direct construction', async () => {
    const direct = new HashedEmbeddings(createContext(), localOptions({ dimension: 256 }))
    expect(direct.space).toEqual({ provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 256, normalized: true })
    expect(spaceKeyOf(direct.space)).toBe('sp:1a432a5391e0f78270fa3912')
    const ctx = createContext()
    await ctx.plugin(embedPlugin, pluginConfig({ dimension: 256 }))
    expect(spaceKeyOf(ctx.embeddings.space)).toBe(spaceKeyOf(direct.space))
  })

  it('rejects a width below eight or one that is not an integer', () => {
    const small = failure(() => new HashedEmbeddings(createContext(), localOptions({ dimension: 4 })))
    expect(small).toBeInstanceOf(RetrievalError)
    expect(small.code).toBe('invalid_input')
    expect(small.message).toContain('embedding dimension must be an integer of at least 8, got 4')
    expect(failure(() => new HashedEmbeddings(createContext(), localOptions({ dimension: 64.5 }))).message).toContain('got 64.5')
  })

  it('rejects a batch bound below one text', () => {
    const error = failure(() => new HashedEmbeddings(createContext(), localOptions({ maxBatch: 0 })))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('embedding maxBatch must be at least 1, got 0')
  })
})

describe('HashedEmbeddings embed', () => {
  it('is deterministic for the same text and independent of call grouping', async () => {
    const provider = new HashedEmbeddings(createContext(), localOptions())
    expect(await provider.embed(['Refunds settle through the ledger.'])).toEqual(await provider.embed(['Refunds settle through the ledger.']))
    const pair = await provider.embed(['alpha refund', 'beta ledger'])
    expect(pair[0]).toEqual((await provider.embed(['alpha refund']))[0])
    expect(pair[1]).toEqual((await provider.embed(['beta ledger']))[0])
  })

  it('returns one vector of the configured width per input, in caller order', async () => {
    const provider = new HashedEmbeddings(createContext(), localOptions({ dimension: 32 }))
    expect(await provider.embed([])).toEqual([])
    const vectors = await provider.embed(['refundPayment', 'drawChart canvas', 'staging restores Tuesday'])
    expect(vectors).toHaveLength(3)
    for (const vector of vectors) expect(vector).toHaveLength(32)
    expect(vectors[0]).not.toEqual(vectors[1])
  })

  it('returns a unit-length finite vector for every input, including a tokenless one', async () => {
    const provider = new HashedEmbeddings(createContext(), localOptions({ dimension: 64 }))
    for (const text of ['refund ledger', '', '!!! ???', 'a', 'x'.repeat(2_000)]) {
      const [vector] = await provider.embed([text])
      if (vector === undefined) throw new Error('the provider returned no vector')
      expect(vector).toHaveLength(64)
      expect(vector.every(value => Number.isFinite(value))).toBe(true)
      expect(Math.abs(Math.hypot(...vector) - 1)).toBeLessThan(1e-9)
    }
  })

  it('embeds a bag of tokens rather than an ordered string', async () => {
    const provider = new HashedEmbeddings(createContext(), localOptions())
    expect(await provider.embed(['alpha beta gamma'])).toEqual(await provider.embed(['gamma alpha beta']))
    expect(await provider.embed(['Refunds settle.'])).toEqual(await provider.embed(['REFUNDS SETTLE.']))
    expect(await provider.embed(['alpha'])).not.toEqual(await provider.embed(['beta']))
  })

  it('scores shared terms closer than unrelated terms', async () => {
    const provider = new HashedEmbeddings(createContext(), localOptions({ dimension: 256 }))
    const [query] = await provider.embed(['refund ledger balance'])
    const [related] = await provider.embed(['refund ledger'])
    const [unrelated] = await provider.embed(['canvas stroke chart'])
    if (query === undefined || related === undefined || unrelated === undefined) throw new Error('the provider returned no vector')
    const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0)
    expect(dot(query, related)).toBeGreaterThan(dot(query, unrelated))
  })

  it('bounds each hashing pass by maxBatch and checks cancellation between passes', async () => {
    const provider = new HashedEmbeddings(createContext(), localOptions({ maxBatch: 2 }))
    expect(await provider.embed(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])).toHaveLength(5)

    const aborted = new AbortController()
    aborted.abort()
    const sliced = new HashedEmbeddings(createContext(), localOptions({ maxBatch: 1 }))
    const cancelled = await rejection(() => sliced.embed(['alpha', 'beta'], aborted.signal))
    expect(cancelled.code).toBe('cancelled')
    expect(cancelled.message).toContain('embedding batch was cancelled')
    await expect(provider.embed(['alpha'], aborted.signal)).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('closes without releasing anything', async () => {
    const provider = new HashedEmbeddings(createContext(), localOptions())
    await expect(provider.close()).resolves.toBeUndefined()
  })
})

describe('RemoteEmbeddings space and configuration', () => {
  it('reports the configured remote space', () => {
    const provider = remoteProvider()
    expect(provider).toBeInstanceOf(RemoteEmbeddings)
    expect(provider).toBeInstanceOf(Embeddings)
    expect(provider.space).toEqual({ provider: 'openai-compatible', model: 'test-embed-model', dimension: 8, normalized: true, revision: '877958083aed2150e6512b740eb0cb327a785e3e676e7937a3e9609f01469f48' })
    expect(spaceKeyOf(provider.space)).toBe('sp:0dca7ce85051bc0412e42a04')
  })

  it('folds a non-empty weight revision into the space identity', () => {
    const tagged = remoteProvider({ modelRevision: 'v3-weights' })
    expect(tagged.space.revision).toBe(contentHash('http://127.0.0.1:1/v1/embeddings\u0000v3-weights'))
    expect(tagged.space.revision).not.toBe(remoteProvider().space.revision)
  })

  it('rejects an invalid width, batch, retry, or timeout limit', () => {
    expect(failure(() => remoteProvider({ dimension: 4 })).message).toContain('embedding dimension must be an integer of at least 8, got 4')
    expect(failure(() => remoteProvider({ dimension: 8.5 })).message).toContain('got 8.5')
    const limits: readonly Partial<RemoteOptions>[] = [{ maxBatch: 0 }, { maxRetries: -1 }, { timeoutMs: 0 }]
    for (const over of limits) {
      const error = failure(() => remoteProvider(over))
      expect(error.code).toBe('invalid_input')
      expect(error.message).toContain('embedding batch, retry, and timeout limits must be positive')
    }
  })

  it('rejects an endpoint that is not HTTP(S) before reading the credential', () => {
    const error = failure(() => remoteProvider({ baseUrl: 'ftp://127.0.0.1:1/v1' }, null))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('embedding endpoint must be HTTP(S), got ftp:')
  })

  it('rejects a baseUrl that is not an absolute URL', () => {
    const error = failure(() => remoteProvider({ baseUrl: '127.0.0.1:1/v1' }, null))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('embedding baseUrl must be an absolute HTTP(S) URL')
  })

  it('refuses endpoint credentials that bypass the configured environment variable', () => {
    const error = failure(() => remoteProvider({ baseUrl: 'http://operator:secret@127.0.0.1:1/v1' }, null))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('embedding endpoint credentials must use the configured environment variable')
  })

  it('refuses a remote provider whose retry backoff bounds are unusable', () => {
    const bounds: readonly Partial<RemoteOptions>[] = [
      { retryBackoffMs: -1 },
      { retryBackoffMs: 25.5 },
      { retryMaxBackoffMs: -1 },
      { retryBackoffMs: 500, retryMaxBackoffMs: 250 },
    ]
    for (const over of bounds) {
      const error = failure(() => remoteProvider(over))
      expect(error.code).toBe('invalid_input')
      expect(error.message).toContain('retryMaxBackoffMs must be at least retryBackoffMs')
    }
  })

  it('refuses to construct when the named credential is absent or blank', () => {
    const missing = failure(() => remoteProvider({}, null))
    expect(missing.code).toBe('unauthorized')
    expect(missing.message).toContain(`no embedding credential in environment variable ${KEY_ENV}`)
    expect(failure(() => remoteProvider({}, '   ')).message).toContain('no embedding credential')
  })
})

describe('RemoteEmbeddings embed', () => {
  it('posts the model and inputs to the embeddings endpoint with the bearer token', async () => {
    const calls = stubFetch(() => embedResponse([{ index: 0, embedding: ONES }, { index: 1, embedding: [8, 0, 0, 0, 0, 0, 0, 0] }]))
    const provider = remoteProvider()
    const vectors = await provider.embed(['refund ledger', 'drawChart canvas'])
    expect(calls).toHaveLength(1)
    const request = posted(calls[0])
    expect(request.url).toBe('http://127.0.0.1:1/v1/embeddings')
    expect(request.init.method).toBe('POST')
    expect(request.init.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${FAKE_KEY}` })
    expect(postedBody(request.init)).toEqual({ model: 'test-embed-model', input: ['refund ledger', 'drawChart canvas'] })
    expect(request.init.signal).toBeInstanceOf(AbortSignal)
    expect(vectors[0]).toEqual(UNIT)
    expect(vectors[1]).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
  })

  it('appends one embeddings segment to a baseUrl that already ends in a slash', async () => {
    const calls = stubFetch(() => embedResponse([{ index: 0, embedding: ONES }]))
    await remoteProvider({ baseUrl: 'http://127.0.0.1:1/v1/' }).embed(['refund ledger'])
    expect(posted(calls[0]).url).toBe('http://127.0.0.1:1/v1/embeddings')
  })

  it('orders the returned vectors by the response index, not by arrival', async () => {
    stubFetch(() => embedResponse([
      { index: 1, embedding: [8, 0, 0, 0, 0, 0, 0, 0] },
      { index: 0, embedding: ONES },
    ]))
    const vectors = await remoteProvider().embed(['refund ledger', 'drawChart'])
    expect(vectors[0]).toEqual(UNIT)
    expect(vectors[1]).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
  })

  it('sends one serial request per maxBatch slice', async () => {
    let active = 0
    let peak = 0
    const calls = stubFetch(async (_index, init) => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      return embedResponse(postedBody(init).input.map((_text, position) => ({ index: position, embedding: [8, 0, 0, 0, 0, 0, 0, 0] })))
    })
    const provider = remoteProvider({ maxBatch: 2 })
    const vectors = await provider.embed(['first', 'second', 'third'])
    expect(calls.map(call => postedBody(call.init).input)).toEqual([['first', 'second'], ['third']])
    expect(peak).toBe(1)
    expect(vectors).toEqual([[1, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0]])
  })

  it('returns nothing without calling the server for an empty input list', async () => {
    const calls = stubFetch(() => embedResponse([{ index: 0, embedding: ONES }]))
    expect(await remoteProvider().embed([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('re-reads the credential at request time', async () => {
    const calls = stubFetch(() => embedResponse([{ index: 0, embedding: ONES }]))
    const provider = remoteProvider()
    delete process.env.DSH_RETRIEVAL_EMBED_TEST_KEY
    const error = await rejection(() => provider.embed(['refund ledger']))
    expect(error.code).toBe('unauthorized')
    expect(error.message).toContain(`no embedding credential in environment variable ${KEY_ENV}`)
    expect(calls).toHaveLength(0)
  })

  it('stops before the first request when the caller already aborted', async () => {
    const calls = stubFetch(() => embedResponse([{ index: 0, embedding: ONES }]))
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(() => remoteProvider().embed(['refund ledger'], controller.signal))
    expect(error.code).toBe('cancelled')
    expect(error.message).toContain('embedding batch was cancelled')
    expect(calls).toHaveLength(0)
  })
})

describe('RemoteEmbeddings failures', () => {
  it('retries a retryable status and returns the recovered response', async () => {
    const calls = stubFetch(index => index === 0
      ? new Response('upstream saturated', { status: 503 })
      : embedResponse([{ index: 0, embedding: ONES }]))
    const vectors = await remoteProvider({ maxRetries: 1 }).embed(['refund ledger'])
    expect(calls).toHaveLength(2)
    expect(vectors).toEqual([UNIT])
  })

  it('gives up once the retries are exhausted and reports a retryable backend error', async () => {
    const calls = stubFetch(() => new Response('too fast', { status: 429 }))
    const error = await rejection(() => remoteProvider({ maxRetries: 1 }).embed(['refund ledger']))
    expect(calls).toHaveLength(2)
    expect(error.code).toBe('backend_error')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('embedding server returned 429; retry later')
    expect(error.message).not.toContain('too fast')
  })

  it('reports a non-retryable status without exposing its response body', async () => {
    const reason = `${'a'.repeat(200)}${'b'.repeat(50)}`
    stubFetch(() => new Response(reason, { status: 400 }))
    const error = await rejection(() => remoteProvider().embed(['refund ledger']))
    expect(error.code).toBe('protocol_error')
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('embedding server returned 400; check the embedding service and model configuration')
    expect(error.message).not.toContain('a'.repeat(200))
    expect(error.message).not.toContain('bbbb')
  })

  it('reports 401 and 403 as unauthorized without a retry', async () => {
    for (const status of [401, 403]) {
      const calls = stubFetch(() => new Response('no', { status }))
      const error = await rejection(() => remoteProvider({ maxRetries: 2 }).embed(['refund ledger']))
      expect(calls).toHaveLength(1)
      expect(error.code).toBe('unauthorized')
      expect(error.retryable).toBe(false)
      expect(error.message).toContain(`embedding server refused the credential (${String(status)})`)
    }
  })

  it('reports an unreachable server as a retryable unavailable failure', async () => {
    const calls = stubFetch(() => {
      throw new TypeError('fetch failed')
    })
    const error = await rejection(() => remoteProvider().embed(['refund ledger']))
    expect(calls).toHaveLength(1)
    expect(error.code).toBe('unavailable')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('embedding server unreachable: fetch failed')
  })

  it('reports a rejection that is not an Error by its string form', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise a transport rejection with a non-Error reason.
    const calls = stubFetch(() => Promise.reject('synthetic transport rejection without an Error'))
    const error = await rejection(() => remoteProvider().embed(['refund ledger']))
    expect(calls).toHaveLength(1)
    expect(error.code).toBe('unavailable')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('embedding server unreachable: synthetic transport rejection without an Error')
  })

  it('reports a timeout when an attempt outlives timeoutMs', async () => {
    const calls = stubFetch((_index, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal
      if (signal === undefined || signal === null) {
        reject(new Error('the provider sent no abort signal'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(new Error('The operation was aborted'))
      }, { once: true })
    }))
    const error = await rejection(() => remoteProvider({ timeoutMs: 20 }).embed(['refund ledger']))
    expect(calls).toHaveLength(1)
    expect(error.code).toBe('timeout')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('embedding request exceeded 20 ms')
  })

  it('cancels a retry wait when the caller aborts', async () => {
    const calls = stubFetch(() => new Response('upstream saturated', { status: 503 }))
    const controller = new AbortController()
    const pending = remoteProvider({ maxRetries: 3 }).embed(['refund ledger'], controller.signal)
    setTimeout(() => {
      controller.abort()
    }, 20)
    const error = await rejection(() => pending)
    expect(error.code).toBe('cancelled')
    expect(error.message).toContain('embedding retry cancelled')
    expect(calls).toHaveLength(1)
  })
})

describe('RemoteEmbeddings response validation', () => {
  /**
   * Fail one embedding call with a canned response body.
   * @param body - the response text.
   * @param inputs - texts sent in one batch.
   * @returns the retrieval failure the provider reported.
   */
  async function rejectBody(body: string, inputs: readonly string[] = ['refund ledger']): Promise<RetrievalError> {
    stubFetch(() => jsonResponse(body))
    return await rejection(() => remoteProvider().embed(inputs))
  }

  it('rejects a response with no data entries', async () => {
    expect((await rejectBody('{"data":[]}')).message).toContain('embedding server returned no data')
    expect((await rejectBody('{}')).message).toContain('embedding server returned no data')
    expect((await rejectBody('null')).message).toContain('embedding server returned no data')
    expect((await rejectBody('42')).message).toContain('embedding server returned no data')
  })

  it('rejects a successful response whose body is absent', async () => {
    stubFetch(() => new Response(null, { status: 200 }))
    const error = await rejection(() => remoteProvider().embed(['refund ledger']))
    expect(error.code).toBe('protocol_error')
    expect(error.message).toContain('embedding server returned no data: invalid JSON')
  })

  it('rejects a body that is not JSON', async () => {
    const error = await rejectBody('not json at all')
    expect(error.code).toBe('protocol_error')
    expect(error.message).toContain('embedding server returned no data')
  })

  it('rejects an entry whose embedding is not a list', async () => {
    expect((await rejectBody('{"data":[{"index":0,"embedding":"one"}]}')).message).toContain('embedding response entry 0 is not a list')
  })

  it('rejects an entry that is not the configured width of finite numbers', async () => {
    expect((await rejectBody(`{"data":[{"index":0,"embedding":[${'1,'.repeat(6)}1]}]}`)).message)
      .toContain('embedding response entry 0 is not 8 finite numbers')
    expect((await rejectBody('{"data":[{"index":0,"embedding":[1,1,1,1,1,1,1,null]}]}')).message)
      .toContain('embedding response entry 0 is not 8 finite numbers')
  })

  it('rejects a zero vector', async () => {
    expect((await rejectBody('{"data":[{"index":0,"embedding":[0,0,0,0,0,0,0,0]}]}')).message)
      .toContain('embedding response entry 0 is a zero vector')
  })

  it('rejects an index outside the batch, a fractional index, and a missing index', async () => {
    const valid = ONES.join(',')
    expect((await rejectBody(`{"data":[{"index":5,"embedding":[${valid}]}]}`)).message).toContain('embedding response index 5 is outside the batch')
    expect((await rejectBody(`{"data":[{"index":0.5,"embedding":[${valid}]}]}`)).message).toContain('embedding response index 0.5 is outside the batch')
    expect((await rejectBody(`{"data":[{"embedding":[${valid}]}]}`)).message).toContain('embedding response index undefined is outside the batch')
  })

  it('rejects a repeated index', async () => {
    const valid = ONES.join(',')
    expect((await rejectBody(`{"data":[{"index":0,"embedding":[${valid}]},{"index":0,"embedding":[${valid}]}]}`)).message)
      .toContain('embedding response repeated index 0')
  })

  it('rejects a response that omits the vector of an input', async () => {
    const valid = ONES.join(',')
    const error = await rejectBody(`{"data":[{"index":1,"embedding":[${valid}]}]}`, ['first', 'second'])
    expect(error.code).toBe('protocol_error')
    expect(error.message).toContain('embedding server returned no vector for input 0')
  })
})

describe('retrieval-embed plugin gate', () => {
  it('mounts the local hashed provider for a local-hashed configuration', async () => {
    const ctx = createContext()
    await ctx.plugin(embedPlugin, pluginConfig())
    expect(ctx.embeddings).toBeInstanceOf(HashedEmbeddings)
    expect(ctx.embeddings.space.provider).toBe('local-hashed')
    expect(ctx.embeddings.space.dimension).toBe(256)
  })

  it('refuses the remote provider without the explicit opt-in', async () => {
    const ctx = createContext()
    const error = await rejection(() => ctx.plugin(embedPlugin, pluginConfig({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })))
    expect(error.code).toBe('unauthorized')
    expect(error.message).toContain('set allowRemoteEmbeddings: true to accept that')
  })

  it('requires a baseUrl once the opt-in is granted', async () => {
    const ctx = createContext()
    const error = await rejection(() => ctx.plugin(embedPlugin, pluginConfig({ provider: 'openai-compatible', allowRemoteEmbeddings: true })))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('openai-compatible needs a baseUrl')
  })

  it('refuses a remote mount when the named credential is absent', async () => {
    const ctx = createContext()
    const error = await rejection(() => ctx.plugin(embedPlugin, pluginConfig({ provider: 'openai-compatible', allowRemoteEmbeddings: true, baseUrl: 'http://127.0.0.1:1/v1', dimension: 8 })))
    expect(error.code).toBe('unauthorized')
    expect(error.message).toContain(`no embedding credential in environment variable ${KEY_ENV}`)
  })

  it('mounts the remote provider when opted in and credentialed', async () => {
    process.env[KEY_ENV] = FAKE_KEY
    const calls = stubFetch(() => embedResponse([{ index: 0, embedding: ONES }]))
    const ctx = createContext()
    await ctx.plugin(embedPlugin, pluginConfig({
      provider: 'openai-compatible',
      allowRemoteEmbeddings: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      dimension: 8,
      maxRetries: 0,
      maxResponseBytes: 8_388_608,
      retryBackoffMs: 250,
      retryMaxBackoffMs: 8_000,
    }))
    expect(ctx.embeddings).toBeInstanceOf(RemoteEmbeddings)
    expect(ctx.embeddings.space).toEqual({ provider: 'openai-compatible', model: 'dsh-hashed-v1', dimension: 8, normalized: true, revision: '877958083aed2150e6512b740eb0cb327a785e3e676e7937a3e9609f01469f48' })
    expect(spaceKeyOf(ctx.embeddings.space)).toBe('sp:c09d8078cf493e4001fced45')
    expect(await ctx.embeddings.embed(['refund ledger'])).toEqual([UNIT])
    expect(posted(calls[0]).url).toBe('http://127.0.0.1:1/v1/embeddings')
  })

  it('trims the model tag, the endpoint, and the credential variable name', async () => {
    process.env[KEY_ENV] = FAKE_KEY
    stubFetch(() => embedResponse([{ index: 0, embedding: ONES }]))
    const ctx = createContext()
    await ctx.plugin(embedPlugin, pluginConfig({
      provider: 'openai-compatible',
      allowRemoteEmbeddings: true,
      baseUrl: ' http://127.0.0.1:1/v1 ',
      apiKeyEnv: `  ${KEY_ENV}  `,
      model: '  spaced-model  ',
      dimension: 8,
    }))
    expect(ctx.embeddings.space.model).toBe('spaced-model')
    expect(await ctx.embeddings.embed(['refund ledger'])).toEqual([UNIT])
  })

  it('rejects an empty model tag for either provider', async () => {
    const local = createContext()
    const localError = await rejection(() => local.plugin(embedPlugin, pluginConfig({ model: '   ' })))
    expect(localError.code).toBe('invalid_input')
    expect(localError.message).toContain('embedding model tag must not be empty')
    const remote = createContext()
    const remoteError = await rejection(() => remote.plugin(embedPlugin, pluginConfig({
      provider: 'openai-compatible',
      allowRemoteEmbeddings: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      model: '   ',
    })))
    expect(remoteError.message).toContain('embedding model tag must not be empty')
  })

  it('rejects a width below eight through the loader schema', async () => {
    const ctx = createContext()
    await expect(ctx.plugin(embedPlugin, pluginConfig({ dimension: 4 }))).rejects.toThrow(/dimension/i)
  })
})

describe('local embedding endpoint and bounded responses', () => {
  it('allows an explicitly local endpoint without credentials and rejects external hosts', async () => {
    const calls = stubFetch(() => embedResponse([{ index: 0, embedding: ONES }]))
    const provider = new RemoteEmbeddings(createContext(), remoteOptions({ provider: 'local-openai-compatible' }))
    expect(await provider.embed(['synthetic local text'])).toEqual([UNIT])
    expect(posted(calls[0]).init.headers).toEqual({ 'content-type': 'application/json' })
    expect(posted(calls[0]).init.redirect).toBe('error')
    expect(() => new RemoteEmbeddings(createContext(), remoteOptions({ provider: 'local-openai-compatible', baseUrl: 'https://example.com/v1' }))).toThrow('requires a loopback endpoint')
  })

  it('rejects an oversized response body before parsing vector entries', async () => {
    stubFetch(() => jsonResponse('x'.repeat(2048)))
    await expect(remoteProvider({ maxResponseBytes: 1024 }).embed(['synthetic input'])).rejects.toMatchObject({ code: 'protocol_error' })
  })

  it('keeps its timeout active while reading a stalled body after headers arrive', async () => {
    stubFetch(() => new Response(new ReadableStream<Uint8Array>()))
    await expect(remoteProvider({ timeoutMs: 20 }).embed(['synthetic input'])).rejects.toMatchObject({ code: 'timeout' })
  })

  it('reports the timeout, not a cancel failure, when abandoning a body refuses cleanup', async () => {
    const refusingCancel = new ReadableStream<Uint8Array>({
      cancel(): Promise<never> {
        return Promise.reject(new Error('synthetic body cancel rejection'))
      },
    })
    stubFetch(() => new Response(refusingCancel))
    const error = await rejection(() => remoteProvider({ timeoutMs: 20 }).embed(['synthetic input']))
    expect(error.code).toBe('timeout')
    expect(error.message).toContain('embedding request exceeded 20 ms')
  })

  it('abandons an errored response body and reports the server as unreachable', async () => {
    const erroredBody = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.error(new Error('synthetic body failure'))
      },
    })
    stubFetch(() => new Response(erroredBody))
    const error = await rejection(() => remoteProvider().embed(['synthetic input']))
    expect(error.code).toBe('unavailable')
    expect(error.message).toContain('embedding server unreachable: synthetic body failure')
  })
})
