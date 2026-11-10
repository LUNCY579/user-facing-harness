/**
 * Generate a CycloneDX SBOM from the pnpm lockfile. The SBOM lists every
 * resolved package with its version, so consumers can audit the dependency
 * tree without reading the lockfile.
 * @module scripts/verify-sbom
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

function generateSbom(lockfilePath: string): object {
  const lockfileText = readFileSync(resolve(lockfilePath), 'utf8')
  // Extract `name@version:` keys from the lockfile's `packages:` section.
  // The pattern matches scoped and unscoped npm package keys followed by a colon.
  const packageIds = new Set<string>()
  for (const match of lockfileText.matchAll(/^  '?([^\s]+)'?:(?:\s*|$)/gm)) {
    const key = match[1]
    if (key === undefined) continue
    const lastAt = key.lastIndexOf('@')
    if (lastAt <= 0) continue
    const name = key.slice(0, lastAt)
    const version = key.slice(lastAt + 1)
    if (version.length === 0 || !/^[\w.-]/.test(version)) continue
    const id = `${name}@${version}`
    packageIds.add(id)
  }
  const packages: Array<{ name: string; version: string; purl: string }> = []
  for (const id of packageIds) {
    const lastAt = id.lastIndexOf('@')
    if (lastAt <= 0) continue
    const name = id.slice(0, lastAt)
    const version = id.slice(lastAt + 1)
    packages.push({ name, version, purl: `pkg:npm/${encodeURIComponent(name)}@${version}` })
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    components: packages.map(pkg => ({
      type: 'library' as const,
      name: pkg.name,
      version: pkg.version,
      purl: pkg.purl,
    })),
  }
}

const lockfilePath = process.argv[2] ?? resolve(ROOT, 'pnpm-lock.yaml')
const outputPath = process.argv[3] ?? resolve(ROOT, 'sbom.json')
const sbom = generateSbom(lockfilePath)
writeFileSync(outputPath, JSON.stringify(sbom, null, 2) + '\n')
const components = (sbom as { components: unknown[] }).components.length
process.stdout.write(`verify-sbom: ${String(components)} packages written to ${outputPath}\n`)
