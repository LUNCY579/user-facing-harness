/**
 * Pure backend fold of one complete committed Session log into a structured
 * agent trajectory: turns and steps, user entries, assistant entries with
 * tool-call specs, paired tool results with structured failure identities,
 * settled-but-uncommitted model attempts, and per-step token usage.
 * Trajectories are machine-readable training/evaluation material, so every
 * text surface passes the seam's baseline secret-shape redaction before it
 * leaves the process.
 *
 * The raw log is authoritative: compaction surface replacements never remove
 * earlier messages, and fork-inherited history appears once. System and
 * developer prompt renderings, request headers, and runtime records are
 * excluded — a trajectory describes the conversation's behavior, not the
 * harness's instruction text.
 * @module
 */

import type { AssistantMessage, SessionEvent, TokenUsage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { redactSecretsInString, type WalkState } from '@deepseek-ai/dsh-session-telemetry'
import { visibleContent } from './markdown.ts'

/** Discriminates the trajectory artifact for downstream consumers. */
export const SESSION_TRAJECTORY_SCHEMA = 'dsh.session-trajectory'

/** Current {@link SessionTrajectory} layout version. */
export const SESSION_TRAJECTORY_VERSION = 1

/** One tool-call specification as the model issued it. */
export interface TrajectoryToolCall {
  readonly callId: string
  readonly name: string
  /** Raw JSON argument text exactly as the model produced it, redacted. */
  readonly arguments: string
}

/** One structured tool failure identity outside the model-facing content. */
export interface TrajectoryToolError {
  readonly name: string
  readonly code: string
  readonly reason?: string
}

/** One trajectory entry. */
export type TrajectoryEntry =
  | { readonly kind: 'user'; readonly at: number; readonly text: string }
  | { readonly kind: 'assistant'; readonly at: number; readonly text: string; readonly toolCalls: readonly TrajectoryToolCall[] }
  | {
    readonly kind: 'tool-result'
    readonly at: number
    readonly callId: string
    readonly name: string
    readonly text: string
    readonly isError: boolean
    readonly error?: TrajectoryToolError
  }
  | { readonly kind: 'attempt'; readonly at: number; readonly streamEvents: number }

/** One model call plus the tool executions it requested. */
export interface TrajectoryStep {
  readonly index: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly usage?: TokenUsage
  readonly interrupted?: true
  readonly entries: readonly TrajectoryEntry[]
}

/** One user-visible turn. */
export interface TrajectoryTurn {
  readonly index: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly steps: readonly TrajectoryStep[]
}

/** The complete structured trajectory of one Session. */
export interface SessionTrajectory {
  readonly schema: typeof SESSION_TRAJECTORY_SCHEMA
  readonly version: typeof SESSION_TRAJECTORY_VERSION
  readonly session: { readonly id?: string; readonly title: string; readonly createdAt?: number; readonly cwd?: string }
  readonly turns: readonly TrajectoryTurn[]
}

/** Mutable fold accumulators; the public shapes above are frozen copies. */
interface Step {
  index: number
  startedAt: number | undefined
  endedAt: number | undefined
  usage: TokenUsage | undefined
  interrupted: true | undefined
  entries: TrajectoryEntry[]
}

interface Turn {
  index: number
  startedAt: number | undefined
  endedAt: number | undefined
  steps: Step[]
}

interface Fold {
  turns: Turn[]
  turn: Turn | undefined
  step: Step | undefined
  /** callId → tool name, so a result whose `tool/call` was lost still names its tool. */
  names: Map<string, string>
}

const emptyStep = (): Step => ({
  index: 0,
  startedAt: undefined,
  endedAt: undefined,
  usage: undefined,
  interrupted: undefined,
  entries: [],
})

function toolCallsOf(message: AssistantMessage): TrajectoryToolCall[] {
  const calls: TrajectoryToolCall[] = []
  for (const block of message.content) {
    if (block.type === 'tool-call') {
      calls.push({
        callId: String(block.id),
        name: block.name,
        arguments: block.arguments,
      })
    }
  }
  return calls
}

/**
 * Fold one complete committed Session log into a redacted structured
 * trajectory. Pure: no mounted plugin, no storage, no mutation of the
 * supplied events.
 * @param events - complete committed logical event snapshot in seq order, including any inherited prefix.
 * @param meta - optional session identity from the backend-resolved artifact.
 * @returns the trajectory; an empty log yields one turn-less trajectory.
 */
export function formatSessionTrajectory(
  events: readonly SessionEvent[],
  meta: { readonly id?: string; readonly createdAt?: number; readonly cwd?: string } = {},
): SessionTrajectory {
  const state: WalkState = { nodes: Number.MAX_SAFE_INTEGER, changed: false }
  const redact = (value: string): string => redactSecretsInString(value, state)
  const fold: Fold = { turns: [], turn: undefined, step: undefined, names: new Map() }
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        fold.turn = { index: event.data.turn, startedAt: event.time, endedAt: undefined, steps: [] }
        fold.step = undefined
        fold.turns.push(fold.turn)
        break
      case 'turn/end':
        if (fold.turn !== undefined) fold.turn.endedAt = event.time
        fold.turn = undefined
        fold.step = undefined
        break
      case 'step/start':
        fold.step = {
          index: event.data.step,
          startedAt: event.time,
          endedAt: undefined,
          usage: undefined,
          interrupted: undefined,
          entries: [],
        }
        fold.turn?.steps.push(fold.step)
        break
      case 'step/end':
        if (fold.step !== undefined) fold.step.endedAt = event.time
        fold.step = undefined
        break
      case 'user/message': {
        if (event.surfaceOp !== 'append' || event.data.source.kind !== 'user') break
        const text = redact(visibleContent(event.data.content))
        if (text !== '') target(fold).entries.push({ kind: 'user', at: event.time, text })
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') break
        const entry: TrajectoryEntry = {
          kind: 'assistant',
          at: event.time,
          text: redact(visibleContent(event.data.message.content)),
          toolCalls: toolCallsOf(event.data.message).map(call => ({
            ...call,
            arguments: redact(call.arguments),
          })),
        }
        for (const call of entry.toolCalls) fold.names.set(call.callId, call.name)
        const step = target(fold)
        step.entries.push(entry)
        if (event.data.usage !== undefined) step.usage = event.data.usage
        if (event.data.interrupted === true) step.interrupted = true
        break
      }
      case 'assistant/attempt': {
        target(fold).entries.push({ kind: 'attempt', at: event.time, streamEvents: event.data.stream.length })
        break
      }
      case 'tool/call': {
        fold.names.set(String(event.data.callId), redact(event.data.name))
        break
      }
      case 'tool/result': {
        if (event.surfaceOp !== 'append') break
        const callId = String(event.data.message.toolCallId)
        target(fold).entries.push({
          kind: 'tool-result',
          at: event.time,
          callId,
          name: fold.names.get(callId) ?? 'unknown',
          text: redact(visibleContent(event.data.message.content)),
          isError: event.data.message.isError === true,
          ...(event.data.error === undefined ? {} : { error: redactError(event.data.error, redact) }),
        })
        break
      }
      default:
        break
    }
  }
  return {
    schema: SESSION_TRAJECTORY_SCHEMA,
    version: SESSION_TRAJECTORY_VERSION,
    session: {
      ...(meta.id === undefined ? {} : { id: meta.id }),
      title: redact(events.findLast(event => event.type === 'session/title')?.data.title ?? ''),
      ...(meta.createdAt === undefined ? {} : { createdAt: meta.createdAt }),
      ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    },
    turns: fold.turns.map(turn => projectTurn(turn)),
  }
}

