/**
 * Optional compressed dense-vector provider using an isolated, bounded turbovec Python worker.
 * Zvec remains authoritative. A failed, timed-out, restarted, or incomplete worker cannot answer a
 * query unless every authorized candidate exists in its current ephemeral index.
 * @module @deepseek-ai/dsh-retrieval-zvec/turbovec
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Accelerator, RecordId, RetrievalError, assertValidVector, throwIfAborted, type AcceleratorStats, type BackendHit, type RetrievalErrorCode } from '@deepseek-ai/dsh-retrieval'
import type { Context } from '@deepseek-ai/cordis'
import { TURBOVEC_WORKER } from './turbovec-worker.ts'

/** Deployment limits for the optional turbovec worker. */
export interface TurboVecOptions {
  /** Python executable from a trusted environment with turbovec and numpy installed. */
  pythonExecutable: string
  /** Four-bit compression is the supported default; two-bit is experimental. */
  bitWidth: 2 | 4
  /** Deadline for initialization and each native operation, including IPC. */
  timeoutMs: number
  /** Maximum operations waiting for the single worker. */
  maxQueue: number
  /** UTF-8 byte limit for one request or response, including framing. */
  maxMessageBytes: number
  /** Maximum compressed vectors retained by this worker. */
  maxVectors: number
  /** Worker native thread ceiling. */
  threads: number
}

interface PendingReply {
  id: number
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
}

/** Ephemeral turbovec derivative with one worker and one serial operation queue per provider. */
export class TurboVecAccelerator extends Accelerator {
  private worker: ChildProcessWithoutNullStreams | null = null
  private readonly workerExits = new Set<Promise<void>>()
  private pending: PendingReply | null = null
  private response = Buffer.alloc(0)
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private ordinal = 0
  private closed = false
  private count = 0
  private degraded: string | null = null

  /**
   * @param ctx - provider context with a resolved embedding space.
   * @param options - worker executable and resource limits.
   */
  constructor(ctx: Context, private readonly options: TurboVecOptions) {
    super(ctx)
  }

  /** @inheritdoc */
  override get available(): boolean { return !this.closed && this.degraded === null }

