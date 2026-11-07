/**
 * Verdict rules for the native retrieval platform lane. A lane is green only when every collected case
 * passed, every skip is one this platform may explain, the suites loaded, and the built entries opened
 * a real collection and answered before and after a reopen. Turbovec cases are the only skips a lane
 * may keep, and only while it has not provisioned Python; a provisioned lane must see them execute.
 * @module
 */

/** One reported case: the suite chain that owns it and the status the reporter recorded. */
export interface LaneCase {
  /** Suite titles plus the case title, as the reporter spells them. */
  fullName: string
  /** `passed`, `failed`, `skipped`, `pending`, or `todo`. */
  status: string
  /** Titles of the suites containing this case, outermost first. */
  ancestorTitles: string[]
}

/** The reporter's record of one native retrieval run. */
export interface LaneRun {
  /** Suites that could not load or collect, which carry no case list. */
  numFailedTestSuites: number
  /** Cases the reporter saw, counting skipped ones. */
  numTotalTests: number
  /** One entry per collected suite file. */
  testResults: { assertionResults: LaneCase[] }[]
}

/** The built-entry smoke's machine-readable result. */
export interface SmokeOutcome {
  /** `platform-arch` pair the smoke ran on. */
  platform: string
  /** Backend the mounted store reported. */
  backend: string
  /** Records the native collection held after two writes. */
  documents: number
  /** Embedding space key the reopened store served, or `null` when it resolved none. */
  space: string | null
  /** Candidates a semantic query returned. */
  semanticHits: number
  /** Candidates a keyword query returned after a reopen. */
  reopenedHits: number
  /** Records a scoped forget removed. */
  forgotten: number
}

/** What a lane promises about the platform it runs on. */
export interface LaneExpectations {
  /** `process.platform` value of this runner. */
  platform: string
  /** `process.arch` value of this runner. */
  arch: string
  /** True when the support matrix names this pair, so skips and missing bindings are failures. */
  required: boolean
  /** True when the lane exported `DSH_TEST_TURBOVEC_PYTHON`, so turbovec cases must run. */
  turbovecProvisioned: boolean
}

/** Everything a verdict reads. */
export interface LaneInput {
  /** Suite run to judge, or `null` when no report was produced. */
  run: LaneRun | null
  /** Exit code of the suite process, or `null` when it was signalled. */
  suiteExitCode: number | null
  /** Smoke result, or `null` when the smoke produced none. */
  smoke: SmokeOutcome | null
  /** Message the smoke exited with; empty when it exited cleanly. */
  smokeError: string
  /** Platform promises to judge against. */
  expectations: LaneExpectations
}

/** Suites a lane may skip only while turbovec is unprovisioned. */
export const TURBOVEC_SUITES = ['real turbovec', 'turbovec memory reconciliation']

/** Platform-and-architecture pairs whose native retrieval the fork treats as supported. */
export const SUPPORTED_PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64']

/**
 * Resolve one lane's promises from its environment and runner identity.
 * @param environment - process environment the lane runs with.
 * @param platform - `process.platform` value of this runner.
 * @param arch - `process.arch` value of this runner.
 * @returns the expectations a verdict judges against.
 */
export function expectationsOf(environment: NodeJS.ProcessEnv, platform: string, arch: string): LaneExpectations {
  return {
    platform, arch,
    required: SUPPORTED_PLATFORMS.includes(`${platform}-${arch}`),
    turbovecProvisioned: environment.DSH_TEST_TURBOVEC_PYTHON !== undefined,
  }
}

/**
 * Decide whether one reported case belongs to a turbovec suite.
 * @param item - case as the reporter recorded it.
 * @returns true when any enclosing suite is turbovec-only.
 */
export function isTurbovecCase(item: LaneCase): boolean {
  return item.ancestorTitles.some(title => TURBOVEC_SUITES.includes(title))
}

/**
 * Judge the built-entry smoke, whose result comes from a mounted native collection.
 * @param smoke - parsed smoke result, or `null` when the smoke produced none.
 * @param smokeError - message the smoke exited with; empty when it exited cleanly.
 * @param label - `platform-arch` pair to name in every violation.
 * @returns one message per reason the published entries did not serve real retrieval.
 */
export function smokeViolations(smoke: SmokeOutcome | null, smokeError: string, label: string): string[] {
  if (smoke !== null && smokeError === '') {
    const violations: string[] = []
    if (smoke.backend !== 'zvec') violations.push(`built entries mounted backend ${smoke.backend} instead of zvec on ${label}`)
    if (smoke.documents < 2) violations.push(`the native collection held ${String(smoke.documents)} records after two writes on ${label}`)
    if (smoke.semanticHits < 1) violations.push(`a semantic query returned no native evidence on ${label}`)
    if (smoke.reopenedHits < 1) violations.push(`the reopened collection answered no keyword query on ${label}`)
    if (smoke.forgotten < 1) violations.push(`a scoped forget removed nothing on ${label}`)
    return violations
  }
  return [smokeError === ''
    ? `the built-entry smoke produced no result on ${label}`
    : `the built-entry smoke failed on ${label}: ${smokeError}`]
}

/**
 * Collect every reason this lane must report as a failure.
 * @param input - suite run, smoke outcome, and platform promises to judge.
 * @returns one message per violation; empty when the lane may report success.
 */
export function laneViolations(input: LaneInput): string[] {
  const { expectations, run, smoke, smokeError, suiteExitCode } = input
  const label = `${expectations.platform}-${expectations.arch}`
  if (run === null) return [`the native retrieval suites produced no case report on ${label}`]
  const cases = run.testResults.flatMap(file => file.assertionResults)
  const violations: string[] = []
  if (run.numFailedTestSuites > 0) violations.push(`${String(run.numFailedTestSuites)} native suite(s) failed to load on ${label}`)
  if (cases.length === 0) violations.push(`no native retrieval case was collected on ${label}`)
  if (suiteExitCode !== null && suiteExitCode !== 0) violations.push(`the native retrieval suites exited with code ${String(suiteExitCode)} on ${label}`)
  for (const item of cases) {
    if (item.status === 'failed') {
      violations.push(`${item.fullName} failed on ${label}`)
      continue
    }
    if (item.status === 'passed') continue
    if (isTurbovecCase(item)) {
      if (expectations.turbovecProvisioned) {
        violations.push(`${item.fullName} was ${item.status} while turbovec was provisioned on ${label}`)
      }
      continue
    }
    if (!expectations.required) continue
    violations.push(`${item.fullName} was ${item.status} on required platform ${label}`)
  }
  if (expectations.turbovecProvisioned && !cases.some(isTurbovecCase)) {
    violations.push(`the lane provisioned turbovec but collected no turbovec case on ${label}`)
  }
  violations.push(...smokeViolations(smoke, smokeError, label))
  return violations
}
