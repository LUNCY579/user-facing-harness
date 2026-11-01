/** The native retrieval consumer must remain in the executable tool catalog. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertManifestComplete, collectToolCatalog, type ToolPackage } from './gen-tool-catalog.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('rejects a manifest that omits the retrieval consumer despite its non-prefix package name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-catalog-'))
  roots.push(root)
  await mkdir(join(root, 'packages/retrieval/retrieval-tools'), { recursive: true })
  expect(() => { assertManifestComplete([], root) }).toThrow('retrieval-tools')
  const listed: ToolPackage = {
    pkg: '@deepseek-ai/dsh-retrieval-tools', dir: 'retrieval-tools', source: 'tools.ts', requires: [], writes: [], mount: async () => {},
  }
  expect(() => { assertManifestComplete([listed], root) }).not.toThrow()
})

it('harvests all nine retrieval tools without starting native storage or embeddings', async () => {
  const entry = (await collectToolCatalog()).find(item => item.pkg === '@deepseek-ai/dsh-retrieval-tools')
  expect(entry?.schemas.map(schema => schema.name)).toEqual([
    'context_index', 'context_search', 'memory_forget', 'memory_remember', 'memory_search',
    'memory_status', 'memory_update', 'vector_similarity_search', 'workspace_semantic_search',
  ])
  expect(entry?.sources['context_index']).toBe('packages/retrieval/retrieval-tools/src/tools.ts')
})
