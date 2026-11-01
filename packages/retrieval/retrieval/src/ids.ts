/** Nominal retrieval identifiers and parser admission for stored and model-supplied keys. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { RetrievalError } from './errors.ts'

/** Principal that owns retrieval records in this local host installation. */
export type OwnerKey = Branded<'RetrievalOwnerKey'>
/** Canonical workspace identity in the retrieval store. */
export type WorkspaceKey = Branded<'RetrievalWorkspaceKey'>
/** Session identity in the retrieval store. */
export type SessionKey = Branded<'RetrievalSessionKey'>
/** Agent identity in the retrieval store. */
export type AgentKey = Branded<'RetrievalAgentKey'>
/** Stable primary key of one memory or indexed passage. */
export type RecordId = Branded<'RetrievalRecordId'>
/** Identity of a compatible embedding space. */
export type SpaceKey = Branded<'RetrievalSpaceKey'>

/**
 * Admit a principal key read from trusted host configuration or durable metadata.
 * @param value - printable store-safe identifier.
 * @returns the validated principal key.
 */
export function OwnerKey(value: string): OwnerKey { return brandString<OwnerKey>(admit(value)) }
/**
 * Admit a workspace key read from durable metadata.
 * @param value - printable store-safe identifier.
 * @returns the validated workspace key.
 */
export function WorkspaceKey(value: string): WorkspaceKey { return brandString<WorkspaceKey>(admit(value)) }
/**
 * Admit a session key read from durable metadata.
 * @param value - printable store-safe identifier.
 * @returns the validated session key.
 */
export function SessionKey(value: string): SessionKey { return brandString<SessionKey>(admit(value)) }
/**
 * Admit an agent key read from durable metadata.
 * @param value - printable store-safe identifier.
 * @returns the validated agent key.
 */
export function AgentKey(value: string): AgentKey { return brandString<AgentKey>(admit(value)) }
/**
 * Admit a record id supplied by a tool parser or persistent store.
 * @param value - printable store-safe identifier.
 * @returns the validated record id.
 */
export function RecordId(value: string): RecordId { return brandString<RecordId>(admit(value)) }
/**
 * Admit an embedding-space key read from durable metadata.
 * @param value - printable store-safe identifier.
 * @returns the validated embedding-space key.
 */
export function SpaceKey(value: string): SpaceKey { return brandString<SpaceKey>(admit(value)) }

/** Reject literals the native store cannot safely represent in filters. */
function admit(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new RetrievalError('invalid_input', 'retrieval identifier contains unsupported characters or exceeds 128 characters')
  return value
}
