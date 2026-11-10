/**
 * Cross-check that every deliberate dependency pin documented in
 * pnpm-workspace.yaml (allowBuilds comments + patchedDependencies) has a
 * corresponding entry in .github/dependabot.yml's ignore list. A pin
 * without an ignore entry produces recurring blocked dependabot PRs that
 * close as noise.
 * @module scripts/verify-dependabot-pins
 */

import { readFileSync } from 'node:fs'

/** Parse the pnpm-workspace.yaml for patched package names and commented pins. */
function extractPins(workspaceText: string): Set<string> {
  const pins = new Set<string>()
  for (const match of workspaceText.matchAll(/^\s+([\w@/.-]+)@\S+:\s/gm)) {
    const pkg = match[1]
    if (pkg !== undefined) pins.add(pkg.split('@')[0] ?? pkg)
  }
  for (const match of workspaceText.matchAll(/^\s*#.*\b(Koffi|lexical)\b.*\d+\.\d/gim)) {
    const name = match[1]
    if (name !== undefined) pins.add(name.toLowerCase())
  }
  return pins
}

/** Parse the dependabot.yml ignore list. */
function extractIgnores(dependabotText: string): Set<string> {
  const ignores = new Set<string>()
  for (const match of dependabotText.matchAll(/^\s*- dependency-name:\s*"([^"]+)"/gm)) {
    const name = match[1]
    if (name !== undefined) ignores.add(name)
  }
  return ignores
}

function inspect(workspacePath: string, dependabotPath: string): { pins: Set<string>; failures: string[] } {
  const workspaceText = readFileSync(workspacePath, 'utf8')
  const dependabotText = readFileSync(dependabotPath, 'utf8')
  const pins = extractPins(workspaceText)
  const ignores = extractIgnores(dependabotText)
  const failures: string[] = []
  for (const pin of pins) {
    const covered = [...ignores].some((ignore) => {
      if (ignore === pin) return true
      if (ignore.endsWith('/*') && pin.startsWith(ignore.slice(0, -2))) return true
      return false
    })
    if (!covered) failures.push(`pnpm pin "${pin}" has no dependabot ignore entry`)
  }
  return { pins, failures }
}

if (process.argv[1] && process.argv[1].includes('verify-dependabot-pins')) {
  const report = inspect('pnpm-workspace.yaml', '.github/dependabot.yml')
  if (report.failures.length > 0) {
    process.stderr.write('verify-dependabot-pins: uncovered dependency pins found:\n')
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`verify-dependabot-pins: ${String(report.pins.size)} pin(s) covered.\n`)
  }
}
