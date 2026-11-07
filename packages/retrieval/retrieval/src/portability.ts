import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AgentKey, OwnerKey, RecordId, SessionKey, SpaceKey, WorkspaceKey } from './ids.ts'
import { RetrievalError } from './errors.ts'
import { contentHash } from './records.ts'
import type { MemoryAttribution, MemoryRecord, RecordScope } from './types.ts'

/**
 * Format version written into every export, journal, and ledger this release produces, and the only
 * version `decodeMemoryExport` reads.
 */
export const MEMORY_EXPORT_VERSION = 1

/** An empty ledger, used before the first verified deletion writes one. */
export const EMPTY_FORGET_LEDGER: ForgetLedger = { version: MEMORY_EXPORT_VERSION, entries: [] }

/** One exported memory with its ownership and lifecycle fields preserved verbatim. */
export type ExportedMemory = MemoryRecord

/** A portable memory population exported from one embedding space. */
export interface MemoryExport {
  /** Format version; a reader rejects any version it does not implement. */
  version: number
  /** Milliseconds since the epoch when the export was produced. */
  exportedAt: number
  /** Embedding space the source records were written under. */
  sourceSpace: SpaceKey
  /** Authorized records, newest first. */
  records: ExportedMemory[]
}

/** A memory id that was durably removed from one store. */
export interface ForgottenEntry {
  id: RecordId
  contentHash: string
  forgottenAt: number
}

/** Durable record of forgotten memories, consulted before any import or migration. */
export interface ForgetLedger {
  version: number
  entries: ForgottenEntry[]
}

/**
 * Write-ahead intent for one staged import. A non-empty `staged` list with `published` false means an
 * operation left records in the target store whose verification never completed, so the next import
 * for that store removes those ids before planning again.
 */
export interface ImportJournal {
  version: number
  /** Record ids this operation planned to write, in plan order. */
  staged: RecordId[]
  /** Embedding space the staged vectors belong to. */
  targetSpace: SpaceKey
  startedAt: number
  /** Whether the staged records passed verification and were published. */
  published: boolean
}

/** Why one exported record was not admitted by an import. */
export interface ImportRefusal {
  id: RecordId
  reason: string
}

/** Counters and refusals for one completed import or migration attempt. */
export interface ImportReport {
  accepted: number
  reused: number
  /** Record ids an interrupted earlier journal removed from the target store before this attempt. */
  recovered: number
  refused: ImportRefusal[]
  sourceSpace: SpaceKey
  targetSpace: SpaceKey
}

/**
 * Build an export envelope from already-authorized records.
 * @param records - memory records the caller may read, in the order to export.
 * @param sourceSpace - embedding space key the exported records were written under.
 * @returns the envelope for {@link encodeMemoryExport}.
 */
export function memoryExportOf(records: readonly MemoryRecord[], sourceSpace: SpaceKey): MemoryExport {
  return {
    version: MEMORY_EXPORT_VERSION,
    exportedAt: Date.now(),
    sourceSpace,
    records: records.map(record => ({ ...record, tags: [...record.tags], supersedes: [...record.supersedes] })),
  }
}

/**
 * Serialize one memory with a fixed field order. Import verification compares this text against what
 * the store reads back, so a field the store changed on the way in surfaces as a mismatch.
 * @param record - memory to serialize.
 * @returns JSON text of every stored field.
 */
export function encodeMemoryRecord(record: MemoryRecord): string {
  return JSON.stringify(memoryFields(record))
}

/**
 * Order every stored field of one memory the same way, so serialization is a function of the facts and
 * a newly added record field fails to compile until the portability format accounts for it.
 * @param record - memory to copy.
 * @returns the same record with declaration-order keys and copied arrays.
 */
