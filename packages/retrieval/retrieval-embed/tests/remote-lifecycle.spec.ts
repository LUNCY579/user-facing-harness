/** Local HTTP barriers verify that provider disposal settles owned requests before returning. */
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { RetrievalError } from '@deepseek-ai/dsh-retrieval'
import { afterEach, describe, expect, it } from 'vitest'
import * as embedPlugin from '../src/index.ts'

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error !== undefined) reject(error)
      else resolve()
    }))
  }))
})

/** One explicit barrier, independent of scheduler timing. */
function barrier(): { reached: Promise<void>; release: () => void } {
  let release = (): void => { throw new Error('barrier is not initialized') }
  const reached = new Promise<void>((resolve) => { release = resolve })
  return { reached, release }
}

describe('remote embedding lifecycle', { timeout: 30000 }, () => {
  it('does not send an ambient cloud credential to a local embedding server', async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'synthetic-ambient-cloud-key'
    try {
      let authorization: string | undefined
      const server = createServer((request, response) => {
        authorization = request.headers.authorization
        request.resume()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 1, 1, 1, 1, 1, 1, 1] }] }))
      })
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { resolve() })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no bound port')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(embedPlugin, embedPlugin.Config({
        provider: 'local-openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: 'synthetic-local', dimension: 8,
      }))
      expect(await ctx.embeddings.embed(['synthetic local input'])).toHaveLength(1)
      expect(authorization).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  it('keeps reflected credentials and private input out of status and JSON errors', async () => {
    const previous = process.env.DSH_RETRIEVAL_REFLECT_TEST_KEY
    const fakeKey = 'synthetic-reflected-credential'
    const privateInput = 'synthetic-private-embedding-input'
    process.env.DSH_RETRIEVAL_REFLECT_TEST_KEY = fakeKey
    try {
      const statuses = [400, 503, 200]
      let requests = 0
      const server = createServer((request, response) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => { body += chunk })
        request.on('end', () => {
          response.writeHead(statuses[requests++] ?? 400, { 'content-type': 'application/json' })
          response.end(`reflected credential: ${request.headers.authorization}; reflected request: ${body}`)
        })
      })
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { resolve() })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no bound port')
      for (const status of statuses) {
        const ctx = new Context()
        contexts.push(ctx)
        await ctx.plugin(embedPlugin, embedPlugin.Config({
          provider: 'local-openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: 'synthetic-reflection', dimension: 8, apiKeyEnv: 'DSH_RETRIEVAL_REFLECT_TEST_KEY', maxRetries: 0,
        }))
        const failure = await ctx.embeddings.embed([privateInput]).then(() => undefined, (error: unknown) => error)
        if (!(failure instanceof RetrievalError)) throw new Error('reflection fixture did not return a retrieval failure')
        const rendered = JSON.stringify({ message: failure.message, detail: failure.detail })
        expect(rendered).not.toContain(fakeKey)
        expect(rendered).not.toContain(privateInput)
        if (status !== 200) expect(failure.message).toContain(String(status))
        else expect(failure.code).toBe('protocol_error')
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_RETRIEVAL_REFLECT_TEST_KEY
      else process.env.DSH_RETRIEVAL_REFLECT_TEST_KEY = previous
    }
  })

  it('requires an explicit credential variable for a remote provider', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(embedPlugin, embedPlugin.Config({
      provider: 'openai-compatible', allowRemoteEmbeddings: true, baseUrl: 'http://127.0.0.1:1/v1',
      model: 'synthetic-remote', dimension: 8,
    }))).rejects.toThrow(/apiKeyEnv naming/)
  })

  it('aborts an active HTTP body, prevents the next batch, and settles before plugin unload completes', async () => {
    const entered = barrier()
    const disconnected = barrier()
    let requests = 0
    const server = createServer((request, response) => {
      requests++
      request.resume()
      response.once('close', disconnected.release)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"data":[')
      entered.release()
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no bound port')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(embedPlugin, embedPlugin.Config({
      provider: 'local-openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'synthetic-lifetime', dimension: 8, apiKeyEnv: '', maxBatch: 1, timeoutMs: 60000, maxRetries: 2,
    }))
    const provider = ctx.embeddings
    const outcome = provider.embed(['synthetic-first', 'synthetic-second']).then(
      () => ({ code: 'unexpected_success' }),
      (error: unknown) => error,
    )
    await entered.reached
    await ctx.fiber.dispose()
    await expect(outcome).resolves.toMatchObject({ code: 'cancelled' })
    await disconnected.reached
    expect(requests).toBe(1)
    await expect(provider.embed(['synthetic-after-close'])).rejects.toMatchObject({ code: 'cancelled' })
    await expect(provider.embed([])).rejects.toMatchObject({ code: 'cancelled' })
    await provider.close()
  })
})
