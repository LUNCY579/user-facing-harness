import { Context } from '@deepseek-ai/cordis'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { onTestFinished } from 'vitest'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Config } from '../src/index.ts'
import { COVERAGE_TEST_TIMEOUT_ENV, coverageTestTimeoutOptions } from '../../../../scripts/coverage-partitions.ts'

/** The repository lane's outer test budget, absent for ordinary local runs. */
export const runtimeTestBudget = coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV]).testTimeout

/**
 * Reserve one-third of the case budget for execution and teardown after interpreter validation.
 * @param config - Per-case runtime settings, including intentional probe deadlines.
 * @param testBudget - Lane case budget, or undefined to retain the production probe default.
 * @returns Runtime settings with a bounded startup allowance and explicit per-case overrides.
 */
export function pythonFixtureConfig(config: Config, testBudget: number | undefined): Config {
  return {
    pythonProbeTimeoutMs: testBudget === undefined ? 5_000 : Math.max(1, Math.floor(testBudget * 2 / 3)),
    ...config,
  }
}

/** Mount the Python runtime's policy and confinement providers with owned teardown. */
export async function createRuntimeContext(policy: { mode?: SandboxMode; workspaceRoot?: string } = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  return ctx
}