function memoryFields(record: MemoryRecord): MemoryRecord {
  return {
    id: record.id, kind: record.kind, pending: record.pending, scope: record.scope, ownerKey: record.ownerKey,
    workspaceKey: record.workspaceKey, sessionKey: record.sessionKey, agentKey: record.agentKey, text: record.text,
    tags: [...record.tags], attribution: { actor: record.attribution.actor, ref: record.attribution.ref },
    version: record.version, supersedes: [...record.supersedes], supersededBy: record.supersededBy,
    createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt,
    contentHash: record.contentHash, spaceKey: record.spaceKey,
  }
}

/**
 * Serialize an envelope with a fixed field order, so the same records always serialize identically and
 * a diff between two exports shows only changed values.
 * @param value - envelope to write.
 * @returns JSON text with no trailing newline.
 */
export function encodeMemoryExport(value: MemoryExport): string {
  return JSON.stringify({
    version: value.version,
    exportedAt: value.exportedAt,
    sourceSpace: value.sourceSpace,
    records: value.records.map(memoryFields),
  })
}

/**
 * Parse and validate export text. A version this release does not implement, a malformed identity, an
 * ownership combination the engine never writes, an unfinished supersession intent, or a text that does
 * not hash to its recorded digest is rejected as a whole rather than partially admitted.
 * @param text - JSON produced by {@link encodeMemoryExport}.
 * @param limit - maximum records accepted.
 * @returns the validated envelope.
 * @throws RetrievalError with code `invalid_input` when the export is unusable.
 */
export function decodeMemoryExport(text: string, limit: number): MemoryExport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new RetrievalError('invalid_input', 'memory export is not valid JSON', false, { cause: String(error) })
  }
  const value = asRecord(raw, 'memory export')
  if (value.version !== MEMORY_EXPORT_VERSION) {
    throw new RetrievalError('invalid_input', `memory export version ${String(value.version)} is not supported; this release reads version ${MEMORY_EXPORT_VERSION}`)
  }
  const exportedAt = numberField(value.exportedAt, 'exportedAt')
  const sourceSpace = SpaceKey(stringField(value.sourceSpace, 'sourceSpace'))
  if (!Array.isArray(value.records) || value.records.length > limit) {
    throw new RetrievalError('invalid_input', `memory export must carry an array of at most ${limit} records`)
  }
  const seen = new Set<RecordId>()
  const records = value.records.map((entry) => {
    const record = recordOf(entry)
    if (seen.has(record.id)) throw new RetrievalError('invalid_input', `memory export repeats record id ${record.id}`)
    seen.add(record.id)
    return record
  })
  return { version: MEMORY_EXPORT_VERSION, exportedAt, sourceSpace, records }
}

/**
 * Replace a file atomically so an interrupted write cannot truncate an earlier journal or ledger.
 * @param path - absolute file path.
 * @param text - exact file content to store.
 * @returns after the replacement is durable.
 */
export async function writePortabilityText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, path)
}

/**
 * Replace a portability JSON file atomically.
 * @param path - absolute file path.
 * @param value - serializable value to store.
 * @returns after the replacement is durable.
 */
export async function writePortabilityJson(path: string, value: unknown): Promise<void> {
  await writePortabilityText(path, JSON.stringify(value))
}

/**
 * Read a portability file, treating an absent file as the supplied initial value.
 * @param path - absolute file path.
 * @param initial - value to return when the file does not exist.
 * @returns the stored or initial value.
 * @throws RetrievalError with code `backend_error` when a present file is unreadable.
 */
export async function readPortabilityText(path: string, initial: string | null): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initial
    throw new RetrievalError('backend_error', `portability file ${path} is unreadable`, false, { cause: String(error) })
  }
}

/**
 * Read a portability JSON file, treating an absent file as the supplied initial value.
 * @param path - absolute file path.
 * @param initial - value to return when the file does not exist.
 * @returns the stored or initial value.
 */
export async function readPortabilityJson<T>(path: string, initial: T): Promise<T> {
  const text = await readPortabilityText(path, null)
  if (text === null) return initial
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new RetrievalError('backend_error', `portability file ${path} is not valid JSON`, false, { cause: String(error) })
  }
}

