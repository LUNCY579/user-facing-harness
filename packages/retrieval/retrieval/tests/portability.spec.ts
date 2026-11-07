/** Coverage for the versioned export format, portability files, path rules, and the forgotten ledger. */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentKey, OwnerKey, RecordId, SessionKey, SpaceKey, WorkspaceKey, contentHash } from '../src/index.ts'
import type { RetrievalError } from '../src/errors.ts'
import {
  EMPTY_FORGET_LEDGER, MEMORY_EXPORT_VERSION, confinedPortabilityPath, decodeMemoryExport, encodeMemoryExport,
  encodeMemoryRecord, forgottenIndex, journalPathOf, ledgerPathOf, ledgerWithForgotten, memoryExportOf,
  portabilityPath, readPortabilityJson, readPortabilityText, writePortabilityJson, writePortabilityText,
} from '../src/portability.ts'
import type { ForgetLedger } from '../src/portability.ts'
import type { MemoryRecord } from '../src/types.ts'

const SPACE = SpaceKey('fixture-v1')
const LIMIT = 4
const REFUSALS: readonly [string, unknown, RegExp][] = [
  ['kind', 'chunk', /carry only memory records/],
  ['scope', 'galaxy', /unknown scope galaxy/],
  ['id', 'bad id', /unsupported characters/],
  ['pending', true, /committed records, never a pending supersession intent/],
  ['pending', 'no', /committed records, never a pending supersession intent/],
  ['ownerKey', 7, /ownerKey must be a non-empty string/],
  ['workspaceKey', '', /workspaceKey must be a non-empty string/],
  ['sessionKey', 7, /sessionKey must be a non-empty string/],
  ['agentKey', false, /agentKey must be a non-empty string/],
  ['text', 5, /text must be a non-empty string/],
  ['tags', 'preference', /tags must be an array of strings/],
  ['supersedes', [7], /supersedes must be an array of strings/],
  ['supersededBy', 7, /supersededBy must be a non-empty string/],
  ['version', 'three', /version must be a finite number/],
  ['createdAt', null, /createdAt must be a finite number/],
  ['updatedAt', Number.NaN, /updatedAt must be a finite number/],
  ['expiresAt', 'soon', /expiresAt must be a finite number/],
  ['contentHash', '', /contentHash must be a non-empty string/],
  ['spaceKey', 'sp ace', /unsupported characters/],
  ['attribution', 'user', /attribution must be a JSON object/],
  ['attribution', { actor: 'ghost', ref: 'fixture' }, /actor ghost is unknown/],
  ['attribution', { actor: 'user' }, /attribution\.ref must be a non-empty string/],
]
const OWNERSHIPS: readonly [string, SessionKey | null, AgentKey | null, RegExp][] = [
  ['workspace', null, AgentKey('agent-a'), /names a session or agent owner for workspace scope/],
  ['user', SessionKey('session-a'), null, /names a session or agent owner for user scope/],
  ['session', null, null, /malformed session ownership/],
  ['session', SessionKey('session-a'), AgentKey('agent-a'), /malformed session ownership/],
  ['agent', null, AgentKey('agent-a'), /malformed agent ownership/],
  ['agent', SessionKey('session-a'), null, /malformed agent ownership/],
]
const ESCAPES: readonly string[] = ['', '.', '..', '../escape.json', join('nested', '..', '..', 'escape.json'), '/etc/passwd']
const directories: string[] = []

/** One stored memory, with its digest recomputed unless the caller supplies a deliberate mismatch. */
function memory(over: Partial<MemoryRecord> = {}): MemoryRecord {
  const record: MemoryRecord = {
    kind: 'memory', pending: false, id: RecordId('mem-1'), scope: 'workspace',
    ownerKey: OwnerKey('owner-a'), workspaceKey: WorkspaceKey('workspace-a'), sessionKey: null, agentKey: null,
    text: 'Prefers tea over coffee', tags: ['preference'], attribution: { actor: 'user', ref: 'fixture' },
    version: 1, supersedes: [], supersededBy: null, createdAt: 1, updatedAt: 2, expiresAt: null,
    contentHash: '', spaceKey: SPACE, ...over,
  }
  return { ...record, contentHash: over.contentHash ?? contentHash(record.text) }
}

/** Export text for the supplied records. */
function exportText(records: readonly MemoryRecord[]): string {
  return encodeMemoryExport(memoryExportOf(records, SPACE))
}

