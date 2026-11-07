/** Verdict rules for the native retrieval platform lane: what a lane may tolerate and what it must report. */
import { describe, expect, it } from 'vitest'
import {
  expectationsOf, isTurbovecCase, laneViolations, smokeViolations, SUPPORTED_PLATFORMS,
  type LaneCase, type LaneRun, type SmokeOutcome,
} from './native-retrieval-verdict.ts'

/**
 * Build one reported case.
 * @param title - case title.
 * @param status - status the reporter recorded.
 * @param ancestors - enclosing suite titles, outermost first.
 * @returns a case as the lane reads it.
 */
function item(title: string, status: string, ancestors: string[] = ['zvec retrieval']): LaneCase {
  return { fullName: [...ancestors, title].join(' > '), status, ancestorTitles: ancestors }
}

/**
 * Build a suite report from a case list.
 * @param cases - collected cases.
 * @param failures - suites that could not load.
 * @returns a run as the lane reads it.
 */
function run(cases: LaneCase[], failures = 0): LaneRun {
  const byFile = new Map<string, LaneCase[]>()
  for (const one of cases) byFile.set(one.ancestorTitles[0] ?? 'suite', [...(byFile.get(one.ancestorTitles[0] ?? 'suite') ?? []), one])
  return {
    numFailedTestSuites: failures,
    numTotalTests: cases.length,
    testResults: [...byFile.values()].map(assertionResults => ({ assertionResults })),
  }
}

/** A smoke result that proves native retrieval served the built entries. */
const healthySmoke: SmokeOutcome = {
  platform: 'linux-x64', backend: 'zvec', documents: 2, space: 'sp:0123456789abcdef01234567',
  semanticHits: 3, reopenedHits: 1, forgotten: 2,
}

/** Required linux x64 lane promises without turbovec provisioning. */
const required = { platform: 'linux', arch: 'x64', required: true, turbovecProvisioned: false }

