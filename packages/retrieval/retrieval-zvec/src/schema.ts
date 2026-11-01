/**
 * Zvec collection layout, the record-to-document conversion, and the filter expression that carries
 * caller authority into the store. The filter grammar is SQL-like and has no string-escape mechanism,
 * so identity literals use a fixed character class and source restrictions use UTF-8 hexadecimal
 * strings. Raw paths and model text never become filter syntax.
 * @module @deepseek-ai/dsh-retrieval-zvec/schema
 */

import { sep } from 'node:path'
import {
  RetrievalError,
  OwnerKey,
  WorkspaceKey,
  SessionKey,
  AgentKey,
  RecordId,
  SpaceKey,
  type ChunkRecord,
  type MemoryRecord,
  type ReadFilter,
  type RecordScope,
  type StoredRecord,
} from '@deepseek-ai/dsh-retrieval'
import type {
  ZVecDataType,
  ZVecDoc,
  ZVecFieldSchema,
  ZVecFtsIndexParams,
  ZVecHnswIndexParams,
  ZVecInvertIndexParams,
} from '@zvec/zvec'

/** Scalar column names of the retrieval collection. */
export const F = {
  kind: 'kind',
  pending: 'pending',
  scope: 'scope',
  ownerKey: 'ownerKey',
  agentKey: 'agentKey',
  workspaceKey: 'wsKey',
  sessionKey: 'sessKey',
  /** Copy of the primary key as an ordinary indexed column; the primary key itself is not filterable. */
  idKey: 'idKey',
  text: 'text',
  source: 'source',
  sourceKey: 'sourceKey',
  startLine: 'startLine',
  endLine: 'endLine',
  contentHash: 'contentHash',
  spaceKey: 'spaceKey',
  updatedAt: 'updatedAt',
  createdAt: 'createdAt',
  expiresAt: 'expiresAt',
  version: 'version',
  supersedes: 'supersedes',
  supersededBy: 'supersededBy',
  tags: 'tags',
  attributionActor: 'attrActor',
  attributionRef: 'attrRef',
} as const

/** Dense embedding column; the only vector field the collection carries. */
export const VECTOR_FIELD = 'dense'

/** Scalar columns requested by every read; vectors stay out of result payloads. */
export const OUTPUT_FIELDS: readonly string[] = Object.values(F)

/** Storage tag for a record that no session owns. */
const NO_SESSION = 'none'

/** Stored value meaning "no superseding record", because a nullable column cannot hold `null`. */
const NO_REFERENCE = ''

/** Stored value meaning "never expires", small enough to fail every real expiry comparison. */
const NO_EXPIRY = 0

/**
 * An expression no document can satisfy. A filter that restricts nothing is not the same as no
 * filter, so an empty scope set or id set has to be expressed as a contradiction.
 */
const MATCHES_NOTHING = `${F.kind} = 'chunk' AND ${F.kind} = 'memory'`

/** Column declarations one Zvec collection is created from. */
export interface CollectionLayout {
  readonly fields: ZVecFieldSchema[]
  readonly vectors: {
    readonly name: string
    readonly dataType: ZVecDataType
    readonly dimension: number
    readonly indexParams: ZVecHnswIndexParams
  }[]
}

/**
 * Declare the scalar, full-text, and dense columns of a retrieval collection.
 * @param dimension - dense-vector width, fixed when the collection is created.
 * @param fts - full-text index parameters for the text column.
 * @param hnsw - index parameters for the dense column.
 * @param native - loaded SDK providing its documented field and index enums.
 * @returns scalar and vector column declarations of one retrieval collection.
 */
