/**
 * What the store is allowed to read, expressed before any candidate is scored, and what it refuses to
 * materialize once a document is back on disk. The filter grammar has no string escape, so every
 * identity literal has to be refused rather than quoted, and a read that restricts nothing has to be
 * expressed as a contradiction. These cases call the predicate builder and the record decoder directly:
 * a live collection cannot be asked for a document whose scope column holds a tag this build never
 * writes, but a restored or half-written index can contain one.
 */
import {
  AgentKey,
  OwnerKey,
  RecordId,
  SessionKey,
  SpaceKey,
  WorkspaceKey,
  isRetrievalError,
  type ChunkRecord,
  type MemoryRecord,
  type ReadFilter,
} from '@deepseek-ai/dsh-retrieval'
import type { ZVecDoc } from '@zvec/zvec'
import { describe, expect, it } from 'vitest'
import {
  F,
  buildFilterExpression,
  documentToRecord,
  matchesPathPrefix,
  recordToDocument,
  safeLiteral,
  underPrefix,
} from '../src/schema.ts'

/** The contradiction no document satisfies, used for a read that restricts nothing. */
const NOTHING = `${F.kind} = 'chunk' AND ${F.kind} = 'memory'`

/** Space key of the store this filter reads; {@link buildFilterExpression} pins it into every read. */
const SPACE_KEY = 'sp:0123456789abcdef01234567'

/** One filter with a fully authorized caller, overriding only the constraint a case is about. */
function filter(overrides: Partial<ReadFilter> = {}): ReadFilter {
  return {
    activeAt: null,
    scopes: ['user', 'workspace', 'session', 'agent'],
    kinds: null,
    ownerKey: OwnerKey('owner-a'),
    workspaceKey: WorkspaceKey('ws-a'),
    agentKey: AgentKey('agent-a'),
    sessionKey: SessionKey('sess-a'),
    crossSession: false,
    userScope: true,
    pathPrefixes: [],
    onlyIds: null,
    ...overrides,
  }
}

/** Build the expression for one filter under a two-id ceiling. */
function expression(overrides: Partial<ReadFilter> = {}): string {
  return buildFilterExpression(filter(overrides), SPACE_KEY, 2)
}

/** A chunk under `/repo/src`, written by the workspace indexer. */
const CHUNK: ChunkRecord = {
  kind: 'chunk', id: RecordId('chunk-1'), scope: 'workspace', ownerKey: OwnerKey('owner-a'),
  workspaceKey: WorkspaceKey('ws-a'), sessionKey: null, agentKey: null,
  source: '/repo/src/core.ts', startLine: 10, endLine: 24, text: 'refundPayment(input)',
  contentHash: 'sha256:abc', updatedAt: 1700, spaceKey: SpaceKey(SPACE_KEY),
}

/** A current memory written by the model, with no expiry and no supersessor. */
const MEMORY: MemoryRecord = {
  kind: 'memory', pending: false, id: RecordId('mem-1'), scope: 'session', ownerKey: OwnerKey('owner-a'),
  workspaceKey: WorkspaceKey('ws-a'), sessionKey: SessionKey('sess-a'), agentKey: AgentKey('agent-a'),
  text: 'the ledger rounds half up', tags: ['accounting'], attribution: { actor: 'model', ref: 'sess-a' },
  version: 2, supersedes: [RecordId('mem-0')], supersededBy: null, createdAt: 1600, updatedAt: 1700,
  expiresAt: null, contentHash: 'sha256:def', spaceKey: SpaceKey(SPACE_KEY),
}

/** Wrap one document's columns as the backend returns them. */
function doc(fields: Record<string, unknown>, id = 'mem-1'): ZVecDoc {
  return { id, vectors: {}, fields, score: 1 }
}

/** The stored columns of {@link MEMORY} with the named columns replaced or removed. */
function memoryFields(patch: Record<string, unknown>, dropped: readonly string[] = []): Record<string, unknown> {
  const fields = { ...recordToDocument(MEMORY).fields, ...patch }
  return Object.fromEntries(Object.entries(fields).filter(([name]) => !dropped.includes(name)))
}

