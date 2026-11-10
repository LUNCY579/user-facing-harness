/**
 * Durable security audit log for the harness. Append-only JSONL in the harness
 * home (`~/.dsh/audit.jsonl`, `0o600`), recording security-relevant events
 * (auth denials, sandbox denials, escalation decisions, credential
 * rotations, rate-limit rejections) with structured facts and never any
 * secret value. Writes are synchronous appends — the volume is low (denials
 * and approvals, not per-tool-call) and the durability guarantee (the event
 * is on disk before the caller proceeds) is the point.
 *
 * Consumers register the plugin and obtain the `ctx.auditLog` service; any
 * module that owns a security decision calls `ctx.auditLog.record(...)`.
 * @module @deepseek-ai/dsh-audit-local
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Context, Service } from '@deepseek-ai/cordis'

/** The audit event categories, each owned by a different security layer. */
export type AuditCategory =
  | 'auth-denial'
  | 'sandbox-denial'
  | 'escalation'
  | 'credential'
  | 'rate-limit'
  | 'share'

/** One structured audit event. Values are primitives — no secrets, no objects. */
export interface AuditEvent {
  /** Epoch milliseconds. */
  readonly time: number
  /** The security layer that produced the event. */
  readonly category: AuditCategory
  /** The specific action within the category, snake_case. */
  readonly action: string
  /** Structured facts. Values are primitives; keys are stable per action. */
  readonly detail: Record<string, string | number | boolean>
}

/** The audit log file basename inside the harness home. */
export const AUDIT_FILENAME = 'audit.jsonl'

/** Maximum file size before rotation (the log is renamed to `audit.jsonl.1`). */
const MAX_FILE_BYTES = 16 * 1024 * 1024

/** The plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /** Harness-home path resolver override (tests). */
  dshHome?: string
  /** Disable the audit log entirely (events are dropped, not written). */
  disabled?: boolean
}

/**
 * The audit-log service. Append-only JSONL, one event per line, `0o600`.
 * @param ctx - the cordis context (provides `ctx.auditLog`).
 * @param config - the plugin config.
 */
export class AuditLogService extends Service {
  private readonly filePath: string
  private readonly disabled: boolean

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'auditLog')
    this.disabled = config.disabled === true
    const home = resolveDshHome(config.dshHome)
    this.filePath = join(home, AUDIT_FILENAME)
    if (!this.disabled && !existsSync(this.filePath)) {
      mkdirSync(home, { recursive: true })
      appendFileSync(this.filePath, '', { mode: 0o600 })
    }
  }

  /**
   * Record one security event. The event is appended synchronously to the
   * JSONL file before this method returns, so the caller knows the record is
   * durable. Rotation: when the file exceeds `MAX_FILE_BYTES`, it is renamed
   * to `audit.jsonl.1` (one generation, replacing any previous generation)
   * and a fresh file starts.
   * @param category - the security layer that produced the event.
   * @param action - the specific action, snake_case.
   * @param detail - structured facts; values must be primitives, no secrets.
   */
  record(category: AuditEvent['category'], action: string, detail: Record<string, string | number | boolean> = {}): void {
    if (this.disabled) return
    const event: AuditEvent = { time: Date.now(), category, action, detail }
    appendFileSync(this.filePath, JSON.stringify(event) + '\n', { mode: 0o600 })
    if (statSync(this.filePath).size > MAX_FILE_BYTES) {
      const renamed = this.filePath + '.1'
      if (existsSync(renamed)) unlinkSync(renamed)
      renameSync(this.filePath, renamed)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    auditLog: AuditLogService
  }
}

export default AuditLogService
