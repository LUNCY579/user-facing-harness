/** Parser admission for nominal record, authority, and embedding identifiers. */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { AgentKey, OwnerKey, RecordId, SessionKey, SpaceKey, WorkspaceKey, tokenOf } from '../src/index.ts'

describe('retrieval identifiers', () => {
  it('preserves admitted values and keeps authority domains distinct in TypeScript', () => {
    for (const constructor of [OwnerKey, WorkspaceKey, SessionKey, AgentKey, RecordId, SpaceKey]) expect(constructor('synthetic:fixture-1')).toBe('synthetic:fixture-1')
    expectTypeOf<OwnerKey>().not.toEqualTypeOf<WorkspaceKey>()
    expectTypeOf<SessionKey>().not.toEqualTypeOf<AgentKey>()
    expectTypeOf<RecordId>().not.toEqualTypeOf<SpaceKey>()
    expectTypeOf(tokenOf('ws', '/fixture')).toEqualTypeOf<WorkspaceKey>()
    expectTypeOf(tokenOf('user', 'fixture')).toEqualTypeOf<OwnerKey>()
  })

  it('rejects invalid parser input before it can reach a store filter', () => {
    for (const constructor of [OwnerKey, WorkspaceKey, SessionKey, AgentKey, RecordId, SpaceKey]) {
      for (const invalid of ['', "x' OR true", 'x\u0000y', 'x'.repeat(129)]) expect(() => constructor(invalid)).toThrow('retrieval identifier')
    }
  })
})
