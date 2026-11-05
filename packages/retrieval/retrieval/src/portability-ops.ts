/**
 * The staged export and import protocol for explicit memories. The retrieval service supplies the
 * mounted store, embedding provider, configuration, and authorization decisions through
 * {@link PortabilityHost}; this module owns the ordering that makes an import interrupt-safe: journal,
 * write, verify, publish, and rollback.
 * @module @deepseek-ai/dsh-retrieval/portability-ops
 */

import { RetrievalError, throwIfAborted } from './errors.ts'
import type { VectorStore } from './contract.ts'
import type { Config } from './engine.ts'
import {
  EMPTY_FORGET_LEDGER, MEMORY_EXPORT_VERSION, confinedPortabilityPath, decodeMemoryExport, encodeMemoryExport,
  encodeMemoryRecord, forgottenIndex, journalPathOf, ledgerPathOf, memoryExportOf, readPortabilityJson,
  readPortabilityText, writePortabilityJson, writePortabilityText,
} from './portability.ts'
import type { ForgottenEntry, ImportJournal, ImportRefusal, ImportReport, MemoryExport } from './portability.ts'
import type { MemoryRecord, ReadFilter, RecordId, SpaceKey, StoredRecord, TrustedIdentity } from './types.ts'

/** Engine operations one portability run needs, every one resolved under the engine's own rules. */
export interface PortabilityHost {
  /** Resolved engine configuration, including the portability limits. */
  readonly config: Config
  /** Authoritative store the operation reads from or writes into. */
  readonly store: VectorStore
  /** Embedding space key the mounted store and provider currently agree on. */
  readonly targetSpace: SpaceKey
  /** Embed records in the target space, refusing when the provider disagrees with the store. */
  embed(records: readonly MemoryRecord[], signal?: AbortSignal): Promise<Map<RecordId, readonly number[]>>
  /** Every memory the caller may read, including expired, superseded, and pending rows. */
  authorized(identity: TrustedIdentity): Promise<MemoryRecord[]>
  /** Population already stored under these ids, including rows that are not memories. */
  stored(ids: readonly RecordId[]): Promise<StoredRecord[]>
  /** The active memory the engine's own duplicate rule already holds for this record, when any. */
  duplicate(record: MemoryRecord, identity: TrustedIdentity): Promise<MemoryRecord | undefined>
  /** Filter selecting only the supplied ids under the caller's authority. */
  probeFilter(identity: TrustedIdentity, onlyIds: readonly RecordId[]): ReadFilter
  /** Refuse a record the caller may not write, using the engine's ownership rules. */
  assertWritable(record: MemoryRecord, identity: TrustedIdentity): void
  /** Mirror published vectors into the accelerator; accelerator failures never undo the store write. */
  mirror(vectors: Map<RecordId, readonly number[]>): Promise<void>
  /** Discard cached lifecycle recovery after durable records changed underneath it. */
  invalidateRecovery(): void
}

/** Selection for an operator-run memory export. */
export interface ExportInput {
  /** File name below `portabilityDir` to write; absent returns the envelope without writing. */
  path?: string
  /** Include expired and superseded rows so the target can keep lifecycle history. */
  includeInactive?: boolean
}

/** Selection for an operator-run memory import or embedding-space migration. */
export interface ImportInput {
  /** File name below `portabilityDir` holding export text; required unless `json` is supplied. */
  path?: string
  /** Export text held by the operator, admitted under the same validation as a file. */
  json?: string
}

/**
 * Whether a memory is currently retrievable, in the same terms the store's `activeAt` filter applies.
 * An export carries committed records only, so a staged record is never an unfinished supersession intent.
 */
function active(record: MemoryRecord, now: number): boolean {
  return record.supersededBy === null && (record.expiresAt === null || record.expiresAt > now)
}

/**
 * Build the export envelope from the caller's authorized records and optionally write it.
 * @param host - engine operations for the mounted store.
 * @param identity - caller whose readable records are exported.
 * @param input - optional file name below `portabilityDir` and inactive-row selection.
 * @param directory - absolute configured portability directory.
 * @param signal - cancellation of the in-flight read.
 * @returns the validated envelope.
 */
export async function exportMemories(
  host: PortabilityHost,
  identity: TrustedIdentity,
  input: ExportInput,
  directory: string,
  signal?: AbortSignal,
): Promise<MemoryExport> {
  throwIfAborted(signal, 'memory export')
  const records = await host.authorized(identity)
  const now = Date.now()
  const selected = input.includeInactive === true ? records : records.filter(record => active(record, now))
  if (selected.length > host.config.maxPortabilityRecords) {
    throw new RetrievalError('invalid_input', `export would exceed maxPortabilityRecords (${host.config.maxPortabilityRecords})`)
  }
  const envelope = memoryExportOf(selected, host.targetSpace)
  if (input.path === undefined) return envelope
  const path = await confinedPortabilityPath(directory, input.path)
  try {
    await writePortabilityText(path, encodeMemoryExport(envelope))
  } catch (error) {
    throw new RetrievalError('backend_error', `memory export ${path} was not written`, false, { cause: String(error) })
  }
  return envelope
}