/** Export text whose only record carries these fields. */
function recordFields(over: Partial<MemoryRecord>): string {
  return exportText([memory(over)])
}

/** Export text with one envelope field replaced. */
function envelopeText(field: string, value: unknown): string {
  const raw = JSON.parse(exportText([memory()])) as Record<string, unknown>
  raw[field] = value
  return JSON.stringify(raw)
}

/** Export text with one record field replaced, digest left as the source wrote it. */
function recordText(field: string, value: unknown): string {
  const raw = JSON.parse(exportText([memory()])) as { records: [Record<string, unknown>, ...Record<string, unknown>[]] }
  raw.records[0][field] = value
  return JSON.stringify(raw)
}

/** Decode text that must be refused, and return the failure. */
function decodeFailure(text: string, limit: number = LIMIT): RetrievalError {
  try {
    decodeMemoryExport(text, limit)
  } catch (error) {
    return error as RetrievalError
  }
  throw new Error('decodeMemoryExport accepted an invalid export')
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retrieval-portability-'))
  directories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('export envelope', () => {
  it('round-trips every stored field of a memory', () => {
    const source = memory({
      scope: 'agent', sessionKey: SessionKey('session-a'), agentKey: AgentKey('agent-a'),
      tags: ['task', 'state'], supersedes: [RecordId('mem-0')], supersededBy: RecordId('mem-2'),
      expiresAt: 9_000, version: 3, attribution: { actor: 'model', ref: 'call-1' },
    })
    const decoded = decodeMemoryExport(exportText([source]), LIMIT)
    expect(decoded.records).toEqual([source])
    expect(decoded.version).toBe(MEMORY_EXPORT_VERSION)
    expect(decoded.sourceSpace).toBe(SPACE)
    expect(decoded.exportedAt).toBeGreaterThan(0)
  })

  it('reads back the same text it decoded, so verification compares facts rather than key order', () => {
    const text = exportText([memory(), memory({ id: RecordId('mem-2'), text: 'Deploy runs on Tuesdays' })])
    expect(encodeMemoryExport(decodeMemoryExport(text, LIMIT))).toBe(text)
  })

  it('writes fields in declaration order', () => {
    const fields = JSON.parse(encodeMemoryRecord(memory())) as Record<string, unknown>
    expect(Object.keys(fields)).toEqual([
      'id', 'kind', 'pending', 'scope', 'ownerKey', 'workspaceKey', 'sessionKey', 'agentKey', 'text', 'tags',
      'attribution', 'version', 'supersedes', 'supersededBy', 'createdAt', 'updatedAt', 'expiresAt', 'contentHash', 'spaceKey',
    ])
  })

  it('orders keys by declaration, whatever order the record carries them in', () => {
    const stored = memory()
    const reversed: MemoryRecord = {
      spaceKey: stored.spaceKey, contentHash: stored.contentHash, expiresAt: stored.expiresAt, updatedAt: stored.updatedAt,
      createdAt: stored.createdAt, supersededBy: stored.supersededBy, supersedes: [...stored.supersedes],
      version: stored.version, attribution: { ref: stored.attribution.ref, actor: stored.attribution.actor },
      tags: [...stored.tags], text: stored.text, agentKey: stored.agentKey, sessionKey: stored.sessionKey,
      workspaceKey: stored.workspaceKey, ownerKey: stored.ownerKey, scope: stored.scope, pending: stored.pending,
      kind: stored.kind, id: stored.id,
    }
    expect(encodeMemoryRecord(reversed)).toBe(encodeMemoryRecord(stored))
  })

  it('copies the arrays it carries so a later store mutation cannot rewrite an export', () => {
    const source = memory()
    const envelope = memoryExportOf([source], SPACE)
    source.tags.push('mutated')
    source.supersedes.push(RecordId('mem-9'))
    expect(envelope.records[0]?.tags).toEqual(['preference'])
    expect(envelope.records[0]?.supersedes).toEqual([])
  })

  it('refuses text that is not JSON', () => {
    const failure = decodeFailure('{not json')
    expect(failure.code).toBe('invalid_input')
    expect(failure.message).toContain('not valid JSON')
  })

  it.each([
    ['version', 2, /version 2 is not supported/] as [string, unknown, RegExp],
    ['exportedAt', 'yesterday', /exportedAt must be a finite number/],
    ['sourceSpace', ' ', /unsupported characters/],
    ['records', 'none', /array of at most 4 records/],
  ])('refuses an envelope whose %s is unusable', (field, value, message) => {
    expect(decodeFailure(envelopeText(field, value)).message).toMatch(message)
  })

  it('refuses an envelope larger than the caller limit', () => {
    const many = Array.from({ length: 3 }, (_, index) => memory({ id: RecordId(`mem-${String(index)}`) }))
    const failure = decodeFailure(exportText(many), 2)
    expect(failure.code).toBe('invalid_input')
    expect(failure.message).toContain('at most 2 records')
    expect(decodeMemoryExport(exportText(many), 3).records).toHaveLength(3)
  })

  it('refuses an envelope that repeats one record id', () => {
    expect(decodeFailure(exportText([memory(), memory()])).message).toContain('repeats record id mem-1')
  })

  it.each(REFUSALS)('refuses a record whose %s is %s', (field, value, message) => {
    const failure = decodeFailure(recordText(field, value))
    expect(failure.code).toBe('invalid_input')
    expect(failure.message).toMatch(message)
  })

  it.each(OWNERSHIPS)('refuses %s ownership that the engine never writes', (scope, sessionKey, agentKey, message) => {
    const failure = decodeFailure(recordFields({ scope: scope as MemoryRecord['scope'], sessionKey, agentKey }))
    expect(failure.code).toBe('invalid_input')
    expect(failure.message).toMatch(message)
  })

  it.each([0, 1.5])('refuses a record version of %s', (version) => {
    expect(decodeFailure(recordFields({ version })).message).toMatch(/version below 1/)
  })

  it('refuses a text that does not hash to its recorded digest', () => {
    const tampered = JSON.parse(exportText([memory()])) as { records: [Record<string, unknown>, ...Record<string, unknown>[]] }
    tampered.records[0].text = 'Prefers coffee over tea'
    const failure = decodeFailure(JSON.stringify(tampered))
    expect(failure.code).toBe('invalid_input')
    expect(failure.message).toContain('does not match its recorded content digest')
  })

  it.each(['model', 'user', 'indexer'])('reads an attribution written by a %s', (actor) => {
    const record = decodeMemoryExport(recordFields({ attribution: { actor: actor as MemoryRecord['attribution']['actor'], ref: 'fixture' } }), LIMIT).records[0]
    expect(record?.attribution.actor).toBe(actor)
  })
})

describe('portability paths', () => {
  it('names a file below the configured directory, including nested names', async () => {
    const root = await tempDir()
    expect(portabilityPath(root, 'export.json')).toBe(join(resolve(root), 'export.json'))
    expect(portabilityPath(root, join('nested', 'export.json'))).toBe(join(resolve(root), 'nested/export.json'))
  })

  it.each(ESCAPES)('refuses the name %s', async (name) => {
    const root = await tempDir()
    expect(() => portabilityPath(root, name)).toThrow(/path below the configured directory/)
  })

  it('keeps the ledger and one journal per store below the directory', async () => {
    const root = await tempDir()
    expect(ledgerPathOf(root)).toBe(join(resolve(root), 'memory-ledger.json'))
    const first = journalPathOf(root, join(root, 'store-a'))
    expect(first).toBe(journalPathOf(root, join(root, 'store-a')))
    expect(first).not.toBe(journalPathOf(root, join(root, 'store-b')))
    expect(first.startsWith(resolve(root))).toBe(true)
  })

  it('refuses a name whose link leaves the configured directory', async () => {
    const root = await tempDir()
    const outside = await tempDir()
    await writeFile(join(outside, 'elsewhere.json'), 'outside the configured directory')
    await symlink(join(outside, 'elsewhere.json'), join(root, 'link.json'))
    await expect(confinedPortabilityPath(root, 'link.json')).rejects.toMatchObject({ code: 'path_escape' })
  })

  it('refuses a nested name under a linked directory that leaves the configured directory', async () => {
    const root = await tempDir()
    const outside = await tempDir()
    await mkdir(join(outside, 'staged'), { recursive: true })
    await symlink(join(outside, 'staged'), join(root, 'nested'))
    await expect(confinedPortabilityPath(root, join('nested', 'export.json')))
      .rejects.toMatchObject({ code: 'path_escape' })
  })

  it('keeps a nested name whose linked parent stays inside the configured directory', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'real'), { recursive: true })
    await symlink(join(root, 'real'), join(root, 'nested'))
    expect(await confinedPortabilityPath(root, join('nested', 'export.json')))
      .toBe(join(resolve(root), 'nested/export.json'))
  })

  it('keeps a name below an existing directory and one whose parents do not exist yet', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'nested'), { recursive: true })
    expect(await confinedPortabilityPath(root, join('nested', 'export.json')))
      .toBe(join(resolve(root), 'nested/export.json'))
    expect(await confinedPortabilityPath(root, join('created-later', 'export.json')))
      .toBe(join(resolve(root), 'created-later/export.json'))
  })

  it('keeps a name that reaches the directory through a link pointing back at it', async () => {
    const root = await tempDir()
    await symlink(root, join(root, 'self'))
    expect(await confinedPortabilityPath(root, join('self', 'export.json')))
      .toBe(join(resolve(root), 'self/export.json'))
  })

  it('names a file below a directory that does not exist yet', async () => {
    const root = await tempDir()
    expect(await confinedPortabilityPath(join(root, 'not-created'), 'export.json'))
      .toBe(join(resolve(root, 'not-created'), 'export.json'))
  })
})