describe('buildFilterExpression', () => {
  it('requires the owner, the embedding space, and one authority per scope', () => {
    const built = expression()
    expect(built).toContain(`${F.ownerKey} = 'owner-a'`)
    expect(built).toContain(`${F.spaceKey} = '${SPACE_KEY}'`)
    expect(built).toContain(`(${F.scope} = 'workspace' AND ${F.workspaceKey} = 'ws-a')`)
    expect(built).toContain(`(${F.scope} = 'agent' AND ${F.workspaceKey} = 'ws-a' AND ${F.agentKey} = 'agent-a' AND ${F.sessionKey} = 'sess-a')`)
    expect(built).toContain(`(${F.scope} = 'user')`)
  })

  it('contradicts everything when the caller holds no scope', () => {
    expect(buildFilterExpression(filter({ scopes: [] }), SPACE_KEY, 2)).toBe(NOTHING)
  })

  it('contradicts everything for an explicit-id set with no ids', () => {
    expect(expression({ onlyIds: [] })).toBe(NOTHING)
  })

  it('contradicts everything when the only permitted scope is user without a user grant', () => {
    expect(buildFilterExpression(filter({ scopes: ['user'], userScope: false }), SPACE_KEY, 2)).toBe(NOTHING)
  })

  it('refuses an agent-scope read that has no agent or no session identity', () => {
    for (const overrides of [{ agentKey: null }, { sessionKey: null }] as const) {
      expect(expression({ scopes: ['agent'], ...overrides })).toContain(NOTHING)
    }
  })

  it('refuses a session-scope read for a caller with no session', () => {
    expect(expression({ scopes: ['session'], crossSession: false, sessionKey: null })).toContain(NOTHING)
  })

  it('drops the session predicate only for a cross-session grant', () => {
    expect(expression({ scopes: ['session'], crossSession: false })).toContain(`${F.sessionKey} = 'sess-a'`)
    expect(expression({ scopes: ['session'], crossSession: true })).not.toContain(F.sessionKey)
  })

  it('admits both record classes unless the read names one', () => {
    expect(expression()).toContain(`${F.kind} IN ('chunk','memory')`)
    expect(expression({ kinds: ['memory'] })).toContain(`${F.kind} = 'memory'`)
  })

  it('restricts one id by equality and several by a closed set', () => {
    expect(expression({ onlyIds: [RecordId('mem-1')] })).toContain(`${F.idKey} = 'mem-1'`)
    expect(expression({ onlyIds: [RecordId('mem-1'), RecordId('mem-2')] }))
      .toContain(`${F.idKey} IN ('mem-1','mem-2')`)
  })

  it('refuses an explicit-id set above the configured ceiling instead of truncating it', () => {
    const ids = [RecordId('a'), RecordId('b'), RecordId('c')]
    expect(() => buildFilterExpression(filter({ onlyIds: ids }), SPACE_KEY, 2))
      .toThrow(/id filter of 3 exceeds 2/u)
  })

  it('encodes a path restriction as hexadecimal source keys and confines it to chunks', () => {
    const built = expression({ scopes: ['workspace'], pathPrefixes: ['/repo/src'] })
    expect(built).toContain(`${F.sourceKey} = '2f7265706f2f737263'`)
    expect(built).toContain(`${F.sourceKey} LIKE '2f7265706f2f7372632f%'`)
    expect(built).toContain(`${F.kind} = 'chunk'`)
  })

  it('strips a trailing separator so one root does not gain an empty path segment', () => {
    expect(expression({ pathPrefixes: ['/repo/src/'] })).toContain(`${F.sourceKey} = '2f7265706f2f737263'`)
  })

  it('selects staged memories for reconciliation', () => {
    const built = expression({ pendingOnly: true })
    expect(built).toContain(`${F.kind} = 'memory'`)
    expect(built).toContain(`${F.pending} = TRUE`)
  })

  it('hides expired, pending, and superseded memories at a visibility time', () => {
    const built = expression({ activeAt: 1234.9 })
    expect(built).toContain(`${F.pending} = FALSE`)
    expect(built).toContain(`${F.supersededBy} = ''`)
    expect(built).toContain(`${F.expiresAt} = 0 OR ${F.expiresAt} > 1234`)
  })

  it('refuses a visibility time that is not a positive finite number', () => {
    for (const activeAt of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => expression({ activeAt })).toThrow(/invalid memory visibility time/u)
    }
  })

  it('refuses a record-class set with no classes instead of admitting every class', () => {
    expect(() => expression({ kinds: [] })).toThrow(/kind filter has no values/u)
  })

  it.each([
    ["sp:x' OR '1' = '1"],
    ['sp:x ; drop'],
    [''],
    [`sp:${'x'.repeat(128)}`],
  ])('refuses the space key %j instead of quoting it', (spaceKey) => {
    expect(() => buildFilterExpression(filter(), spaceKey, 2)).toThrow(/cannot be used in a store filter/u)
  })

  it('admits an identity literal only through a branded key, which refuses a store-unsafe value', () => {
    for (const admit of [OwnerKey, WorkspaceKey, SessionKey, AgentKey, RecordId, SpaceKey]) {
      expect(() => admit("a' OR '1' = '1")).toThrow(/unsupported characters or exceeds 128 characters/u)
    }
  })

  it('keeps the literals its character class admits', () => {
    expect(safeLiteral('sp:0123456789abcdef01234567', 'spaceKey')).toBe('sp:0123456789abcdef01234567')
    expect(safeLiteral('agent-7.local:1', 'agentKey')).toBe('agent-7.local:1')
  })
})

