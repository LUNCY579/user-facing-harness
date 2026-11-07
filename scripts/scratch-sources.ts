/**
 * Corpus rules for gates that list source trees while the test suite runs beside them.
 * @module scratch-sources
 */

import { readFileSync } from 'node:fs'
import { sep } from 'node:path'

/**
 * Name of a scratch source the Oxlint executable contract owns. That suite writes real `.ts` and
 * `.tsx` files into package `src` and `tests` trees so the linter resolves their owning TypeScript
 * project, then removes them; the names are git-ignored and never reach a commit.
 */
const SCRATCH_PROBE = /(?:^|\/)oxlint-contract-[^/]+\.tsx?$/u

/**
 * Report whether one corpus path is a scratch probe rather than repository content.
 * @param file - repository-relative path with `/` separators, as gates normalize glob results.
 * @returns true when the file belongs to the lint contract suite, whose temporary contents and
 *   absence say nothing about the repository.
 */
export function isScratchProbe(file: string): boolean {
  return SCRATCH_PROBE.test(file)
}

/**
 * Normalize one corpus listing for a gate that reads repository sources.
 * @param paths - raw glob results, in the host's separator form.
 * @returns the `/`-separated paths in sorted order, without the lint contract's scratch probes.
 */
export function corpusListing(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map(path => path.split(sep).join('/')))].filter(path => !isScratchProbe(path)).sort()
}

/**
 * Read a corpus path another process may delete between listing and reading.
 * @param path - absolute path taken from a corpus listing.
 * @returns the file text, or `undefined` when the path is gone.
 * @throws the read failure when it is not a vanished path, so a real defect in the gate or its
 *   fixture still surfaces.
 */
export function readCorpus(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}
