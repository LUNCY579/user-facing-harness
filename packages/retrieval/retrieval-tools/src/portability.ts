/**
 * Operator-run memory portability commands. Moving memories between host installations is a trusted
 * maintenance action, so it is a human command rather than a model tool: identity comes from the
 * receiving Agent, and each result reports counts, record ids, and space keys instead of memory texts,
 * which stay inside the export file. A failing command throws, and the command registry records its
 * message as the error result.
 * @module @deepseek-ai/dsh-retrieval-tools/portability
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ResolveIdentity } from './identity.ts'

/** Flag that adds expired and superseded rows to an export so the target keeps lifecycle history. */
const INACTIVE_FLAG = '--include-inactive'

/** One accepted `/memory-export` argument list. */
interface ExportArguments {
  /** Export file name below the configured portability directory. */
  name: string
  /** Whether inactive rows join the export. */
  includeInactive: boolean
}

/**
 * Register the memory export and import commands.
 * @param ctx - scope that resolved the retrieval service.
 * @param commands - the host's command registry, already resolved by the caller.
 * @param resolveIdentity - host-owned identity resolver shared with the retrieval tools.
 * @returns nothing; each registration is an effect owned by this scope.
 */
export function registerPortabilityCommands(
  ctx: Context,
  commands: NonNullable<Context['commands']>,
  resolveIdentity: ResolveIdentity,
): void {
  ctx.effect(() => commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-retrieval-tools/memory-export'),
    name: 'memory-export',
    description: 'Export the memories this caller may read to a file below the portability directory',
    input: { hint: `<file-name> [${INACTIVE_FLAG}]` },
    handler: async invocation => await runExport(ctx, resolveIdentity, invocation),
  }))
  ctx.effect(() => commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-retrieval-tools/memory-import'),
    name: 'memory-import',
    description: 'Import one export file, re-embedding it into the current store',
    input: { hint: '<file-name>' },
    handler: async invocation => await runImport(ctx, resolveIdentity, invocation),
  }))
}

async function runExport(ctx: Context, resolveIdentity: ResolveIdentity, invocation: CommandInvocation): Promise<CommandResult> {
  const args = parseExportArguments(invocation.rawInput)
  if (args === undefined) return { kind: 'error', text: `Usage: /memory-export <file-name> [${INACTIVE_FLAG}]` }
  const identity = await resolveIdentity(invocation.agent, invocation.signal)
  const envelope = await ctx.retrieval.exportMemories(
    identity, { path: args.name, includeInactive: args.includeInactive }, invocation.signal,
  )
  return { kind: 'success', text: `Exported ${String(envelope.records.length)} memories to ${args.name}.` }
}

async function runImport(ctx: Context, resolveIdentity: ResolveIdentity, invocation: CommandInvocation): Promise<CommandResult> {
  const name = singleName(invocation.rawInput)
  if (name === undefined) return { kind: 'error', text: 'Usage: /memory-import <file-name>' }
  const identity = await resolveIdentity(invocation.agent, invocation.signal)
  const report = await ctx.retrieval.importMemories(identity, { path: name }, invocation.signal)
  const outcome = [
    `${String(report.accepted)} accepted`,
    `${String(report.reused)} already present`,
    `${String(report.recovered)} staged by an interrupted import and removed before this attempt`,
  ]
  if (report.sourceSpace !== report.targetSpace) {
    outcome.push(`re-embedded from ${report.sourceSpace} to ${report.targetSpace}`)
  }
  if (report.refused.length > 0) {
    outcome.push(`refused:\n${report.refused.map(entry => `${entry.id}: ${entry.reason}`).join('\n')}`)
  }
  return { kind: 'success', text: `Imported ${name}. ${outcome.join('; ')}.` }
}

/**
 * Read one export file name and the inactive-row flag.
 * @param raw - text following the command name.
 * @returns the arguments, or `undefined` when the line names no file or more than one.
 */
function parseExportArguments(raw: string): ExportArguments | undefined {
  const trimmed = raw.trim()
  const includeInactive = trimmed.endsWith(INACTIVE_FLAG)
  const name = singleName(includeInactive ? trimmed.slice(0, trimmed.length - INACTIVE_FLAG.length) : trimmed)
  return name === undefined ? undefined : { name, includeInactive }
}

/**
 * Read exactly one whitespace-free argument.
 * @param raw - argument text to test.
 * @returns the argument, or `undefined` when it is empty or holds more than one word.
 */
function singleName(raw: string): string | undefined {
  const name = raw.trim()
  return name.length === 0 || /\s/u.test(name) ? undefined : name
}
