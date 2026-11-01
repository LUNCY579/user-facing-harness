import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkClientDomainPackage, resolveClientImport } from './verify-client-domain-graph.ts'

describe('client domain import resolution', () => {
  it('preserves imports that leave src/client from a top-level file', () => {
    expect(resolveClientImport('styles.ts', '../styles/base.css?inline'))
      .toBe('../styles/base.css?inline')
  })

  it('normalizes imports between domains inside src/client', () => {
    expect(resolveClientImport('input/hub.ts', '../queue/store.ts'))
      .toBe('queue/store.ts')
  })
})

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function clientFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-client-domain-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return root
}

describe('client domain import classification', () => {
  it('accepts supported presentation resources without exempting their directories', () => {
    const root = clientFixture({
      'View.tsx': "import icon from './assets/icon.svg'\nimport hero from './art/hero.webp'\n",
      'input/View.tsx': "import css from '../rows/Rows.module.css'\nimport text from '../theme/global.css?inline'\n",
      'contract/types.ts': "import png from '../art/icon.png?url'\nimport jpg from '../art/icon.jpg#preview'\nimport jpeg from '../art/icon.jpeg'\n",
    })
    expect(checkClientDomainPackage('example', root)).toEqual([])
  })

  it.each([
    ['assets code', 'View.tsx', './assets/controller.ts'],
    ['locale code', 'View.tsx', './locales/onboarding.ts'],
    ['asset type declarations', 'contract/types.ts', '../assets/types.ts'],
    ['locale type declarations', 'contract/types.ts', '../locales/types.ts'],
    ['sibling type declarations', 'input/view.ts', '../queue/types.ts'],
    ['contract implementation dependency', 'contract/types.ts', '../chat/state.ts'],
    ['resource-looking code filename', 'input/view.ts', '../art/icon.svg.ts'],
    ['code request with a resource-looking query', 'input/view.ts', '../art/controller.ts?file=icon.svg'],
  ])('rejects %s', (_name, file, imported) => {
    const root = clientFixture({ [file]: `import type { Value } from '${imported}'\n` })
    const violations = checkClientDomainPackage('example', root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(`example/src/client/${file}`)
    expect(violations[0]?.imported).toBe(imported)
    expect(violations[0]?.reason).toContain(file.includes('/') ? 'imports sibling domain' : 'top-level non-assembly')
  })

  it('rejects runtime code across domains and under an assets directory', () => {
    const root = clientFixture({
      'View.tsx': "import { run } from './assets/controller.ts'\n",
      'input/View.tsx': "import { run } from '../queue/controller.ts'\n",
    })
    expect(checkClientDomainPackage('example', root).map(({ file, imported }) => ({ file, imported }))).toEqual([
      { file: 'example/src/client/View.tsx', imported: './assets/controller.ts' },
      { file: 'example/src/client/input/View.tsx', imported: '../queue/controller.ts' },
    ])
  })

  it('preserves shared declarations, domain-local code, and root assembly', () => {
    const root = clientFixture({
      'input/view.ts': "import type { Value } from '../contract/types.ts'\nimport { state } from './state.ts'\nimport { shared } from '../shared.ts'\n",
      'apply.ts': "import { input } from './input/view.ts'\nimport { queue } from './queue/view.ts'\n",
      'index.ts': "export { queue } from './queue/view.ts'\n",
    })
    expect(checkClientDomainPackage('example', root)).toEqual([])
  })
})