describe('documentToRecord', () => {
  it('round-trips a chunk through its columns', () => {
    const document = recordToDocument(CHUNK)
    expect(documentToRecord(doc(document.fields, document.id))).toEqual(CHUNK)
  })

  it('round-trips a memory with its lifecycle and attribution', () => {
    expect(documentToRecord(doc(recordToDocument(MEMORY).fields))).toEqual(MEMORY)
  })

  it('reads a memory that never expires and stays current as null on both edges', () => {
    const record = documentToRecord(doc(recordToDocument(MEMORY).fields))
    expect(record.kind === 'memory' && record.expiresAt).toBe(null)
    expect(record.kind === 'memory' && record.supersededBy).toBe(null)
  })

  it('keeps an expiry and a supersessor', () => {
    const replaced: MemoryRecord = { ...MEMORY, expiresAt: 1800, supersededBy: RecordId('mem-2') }
    expect(documentToRecord(doc(recordToDocument(replaced).fields))).toEqual(replaced)
  })

  it('falls back to the model actor for an unknown or absent attribution', () => {
    for (const actor of ['stranger', undefined]) {
      const record = documentToRecord(doc(memoryFields({ [F.attributionActor]: actor })))
      expect(record.kind === 'memory' && record.attribution.actor).toBe('model')
    }
  })

  it('reads the user and indexer actors as written', () => {
    for (const actor of ['user', 'indexer']) {
      const record = documentToRecord(doc(memoryFields({ [F.attributionActor]: actor })))
      expect(record.kind === 'memory' && record.attribution.actor).toBe(actor)
    }
  })

  it('refuses a stored record of unknown kind', () => {
    expect(() => documentToRecord(doc(memoryFields({ [F.kind]: 'note' }))))
      .toThrow(/has unknown kind note/u)
  })

  it('refuses a stored scope this build never writes', () => {
    expect(() => documentToRecord(doc(memoryFields({ [F.scope]: 'global' }))))
      .toThrow(/stored record carries unknown scope global/u)
  })

  it('refuses a memory whose commit state is missing or not a boolean', () => {
    for (const fields of [memoryFields({}, [F.pending]), memoryFields({ [F.pending]: 'false' })]) {
      try {
        documentToRecord(doc(fields))
        expect.unreachable('a corrupt commit state must not decode')
      } catch (error) {
        expect(isRetrievalError(error) && error.code).toBe('backend_error')
        expect(isRetrievalError(error) && error.message).toMatch(/commit state is missing or corrupt/u)
      }
    }
  })

  it('refuses a session or agent column that is neither absent nor a string', () => {
    expect(() => documentToRecord(doc(memoryFields({ [F.sessionKey]: 7 }))))
      .toThrow(/invalid stored session or agent id/u)
    expect(() => documentToRecord(doc(memoryFields({ [F.agentKey]: true }, ['sessKey']))))
      .toThrow(/invalid stored session or agent id/u)
  })

  it('reads a record with no session as owned by none', () => {
    const record = documentToRecord(doc(memoryFields({ [F.sessionKey]: 'none', [F.agentKey]: 'none' })))
    expect(record.kind === 'memory' && record.sessionKey).toBe(null)
    expect(record.kind === 'memory' && record.agentKey).toBe(null)
  })

  it('refuses a document whose kind or scope column is missing', () => {
    expect(() => documentToRecord(doc(memoryFields({}, [F.kind])))).toThrow(/has unknown kind/u)
    expect(() => documentToRecord(doc(memoryFields({}, [F.scope])))).toThrow(/unknown scope/u)
  })

  it('refuses a document that lost an identity column instead of reading it as another owner', () => {
    for (const column of [F.ownerKey, F.workspaceKey, F.spaceKey]) {
      expect(() => documentToRecord(doc(memoryFields({}, [column]))))
        .toThrow(/unsupported characters or exceeds 128 characters/u)
    }
  })

  it('reads an absent supersessor and attribution reference as none', () => {
    const record = documentToRecord(doc(memoryFields({}, [F.supersededBy, F.attributionRef])))
    expect(record.kind === 'memory' && record.supersededBy).toBe(null)
    expect(record.kind === 'memory' && record.attribution.ref).toBe('')
  })

  it('substitutes empty values for columns a half-written document left out', () => {
    const record = documentToRecord(doc({
      [F.kind]: 'chunk', [F.scope]: 'workspace', [F.ownerKey]: 'owner-a',
      [F.workspaceKey]: 'ws-a', [F.spaceKey]: SPACE_KEY,
    }, 'chunk-9'))
    expect(record).toEqual({
      kind: 'chunk', id: RecordId('chunk-9'), scope: 'workspace', ownerKey: OwnerKey('owner-a'),
      workspaceKey: WorkspaceKey('ws-a'), sessionKey: null, agentKey: null, text: '', contentHash: '',
      updatedAt: 0, spaceKey: SpaceKey(SPACE_KEY), source: '', startLine: 0, endLine: 0,
    })
  })

  it('reads a non-array list column as empty and a non-number numeric column as zero', () => {
    const record = documentToRecord(doc(memoryFields({
      [F.tags]: 'accounting', [F.supersedes]: null, [F.version]: '2', [F.createdAt]: undefined,
    })))
    expect(record.kind === 'memory' && record.tags).toEqual([])
    expect(record.kind === 'memory' && record.supersedes).toEqual([])
    expect(record.kind === 'memory' && record.version).toBe(0)
    expect(record.kind === 'memory' && record.createdAt).toBe(0)
  })
})