export function collectionLayout(
  dimension: number,
  fts: ZVecFtsIndexParams,
  hnsw: ZVecHnswIndexParams,
  native: typeof import('@zvec/zvec'),
): CollectionLayout {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new RetrievalError('invalid_input', `vector dimension must be positive, got ${dimension}`)
  }
  const invert: ZVecInvertIndexParams = { indexType: native.ZVecIndexType.INVERT }
  return {
    fields: [
      { name: F.kind, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.pending, dataType: native.ZVecDataType.BOOL, indexParams: invert },
      { name: F.scope, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.ownerKey, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.agentKey, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.workspaceKey, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.sessionKey, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.idKey, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.spaceKey, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.contentHash, dataType: native.ZVecDataType.STRING },
      { name: F.source, dataType: native.ZVecDataType.STRING },
      { name: F.sourceKey, dataType: native.ZVecDataType.STRING, indexParams: invert },
      { name: F.supersededBy, dataType: native.ZVecDataType.STRING },
      { name: F.attributionActor, dataType: native.ZVecDataType.STRING },
      { name: F.attributionRef, dataType: native.ZVecDataType.STRING },
      { name: F.tags, dataType: native.ZVecDataType.ARRAY_STRING },
      { name: F.supersedes, dataType: native.ZVecDataType.ARRAY_STRING },
      { name: F.startLine, dataType: native.ZVecDataType.INT32 },
      { name: F.endLine, dataType: native.ZVecDataType.INT32 },
      { name: F.version, dataType: native.ZVecDataType.INT32 },
      { name: F.createdAt, dataType: native.ZVecDataType.INT64 },
      { name: F.updatedAt, dataType: native.ZVecDataType.INT64 },
      { name: F.expiresAt, dataType: native.ZVecDataType.INT64 },
      { name: F.text, dataType: native.ZVecDataType.STRING, indexParams: fts },
    ],
    vectors: [{ name: VECTOR_FIELD, dataType: native.ZVecDataType.VECTOR_FP32, dimension, indexParams: hnsw }],
  }
}

/**
 * Values a filter equality may interpolate: scope tags, digested identity tokens, record ids, and
 * embedding-space keys. Anything else fails loudly.
 * @param value - candidate literal.
 * @param what - what the value names, for the failure message.
 * @returns the same value, checked.
 */
export function safeLiteral(value: string, what: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new RetrievalError('invalid_input', `${what} cannot be used in a store filter`)
  }
  return value
}

/** One equality predicate. */
function eq(field: string, value: string): string {
  return `${field} = '${safeLiteral(value, field)}'`
}

/**
 * One closed-set predicate over a single field. Zvec's grammar takes `IN (…)` with parentheses;
 * `IN […]` is rejected.
 * @param field - column name.
 * @param values - permitted values; deduplicated.
 * @returns the predicate.
 */
function anyOf(field: string, values: readonly string[]): string {
  const unique = [...new Set(values)]
  if (unique.length === 0) throw new RetrievalError('invalid_input', `${field} filter has no values`)
  if (unique.length === 1) return eq(field, unique[0] ?? '')
  return `${field} IN (${unique.map(value => `'${safeLiteral(value, field)}'`).join(',')})`
}

/**
 * Build the pre-scoring expression that carries a caller's authority into the store. Scope, workspace,
 * embedding space, and session predicates are conjunctive, so an unauthorized document never becomes a
 * candidate. A `crossSession` caller drops the session predicate entirely.
 * @param filter - resolved authorization constraints.
 * @param spaceKey - the store's current embedding space; records from another space are never read.
 * @param maxIds - ceiling on the explicit-id restriction, so one expression stays bounded.
 * @returns the boolean expression, contradicting everything when the filter can match nothing.
 */
export function buildFilterExpression(filter: ReadFilter, spaceKey: string, maxIds: number): string {
  if (filter.scopes.length === 0) return MATCHES_NOTHING
  if (filter.onlyIds !== null && filter.onlyIds.length === 0) return MATCHES_NOTHING
  const permitted = filter.scopes.filter(scope => scope !== 'user' || filter.userScope)
  const authorities = permitted.map((scope) => {
    const scopeParts = [eq(F.scope, scope)]
    if (scope !== 'user') scopeParts.push(eq(F.workspaceKey, filter.workspaceKey))
    if (scope === 'agent') {
      if (filter.agentKey === null || filter.sessionKey === null) return MATCHES_NOTHING
      scopeParts.push(eq(F.agentKey, filter.agentKey), eq(F.sessionKey, filter.sessionKey))
    } else if (scope === 'session' && !filter.crossSession) {
      if (filter.sessionKey === null) return MATCHES_NOTHING
      scopeParts.push(eq(F.sessionKey, filter.sessionKey))
    }
    return `(${scopeParts.join(' AND ')})`
  })
  if (authorities.length === 0) return MATCHES_NOTHING
  const parts = [
    anyOf(F.kind, filter.kinds ?? ['chunk', 'memory']),
    eq(F.ownerKey, filter.ownerKey),
    `(${authorities.join(' OR ')})`,
    eq(F.spaceKey, spaceKey),
  ]
  if (filter.onlyIds !== null) {
    if (filter.onlyIds.length > maxIds) {
      throw new RetrievalError('invalid_input', `id filter of ${filter.onlyIds.length} exceeds ${maxIds}`)
    }
    parts.push(anyOf(F.idKey, filter.onlyIds))
  }
  if (filter.pathPrefixes.length > 0) {
    const paths = filter.pathPrefixes.map((path) => {
      const normalized = normalizePath(path).replace(/\/$/, '')
      const encoded = Buffer.from(normalized, 'utf8').toString('hex')
      return `(${F.sourceKey} = '${encoded}' OR ${F.sourceKey} LIKE '${encoded}2f%')`
    })
    parts.push(`${F.kind} = 'chunk'`, `(${paths.join(' OR ')})`)
  }
  if (filter.pendingOnly === true) {
    parts.push(`${F.kind} = 'memory'`, `${F.pending} = TRUE`)
  } else if (filter.activeAt !== null) {
    if (!Number.isFinite(filter.activeAt) || filter.activeAt < 0) throw new RetrievalError('invalid_input', 'invalid memory visibility time')
    parts.push(`(${F.kind} != 'memory' OR (${F.pending} = FALSE AND ${F.supersededBy} = '' AND (${F.expiresAt} = 0 OR ${F.expiresAt} > ${Math.floor(filter.activeAt)})))`)
  }
  return parts.join(' AND ')
}