describe('native retrieval lane verdict', () => {
  it('names the platform-and-architecture pairs the matrix supports and reads provisioning from the environment', () => {
    expect(SUPPORTED_PLATFORMS).toEqual(['linux-x64', 'linux-arm64', 'darwin-arm64'])
    expect(expectationsOf({}, 'linux', 'x64')).toEqual({ ...required, arch: 'x64', platform: 'linux' })
    expect(expectationsOf({ DSH_TEST_TURBOVEC_PYTHON: '/venv/bin/python' }, 'linux', 'x64').turbovecProvisioned).toBe(true)
    expect(expectationsOf({}, 'win32', 'x64').required).toBe(false)
    expect(expectationsOf({}, 'linux', 'armv7l').required).toBe(false)
  })

  it('classifies only turbovec suites as optional skips', () => {
    expect(isTurbovecCase(item('scores stable ids', 'skipped', ['real turbovec']))).toBe(true)
    expect(isTurbovecCase(item('reconciles memories', 'skipped', ['turbovec memory reconciliation']))).toBe(true)
    expect(isTurbovecCase(item('rejects a foreign workspace', 'skipped', ['zvec retrieval']))).toBe(false)
  })

  it('accepts a required lane whose cases all passed and whose entries served retrieval', () => {
    const cases = [item('answers a semantic query', 'passed'), item('reopens the collection', 'passed')]
    expect(laneViolations({
      run: run(cases), suiteExitCode: 0, smoke: healthySmoke, smokeError: '', expectations: required,
    })).toEqual([])
  })

  it('reports an unexecuted case on a required platform instead of treating a skip as success', () => {
    const cases = [item('answers a semantic query', 'passed'), item('holds one writer lease', 'skipped', ['zvec security'])]
    const violations = laneViolations({
      run: run(cases), suiteExitCode: 0, smoke: healthySmoke, smokeError: '', expectations: required,
    })
    expect(violations).toEqual(['zvec security > holds one writer lease was skipped on required platform linux-x64'])
  })

  it('tolerates turbovec skips only while the lane did not provision turbovec', () => {
    const cases = [item('scores stable ids', 'skipped', ['real turbovec'])]
    const withoutProvisioning = { run: run(cases), suiteExitCode: 0, smoke: healthySmoke, smokeError: '', expectations: required }
    expect(laneViolations(withoutProvisioning)).toEqual([])
    expect(laneViolations({ ...withoutProvisioning, expectations: { ...required, turbovecProvisioned: true } }))
      .toEqual(['real turbovec > scores stable ids was skipped while turbovec was provisioned on linux-x64'])
  })

  it('fails a provisioned lane whose turbovec cases did not run to completion', () => {
    const cases = [item('scores stable ids', 'passed', ['real turbovec']), item('reconciles memories', 'todo', ['turbovec memory reconciliation'])]
    expect(laneViolations({
      run: run(cases), suiteExitCode: 0, smoke: healthySmoke, smokeError: '',
      expectations: { ...required, turbovecProvisioned: true },
    })).toEqual(['turbovec memory reconciliation > reconciles memories was todo while turbovec was provisioned on linux-x64'])
  })

  it('fails a provisioned lane that collected no turbovec case at all', () => {
    expect(laneViolations({
      run: run([item('answers a semantic query', 'passed')]), suiteExitCode: 0, smoke: healthySmoke, smokeError: '',
      expectations: { ...required, turbovecProvisioned: true },
    })).toEqual(['the lane provisioned turbovec but collected no turbovec case on linux-x64'])
  })

  it('reports missing native dependencies and an empty case list as failures', () => {
    const input = { suiteExitCode: 1, smoke: healthySmoke, smokeError: '', expectations: required }
    expect(laneViolations({ ...input, run: run([], 2) })).toEqual([
      '2 native suite(s) failed to load on linux-x64',
      'no native retrieval case was collected on linux-x64',
      'the native retrieval suites exited with code 1 on linux-x64',
    ])
    expect(laneViolations({ ...input, run: null })).toEqual(['the native retrieval suites produced no case report on linux-x64'])
  })

  it('reports a failing suite even where the platform is untested', () => {
    const cases = [item('answers a semantic query', 'failed'), item('kills an oversized response', 'skipped')]
    const violations = laneViolations({
      run: run(cases), suiteExitCode: 1, smoke: healthySmoke, smokeError: '',
      expectations: { ...required, required: false, platform: 'win32' },
    })
    expect(violations).toContain('zvec retrieval > answers a semantic query failed on win32-x64')
    expect(violations).toContain('the native retrieval suites exited with code 1 on win32-x64')
    expect(violations).not.toContain('zvec retrieval > kills an oversized response was skipped on required platform win32-x64')
  })

  it('separates an install that disabled retrieval from one that serves native retrieval', () => {
    expect(smokeViolations({ ...healthySmoke, backend: 'disabled' }, '', 'linux-x64'))
      .toEqual(['built entries mounted backend disabled instead of zvec on linux-x64'])
    expect(smokeViolations({ ...healthySmoke, documents: 0, space: null }, '', 'linux-x64'))
      .toEqual(['the native collection held 0 records after two writes on linux-x64'])
    expect(smokeViolations({ ...healthySmoke, semanticHits: 0 }, '', 'linux-x64'))
      .toEqual(['a semantic query returned no native evidence on linux-x64'])
    expect(smokeViolations({ ...healthySmoke, reopenedHits: 0 }, '', 'linux-x64'))
      .toEqual(['the reopened collection answered no keyword query on linux-x64'])
    expect(smokeViolations({ ...healthySmoke, forgotten: 0 }, '', 'linux-x64'))
      .toEqual(['a scoped forget removed nothing on linux-x64'])
  })

  it('reports a smoke that produced no result or exited with a native binding error', () => {
    expect(smokeViolations(null, '', 'linux-x64')).toEqual(['the built-entry smoke produced no result on linux-x64'])
    expect(smokeViolations(null, 'Cannot find module \'@zvec/bindings-linux-x64\'', 'linux-x64'))
      .toEqual(["the built-entry smoke failed on linux-x64: Cannot find module '@zvec/bindings-linux-x64'"])
  })
})