/**
 * Resolve a portability file name inside the configured directory, rejecting any escape from it.
 * @param directory - configured absolute portability directory.
 * @param name - file path below that directory; parent traversal and absolute names are refused.
 * @returns the absolute path.
 * @throws RetrievalError with code `path_escape` when the result leaves the directory.
 */
export function portabilityPath(directory: string, name: string): string {
  const root = resolve(directory)
  const gap = relative(root, resolve(root, name))
  if (gap.length === 0 || gap === '..' || gap.startsWith(`..${sep}`) || isAbsolute(gap)) {
    throw new RetrievalError('path_escape', 'portability file must name a path below the configured directory')
  }
  return resolve(root, name)
}

/**
 * Resolve an operator-named portability file and refuse it after filesystem links are followed.
 * {@link portabilityPath} bounds the name as written; a link inside the configured directory still points
 * outside it, so each existing component below the directory is resolved and re-checked here before an
 * export writes or an import reads. A component the filesystem does not answer for is the operator's own
 * file name, which the write creates inside the already-verified directory.
 * @param directory - configured absolute portability directory, which may not exist yet.
 * @param name - file path below that directory.
 * @returns the absolute lexical path, unchanged when no link leaves the directory.
 * @throws RetrievalError with code `path_escape` when a component resolves outside the directory.
 */
export async function confinedPortabilityPath(directory: string, name: string): Promise<string> {
  const path = portabilityPath(directory, name)
  const root = await realpath(resolve(directory)).catch(() => null)
  if (root === null) return path
  let walk = root
  for (const component of relative(resolve(directory), path).split(sep)) {
    const resolved = await realpath(join(walk, component)).catch(() => null)
    if (resolved === null) return path
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      throw new RetrievalError('path_escape', 'portability file must stay below the configured directory once links are resolved')
    }
    walk = resolved
  }
  return path
}

/**
 * Ledger path below a portability directory.
 * @param directory - configured absolute portability directory.
 * @returns the absolute ledger path.
 */
export function ledgerPathOf(directory: string): string {
  return portabilityPath(directory, 'memory-ledger.json')
}

/**
 * Journal path for one staged import, keyed by the target store so separate indexes keep separate journals.
 * @param directory - configured absolute portability directory.
 * @param storePath - absolute path of the store receiving the staged records.
 * @returns the absolute journal path.
 */
export function journalPathOf(directory: string, storePath: string): string {
  return portabilityPath(directory, `import-journal-${contentHash(resolve(storePath)).slice(0, 16)}.json`)
}

/**
 * Add forgotten records to a ledger, keeping one entry per id and the earliest recorded removal.
 * @param ledger - current ledger contents.
 * @param entries - records whose deletion is being durably recorded.
 * @returns the ledger to persist.
 */
export function ledgerWithForgotten(ledger: ForgetLedger, entries: readonly MemoryRecord[]): ForgetLedger {
  const known = new Map(ledger.entries.map(entry => [entry.id, entry]))
  const forgottenAt = Date.now()
  for (const record of entries) {
    if (!known.has(record.id)) known.set(record.id, { id: record.id, contentHash: record.contentHash, forgottenAt })
  }
  return { version: MEMORY_EXPORT_VERSION, entries: [...known.values()].sort((a, b) => a.forgottenAt - b.forgottenAt) }
}

/**
 * Group ledger entries by id so an import tests one lookup per candidate.
 * @param ledger - current ledger contents.
 * @returns forgotten ids mapped to when they were removed.
 */
export function forgottenIndex(ledger: ForgetLedger): Map<RecordId, ForgottenEntry> {
  return new Map(ledger.entries.map(entry => [entry.id, entry]))
}