/**
 * Import one export into the mounted store under a write-ahead journal: plan against authorization and
 * forgotten ledger entries, re-embed the accepted texts, stage them, verify durability, digests, space,
 * lifecycle, and retrievability, then publish. A write or verification failure removes exactly the staged
 * ids.
 * @param host - engine operations for the mounted store.
 * @param identity - caller whose authority decides which records are admitted.
 * @param input - export file name below `portabilityDir`, or export text.
 * @param directory - absolute configured portability directory.
 * @param signal - cancellation before or between bounded steps; staged records are always rolled back.
 * @returns counters, refusals, and the space pair for the attempt.
 */
export async function importMemories(
  host: PortabilityHost,
  identity: TrustedIdentity,
  input: ImportInput,
  directory: string,
  signal?: AbortSignal,
): Promise<ImportReport> {
  throwIfAborted(signal, 'memory import')
  const source = input.path === undefined ? undefined : await confinedPortabilityPath(directory, input.path)
  const text = input.json ?? (source === undefined ? null : await readPortabilityText(source, null))
  if (text === null) throw new RetrievalError('not_found', 'memory import needs an export path below portabilityDir or export text')
  const envelope = decodeMemoryExport(text, host.config.maxPortabilityRecords)
  const targetSpace = host.targetSpace
  const journalPath = journalPathOf(directory, (await host.store.stats()).path)
  const recovered = await clearInterruptedJournal(host, journalPath)
  const ledger = forgottenIndex(await readPortabilityJson(ledgerPathOf(directory), EMPTY_FORGET_LEDGER))
  const plan = await planImport(host, identity, envelope, ledger)
  if (plan.accepted.length === 0) return report(0, plan.reused, recovered, plan.refused, envelope.sourceSpace, targetSpace)
  const records = plan.accepted.map(record => ({ ...record, spaceKey: targetSpace }))
  const vectors = await host.embed(records, signal)
  const journal: ImportJournal = {
    version: MEMORY_EXPORT_VERSION,
    staged: records.map(record => record.id),
    targetSpace,
    startedAt: Date.now(),
    published: false,
  }
  await writePortabilityJson(journalPath, journal)
  try {
    const outcome = await host.store.write(records, vectors, signal)
    if (outcome.written !== records.length || outcome.rejected !== 0 || outcome.spaceConflict !== null) {
      throw new RetrievalError('backend_error', `the import batch was not fully acknowledged (${outcome.written} written, ${outcome.rejected} rejected)`)
    }
    await verifyImport(host, identity, records, vectors, signal)
  } catch (error) {
    await rollback(host, journalPath, journal, error)
  }
  await writePortabilityJson(journalPath, { ...journal, staged: [], published: true })
  await host.mirror(vectors)
  host.invalidateRecovery()
  return report(records.length, plan.reused, recovered, plan.refused, envelope.sourceSpace, targetSpace)
}

/**
 * @returns the report for one completed import attempt.
 */
function report(
  accepted: number,
  reused: number,
  recovered: number,
  refused: ImportRefusal[],
  sourceSpace: SpaceKey,
  targetSpace: SpaceKey,
): ImportReport {
  return { accepted, reused, recovered, refused, sourceSpace, targetSpace }
}

/** Records an import intends to write, plus the ids it deliberately did not take. */
interface ImportPlan {
  accepted: MemoryRecord[]
  reused: number
  refused: ImportRefusal[]
}

/**
 * Decide, record by record, what one export may add to this store. Every refusal is a reason the
 * operator can act on, never a silent skip: forgotten ids, foreign ownership, an id that already holds
 * different content, and the memory cap.
 * @param host - engine operations for the mounted store.
 * @param identity - caller whose authority decides admission.
 * @param envelope - decoded export.
 * @param ledger - ids this host recorded as forgotten.
 * @returns the accepted records in export order, reuse counters, and refusals.
 */
async function planImport(
  host: PortabilityHost,
  identity: TrustedIdentity,
  envelope: MemoryExport,
  ledger: Map<RecordId, ForgottenEntry>,
): Promise<ImportPlan> {
  const population = await host.authorized(identity)
  const present = new Map((await host.stored(envelope.records.map(record => record.id))).map(row => [row.id, row]))
  const accepted: MemoryRecord[] = []
  const refused: ImportRefusal[] = []
  let reused = 0
  for (const record of envelope.records) {
    if (ledger.has(record.id)) {
      refused.push({ id: record.id, reason: 'this host recorded the memory as forgotten; restoring it means deleting that ledger entry first' })
      continue
    }
    try {
      host.assertWritable(record, identity)
    } catch (error) {
      refused.push({ id: record.id, reason: String(error) })
      continue
    }
    const existing = present.get(record.id)
    if (existing !== undefined) {
      if (existing.kind !== 'memory') refused.push({ id: record.id, reason: 'the store holds an indexed passage under this id, so it is not a memory export' })
      else if (existing.contentHash === record.contentHash) reused += 1
      else refused.push({ id: record.id, reason: 'the store holds different content under this id' })
      continue
    }
    if (await host.duplicate(record, identity) !== undefined) {
      reused += 1
      continue
    }
    if (population.length + accepted.length >= host.config.maxMemories) {
      refused.push({ id: record.id, reason: `memory cap reached (${String(host.config.maxMemories)})` })
      continue
    }
    accepted.push(record)
  }
  return { accepted, reused, refused }
}