  /**
   * Serialize worker operations and apply backpressure before retaining another operation.
   * @param operation - bounded operation to execute.
   * @returns its result.
   */
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new RetrievalError('unavailable', 'turbovec provider is closed', true)
    if (this.queued >= this.options.maxQueue) throw new RetrievalError('unavailable', 'turbovec queue is full', true)
    this.queued++
    const run = this.tail.then(operation)
    this.tail = run.catch(() => undefined)
    try { return await run } finally { this.queued-- }
  }

  /** Refuse work after disposal, including an operation resumed after an awaited worker exit. */
  private assertOpen(): void {
    if (this.closed) throw new RetrievalError('unavailable', 'turbovec provider is closed', true)
  }

  /**
   * Start one isolated interpreter on demand and admit no ambient credentials to its environment.
   * @returns when the worker has accepted the embedding space.
   */
  private async start(signal?: AbortSignal): Promise<void> {
    this.assertOpen()
    if (this.worker !== null) return
    await Promise.all(this.workerExits)
    throwIfAborted(signal, 'turbovec startup')
    this.assertOpen()
    const space = this.ctx.embeddings.space
    if (!space.normalized || space.dimension % 8 !== 0 || space.dimension > 16384) {
      throw new RetrievalError('space_mismatch', 'turbovec requires normalized vectors with dimension a multiple of 8, at most 16384')
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      OMP_NUM_THREADS: String(this.options.threads),
      OPENBLAS_NUM_THREADS: String(this.options.threads),
      RAYON_NUM_THREADS: String(this.options.threads),
    }
    const worker = spawn(this.options.pythonExecutable, ['-I', '-u', '-c', TURBOVEC_WORKER, String(this.options.maxMessageBytes)], { env, stdio: 'pipe', windowsHide: true })
    this.worker = worker
    const exited = new Promise<void>(resolve => worker.once('close', () => { resolve() }))
    this.workerExits.add(exited)
    void exited.then(() => { this.workerExits.delete(exited) })
    this.response = Buffer.alloc(0)
    worker.stdin.on('error', (error) => { this.fail(worker, `turbovec stdin failed: ${error.message}`) })
    worker.stderr.on('data', () => { /* Import diagnostics are represented by the structured exit error. */ })
    worker.stdout.on('data', (chunk: Buffer) => { this.receive(worker, chunk) })
    worker.on('error', (error) => { this.fail(worker, `turbovec worker could not start: ${error.message}`, 'spawn_failed') })
    worker.on('exit', (code, signal) => { this.fail(worker, `turbovec worker exited (${signal ?? code ?? 'unknown'}); rebuild its derivative or reload the plugin`, 'worker_crashed') })
    try {
      await this.send({ op: 'init', dimension: space.dimension, bitWidth: this.options.bitWidth, maxVectors: this.options.maxVectors }, signal)
      this.degraded = null
      this.count = 0
    } catch (error) {
      this.fail(worker, 'turbovec initialization failed; check its Python environment')
      throw error
    }
  }

  /**
   * Parse exactly one bounded response and reject an invalid protocol before using any native value.
   * @param worker - process that emitted the bytes.
   * @param chunk - newly emitted stdout bytes.
   * @returns nothing.
   */
  private receive(worker: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (worker !== this.worker) return
    if (this.response.length + chunk.length > this.options.maxMessageBytes) {
      this.fail(worker, 'turbovec response exceeds the IPC byte limit', 'protocol_error')
      return
    }
    this.response = Buffer.concat([this.response, chunk])
    const newline = this.response.indexOf(10)
    if (newline < 0) return
    const pending = this.pending
    if (pending === null || newline !== this.response.length - 1) {
      this.fail(worker, 'turbovec emitted an unsolicited or malformed response', 'protocol_error')
      return
    }
    const line = this.response.subarray(0, newline).toString('utf8')
    this.response = Buffer.alloc(0)
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      this.fail(worker, `turbovec emitted invalid JSON: ${error instanceof Error ? error.message : 'parse failure'}`, 'protocol_error')
      return
    }
    if (!isObject(value) || value.requestId !== pending.id || typeof value.ok !== 'boolean') {
      this.fail(worker, 'turbovec response id or status is invalid', 'protocol_error')
      return
    }
    this.pending = null
    if (!value.ok) {
      pending.reject(new RetrievalError('unavailable', typeof value.error === 'string' ? value.error : 'turbovec operation failed', true))
      this.fail(worker, 'turbovec derivative is inconsistent; rebuild or reload the plugin')
      return
    }
    if (!isObject(value.data)) {
      pending.reject(new RetrievalError('protocol_error', 'turbovec response data is invalid', true))
      this.fail(worker, 'turbovec response data is invalid', 'protocol_error')
      return
    }
    pending.resolve(value.data)
  }

  /**
   * Exchange one request with the active worker. Timeouts kill its untrusted partial derivative.
   * @param payload - operation fields, without the monotonic request id.
   * @returns validated response object.
   */
  private async send(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfAborted(signal, 'turbovec request')
    const worker = this.worker
    if (worker === null) throw new RetrievalError('unavailable', 'turbovec worker is unavailable', true)
    const id = ++this.ordinal
    const text = `${JSON.stringify({ ...payload, requestId: id })}\n`
    if (Buffer.byteLength(text) > this.options.maxMessageBytes) throw new RetrievalError('invalid_input', 'turbovec request exceeds the IPC byte limit')
    return await new Promise((resolve, reject) => {
      const aborted = (): void => {
        this.fail(worker, 'turbovec operation was cancelled; its partial derivative was discarded', 'cancelled')
      }
      const timer = setTimeout(() => {
        this.fail(worker, 'turbovec operation timed out; rebuild or reload the plugin', 'timeout')
      }, this.options.timeoutMs)
      const finish = (callback: () => void): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        callback()
      }
      this.pending = {
        id,
        resolve: (value) => { finish(() => { resolve(value) }) },
        reject: (error) => { finish(() => { reject(error) }) },
      }
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted === true) {
        aborted()
        return
      }
      worker.stdin.write(text, (error) => {
        if (error !== null && error !== undefined) this.fail(worker, `turbovec IPC write failed: ${error.message}`)
      })
    })
  }

  /**
   * Discard a worker and reject its in-flight operation; authoritative Zvec data is untouched.
   * @param worker - worker being discarded.
   * @param reason - non-sensitive diagnostic.
   * @returns nothing.
   */
  private fail(worker: ChildProcessWithoutNullStreams, reason: string, code: RetrievalErrorCode = 'unavailable'): void {
    if (this.worker !== worker) return
    this.worker = null
    this.degraded = reason
    this.count = 0
    const pending = this.pending
    this.pending = null
    pending?.reject(new RetrievalError(code, reason, true))
    worker.kill('SIGKILL')
  }

  /** @inheritdoc */
  override async add(ids: readonly RecordId[], vectors: readonly (readonly number[])[], signal?: AbortSignal): Promise<number> {
    return await this.mutate('add', ids, vectors, signal)
  }

  /**
   * Validate and send an add or rebuild as one serialized operation.
   * @param op - mutation mode.
   * @param ids - stable authoritative ids.
   * @param vectors - vectors in positional order.
   * @param signal - cancellation checked before mutation.
   * @returns the accepted count.
   */
  private async mutate(op: 'add' | 'rebuild', ids: readonly RecordId[], vectors: readonly (readonly number[])[], signal?: AbortSignal): Promise<number> {
    if (ids.length !== vectors.length || new Set(ids).size !== ids.length) throw new RetrievalError('invalid_input', 'turbovec requires unique positional ids and vectors')
    if (ids.length > this.options.maxVectors) throw new RetrievalError('invalid_input', 'turbovec vector limit exceeded')
    if (ids.some(id => id.length === 0 || id.length > 1024)) throw new RetrievalError('invalid_input', 'turbovec record id is too long or empty')
    return await this.enqueue(async () => {
      try {
        throwIfAborted(signal, 'turbovec add')
        await this.start(signal)
        if (ids.length === 0 && op === 'add') return 0
        const dimension = this.ctx.embeddings.space.dimension
        const rows = Math.max(1, Math.floor((this.options.maxMessageBytes - 2048) / (dimension * 32 + 4096)))
        let written = 0
        for (let offset = 0; offset < Math.max(ids.length, 1); offset += rows) {
          throwIfAborted(signal, 'turbovec add')
          const prepared = vectors.slice(offset, offset + rows).map(vector => assertValidVector([...vector], this.ctx.embeddings.space))
          const data = await this.send({ op: op === 'rebuild' && offset === 0 ? 'rebuild' : 'add', ids: ids.slice(offset, offset + rows), vectors: prepared }, signal)
          this.count = natural(data.vectors)
          written += natural(data.count)
        }
        return written
      } catch (error) {
        if (this.worker !== null) this.fail(this.worker, 'turbovec mutation failed; its partial derivative was discarded')
        throw error
      }
    })
  }

  /** @inheritdoc */
  override async search(
    vector: readonly number[],
    topK: number,
    allowlist: readonly RecordId[],
    signal?: AbortSignal,
  ): Promise<BackendHit[]> {
    if (allowlist.length === 0 || topK <= 0) return []
    return await this.enqueue(async () => {
      throwIfAborted(signal, 'turbovec search')
      const prepared = assertValidVector([...vector], this.ctx.embeddings.space)
      await this.start(signal)
      const data = await this.send({ op: 'search', vector: prepared, topK: Math.floor(topK), allowlist: [...new Set(allowlist)] }, signal)
      if (!Array.isArray(data.hits) || data.hits.length > topK) throw this.protocolError('turbovec returned an invalid result count')
      const permitted = new Set(allowlist)
      return data.hits.map((hit: unknown) => {
        if (!isObject(hit) || typeof hit.id !== 'string' || typeof hit.score !== 'number' || !Number.isFinite(hit.score)) throw this.protocolError('turbovec returned an invalid or unauthorized hit')
        let id: RecordId
        try { id = RecordId(hit.id) } catch (error) { throw this.protocolError(error instanceof Error ? error.message : 'invalid worker record id') }
        if (!permitted.has(id)) throw this.protocolError('turbovec returned an unauthorized hit')
        return { id, score: hit.score }
      })
    })
  }

  /** @inheritdoc */
  override async remove(ids: readonly RecordId[]): Promise<number> {
    return await this.enqueue(async () => {
      await this.start()
      const data = await this.send({ op: 'remove', ids })
      try {
        this.count = natural(data.vectors)
        return natural(data.count)
      } catch (error) {
        throw this.protocolError(error instanceof Error ? error.message : 'turbovec returned invalid removal counts')
      }
    })
  }

  /** @inheritdoc */
  override async sync(): Promise<void> {
    await this.enqueue(async () => { await this.start(); await this.send({ op: 'sync' }) })
  }

  /** @inheritdoc */
  override async rebuild(ids: readonly RecordId[], vectors: readonly (readonly number[])[], signal?: AbortSignal): Promise<number> {
    return await this.mutate('rebuild', ids, vectors, signal)
  }

  /** @inheritdoc */
  override async stats(): Promise<AcceleratorStats> {
    if (this.worker !== null && !this.closed && this.queued < this.options.maxQueue) {
      try {
        await this.enqueue(async () => {
          const data = await this.send({ op: 'stats' })
          this.count = natural(data.vectors)
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'turbovec health probe failed'
        this.protocolError(reason)
        this.degraded = reason
      }
    }
    return { backend: 'turbovec', available: this.available, vectors: this.count, bitWidth: this.options.bitWidth, drift: -1, degradedReason: this.degraded }
  }

  /** Discard all derivative state after a malformed native response. */
  private protocolError(reason: string): RetrievalError {
    if (this.worker !== null) this.fail(this.worker, reason, 'protocol_error')
    return new RetrievalError('protocol_error', reason, true)
  }

  /** @inheritdoc */
  override async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    if (worker !== null) this.fail(worker, 'turbovec provider closed')
    await this.tail
    await Promise.all(this.workerExits)
  }
}

/** Narrow an untrusted protocol value to an object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a worker count, refusing corrupt native responses. */
function natural(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RetrievalError('unavailable', 'turbovec returned an invalid count', true)
  return value
}