function recordOf(entry: unknown): ExportedMemory {
  const value = asRecord(entry, 'exported memory')
  if (value.kind !== 'memory') throw new RetrievalError('invalid_input', 'memory exports carry only memory records')
  const scope = value.scope as RecordScope
  if (!(['user', 'workspace', 'session', 'agent'] as readonly string[]).includes(scope)) {
    throw new RetrievalError('invalid_input', `exported memory has unknown scope ${String(value.scope)}`)
  }
  const sessionKey = value.sessionKey === null ? null : SessionKey(stringField(value.sessionKey, 'sessionKey'))
  const agentKey = value.agentKey === null ? null : AgentKey(stringField(value.agentKey, 'agentKey'))
  const record: MemoryRecord = {
    kind: 'memory',
    id: RecordId(stringField(value.id, 'id')),
    pending: pendingField(value.pending),
    scope,
    ownerKey: OwnerKey(stringField(value.ownerKey, 'ownerKey')),
    workspaceKey: WorkspaceKey(stringField(value.workspaceKey, 'workspaceKey')),
    sessionKey,
    agentKey,
    text: stringField(value.text, 'text'),
    tags: stringArray(value.tags, 'tags'),
    attribution: attributionOf(value.attribution),
    version: numberField(value.version, 'version'),
    supersedes: stringArray(value.supersedes, 'supersedes').map(id => RecordId(id)),
    supersededBy: value.supersededBy === null ? null : RecordId(stringField(value.supersededBy, 'supersededBy')),
    createdAt: numberField(value.createdAt, 'createdAt'),
    updatedAt: numberField(value.updatedAt, 'updatedAt'),
    expiresAt: value.expiresAt === null ? null : numberField(value.expiresAt, 'expiresAt'),
    contentHash: stringField(value.contentHash, 'contentHash'),
    spaceKey: SpaceKey(stringField(value.spaceKey, 'spaceKey')),
  }
  assertOwnershipShape(record)
  if (contentHash(record.text) !== record.contentHash) {
    throw new RetrievalError('invalid_input', `exported memory ${record.id} does not match its recorded content digest`)
  }
  return record
}

/** Reject an ownership combination the engine never writes, so a forged envelope cannot smuggle scope. */
function assertOwnershipShape(record: MemoryRecord): void {
  if ((record.scope === 'workspace' || record.scope === 'user') && (record.sessionKey !== null || record.agentKey !== null)) {
    throw new RetrievalError('invalid_input', `exported memory ${record.id} names a session or agent owner for ${record.scope} scope`)
  }
  if (record.scope === 'session' && (record.sessionKey === null || record.agentKey !== null)) {
    throw new RetrievalError('invalid_input', `exported memory ${record.id} has malformed session ownership`)
  }
  if (record.scope === 'agent' && (record.sessionKey === null || record.agentKey === null)) {
    throw new RetrievalError('invalid_input', `exported memory ${record.id} has malformed agent ownership`)
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new RetrievalError('invalid_input', `exported memory ${record.id} has a version below 1`)
  }
}

function attributionOf(value: unknown): MemoryAttribution {
  const attribution = asRecord(value, 'attribution')
  if (attribution.actor !== 'model' && attribution.actor !== 'user' && attribution.actor !== 'indexer') {
    throw new RetrievalError('invalid_input', `exported attribution actor ${String(attribution.actor)} is unknown`)
  }
  return { actor: attribution.actor, ref: stringField(attribution.ref, 'attribution.ref') }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RetrievalError('invalid_input', `${name} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new RetrievalError('invalid_input', `${name} must be a non-empty string`)
  return value
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RetrievalError('invalid_input', `${name} must be a finite number`)
  return value
}

/** A pending row is an unfinished supersession intent that only its own store can resolve, so it cannot travel. */
function pendingField(value: unknown): false {
  if (value !== false) throw new RetrievalError('invalid_input', 'a memory export carries committed records, never a pending supersession intent')
  return false
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new RetrievalError('invalid_input', `${name} must be an array of strings`)
  }
  return value.map(entry => String(entry))
}
