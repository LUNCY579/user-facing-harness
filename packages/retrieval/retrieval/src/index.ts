/**
 * Plugin entry for the retrieval seam. Mounting `@deepseek-ai/dsh-retrieval` provides `ctx.retrieval`,
 * the consumer-facing search and memory surface; backends and embedding providers mount beside it.
 * @module @deepseek-ai/dsh-retrieval
 */

export { OwnerKey, WorkspaceKey, SessionKey, AgentKey, RecordId, SpaceKey } from './ids.ts'
export { Embeddings, Accelerator, VectorStore } from './contract.ts'
export {
  RetrievalService,
  Config,
} from './engine.ts'
export type { Config as RetrievalConfig, RememberInput, MemoryPatch, ForgetSelector, MemoryCounts } from './engine.ts'
export { IndexingService } from './indexing.ts'
export type { Config as IndexingConfig, IndexState, SourceState, SyncReport } from './indexing.ts'
export { RetrievalError, isRetrievalError, classifyFailure, throwIfAborted } from './errors.ts'
export type { RetrievalErrorCode } from './errors.ts'
export {
  assertValidVector,
  chunkIdOf,
  chunkText,
  contentHash,
  estimateTokens,
  newMemoryId,
  normalizeVector,
  sourceKeyOf,
  spaceKeyOf,
  tokenize,
  tokenOf,
} from './records.ts'
export type { ChunkPolicy } from './records.ts'
export {
  calibrate,
  dedupeCandidates,
  mergeCandidates,
  pack,
  PASSAGE_INTRO,
  renderInjection,
  renderPassage,
  scaleFor,
  toCandidates,
} from './fusion.ts'
export type { ScoreScale } from './fusion.ts'
export type * from './types.ts'

import { RetrievalService } from './engine.ts'

export default RetrievalService
