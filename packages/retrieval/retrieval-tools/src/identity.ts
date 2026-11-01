/**
 * Identity resolution for retrieval calls. Every field is derived from a host fact — the configured
 * principal and calling Agent's original Session workspace — so a model cannot widen its authority by
 * naming a workspace, a session, or a user.
 * @module @deepseek-ai/dsh-retrieval-tools/identity
 */

import type { Context } from '@deepseek-ai/cordis'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { RetrievalError, tokenOf, type OwnerKey, type TrustedIdentity } from '@deepseek-ai/dsh-retrieval'

/** Scope grants carried into every identity from plugin and engine config, never from a caller. */
export interface Grants {
  /** Local host principal configured by the operator, never by a tool call. */
  ownerKey: OwnerKey
  /** Lets the caller read records owned by other sessions. */
  crossSessionRead: boolean
  /** Lets the caller read and write `user` scope records, which outlive this workspace. */
  persistentMemory: boolean
}

/**
 * Resolve one agent's fixed host identity while honoring call cancellation.
 * @param agent - host-attributed calling agent.
 * @param signal - cancellation of the current operation.
 * @returns its captured identity, after verifying the original workspace target.
 */
export type ResolveIdentity = (agent: Agent, signal?: AbortSignal) => Promise<TrustedIdentity>

/**
 * Capture original workspace ownership before an agent runs; reject a later symlink retarget.
 * @param ctx - scope owning the resolver and its lifecycle listener.
 * @param grants - trusted local principal and permissions.
 * @returns a resolver shared by explicit tools and automatic retrieval.
 */
export async function createIdentityResolver(ctx: Context, grants: Grants): Promise<ResolveIdentity> {
  const identities = new WeakMap<Agent, Promise<TrustedIdentity>>()
  const resolve: ResolveIdentity = async (agent, signal) => {
    signal?.throwIfAborted()
    let pending = identities.get(agent)
    if (pending === undefined) {
      pending = identityOf(ctx, agent, grants)
      identities.set(agent, pending)
    }
    const identity = await pending
    const path = agent.session.header.cwd
    if (path === undefined || await realpath(path) !== identity.workspaceRoot) {
      throw new RetrievalError('path_escape', 'The original session workspace target changed; open a new session')
    }
    await requireLocalWorkspace(ctx, path, identity.workspaceRoot, signal)
    signal?.throwIfAborted()
    return identity
  }
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (agent.session.header.cwd !== undefined) await resolve(agent, signal)
  })
  await Promise.all((ctx.get('agents')?.list() ?? [])
    .filter(agent => agent.session.header.cwd !== undefined).map(agent => resolve(agent)))
  return resolve
}

/**
 * Build the caller identity for one retrieval call.
 * @param ctx - calling scope with the filesystem execution world.
 * @param agent - the calling agent.
 * @param grants - host-side scope grants for this mount.
 * @param signal - cancellation of the enclosing call.
 * @returns an identity whose keys are digests of host facts only.
 */
export async function identityOf(
  ctx: Context,
  agent: Agent,
  grants: Grants,
  signal?: AbortSignal,
): Promise<TrustedIdentity> {
  signal?.throwIfAborted()
  const initialCwd = agent.session.header.cwd
  if (initialCwd === undefined) throw new RetrievalError('unauthorized', 'Retrieval requires a session workspace')
  const cwd = await realpath(initialCwd)
  signal?.throwIfAborted()
  if (resolve(initialCwd) !== cwd) {
    throw new RetrievalError('path_escape', `Retrieval requires a canonical original workspace path; select ${cwd} and open a new session`)
  }
  await requireLocalWorkspace(ctx, initialCwd, cwd, signal)
  signal?.throwIfAborted()
  const sessionId = String(agent.session.id)
  const agentId = String(agent.id)
  return {
    ownerKey: grants.ownerKey,
    workspaceRoot: cwd,
    workspaceKey: tokenOf('ws', cwd),
    sessionKey: tokenOf('se', sessionId),
    agentKey: tokenOf('ag', agentId),
    allowCrossSession: grants.crossSessionRead,
    allowUserScope: grants.persistentMemory,
  }
}

/** Require the current filesystem provider to identify the same host directory before retrieval. */
async function requireLocalWorkspace(ctx: Context, original: string, canonical: string, signal?: AbortSignal): Promise<void> {
  const fs = ctx.fs
  const mapped = fs.processPathFromHostPath(canonical)
  if (mapped === undefined) throw new RetrievalError('unauthorized', 'Local retrieval requires a filesystem that shares the host workspace')
  const target = await fs.resolve(original, signal === undefined ? {} : { signal })
  if (fs.processPath(target) !== mapped) {
    throw new RetrievalError('unauthorized', 'The session filesystem does not map to the authorized host workspace')
  }
}

/**
 * The calling agent, or a failure when a call arrives outside an agent context.
 * @param agent - the agent recorded on the execution, when the loop set one.
 * @param tool - tool name quoted in the refusal.
 * @returns the agent.
 */
export function requireAgent(agent: Agent | undefined, tool: string): Agent {
  if (agent === undefined) throw new RetrievalError('unauthorized', `${tool} requires a calling agent`)
  return agent
}
