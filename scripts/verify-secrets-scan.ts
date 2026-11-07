/**
 * Scan recorded fixtures and example content for secret-shaped strings, so a
 * real credential captured into a session snapshot, expected output, demo
 * pack, or example fails the gate instead of shipping in the repository.
 * The scanner is intentionally structural — it looks for the shapes provider
 * keys, OAuth tokens, private keys, and cloud credentials take — not for any
 * specific secret; a match names the file, line, and matched shape, never the
 * matched text.
 * @module scripts/verify-secrets-scan
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Directories whose committed content must stay synthetic. */
const SCAN_ROOTS = ['snapshots', 'demo-pack', 'testing-platform', 'examples'] as const

/** Scanned text extensions; everything else (lockfiles excepted) is out of scope. */
const SCANNED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.ts', '.js', '.sh', '.py'])

/** Lockfiles and manifests are dependency records, not fixtures. */
const SKIPPED_BASENAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'])

/** One secret shape worth one diagnostic; `group` selects the matched text's position when the shape wraps it. */
interface SecretShape {
  /** Diagnostic name, e.g. `OpenAI-style API key`. */
  readonly name: string
  readonly pattern: RegExp
  /** Capture index carrying the secret-looking run; the match alone may include benign fixed text. */
  readonly group?: number
  /** Minimum matched length, so short incidentals do not trip the shape. */
  readonly minLength?: number
}

/** The structural secret shapes the gate recognizes. */
const SHAPES: readonly SecretShape[] = [
  { name: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'DeepSeek API key', pattern: /\bsk-(?:hf|dl)-[A-Za-z0-9]{20,}\b/g },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'PEM private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g },
  {
    name: 'bearer credential in committed text',
    // The /i flag makes A-Z and a-z duplicate ranges per sonarjs; \w- is the folded equivalent.
    pattern: /\b(?:bearer|token|api[_-]?key|secret)\s*[:=]\s*['"]([\w-]{24,})['"]/gi,
    group: 1,
  },
]

/** Result of scanning every committed fixture file. */
export interface SecretsScanReport {
  /** Number of files read. */
  fileCount: number
  /** Repository-relative, shape-only diagnostics; matched text is never echoed. */
  failures: string[]
}

function isScannedPath(relativePath: string): boolean {
  if (SKIPPED_BASENAMES.has(relativePath.split('/').pop() ?? '')) return false
  const dot = relativePath.lastIndexOf('.')
  return dot !== -1 && SCANNED_EXTENSIONS.has(relativePath.slice(dot))
}

/**
 * Scan one text for every shape; each match becomes a `file:line` diagnostic
 * naming the shape. Overlapping matches of the same shape at one position
 * collapse; distinct positions and shapes each report.
 * @param file - repository-relative file name for diagnostics.
 * @param text - the file's text.
 * @returns the file's diagnostics.
 */
export function scanText(file: string, text: string): string[] {
  const failures: string[] = []
  for (const shape of SHAPES) {
    const pattern = new RegExp(shape.pattern.source, shape.pattern.flags)
    for (const match of text.matchAll(pattern)) {
      // Every capture group in SHAPES is mandatory; the fallback only satisfies
      // the indexer type and cannot pass the length floor.
      const candidate = shape.group === undefined ? match[0] : (match[shape.group] ?? '')
      if (shape.minLength !== undefined && candidate.length < shape.minLength) continue
      const line = text.slice(0, match.index).split('\n').length
      failures.push(`${file}:${line}: ${shape.name}`)
    }
  }
  return failures
}

/** Scan every committed fixture under the scan roots. */
export function scanFixtures(root: string = ROOT): SecretsScanReport {
  const files: string[] = []
  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = resolve(root, scanRoot)
    let rootStat
    try {
      rootStat = statSync(absoluteRoot)
    } catch {
      continue
    }
    if (!rootStat.isDirectory()) continue
    for (const entry of readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue
      const relativePath = `${scanRoot}${sep}${relative(absoluteRoot, join(entry.parentPath, entry.name))}`
      if (!isScannedPath(relativePath)) continue
      files.push(relativePath)
    }
  }
  const failures: string[] = []
  for (const file of files) {
    const text = readFileSync(resolve(root, file), 'utf8')
    failures.push(...scanText(relative(ROOT, resolve(root, file)), text))
  }
  return { fileCount: files.length, failures }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const report = scanFixtures()
  if (report.failures.length > 0) {
    process.stderr.write('verify-secrets-scan: secret-shaped strings found in committed fixtures (matched text withheld):\n')
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`verify-secrets-scan: ${String(report.fileCount)} fixture file(s) scanned; no secret-shaped strings.\n`)
  }
}
