/**
 * Mounts the Zvec-backed retrieval providers: the authoritative store and, when configured, the
 * quantized accelerator. Both need an embedding provider already on the context, so a profile that
 * enables this plugin must also mount one.
 * @module @deepseek-ai/dsh-retrieval-zvec
 */

import type { Context } from '@deepseek-ai/cordis'
import { RetrievalError } from '@deepseek-ai/dsh-retrieval'
import z from '@deepseek-ai/schemastery'
import { TurboVecAccelerator, type TurboVecOptions } from './turbovec.ts'
import { ZvecStore, type ZvecStoreOptions } from './store.ts'
import { ensureInitialized } from './gateway.ts'

/** Plugin name as it appears in a profile's patch list. */
export const name = 'retrieval-zvec'

/** Services this plugin requires before it can open a collection. */
export const inject = ['embeddings']

/** Deployment configuration for the Zvec-backed retrieval providers. */
export interface Config {
  /** Index root for the authoritative collection, relative to the process working directory. */
  indexDir: string
  /** Collection name recorded in the Zvec schema. */
  collectionName: string
  /** Open the authoritative collection without write access. */
  readOnly: boolean
  /** Memory-map Zvec data files instead of reading them per access. */
  enableMMAP: boolean
  /** Threads Zvec uses for searches; `0` lets the engine choose. */
  queryThreads: number
  /** Threads Zvec uses for index builds; `0` lets the engine choose. */
  optimizeThreads: number
  /** Directory for Zvec's own log files; empty selects console logging. */
  logDir: string
  /** Zvec log level, `0` debug through `4` fatal. */
  logLevel: number
  /** Maximum graph neighbors retained per vector. */
  hnswM: number
  /** Candidate list size during HNSW construction. */
  hnswEfConstruction: number
  /** Candidate list size per HNSW query; Zvec accepts at most 2048. */
  hnswEf: number
  /** Full-text tokenizer: `standard`, `ngram`, `jieba`, or `whitespace`. */
  ftsTokenizer: string
  /** Full-text token filters, e.g. `lowercase`, `ascii_folding`, `stemmer`. */
  ftsFilters: string[]
  /** Ceiling on record ids in one explicit-id filter expression. */
  maxFilterIds: number
  /** Documents per write batch. */
  writeBatchSize: number
  /** Weight of the vector half in hybrid fusion, in `[0, 1]`. */
  hybridVectorWeight: number
  /** Mount the quantized accelerator and let the engine re-rank through it. */
  acceleratorEnabled: boolean
  /** TurboQuant bits per vector component: `4`, or experimental `2`. */
  acceleratorBitWidth: number
  /** Trusted Python executable with turbovec and numpy installed. */
  turbovecPython: string
  /** Worker operation deadline, including IPC. */
  workerTimeoutMs: number
  /** Maximum queued worker operations. */
  workerMaxQueue: number
  /** Maximum UTF-8 bytes per framed IPC message. */
  workerMaxMessageBytes: number
  /** Maximum compressed vectors per worker. */
  workerMaxVectors: number
  /** Maximum native worker threads. */
  workerThreads: number
}

/** Loader schema for {@link Config}. */
export const Config: z<Partial<Config>, Config> = z.object({
  indexDir: z.string().default('.testingplatform/retrieval'),
  collectionName: z.string().default('retrieval'),
  readOnly: z.boolean().default(false),
  enableMMAP: z.boolean().default(true),
  queryThreads: z.natural().default(1),
  optimizeThreads: z.natural().default(1),
  logDir: z.string().default(''),
  logLevel: z.natural().min(0).max(4).default(3),
  hnswM: z.natural().min(2).default(16),
  hnswEfConstruction: z.natural().min(8).default(200),
  hnswEf: z.natural().min(8).max(2048).default(2048),
  ftsTokenizer: z.string().default('standard'),
  ftsFilters: z.array(z.string()).default(['lowercase']),
  maxFilterIds: z.natural().min(1).default(512),
  writeBatchSize: z.natural().min(1).default(256),
  hybridVectorWeight: z.number().min(0).max(1).default(0.7),
  acceleratorEnabled: z.boolean().default(false),
  acceleratorBitWidth: z.natural().default(4),
  turbovecPython: z.string().default('python3'),
  workerTimeoutMs: z.natural().min(1).default(30000),
  workerMaxQueue: z.natural().min(1).default(8),
  workerMaxMessageBytes: z.natural().min(1024).default(16777216),
  workerMaxVectors: z.natural().min(1).default(100000),
  workerThreads: z.natural().min(1).default(1),
})

/**
 * @param config - resolved plugin configuration.
 * @returns the authoritative store's accepted deployment options.
 */
function storeOptions(config: Config): ZvecStoreOptions {
  return {
    indexDir: config.indexDir,
    collectionName: config.collectionName,
    readOnly: config.readOnly,
    enableMMAP: config.enableMMAP,
    queryThreads: config.queryThreads,
    optimizeThreads: config.optimizeThreads,
    logDir: config.logDir,
    logLevel: config.logLevel,
    hnswM: config.hnswM,
    hnswEfConstruction: config.hnswEfConstruction,
    hnswEf: config.hnswEf,
    ftsTokenizer: config.ftsTokenizer,
    ftsFilters: config.ftsFilters,
    maxFilterIds: config.maxFilterIds,
    writeBatchSize: config.writeBatchSize,
    hybridVectorWeight: config.hybridVectorWeight,
  }
}

/**
 * @param config - resolved plugin configuration.
 * @returns the accelerator's accepted option set.
 */
function acceleratorOptions(config: Config): TurboVecOptions {
  if (config.acceleratorBitWidth !== 2 && config.acceleratorBitWidth !== 4) {
    throw new RetrievalError('invalid_input', `turbovec bit width must be 2 or 4, got ${config.acceleratorBitWidth}`)
  }
  return {
    pythonExecutable: config.turbovecPython,
    bitWidth: config.acceleratorBitWidth,
    timeoutMs: config.workerTimeoutMs,
    maxQueue: config.workerMaxQueue,
    maxMessageBytes: config.workerMaxMessageBytes,
    maxVectors: config.workerMaxVectors,
    threads: config.workerThreads,
  }
}

/**
 * Provide `ctx.vectorStore` and optional `ctx.accelerator`. Disposal closes the store and writer
 * lease, terminates the worker, and discards its derivative.
 * @param ctx - registrant context.
 * @param config - resolved deployment configuration.
 * @returns when the providers are mounted.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let native: typeof import('@zvec/zvec')
  try {
    native = await import('@zvec/zvec')
  } catch (error) {
    throw RetrievalError.from(
      'unavailable', 'Zvec native SDK is unavailable. Install optional dependencies on a supported platform, or disable retrieval.', error,
    )
  }
  ensureInitialized(config, native)
  const store = new ZvecStore(ctx, storeOptions(config), native)
  ctx.effect(() => async () => { await store.close() }, 'retrieval-zvec: store')
  if (!config.acceleratorEnabled) return
  const accelerator = new TurboVecAccelerator(ctx, acceleratorOptions(config))
  ctx.effect(() => async () => { await accelerator.close() }, 'retrieval-zvec: accelerator')
}
