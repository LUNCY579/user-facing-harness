/**
 * Trajectory fold coverage: turns and steps, redaction on every text surface,
 * tool pairing, usage projection, and the excluded event classes.
 * @module packages/session-query/session-log-export/tests/trajectory.host.spec
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { formatSessionTrajectory } from '../src/trajectory.ts'

const messageId = (value: string): MessageId => brandString<MessageId>(value)
const callId = (value: string): ToolCallId => brandString<ToolCallId>(value)
const sequence = (value: number): SessionSeq => brandNumber<SessionSeq>(value)

function start(seq: number, turn: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: sequence(seq), time: seq, data: { turn } }
}

function stepStart(seq: number, turn: number, step: number): SessionEvent<'step/start'> {
  return { type: 'step/start', seq: sequence(seq), time: seq, data: { turn, step } }
}

function stepEnd(seq: number, turn: number, step: number): SessionEvent<'step/end'> {
  return { type: 'step/end', seq: sequence(seq), time: seq, data: { turn, step } }
}

function end(seq: number, turn: number): SessionEvent<'turn/end'> {
  return { type: 'turn/end', seq: sequence(seq), time: seq, data: { turn, reason: { kind: 'completed' } } }
}

function user(seq: number, text: string): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: sequence(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      role: 'user',
      id: messageId(`user-${String(seq)}`),
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  }
}

function assistant(
  seq: number,
  content: ContentBlock[],
  options: { readonly usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }; readonly interrupted?: true } = {},
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: sequence(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        id: messageId(`assistant-${String(seq)}`),
        source: { kind: 'model', provider: 'test', model: 'test' },
        content,
      },
      stream: [],
      ...options,
    },
  }
}

function toolCall(seq: number, id: string, name: string, argumentsText: string): SessionEvent<'tool/call'> {
  return {
    type: 'tool/call',
    seq: sequence(seq),
    time: seq,
    data: { turn: 1, step: 1, callId: callId(id), name, arguments: argumentsText },
  }
}

function toolResult(
  seq: number,
  id: string,
  text: string,
  options: { readonly isError?: boolean; readonly reason?: string } = {},
): SessionEvent<'tool/result'> {
  return {
    type: 'tool/result',
    seq: sequence(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        id: messageId(`result-${String(seq)}`),
        source: { kind: 'tool', callId: callId(id) },
        toolCallId: callId(id),
        content: [{ type: 'text', text }],
        ...options.isError === true ? { isError: true } : {},
      },
      ...options.reason === undefined
        ? {}
        : { error: { name: 'ToolError', code: 'TOOL_FAILED', reason: options.reason } },
    },
  }
}

describe('formatSessionTrajectory', () => {
  it('folds turns, steps, tool pairing, and usage into the redacted structure', () => {
    const trajectory = formatSessionTrajectory([
      start(1, 0),
      stepStart(2, 0, 0),
      user(3, 'list the files'),
      assistant(4, [
        { type: 'text', text: 'Checking.' },
        { type: 'tool-call', id: callId('c1'), name: 'bash', arguments: '{"command":"ls -la"}' },
      ], { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      toolCall(5, 'c1', 'bash', '{"command":"ls -la"}'),
      toolResult(6, 'c1', 'a.txt', { isError: true, reason: 'sandbox denied' }),
      stepEnd(7, 0, 0),
      assistant(8, [{ type: 'text', text: 'a.txt is the only file.' }], { usage: { inputTokens: 8, outputTokens: 3 } }),
      end(9, 0),
    ], { id: 'session-1', createdAt: 1700000000000, cwd: '/workspace' })

    expect(trajectory.schema).toBe('dsh.session-trajectory')
    expect(trajectory.version).toBe(1)
    expect(trajectory.session).toEqual({ id: 'session-1', title: '', createdAt: 1700000000000, cwd: '/workspace' })
    expect(trajectory.turns).toHaveLength(1)
    const turn = trajectory.turns[0]!
    expect(turn.index).toBe(0)
    expect(turn.steps).toHaveLength(2)
    const first = turn.steps[0]!
    expect(first.startedAt).toBe(2)
    expect(first.endedAt).toBe(7)
    expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(first.entries.map(entry => entry.kind)).toEqual(['user', 'assistant', 'tool-result'])
    const assistantEntry = first.entries[1]!
    expect(assistantEntry).toMatchObject({ kind: 'assistant', text: 'Checking.', toolCalls: [{ callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' }] })
    const result = first.entries[2]!
    expect(result).toMatchObject({ kind: 'tool-result', callId: 'c1', name: 'bash', text: 'a.txt', isError: true, error: { name: 'ToolError', code: 'TOOL_FAILED', reason: 'sandbox denied' } })
    expect(turn.steps[1]!.usage).toEqual({ inputTokens: 8, outputTokens: 3 })
  })

  it('redacts secret-shaped strings on every text surface', () => {
    const trajectory = formatSessionTrajectory([
      start(1, 0),
      stepStart(2, 0, 0),
      user(3, 'my key is sk-abcdefghijklmnopqrstuvwx'),
      assistant(4, [
        { type: 'text', text: 'trying ghp_abcdefghijklmnopqrst' },
        { type: 'tool-call', id: callId('c1'), name: 'bash', arguments: '{"command":"curl -H auth: glpat-abcdefghijklmnopqrst"}' },
      ]),
      toolResult(5, 'c1', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', { isError: true, reason: 'denied: AIzaSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS' }),
      end(6, 0),
    ], { id: 'session-2' })
    const serialized = JSON.stringify(trajectory)
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrst')
    expect(serialized).not.toContain('glpat-abcdefghijklmnopqrst')
    expect(serialized).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(serialized).not.toContain('AIzaSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS')
    expect(serialized).toContain('[REDACTED:')
  })

  it('names a tool result whose tool/call event is absent', () => {
    const trajectory = formatSessionTrajectory([
      start(1, 0),
      stepStart(2, 0, 0),
      toolResult(3, 'c9', 'done'),
      end(4, 0),
    ])
    expect(trajectory.turns[0]?.steps[0]?.entries[0]).toMatchObject({ kind: 'tool-result', callId: 'c9', name: 'unknown', isError: false })
  })

  it('excludes injected context, titles carry redaction, and empty logs fold to a turn-less trajectory', () => {
    const trajectory = formatSessionTrajectory([])
    expect(trajectory.turns).toEqual([])
    expect(trajectory.session.title).toBe('')
  })
})
