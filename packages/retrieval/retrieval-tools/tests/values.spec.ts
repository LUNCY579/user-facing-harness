/** Pure projections and model-facing renderings of retrieval tool outputs. */
import { AgentKey, OwnerKey, RecordId, SessionKey, SpaceKey, WorkspaceKey, type ChunkRecord, type MemoryRecord, type RetrievalStatus } from '@deepseek-ai/dsh-retrieval'
import { describe, expect, it } from 'vitest'
import {
  renderForget,
  renderMemories,
  renderMemory,
  renderSearch,
  renderStatus,
  toFinding,
  toMemoryValue,
  toStatusValue,
  type Finding,
  type MemoryValue,
  type StatusValue,
} from '../src/values.ts'

const chunk: ChunkRecord = {
  kind: 'chunk',
  id: RecordId('chunk-1'),
  scope: 'workspace',
  ownerKey: OwnerKey('owner-a'),
  workspaceKey: WorkspaceKey('workspace-a'),
  sessionKey: null,
  agentKey: null,
  source: '/tmp/alpha/src/core.ts',
  startLine: 3,
  endLine: 6,
  text: 'const ledger = openLedger(input)',
  contentHash: 'aa',
  updatedAt: 1700000000000,
  spaceKey: SpaceKey('space-a'),
}

const memory: MemoryRecord = {
  kind: 'memory',
  pending: false,
  id: RecordId('mem-1'),
  scope: 'session',
  ownerKey: OwnerKey('owner-a'),
  workspaceKey: WorkspaceKey('workspace-a'),
  sessionKey: SessionKey('session-a'),
  agentKey: AgentKey('agent-a'),
  text: 'Refund ledger rejects negative balances.',
  tags: ['refunds'],
  attribution: { actor: 'model', ref: 'call-1' },
  version: 2,
  supersedes: [RecordId('mem-0')],
  supersededBy: null,
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  expiresAt: null,
  contentHash: 'bb',
  spaceKey: SpaceKey('space-a'),
}

function memoryValue(overrides: Partial<MemoryValue> = {}): MemoryValue {
  return {
    id: 'mem-1',
    text: 'Refund ledger rejects negative balances.',
    scope: 'workspace',
    tags: [],
    version: 1,
    expires_at: null,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    supersedes: [],
    ...overrides,
  }
}

function statusValue(overrides: Partial<StatusValue> = {}): StatusValue {
  return {
    enabled: true,
    store_documents: 4,
    store_backend: 'zvec',
    index_completeness: 1,
    space: 'local-hashed/dsh-hashed-v1/64',
    index_path: '/tmp/alpha/index',
    accelerator_available: false,
    accelerator_vectors: 0,
    accelerator_bit_width: 0,
    accelerator_drift: -1,
    accelerator_reason: null,
    embedding_model: 'dsh-hashed-v1',
    embedding_dimension: 64,
    memories_active: 2,
    memories_expired: 0,
    memories_superseded: 1,
    memories_pending: 0,
    indexed_roots: ['/tmp/alpha'],
    last_error: null,
    ...overrides,
  }
}

function engineStatus(overrides: Partial<RetrievalStatus> = {}): RetrievalStatus {
  return {
    enabled: true,
    store: { backend: 'zvec', documents: 7, pending: 1, indexCompleteness: 0.5, space: SpaceKey('space-a'), path: '/tmp/alpha/index' },
    accelerator: { backend: 'turbovec', available: true, vectors: 6, bitWidth: 4, drift: 1, degradedReason: null },
    embedding: { provider: 'local-hashed', model: 'dsh-hashed-v1', dimension: 64 },
    memories: { active: 3, expired: 1, superseded: 2, pending: 0 },
    indexedRoots: ['/tmp/alpha'],
    lastError: 'the backend failed',
    ...overrides,
  }
}

/** @param value - rendered block array. @returns its single text block. */
function rendered(value: { type: string; text?: string }[]): string {
  const [block] = value
  if (block === undefined || block.text === undefined) throw new Error('the renderer produced no text block')
  return block.text
}

describe('toFinding', () => {
  it('projects a chunk with its file range and no tags', () => {
    const finding: Finding = toFinding(chunk, 0.987654, 'vector')
    expect(finding).toEqual({
      id: 'chunk-1',
      kind: 'chunk',
      source: '/tmp/alpha/src/core.ts',
      start_line: 3,
      end_line: 6,
      text: 'const ledger = openLedger(input)',
      score: 0.9877,
      origin: 'vector',
      scope: 'workspace',
      tags: [],
      updated_at: 1700000000000,
    })
  })

  it('projects a memory with zero line range and its tags', () => {
    const finding = toFinding(memory, 0.5, 'hybrid')
    expect(finding.kind).toBe('memory')
    expect(finding.source).toBe('memory')
    expect(finding.start_line).toBe(0)
    expect(finding.end_line).toBe(0)
    expect(finding.tags).toEqual(['refunds'])
  })
})

describe('toMemoryValue', () => {
  it('renames the lifecycle fields the model acts on', () => {
    expect(toMemoryValue(memory)).toEqual({
      id: 'mem-1',
      text: 'Refund ledger rejects negative balances.',
      scope: 'session',
      tags: ['refunds'],
      version: 2,
      expires_at: null,
      created_at: 1700000000000,
      updated_at: 1700000100000,
      supersedes: ['mem-0'],
    })
  })
})