/**
 * Clear the journal one interrupted import left behind, so its staged rows cannot leak into the new
 * attempt. Absence is proven before the journal is retired; an unprovable state keeps the journal and
 * refuses the import rather than writing over a store of unknown contents.
 * @param host - engine operations for the mounted store.
 * @param path - absolute journal path for this store.
 * @returns count of staged records removed.
 */
async function clearInterruptedJournal(host: PortabilityHost, path: string): Promise<number> {
  const journal = await readPortabilityJson<ImportJournal | null>(path, null)
  if (journal === null) return 0
  if (journal.version !== MEMORY_EXPORT_VERSION) {
    throw new RetrievalError('invalid_input', `import journal version ${String(journal.version)} is not supported; this release reads version ${MEMORY_EXPORT_VERSION}`)
  }
  if (journal.staged.length === 0) return 0
  let removed: number
  try {
    removed = await host.store.remove(journal.staged)
  } catch (error) {
    throw new RetrievalError('outcome_pending', `staged records of an interrupted import could not be removed; the journal at ${path} is kept`, false, { cause: String(error) })
  }
  if ((await host.store.fetch(journal.staged)).length > 0) {
    throw new RetrievalError('outcome_pending', `staged records of an interrupted import are still in the store; the journal at ${path} is kept`)
  }
  await writePortabilityJson(path, { ...journal, staged: [] })
  host.invalidateRecovery()
  return removed
}

/**
 * Prove the staged batch before publishing it: every record reads back byte-identical to what was
 * exported and carries a vector in the target space, one active record is searchable under the caller's
 * own filter, and one inactive record stays out of search results. The store applies the same lifecycle
 * filter to every row of the batch, so one probe per state proves the imported visibility as written.
 * @param host - engine operations for the mounted store.
 * @param identity - caller whose filter the retrievability probe uses.
 * @param records - staged records, each already carrying the target space key.
 * @param vectors - the vectors written beside them.
 * @param signal - cancellation.
 * @returns when the batch is verified.
 */
async function verifyImport(
  host: PortabilityHost,
  identity: TrustedIdentity,
  records: readonly MemoryRecord[],
  vectors: Map<RecordId, readonly number[]>,
  signal?: AbortSignal,
): Promise<void> {
  const stored = new Map((await host.stored(records.map(record => record.id))).map(row => [row.id, row]))
  const now = Date.now()
  const probes: [MemoryRecord, readonly number[]][] = []
  for (const record of records) {
    const row = stored.get(record.id)
    if (row === undefined || row.kind !== 'memory' || encodeMemoryRecord(row) !== encodeMemoryRecord(record)) {
      throw new RetrievalError('backend_error', `imported memory ${record.id} is not stored exactly as exported`)
    }
    const vector = vectors.get(record.id)
    if (vector === undefined) {
      throw new RetrievalError('backend_error', `imported memory ${record.id} was staged without a vector in the target space`)
    }
    if (probes.length < 2 && !probes.some(probe => active(probe[0], now) === active(record, now))) probes.push([record, vector])
  }
  await host.store.optimize()
  for (const [record, vector] of probes) {
    const retrievable = (await host.store.searchVector(vector, 1, host.probeFilter(identity, [record.id]), signal)).length > 0
    if (retrievable === active(record, now)) continue
    throw new RetrievalError('backend_error', active(record, now)
      ? `imported memory ${record.id} is stored but is not retrievable in the target space`
      : `imported memory ${record.id} is retrievable although it is expired or superseded`)
  }
}

/**
 * Remove exactly the staged ids and rethrow the original failure, so a failed import never leaves a
 * half-written population behind. The journal stays in place when the store cannot prove the batch is
 * gone, which makes the next import for this store clean up before planning again.
 * @param host - engine operations for the mounted store.
 * @param path - absolute journal path for this store.
 * @param journal - the write-ahead journal naming the staged ids.
 * @param failure - the write or verification failure being reported.
 * @returns never; always throws.
 */
async function rollback(
  host: PortabilityHost,
  path: string,
  journal: ImportJournal,
  failure: unknown,
): Promise<never> {
  let survivors: RecordId[]
  try {
    await host.store.remove(journal.staged)
    survivors = (await host.store.fetch(journal.staged)).map(record => record.id)
  } catch (error) {
    throw new RetrievalError('outcome_pending', `${String(failure)}; the staged import batch could not be removed, so the journal at ${path} is kept for retry`, false, { cause: String(error), ids: journal.staged })
  }
  if (survivors.length > 0) {
    throw new RetrievalError('outcome_pending', `${String(failure)}; ${String(survivors.length)} staged records remain in the store, so the journal at ${path} is kept for retry`, false, { ids: survivors })
  }
  await writePortabilityJson(path, { ...journal, staged: [] })
  host.invalidateRecovery()
  throw failure
}