describe('underPrefix', () => {
  it('matches a root and anything below it', () => {
    expect(underPrefix('/repo/src', ['/repo/src'])).toBe(true)
    expect(underPrefix('/repo/src/core.ts', ['/repo/src'])).toBe(true)
    expect(underPrefix('/repo/src/core.ts', ['/repo/src/'])).toBe(true)
  })

  it('refuses a sibling directory whose name starts with the root', () => {
    expect(underPrefix('/repo/srcdb/core.ts', ['/repo/src'])).toBe(false)
    expect(underPrefix('/repo/src', ['/repo/src/core.ts'])).toBe(false)
  })

  it('matches when any one of several roots admits the source', () => {
    expect(underPrefix('/other/a.ts', ['/repo/src', '/other'])).toBe(true)
    expect(underPrefix('/third/a.ts', ['/repo/src', '/other'])).toBe(false)
  })
})

describe('matchesPathPrefix', () => {
  it('keeps every record when the read names no root', () => {
    expect(matchesPathPrefix(CHUNK, [])).toBe(true)
    expect(matchesPathPrefix(MEMORY, [])).toBe(true)
  })

  it('excludes memories from any path restriction, because a memory belongs to no file', () => {
    expect(matchesPathPrefix(CHUNK, ['/repo'])).toBe(true)
    expect(matchesPathPrefix(MEMORY, ['/repo'])).toBe(false)
  })
})