describe('portability files', () => {
  it('creates the parent directory, replaces the file, and leaves no temporary behind', async () => {
    const root = await tempDir()
    const path = join(root, 'nested', 'export.json')
    await writePortabilityText(path, '{"version":1}')
    expect(await readFile(path, 'utf8')).toBe('{"version":1}')
    await writePortabilityText(path, '{"version":2}')
    expect(await readFile(path, 'utf8')).toBe('{"version":2}')
    expect(await readdir(join(root, 'nested'))).toEqual(['export.json'])
  })

  it('reads a file back, and returns the initial value when it is absent', async () => {
    const root = await tempDir()
    const path = join(root, 'ledger.json')
    expect(await readPortabilityText(path, 'absent')).toBe('absent')
    await writePortabilityJson(path, EMPTY_FORGET_LEDGER)
    expect(await readPortabilityJson(path, EMPTY_FORGET_LEDGER)).toEqual(EMPTY_FORGET_LEDGER)
  })

  it('reports a present but unreadable file as a backend failure instead of absence', async () => {
    const root = await tempDir()
    const directory = join(root, 'ledger.json')
    await mkdir(directory)
    await expect(readPortabilityText(directory, 'absent')).rejects.toMatchObject({ code: 'backend_error' })
  })

  it('reports a present but corrupt JSON file as a backend failure', async () => {
    const root = await tempDir()
    const path = join(root, 'journal.json')
    await writeFile(path, '{truncated', 'utf8')
    await expect(readPortabilityJson(path, null))
      .rejects.toMatchObject({ code: 'backend_error', message: /is not valid JSON/ })
  })
})