/** A user or assistant entry outside any open step lands in a synthetic step 0 so no entry is lost. */
function target(fold: Fold): Step {
  if (fold.step !== undefined) return fold.step
  if (fold.turn === undefined) {
    fold.turn = { index: fold.turns.length, startedAt: undefined, endedAt: undefined, steps: [] }
    fold.turns.push(fold.turn)
  }
  const step = emptyStep()
  fold.turn.steps.push(step)
  fold.step = step
  return step
}

function redactError(
  error: { readonly name: string; readonly code: string; readonly reason?: string },
  redact: (value: string) => string,
): TrajectoryToolError {
  return error.reason === undefined
    ? { name: error.name, code: error.code }
    : { name: error.name, code: error.code, reason: redact(error.reason) }
}

/** Freeze one turn's mutable accumulators into the wire shape. */
function projectTurn(turn: Turn): TrajectoryTurn {
  return {
    index: turn.index,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
    steps: turn.steps.map(step => ({
      index: step.index,
      ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
      ...(step.endedAt === undefined ? {} : { endedAt: step.endedAt }),
      ...(step.usage === undefined ? {} : { usage: step.usage }),
      ...(step.interrupted === undefined ? {} : { interrupted: step.interrupted }),
      entries: step.entries,
    })),
  }
}
