/**
 * Baseline secret-shape redaction for exported session records. The
 * `session-telemetry/record` waterfall ships no rules of its own, so without a
 * listener an uploaded feedback replay carries the session's pasted secrets
 * and tool outputs verbatim. This rule is the backend's last line before
 * export: secret-shaped substrings in the record's attribute strings and body
 * payload are replaced with a stable `[REDACTED:<shape>]` marker.
 *
 * The shapes mirror the fixture secrets-scan gate (`scripts/verify-secrets-scan.ts`);
 * when one side gains a shape, bring the other along.
 * @module @deepseek-ai/dsh-session-telemetry/redaction
 */

import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

/** One secret shape worth one replacement class. */
interface SecretShape {
  /** Diagnostic name used in the `[REDACTED:<name>]` marker. */
  readonly name: string
  readonly pattern: RegExp
}

/** Structural secret shapes redacted before export. */
const SHAPES: readonly SecretShape[] = [
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'pem-private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[^-]*-----END [A-Z ]*PRIVATE KEY-----/g },
]

/** Walk budget and change tracking shared by one record's redaction. */
export interface WalkState {
  /** Remaining nodes; exhaustion replaces the remaining subtree with a marker. */
  nodes: number
  /** Whether any string changed, so untouched containers keep their reference. */
  changed: boolean
}

const MAX_DEPTH = 8
const MAX_NODES = 4096

/**
 * Replace every secret-shaped substring in one string. Shared by the OTel
 * export backend and the Session trajectory export; both consumers scrub the
 * same shape table, so a marker convention is identical across surfaces.
 * @param value - text about to leave the process.
 * @param state - the walk's change tracking.
 * @returns the redacted text.
 */
export function redactSecretsInString(value: string, state: WalkState): string {
  let redacted = value
  for (const shape of SHAPES) {
    const pattern = new RegExp(shape.pattern.source, shape.pattern.flags)
    const next = redacted.replace(pattern, `[REDACTED:${shape.name}]`)
    if (next !== redacted) state.changed = true
    redacted = next
  }
  return redacted
}

/**
 * Walk one body value: strings are redacted, plain objects and arrays recurse
 * under the depth and node budgets, and a budget or depth overrun fails
 * closed — the unreachable subtree is replaced with a marker, never passed
 * through unredacted. Non-plain objects pass through: session event data is
 * JSON-validated at append time, so they do not occur.
 */
function redactValue(value: unknown, depth: number, state: WalkState): unknown {
  if (typeof value === 'string') return redactSecretsInString(value, state)
  if (depth >= MAX_DEPTH || state.nodes <= 0) {
    if (typeof value === 'string' || value === null || typeof value === 'number' || typeof value === 'boolean') return value
    state.changed = true
    return '[REDACTED:walk-budget]'
  }
  state.nodes -= 1
  if (Array.isArray(value)) {
    const out: unknown[] = []
    let same = true
    for (let index = 0; index < value.length; index += 1) {
      const redacted = redactValue(value[index], depth + 1, state)
      if (redacted !== value[index]) same = false
      out.push(redacted)
    }
    return same ? value : out
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let same = true
    for (const key of Object.keys(source)) {
      const redacted = redactValue(source[key], depth + 1, state)
      if (redacted !== source[key]) same = false
      out[key] = redacted
    }
    return same ? value : out
  }
  return value
}

/**
 * Redact secret-shaped strings in one record's attribute values and body.
 * The input record is treated as read-only; a fresh pair is returned only
 * when something changed, so a clean record passes through untouched.
 * @param record - the record about to be exported.
 * @returns the redacted record.
 */
export function redactSecretShapes(record: SessionTelemetryRecord): SessionTelemetryRecord {
  const state: WalkState = { nodes: MAX_NODES, changed: false }
  const attributes: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(record.attributes)) {
    attributes[key] = typeof value === 'string' ? redactSecretsInString(value, state) : value
  }
  const body = redactValue(record.body, 0, state)
  if (!state.changed) return record
  return { ...record, attributes, body }
}
