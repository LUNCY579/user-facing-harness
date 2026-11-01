/**
 * Structured retrieval failures. Every backend, embedding, and authorization failure surfaces as a
 * {@link RetrievalError} with a stable code so a caller can branch on the cause, and so a tool result
 * can state what happened without parsing prose.
 * @module @deepseek-ai/dsh-retrieval/errors
 */

/** Machine-stable failure causes. */
export type RetrievalErrorCode =
  | 'unavailable'
  | 'init_failed'
  | 'spawn_failed'
  | 'worker_crashed'
  | 'timeout'
  | 'cancelled'
  | 'protocol_error'
  | 'space_mismatch'
  | 'invalid_vector'
  | 'invalid_input'
  | 'unauthorized'
  | 'not_found'
  | 'path_escape'
  | 'backend_error'
  | 'outcome_pending'
  | 'disabled'

/** Message prefix that makes a thrown retrieval failure recognizable in a log. */
const PREFIX = 'retrieval'

/**
 * A retrieval-domain failure. `code` is stable across releases; `retryable` tells a caller whether
 * re-issuing the same operation can succeed, and `detail` carries backend facts for diagnostics
 * without leaking record contents.
 */
export class RetrievalError extends Error {
  /**
   * @param code - stable cause of the failure.
   * @param message - human-readable explanation naming the operation that failed.
   * @param retryable - whether the same operation may be retried against the same backend.
   * @param detail - backend-supplied diagnostic facts, safe to log.
   */
  constructor(
    readonly code: RetrievalErrorCode,
    message: string,
    readonly retryable: boolean = false,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`${PREFIX}(${code}): ${message}`)
    this.name = 'RetrievalError'
  }

  /**
   * Build an error for an unexpected non-retrieval throw.
   * @param code - cause to report.
   * @param message - operation description.
   * @param cause - the original error.
   * @param retryable - whether the operation may be retried.
   * @returns the structured failure.
   */
  static from(
    code: RetrievalErrorCode,
    message: string,
    cause: unknown,
    retryable = false,
  ): RetrievalError {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return new RetrievalError(code, `${message}: ${reason}`, retryable, { cause: reason })
  }
}

/**
 * True when the value is a retrieval-domain failure.
 * @param value - anything thrown or returned.
 * @returns whether `value` carries a {@link RetrievalErrorCode}.
 */
export function isRetrievalError(value: unknown): value is RetrievalError {
  return value instanceof RetrievalError
}

/**
 * A cancellation or an aborted signal becomes a `cancelled` failure, everything else keeps its code.
 * @param error - the caught failure.
 * @param signal - the caller's cancellation signal, if any.
 * @returns a retrieval failure describing the same outcome.
 */
export function classifyFailure(error: unknown, signal?: AbortSignal): RetrievalError {
  if (isRetrievalError(error)) return error
  if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
    return new RetrievalError('cancelled', 'the caller cancelled the operation')
  }
  return RetrievalError.from('backend_error', 'the backend failed', error, true)
}

/**
 * Fail with `cancelled` once a caller has aborted, so a long loop can stop at a checkpoint.
 * @param signal - cancellation to test; `undefined` means none was requested.
 * @param operation - name of the work being abandoned.
 * @returns when `signal` is not aborted.
 */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new RetrievalError('cancelled', `${operation} was cancelled`)
}
