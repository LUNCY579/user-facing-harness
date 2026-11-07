/**
 * Trajectory Fetch route coverage: authenticated registration, redacted JSON
 * shape, HEAD semantics, missing-session status, and fiber-scoped removal.
 * @module packages/session-query/session-log-export/tests/trajectory-route.host.spec
 */

import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, onTestFinished } from 'vitest'
import { apply, inject } from '../src/index.ts'
import { SESSION_TRAJECTORY_EXPORT_PATH } from '../src/routes.ts'

const SESSION_ID = 'session-trajectory-route' as SessionId

const HEADER: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SESSION_ID,
  createdAt: 1700000000000,
  isSeeded: false,
  cwd: '/workspace',
  delegationDepth: 0,
}

const EVENTS: SessionEvent[] = [
  { type: 'turn/start', seq: brandNumber<SessionSeq>(1), time: 1, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: brandNumber<SessionSeq>(2),
    time: 2,
    surfaceOp: 'append',
    data: {
      role: 'user',
      id: brandString<MessageId>('message-1'),
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'my key is sk-abcdefghijklmnopqrstuvwx' }],
    },
  },
  {
    type: 'assistant/message',
    seq: brandNumber<SessionSeq>(3),
    time: 3,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        id: brandString<MessageId>('message-2'),
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: 'Route answer' }],
      },
      stream: [],
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    },
  },
  { type: 'turn/end', seq: brandNumber<SessionSeq>(4), time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
]

function missingSessionError(): Error {
  return Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
}

function query(readSession?: (id: SessionId) => Promise<unknown>): unknown {
  return { readSession: readSession ?? (async () => ({ session: HEADER, inheritedEventCount: 0, events: EVENTS })) }
}

async function mounted(sessionQuery: unknown): Promise<{
  readonly shared: ReturnType<HostConnectionService['createSharedFetchHandler']>
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('commands', { register: () => () => {} } as never)
  if (sessionQuery !== undefined) ctx.provide('sessionQuery', sessionQuery as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return {
    shared: connection.createSharedFetchHandler('/api'),
    connection,
    dispose: () => fiber.dispose(),
  }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://host${path}`, init)
}

describe('Session trajectory Fetch route', () => {
  it('serves the redacted trajectory with session identity and usage', async () => {
    const { shared, connection, dispose } = await mounted(query())
    const response = await shared.fetch(
      request(`${SESSION_TRAJECTORY_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const trajectory = await response.json() as {
      schema: string
      version: number
      session: { id: string; title: string; createdAt: number; cwd: string }
      turns: Array<{ steps: Array<{ usage?: { totalTokens: number }; entries: Array<{ kind: string; text?: string }> }> }>
    }
    expect(trajectory.schema).toBe('dsh.session-trajectory')
    expect(trajectory.version).toBe(1)
    expect(trajectory.session).toEqual({ id: SESSION_ID, title: '', createdAt: 1700000000000, cwd: '/workspace' })
    expect(trajectory.turns[0]?.steps[0]?.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 })
    // The operator's pasted credential must not reach the export.
    const serialized = JSON.stringify(trajectory)
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(serialized).toContain('[REDACTED:openai-key]')
    await dispose()
  })

  it('answers HEAD with the same status and no body', async () => {
    const { shared, connection, dispose } = await mounted(query())
    const head = await shared.fetch(
      request(`${SESSION_TRAJECTORY_EXPORT_PATH}?sessionId=${SESSION_ID}`, { method: 'HEAD' }),
      connection.browserPeer,
    )
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(head.body).toBeNull()
    await dispose()
  })

  it('rejects a missing sessionId and an unknown session', async () => {
    const { shared, connection, dispose } = await mounted(query(async (id) => {
      if (id !== SESSION_ID) throw missingSessionError()
      return { session: HEADER, inheritedEventCount: 0, events: EVENTS }
    }))
    const missingParameter = await shared.fetch(request(SESSION_TRAJECTORY_EXPORT_PATH), connection.browserPeer)
    expect(missingParameter.status).toBe(400)

    const unknown = await shared.fetch(
      request(`${SESSION_TRAJECTORY_EXPORT_PATH}?sessionId=no-such-session`),
      connection.browserPeer,
    )
    expect(unknown.status).toBe(404)
    await dispose()
  })

  it('maps a missing session-query service to unavailability and removes the route with the fiber', async () => {
    const { shared, connection, dispose } = await mounted(undefined)
    const unavailable = await shared.fetch(
      request(`${SESSION_TRAJECTORY_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )
    expect(unavailable.status).toBe(500)
    expect(await unavailable.text()).toBe('session trajectory export is unavailable: missing session-query service')
    await dispose()

    // The route leaves with the plugin fiber: the shared handler answers 404.
    const gone = await shared.fetch(
      request(`${SESSION_TRAJECTORY_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )
    expect(gone.status).toBe(404)
  })
})
