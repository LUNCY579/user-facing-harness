/**
 * Baseline secret-shape redaction: exported records must not carry
 * secret-shaped strings in attribute values or the body payload, and clean
 * records must pass through untouched.
 * @module packages/session/session-telemetry-otel/tests/redaction.spec
 */

import { describe, expect, it } from 'vitest'
import { redactSecretShapes } from '@deepseek-ai/dsh-session-telemetry'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

function record(body: unknown, attributes: Record<string, string | number> = {}): SessionTelemetryRecord {
  return { channel: 'ledger', time: 0, severity: 'info', attributes, body }
}

describe('redactSecretShapes', () => {
  it('redacts secret-shaped strings in the body at any depth', () => {
    const redacted = redactSecretShapes(record({
      note: 'key is sk-abcdefghijklmnopqrstuvwx',
      nested: { token: 'ghp_abcdefghijklmnopqrst', list: ['x', { jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c' }] },
    }))
    const body = redacted.body as { note: string; nested: { token: string; list: unknown[] } }
    expect(body.note).toBe('key is [REDACTED:openai-key]')
    expect(body.nested.token).toBe('[REDACTED:github-token]')
    expect(JSON.stringify(body.nested.list)).toContain('[REDACTED:jwt]')
    expect(JSON.stringify(redacted)).not.toContain('ghp_')
  })

  it('redacts attribute strings and redacts a PEM block with its body', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'
    const redacted = redactSecretShapes(record('plain', { 'error.message': `failed with ${pem}` }))
    expect(redacted.attributes['error.message']).toContain('[REDACTED:pem-private-key]')
    expect(redacted.attributes['error.message']).not.toContain('BEGIN RSA')
  })

  it('passes a clean record through untouched (same reference)', () => {
    const clean = record({ text: 'no secrets here', count: 3 }, { 'session.id': 's1' })
    expect(redactSecretShapes(clean)).toBe(clean)
  })

  it('keeps non-credential lookalikes and fails closed on the walk budget', () => {
    let deep: Record<string, unknown> = { a: 1 }
    for (let level = 0; level < 30; level += 1) deep = { a: deep }
    const hostile = record({
      bypass: 'SSL_BYPASS=1 and TEST_PASSED are not credentials',
      deep,
      big: Array.from({ length: 6000 }, (_, i) => ({ v: `x${String(i)}` })),
    })
    const redacted = redactSecretShapes(hostile)
    expect((redacted.body as { bypass: string }).bypass).toContain('SSL_BYPASS')
    // The node budget stopped the walk without throwing; the unreachable tail
    // is replaced with a marker instead of passing through unredacted.
    const big = (redacted.body as { big: unknown[] }).big
    expect(big).toHaveLength(6000)
    expect((big[0] as { v: string }).v).toBe('x0')
    expect(big.at(-1)).toBe('[REDACTED:walk-budget]')
    expect((redacted.body as { deep: unknown }).deep).toBeDefined()
  })
})