describe('forgotten ledger', () => {
  it('records one ledger entry per id and keeps the earliest removal time', () => {
    const earlier = { id: RecordId('mem-1'), contentHash: contentHash('Prefers tea over coffee'), forgottenAt: 1_000 }
    const updated = ledgerWithForgotten({ version: MEMORY_EXPORT_VERSION, entries: [earlier] }, [
      memory({ id: RecordId('mem-1') }),
      memory({ id: RecordId('mem-2'), text: 'Deploy runs on Tuesdays' }),
    ])
    const restored = updated.entries.find(entry => entry.id === RecordId('mem-2'))
    expect(updated.version).toBe(MEMORY_EXPORT_VERSION)
    expect(updated.entries.map(entry => entry.id)).toEqual([RecordId('mem-1'), RecordId('mem-2')])
    expect(updated.entries.find(entry => entry.id === earlier.id)).toBe(earlier)
    expect(restored?.contentHash).toBe(contentHash('Deploy runs on Tuesdays'))
    expect(restored?.forgottenAt).toBeGreaterThan(earlier.forgottenAt)
    expect(updated.entries.map(entry => entry.forgottenAt)).toEqual([earlier.forgottenAt, restored?.forgottenAt])
  })

  it('indexes ledger entries by id for one lookup per imported record', () => {
    const entry = { id: RecordId('mem-1'), contentHash: 'hash', forgottenAt: 1 }
    const ledger: ForgetLedger = { version: MEMORY_EXPORT_VERSION, entries: [entry] }
    expect(forgottenIndex(ledger).get(RecordId('mem-1'))).toBe(entry)
    expect(forgottenIndex(EMPTY_FORGET_LEDGER).size).toBe(0)
  })
})
