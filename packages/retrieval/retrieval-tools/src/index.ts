/**
 * Consumer side of the retrieval seam. Mounting `@deepseek-ai/dsh-retrieval-tools` registers the
 * model-facing memory and search tools and, when configured, retrieves before a turn's first model
 * request. Identity comes from the configured local principal and the calling Agent's canonical
 * original Session workspace, so no tool argument can select another workspace, session, or user.
 * @module @deepseek-ai/dsh-retrieval-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { userInfo } from 'node:os'
import { RetrievalError, tokenOf } from '@deepseek-ai/dsh-retrieval'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type { Grants } from './identity.ts'
import { createIdentityResolver } from './identity.ts'
import { installAutoRetrieval } from './auto.ts'
import type { AutoConfig } from './auto.ts'
import { registerPortabilityCommands } from './portability.ts'
import { registerRetrievalTools } from './tools.ts'

export type {} from './auto.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'retrieval-tools'

/** Host services this plugin consumes. Both retrieval services must mount before it does. */
export const inject = ['retrieval', 'retrievalIndexing', 'tools', 'fs']

/** Tool and automatic-retrieval configuration. */
export interface Config {
  /**
   * Trusted local principal, resolved from this host by {@link principalOf} when a profile omits
   * it; use separate profiles/stores for different operating-system users.
   */
  localPrincipal: string
  /** Passages returned when a search omits top_k. */
  defaultSearchTopK: number
  /** Memories listed when memory_search omits limit. */
  defaultMemoryLimit: number
  /** Register the memory and search tools. */
  enableTools: boolean
  /** Append retrieved passages to a turn's first step. */
  autoRetrieval: boolean
  /** Passage ceiling for one automatic query. */
  autoTopK: number
  /** Relevance floor below which automatic retrieval injects nothing. */
  autoMinScore: number
  /** Token ceiling for one automatic injection. */
  autoBudgetTokens: number
  /** Automatic retrieval skips requests shorter than this many characters. */
  autoMinQueryChars: number
}

/**
 * Resolve the trusted local principal from host facts, in the order the operator can verify.
 * @param username - the account name of the mounting uid, or `undefined` when no account record
 *   names it — `os.userInfo` throws there, so containers and CI sandboxes reach the later facts.
 * @param env - the environment of the mounting process.
 * @param uid - the numeric uid, or `undefined` on a platform without one.
 * @returns a label stable for this local operator across restarts.
 * @throws RetrievalError when no host fact names a principal, since memory ownership would then be
 *   unattributable and a mount must not guess one.
 */
export function principalOf(
  username: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  uid: number | undefined,
): string {
  if (username !== undefined && username.length > 0) return username
  const login = env.USER ?? env.USERNAME
  if (login !== undefined && login.length > 0) return login
  if (uid !== undefined) return `uid-${uid}`
  throw new RetrievalError('invalid_input', 'Cannot resolve a local principal from this host; set localPrincipal explicitly.')
}

/** Resolve the {@link Config} default without a host lookup at module load. */
function defaultLocalPrincipal(): string {
  let username: string | undefined
  try {
    username = userInfo().username
  } catch (_error) {
    /* os.userInfo throws when this uid has no account record; the login environment is the next fact. */
  }
  return principalOf(username, process.env, process.getuid?.())
}

/** Loader schema for {@link Config}. */
export const Config: z<Partial<Config>, Config> = z.object({
  localPrincipal: z.lazy(() => z.string().min(1).default(defaultLocalPrincipal())),
  defaultSearchTopK: z.natural().min(1).default(6),
  defaultMemoryLimit: z.natural().min(1).default(20),
  enableTools: z.boolean().default(true),
  autoRetrieval: z.boolean().default(false),
  autoTopK: z.natural().min(1).max(20).default(4),
  autoMinScore: z.number().min(0).max(1).default(0.35),
  autoBudgetTokens: z.natural().min(64).default(600),
  autoMinQueryChars: z.natural().min(1).default(24),
})

/**
 * Register the retrieval tools, the operator portability commands, and, when configured, automatic
 * retrieval.
 * @param ctx - scope that resolved the retrieval services.
 * @param config - resolved plugin configuration.
 * @returns after existing agent identities are captured and effect-owned registrations are installed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const commands = ctx.retrieval.config.portabilityEnabled ? ctx.get('commands') : undefined
  if (!config.enableTools && !config.autoRetrieval && commands === undefined) return
  if (config.autoRetrieval && config.autoTopK > ctx.retrieval.config.maxTopK) {
    throw new RetrievalError('invalid_input', 'autoTopK must not exceed retrieval.maxTopK')
  }
  const grants: Grants = {
    ownerKey: tokenOf('user', config.localPrincipal),
    crossSessionRead: ctx.retrieval.config.crossSessionRead,
    persistentMemory: ctx.retrieval.config.persistentMemory,
  }
  const identity = await createIdentityResolver(ctx, grants)
  if (config.enableTools) registerRetrievalTools(ctx, identity, config)
  if (commands !== undefined) registerPortabilityCommands(ctx, commands, identity)
  const auto: AutoConfig = {
    enabled: config.autoRetrieval,
    topK: config.autoTopK,
    minScore: config.autoMinScore,
    budgetTokens: config.autoBudgetTokens,
    minQueryChars: config.autoMinQueryChars,
  }
  installAutoRetrieval(ctx, auto, identity)
}
