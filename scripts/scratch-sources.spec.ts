import { randomUUID } from 'node:crypto'
import { globSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { corpusListing, isScratchProbe, readCorpus } from './scratch-sources.ts'

const root = mkdtempSync(join(tmpdir(), 'scratch-sources-'))

beforeAll(() => {
  writeFileSync(join(root, 'notes.md'), 'text')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scratch probe names', () => {
  it('admits every path form the lint contract writes', () => {
    for (const file of [
      'packages/core/session/src/oxlint-contract-9f1c2ab4-77e2-4a11-9a3d-6c0f5d2e8b71.ts',
      'packages/client/ui-primitives/src/oxlint-contract-9f1c2ab4-77e2-4a11-9a3d-6c0f5d2e8b71.tsx',
      'packages/client/ui-trajectory/tests/oxlint-contract-9f1c2ab4-77e2-4a11-9a3d-6c0f5d2e8b71.client.ts',
      'scripts/oxlint-contract-9f1c2ab4-77e2-4a11-9a3d-6c0f5d2e8b71.ts',
    ]) {
      expect(isScratchProbe(file), file).toBe(true)
    }
  })

  it('excludes repository content, including a name that only starts similarly', () => {
    for (const file of [
      'packages/core/session/src/index.ts',
      'packages/core/session/src/oxlint-contracts.ts',
      'packages/core/session/src/inner/oxlint-contract-note.md',
      'oxlint-contract-9f1c2ab4-77e2-4a11-9a3d-6c0f5d2e8b71.json',
    ]) {
      expect(isScratchProbe(file), file).toBe(false)
    }
  })
})

describe('corpus listings', () => {
  it('normalizes separators, sorts, drops lint contract paths, and folds repeats', () => {
    expect(corpusListing([
      `packages${sep}core${sep}session${sep}src${sep}zeta.ts`,
      'packages/core/session/src/oxlint-contract-9f1c2ab4-77e2-4a11-9a3d-6c0f5d2e8b71.ts',
      `packages${sep}core${sep}session${sep}src${sep}alpha.ts`,
      'packages/core/session/src/zeta.ts',
    ])).toEqual([
      'packages/core/session/src/alpha.ts',
      'packages/core/session/src/zeta.ts',
    ])
  })
})

describe('corpus reads', () => {
  it('reads a path that is present', () => {
    expect(readCorpus(join(root, 'notes.md'))).toBe('text')
  })

  it('returns nothing for a path deleted between listing and reading', () => {
    expect(readCorpus(join(root, 'gone-mid-scan.ts'))).toBeUndefined()
  })

  it('propagates a read failure that is not a vanished path', () => {
    expect(() => readCorpus(root)).toThrow(/EISDIR/u)
  })
})

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Glob forms that match a lint-contract probe, used by `scripts/oxlint-contract.spec.ts` and any gate that excludes one. */
const probePatterns = ['**/oxlint-contract-*.ts', '**/oxlint-contract-*.tsx']

/**
 * Probes the lint contract writes into compiled trees, paired with the project that owns each one.
 * `packages/core/session/tsconfig.json` declares no `exclude` of its own, so it inherits the base list;
 * the others replace theirs, so each keeps its own directories.
 */
const probeClasses: Array<{ config: string; probe: string }> = [
  { config: 'tsconfig.host.json', probe: 'scripts/oxlint-contract-{id}.ts' },
  { config: 'tsconfig.host.json', probe: 'packages/core/session/tests/oxlint-contract-{id}.ts' },
  { config: 'tsconfig.client.json', probe: 'packages/client/ui-trajectory/tests/oxlint-contract-{id}.client.ts' },
  { config: 'packages/core/session/tsconfig.json', probe: 'packages/core/session/src/oxlint-contract-{id}.ts' },
  { config: 'packages/client/ui-primitives/tsconfig.json', probe: 'packages/client/ui-primitives/src/oxlint-contract-{id}.tsx' },
]

/**
 * List the files one project configuration compiles.
 * @param config - configuration path, relative to the repository root.
 * @returns the program's file paths in repository-relative `/`-separated form.
 * @throws when the configuration itself, or its resolved program, carries a diagnostic.
 */
function programFiles(config: string): string[] {
  const path = join(repositoryRoot, config)
  const read = ts.readConfigFile(path, file => ts.sys.readFile(file))
  if (read.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repositoryRoot, undefined, path)
  if (parsed.errors.length > 0) {
    throw new Error(`${config}: ${parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, ' ')).join('; ')}`)
  }
  return parsed.fileNames.map(file => file.slice(repositoryRoot.length + 1).replaceAll(sep, '/'))
}

/** One configuration's own `exclude`, which replaces the inherited list rather than adding to it. */
function declaredExclude(path: string): string[] | undefined {
  const read = ts.readConfigFile(path, file => ts.sys.readFile(file)) as { config?: { exclude?: string[] } }
  return read.config?.exclude
}

/**
 * Names of the `tsconfig*.json` files under `root`, repository-relative.
 * @param root - directory to walk, skipping installed and emitted trees.
 */
function configListing(root: string): string[] {
  return corpusListing(globSync('**/tsconfig*.json', {
    cwd: root,
    exclude: path => path.includes('node_modules') || path.includes(`${sep}lib${sep}`),
  }))
}

/**
 * Configurations under `root` whose own `exclude` names a probe.
 * @param root - directory to walk.
 */
function configsExcludingProbes(root: string): string[] {
  return configListing(root).filter((config) => {
    const exclude = declaredExclude(join(root, config))
    return exclude !== undefined && exclude.some(pattern => probePatterns.includes(pattern))
  })
}

describe('TypeScript programs', () => {
  // Tsgolint reports `Got tsconfig for file …: <none>` and `Unmatched files` for a probe no project
  // compiles, so `scripts/oxlint-contract.spec.ts` loses the type-aware diagnostics it asserts. The
  // vanished-probe race is answered by the corpus filters above rather than by a compiler exclusion.
  for (const { config, probe } of probeClasses) {
    it(`compiles ${probe} in ${config}`, () => {
      const file = probe.replace('{id}', randomUUID())
      const path = join(repositoryRoot, file)
      writeFileSync(path, 'export const contractProbe = 1\n')
      try {
        const files = programFiles(config)
        expect(files, file).toContain(file)
      } finally {
        rmSync(path, { force: true })
      }
    })
  }

  it('keeps every repository configuration free of probe exclusions', () => {
    expect(configListing(repositoryRoot).length, 'tsconfig files scanned').toBeGreaterThan(1)
    expect(configsExcludingProbes(repositoryRoot)).toEqual([])
  })

  it('names a configuration that excludes a probe and admits one that does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-exclusion-'))
    try {
      writeFileSync(join(dir, 'tsconfig.excluded.json'), JSON.stringify({ exclude: ['**/node_modules', probePatterns[0]] }))
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'], exclude: ['**/*.legacy.*'] }))
      expect(configsExcludingProbes(dir)).toEqual(['tsconfig.excluded.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
