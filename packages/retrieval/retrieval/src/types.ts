/**
 * Pure types of the retrieval domain: record shapes, query and identity contracts, backend
 * request and result values, and health reporting. No runtime code and no host-side value
 * imports live here, so both the engine and every backend provider share one declaration home.
 * @module @deepseek-ai/dsh-retrieval/types
 */

import type { OwnerKey, WorkspaceKey, SessionKey, AgentKey, RecordId, SpaceKey } from './ids.ts'
export type { OwnerKey, WorkspaceKey, SessionKey, AgentKey, RecordId, SpaceKey } from './ids.ts'

/** Authority that owns a record and decides who may read it. */
export type RecordScope = 'user' | 'workspace' | 'session' | 'agent'

/** Stored payload class: indexed workspace or session text, or an explicit memory. */
export type RecordKind = 'chunk' | 'memory'

/** How a query wants candidates produced. */
export type QueryMode = 'keyword' | 'semantic' | 'hybrid'

/** Which producer put a candidate in the result set. */
export type CandidateOrigin = 'keyword' | 'vector' | 'accelerator' | 'hybrid'

/** Origin of one memory, kept for attribution and for judging trust. */
export interface MemoryAttribution {
  /** What wrote the memory: a model tool call, a user instruction, or an indexer projection. */
  actor: 'model' | 'user' | 'indexer'
  /** Session id, document path, or tool call id that produced the record. */
  ref: string
}

/** Text extracted from one file range of a workspace or a session transcript. */
export interface ChunkRecord {
  kind: 'chunk'
  /** Stable content-addressed id; unchanged content re-indexed under the same id. */
  id: RecordId
  scope: RecordScope
  /** Local host principal that owns this record. */
  ownerKey: OwnerKey
  workspaceKey: WorkspaceKey
  sessionKey: SessionKey | null
  /** Exact agent owner for agent scope; otherwise `null`. */
  agentKey: AgentKey | null
  /** Absolute path inside an authorized index root, or a session transcript locator. */
  source: string
  startLine: number
  endLine: number
  text: string
  contentHash: string
  updatedAt: number
  /** Indexing attribution: the embedding space this vector was written under. */
  spaceKey: SpaceKey
}

/** One explicit memory entry with lifecycle metadata. */
export interface MemoryRecord {
  kind: 'memory'
  /** Durable supersession intent awaiting lifecycle reconciliation; excluded from retrieval. */
  pending: boolean
  id: RecordId
  scope: RecordScope
  /** Local host principal that owns this record. */
  ownerKey: OwnerKey
  workspaceKey: WorkspaceKey
  sessionKey: SessionKey | null
  /** Exact agent owner for agent scope; otherwise `null`. */
  agentKey: AgentKey | null
  text: string
  tags: string[]
  attribution: MemoryAttribution
  /** Increments on every rewrite; `1` for the first version. */
  version: number
  /** Ids this record replaced when it was written. */
  supersedes: RecordId[]
  /** Id of the newer record that replaced this one, or `null` while current. */
  supersededBy: RecordId | null
  createdAt: number
  updatedAt: number
  /** Wall-clock expiry, or `null` for a record that never expires. */
  expiresAt: number | null
  contentHash: string
  spaceKey: SpaceKey
}

/** Anything the store holds. */
export type StoredRecord = ChunkRecord | MemoryRecord

/** Identity resolved by the host, never by model-supplied arguments. */
export interface TrustedIdentity {
  /** Principal resolved by the trusted host mount, shared only by its authorized local sessions. */
  ownerKey: OwnerKey
  /** Canonical absolute workspace path authorized by the host. */
  workspaceRoot: string
  /** Workspace the caller is executing in; `user` scope records stay readable from any workspace. */
  workspaceKey: WorkspaceKey
  /** Calling session, or `null` for a caller with no session. */
  sessionKey: SessionKey | null
  /** Calling agent, or `null` for the root agent. */
  agentKey: AgentKey | null
  /** Granted by the host when this caller may read records owned by other sessions. */
  allowCrossSession: boolean
  /** Granted by the host when this caller may read `user` scope records. */
  allowUserScope: boolean
}