/** Primary key plus scalar columns of one record, ready to pair with a vector or send as a field-only update. */
export interface RecordDocument {
  readonly id: RecordId
  readonly fields: Record<string, unknown>
}

/**
 * Turn one stored record into its columns and primary key. `INT64` columns take JavaScript numbers:
 * the Node binding rejects `bigint`, and millisecond timestamps stay below `2^53`.
 * @param record - the record.
 * @returns the document columns, without its vector.
 */
export function recordToDocument(record: StoredRecord): RecordDocument {
  const shared: Record<string, unknown> = {
    [F.kind]: record.kind,
    [F.pending]: record.kind === 'memory' ? record.pending : false,
    [F.scope]: record.scope,
    [F.ownerKey]: record.ownerKey,
    [F.agentKey]: record.agentKey ?? NO_SESSION,
    [F.workspaceKey]: record.workspaceKey,
    [F.sessionKey]: record.sessionKey ?? NO_SESSION,
    [F.idKey]: record.id,
    [F.text]: record.text,
    [F.contentHash]: record.contentHash,
    [F.spaceKey]: record.spaceKey,
    [F.updatedAt]: record.updatedAt,
  }
  const lifecycle: Record<string, unknown> = record.kind === 'memory'
    ? {
      [F.createdAt]: record.createdAt,
      [F.version]: record.version,
      [F.supersedes]: record.supersedes,
      [F.supersededBy]: record.supersededBy ?? NO_REFERENCE,
      [F.tags]: record.tags,
      [F.attributionActor]: record.attribution.actor,
      [F.attributionRef]: record.attribution.ref,
      [F.expiresAt]: record.expiresAt ?? NO_EXPIRY,
      [F.source]: `${record.scope}:${record.id}`,
      [F.sourceKey]: '',
      [F.startLine]: 0,
      [F.endLine]: 0,
    }
    : {
      [F.createdAt]: record.updatedAt,
      [F.version]: 0,
      [F.supersedes]: [],
      [F.supersededBy]: NO_REFERENCE,
      [F.tags]: [],
      [F.attributionActor]: 'indexer',
      [F.attributionRef]: record.source,
      [F.expiresAt]: NO_EXPIRY,
      [F.source]: record.source,
      [F.sourceKey]: Buffer.from(normalizePath(record.source), 'utf8').toString('hex'),
      [F.startLine]: record.startLine,
      [F.endLine]: record.endLine,
    }
  return { id: record.id, fields: { ...shared, ...lifecycle } }
}

/**
 * Rebuild a domain record from one stored document.
 * @param doc - a document carrying every {@link OUTPUT_FIELDS} column.
 * @returns the chunk or memory record.
 */