describe('toStatusValue', () => {
  it('projects every populated backend section', () => {
    expect(toStatusValue(engineStatus(), ['/tmp/alpha'])).toEqual({
      enabled: true,
      store_documents: 7,
      store_backend: 'zvec',
      index_completeness: 0.5,
      space: 'space-a',
      index_path: '/tmp/alpha/index',
      accelerator_available: true,
      accelerator_vectors: 6,
      accelerator_bit_width: 4,
      accelerator_drift: 1,
      accelerator_reason: null,
      embedding_model: 'dsh-hashed-v1',
      embedding_dimension: 64,
      memories_active: 3,
      memories_expired: 1,
      memories_superseded: 2,
      memories_pending: 0,
      indexed_roots: ['/tmp/alpha'],
      last_error: 'the backend failed',
    })
  })

  it('reports zeros and absent sections when no backend answered', () => {
    const value = toStatusValue(engineStatus({
      store: null, accelerator: null, embedding: null, lastError: null,
    }), [])
    expect(value).toMatchObject({
      store_documents: 0,
      store_backend: 'none',
      index_completeness: 0,
      space: null,
      index_path: '',
      accelerator_available: false,
      accelerator_vectors: 0,
      accelerator_bit_width: 0,
      accelerator_drift: -1,
      accelerator_reason: null,
      embedding_model: null,
      embedding_dimension: 0,
      indexed_roots: [],
      last_error: null,
    })
  })

  it('keeps a store without a space and an accelerator that reports a reason', () => {
    const value = toStatusValue(engineStatus({
      store: { backend: 'zvec', documents: 1, pending: 0, indexCompleteness: 1, space: null, path: '/tmp/alpha/index' },
      accelerator: { backend: 'turbovec', available: false, vectors: 0, bitWidth: 0, drift: -1, degradedReason: 'worker crashed' },
    }), ['/tmp/alpha'])
    expect(value.space).toBeNull()
    expect(value.accelerator_reason).toBe('worker crashed')
  })
})

describe('renderSearch', () => {
  it('returns the framed passages unchanged', () => {
    const blocks = renderSearch({}, {
      findings: [], rendered: 'passage text', tokens: 12, truncated: false, deduplicated: 0, served_by: 'zvec', elapsed_ms: 3,
    })
    expect(rendered(blocks)).toBe('passage text')
  })
})

describe('renderMemory', () => {
  it('confirms a memory that never expires', () => {
    expect(rendered(renderMemory({}, { memory: memoryValue() })))
      .toBe('Stored memory mem-1 (v1, workspace)\nRefund ledger rejects negative balances.')
  })

  it('states the expiry instant when one is set', () => {
    expect(rendered(renderMemory({}, { memory: memoryValue({ expires_at: 1800000000000 }) })))
      .toContain(`expires at ${new Date(1800000000000).toISOString()}`)
  })
})

describe('renderMemories', () => {
  it('reports an empty list as a complete notice', () => {
    expect(rendered(renderMemories({}, { memories: [], truncated: false })))
      .toBe('No memories are visible to this caller.')
  })

  it('lists tags, expiry, and the truncation note', () => {
    const text = rendered(renderMemories({}, {
      memories: [memoryValue({ tags: ['refunds'], expires_at: 1800000000000 }), memoryValue({ id: 'mem-2', tags: [], expires_at: null })],
      truncated: true,
    }))
    expect(text).toContain('- mem-1 v1 [workspace] #refunds expires')
    expect(text).toContain('- mem-2 v1 [workspace]\n')
    expect(text).toContain('(more memories exist than were listed)')
  })

  it('omits the truncation note when the whole population is listed', () => {
    expect(rendered(renderMemories({}, { memories: [memoryValue()], truncated: false })))
      .not.toContain('more memories exist')
  })
})

describe('renderForget', () => {
  it('says nothing matched when no id was deleted', () => {
    expect(rendered(renderForget({}, { forgotten: [], count: 0 })))
      .toBe('Nothing matched the forget request; no records were deleted.')
  })

  it('confirms each deleted id after the re-read', () => {
    expect(rendered(renderForget({}, { forgotten: ['mem-1', 'mem-2'], count: 2 })))
      .toBe('Deleted 2 memories and re-read the store to confirm:\nmem-1\nmem-2')
  })
})

describe('renderStatus', () => {
  it('names enabled sections and the accelerator counters', () => {
    const text = rendered(renderStatus({}, statusValue({
      accelerator_available: true, accelerator_vectors: 6, accelerator_bit_width: 4, accelerator_drift: 1,
    })))
    expect(text).toContain('retrieval enabled')
    expect(text).toContain('store: zvec, 4 documents, completeness 1.00')
    expect(text).toContain('accelerator: 6 vectors at 4 bits, drift 1')
    expect(text).toContain('indexed roots: /tmp/alpha')
    expect(text).toContain('no recorded error')
  })

  it('reports a disabled subsystem with unknown space and no roots', () => {
    const text = rendered(renderStatus({}, statusValue({
      enabled: false,
      space: null,
      embedding_model: null,
      indexed_roots: [],
      last_error: 'the backend failed',
      accelerator_reason: null,
    })))
    expect(text).toContain('retrieval disabled')
    expect(text).toContain('embedding: unknown at 64 dimensions, space unknown')
    expect(text).toContain('accelerator: unavailable')
    expect(text).toContain('indexed roots: none')
    expect(text).toContain('last error: the backend failed')
  })

  it('carries the accelerator reason when it is degraded', () => {
    const text = rendered(renderStatus({}, statusValue({ accelerator_reason: 'worker crashed' })))
    expect(text).toContain('accelerator: unavailable (worker crashed)')
  })

  it('formats completeness with two decimals', () => {
    expect(rendered(renderStatus({}, statusValue({ index_completeness: 0.5 })))).toContain('completeness 0.50')
  })
})