/** One retrieval request after validation. */
export interface RetrievalQuery {
  mode: QueryMode
  text: string
  topK: number
  /** Restricts which scopes may contribute; scopes outside the caller's authority are dropped. */
  scopes: RecordScope[]
  /** Only paths under one of these roots are considered, when non-empty. */
  pathPrefixes: string[]
  /** Record classes the query wants; `null` or absent admits chunks and memories alike. */
  kinds?: readonly RecordKind[] | null
  /** Drop candidates below this calibrated relevance in `[0, 1]`. */
  minScore: number
  /** Token ceiling for the packed packet; `0` means unlimited within `topK`. */
  budgetTokens: number
  signal?: AbortSignal
}

/** One record with its calibrated relevance. */
export interface Candidate {
  record: StoredRecord
  /** Backend score exactly as returned, before calibration. */
  rawScore: number
  /** Relevance in `[0, 1]` where higher is better, comparable across backends. */
  score: number
  origin: CandidateOrigin
}

/** A packed, deduplicated retrieval result ready for injection or display. */
export interface ContextPacket {
  candidates: Candidate[]
  tokens: number
  /** True when the budget or `topK` dropped at least one candidate. */
  truncated: boolean
  /** Count of candidates dropped as duplicates of an included passage. */
  deduplicated: number
  /** Backend that actually produced this packet, for observability. */
  servedBy: 'zvec' | 'zvec+accelerator'
  elapsedMs: number
  /** Rendered passage block for the included candidates; `''` when none was taken. */
  rendered: string
}

/** Identity of one embedding space. Records from different spaces are never mixed. */
export interface EmbeddingSpace {
  provider: string
  model: string
  dimension: number
  /** True when vectors are L2-normalized, which makes cosine distance comparable. */
  normalized: boolean
  /** Provider deployment or model revision that changes vector meaning; absent for fixed local hashing. */
  revision?: string
}

/** A hit as a backend returns it: id plus raw score. */
export interface BackendHit {
  id: RecordId
  score: number
  /** Optional materialized fields; a backend may omit them when the engine refetches. */
  record?: StoredRecord
}

/** Write result reported by a backend. */
export interface WriteOutcome {
  written: number
  rejected: number
  /** Non-empty when writes were refused because of an embedding-space change. */
  spaceConflict: SpaceKey | null
}

/** Filter-first constraint a backend must apply before scoring any candidate. */
export interface ReadFilter {
  /** Admit only current memories at this timestamp; `null` includes lifecycle history. */
  activeAt: number | null
  /** Reconciliation-only selection of staged memories, independent of expiry. */
  pendingOnly?: boolean
  /** Only these scopes may match. */
  scopes: RecordScope[]
  /** Only these record classes may match; `null` admits both. */
  kinds: readonly RecordKind[] | null
  ownerKey: OwnerKey
  workspaceKey: WorkspaceKey
  agentKey: AgentKey | null
  /** When `null`, both session-owned and workspace-wide records match. */
  sessionKey: SessionKey | null
  /** True when the caller may read another session's records. */
  crossSession: boolean
  /** True when the caller may read `user` scope records. */
  userScope: boolean
  pathPrefixes: string[]
  /** Restricts the candidate set to these record ids, when non-empty. */
  onlyIds: RecordId[] | null
}

/** Authoritative-store counters. */
export interface StoreStats {
  backend: string
  documents: number
  /** Documents pending an index build. */
  pending: number
  indexCompleteness: number
  space: SpaceKey | null
  path: string
}

/** Accelerator-store counters and consistency facts. */
export interface AcceleratorStats {
  backend: string
  available: boolean
  vectors: number
  bitWidth: number
  /** Count of authoritative records missing from the accelerator, or `-1` when unknown. */
  drift: number
  /** Why the accelerator is unavailable or inconsistent, when it is. */
  degradedReason: string | null
}

/** Health view returned by `memory_status` and the diagnostic command surface. */
export interface RetrievalStatus {
  enabled: boolean
  store: StoreStats | null
  accelerator: AcceleratorStats | null
  embedding: { provider: string; model: string; dimension: number } | null
  memories: { active: number; expired: number; superseded: number; pending: number }
  indexedRoots: string[]
  lastError: string | null
}