export function documentToRecord(doc: ZVecDoc): StoredRecord {
  const fields = doc.fields
  const kind = String(fields[F.kind] ?? '')
  const base = {
    id: RecordId(doc.id),
    scope: readScope(String(fields[F.scope] ?? '')),
    ownerKey: OwnerKey(String(fields[F.ownerKey] ?? '')),
    agentKey: readAgentKey(fields[F.agentKey]),
    workspaceKey: WorkspaceKey(String(fields[F.workspaceKey] ?? '')),
    sessionKey: readSessionKey(fields[F.sessionKey]),
    text: String(fields[F.text] ?? ''),
    contentHash: String(fields[F.contentHash] ?? ''),
    updatedAt: numberOf(fields[F.updatedAt]),
    spaceKey: SpaceKey(String(fields[F.spaceKey] ?? '')),
  }
  if (kind === 'chunk') {
    const record: ChunkRecord = {
      kind: 'chunk',
      ...base,
      source: String(fields[F.source] ?? ''),
      startLine: numberOf(fields[F.startLine]),
      endLine: numberOf(fields[F.endLine]),
    }
    return record
  }
  if (kind !== 'memory') throw new RetrievalError('backend_error', `stored record ${base.id} has unknown kind ${kind}`)
  const actor = String(fields[F.attributionActor] ?? 'model')
  const expiresAt = numberOf(fields[F.expiresAt])
  const supersededBy = String(fields[F.supersededBy] ?? '')
  const pending: unknown = fields[F.pending]
  if (typeof pending !== 'boolean') throw new RetrievalError('backend_error', 'memory commit state is missing or corrupt; rebuild or restore the index')
  const record: MemoryRecord = {
    pending,
    kind: 'memory',
    ...base,
    tags: stringList(fields[F.tags]),
    attribution: {
      actor: actor === 'user' || actor === 'indexer' ? actor : 'model',
      ref: String(fields[F.attributionRef] ?? ''),
    },
    version: numberOf(fields[F.version]),
    supersedes: stringList(fields[F.supersedes]).map(id => RecordId(id)),
    supersededBy: supersededBy === NO_REFERENCE ? null : RecordId(supersededBy),
    createdAt: numberOf(fields[F.createdAt]),
    expiresAt: expiresAt === NO_EXPIRY ? null : expiresAt,
  }
  return record
}

/**
 * Match stored sources against complete authorized directory prefixes.
 * @param source - a stored path.
 * @param prefixes - absolute roots, matched on whole directory boundaries so `/repo/src` cannot pull
 * in `/repo/srcdb`.
 * @returns whether `source` is one of the roots or lies beneath one.
 */
export function underPrefix(source: string, prefixes: readonly string[]): boolean {
  const normalized = normalizePath(source)
  return prefixes.some((raw) => {
    const path = normalizePath(raw)
    const prefix = path.endsWith('/') ? path.slice(0, -1) : path
    return normalized === prefix || normalized.startsWith(`${prefix}/`)
  })
}

/**
 * Narrow already-scored hits to records whose source lies under one of the requested roots. A memory
 * belongs to a workspace or a session rather than a file, so any path restriction excludes it.
 * @param record - the candidate's record.
 * @param prefixes - absolute roots, empty meaning no restriction.
 * @returns whether the record survives the restriction.
 */
export function matchesPathPrefix(record: StoredRecord, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true
  return record.kind === 'chunk' && underPrefix(record.source, prefixes)
}

/**
 * @param value - a stored scope tag.
 * @returns the scope, or a failure when the column holds a tag this build never writes.
 */
function readScope(value: string): RecordScope {
  if (value === 'user' || value === 'workspace' || value === 'session' || value === 'agent') return value
  throw new RetrievalError('backend_error', `stored record carries unknown scope ${value}`)
}

/**
 * @param value - a raw session column value.
 * @returns the owning session key, or `null` for a record no session owns.
 */
function readSessionKey(value: unknown): SessionKey | null {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new RetrievalError('backend_error', 'invalid stored session or agent id')
  const text = value ?? NO_SESSION
  return text === NO_SESSION || text === '' ? null : SessionKey(text)
}

/** Decode an optional agent owner separately from a session identity. */
function readAgentKey(value: unknown): AgentKey | null {
  const key = readSessionKey(value)
  return key === null ? null : AgentKey(key)
}

/**
 * @param value - a raw array column.
 * @returns its entries as strings.
 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(entry => String(entry)) : []
}

/**
 * @param value - a raw numeric column.
 * @returns the same value as a JavaScript number.
 */
function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/** Convert Windows separators without changing valid POSIX filename characters. */
function normalizePath(path: string): string {
  return sep === '\\' ? path.replace(/\\/g, '/') : path
}
