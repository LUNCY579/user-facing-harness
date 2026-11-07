/**
 * Failure classification that callers branch on: the stable `retrieval(code): message` text, the
 * non-retrieval throw wrapped into a domain failure, and the cancellation outcome a caller sees when
 * its signal or an aborted backend promise ends the operation.
 */
import { describe, expect, it } from 'vitest'
import { RetrievalError, classifyFailure, isRetrievalError, throwIfAborted } from '../src/errors.ts'

/** An error whose `name` is what a backend uses to report cancellation. */
function abortError(): Error {
  const error = new Error('the operation was aborted')
  error.name = 'AbortError'
  return error
}

describe('RetrievalError', () => {
  it('prefixes the code into the message so a log line names the cause', () => {
    const error = new RetrievalError('space_mismatch', 'the index holds another space', true)
    expect(error.message).toBe('retrieval(space_mismatch): the index holds another space')
    expect(error.code).toBe('space_mismatch')
    expect(error.retryable).toBe(true)
    expect(error.name).toBe('RetrievalError')
    expect(isRetrievalError(error)).toBe(true)
    expect(isRetrievalError(new Error('other'))).toBe(false)
  })

  it('carries an Error cause as its reason', () => {
    const error = RetrievalError.from('init_failed', 'cannot open the index', new Error('binding missing'))
    expect(error.message).toBe('retrieval(init_failed): cannot open the index: binding missing')
    expect(error.detail).toEqual({ cause: 'binding missing' })
  })

  it('stringifies a non-Error cause instead of dropping it', () => {
    const error = RetrievalError.from('backend_error', 'the backend failed', 'socket closed without a frame', true)
    expect(error.message).toBe('retrieval(backend_error): the backend failed: socket closed without a frame')
    expect(error.detail).toEqual({ cause: 'socket closed without a frame' })
    expect(error.retryable).toBe(true)
  })

  it('defaults to a non-retryable failure with no detail', () => {
    const error = new RetrievalError('disabled', 'retrieval is turned off')
    expect(error.retryable).toBe(false)
    expect(error.detail).toEqual({})
  })
})

describe('classifyFailure', () => {
  it('returns an existing retrieval failure unchanged so its code survives', () => {
    const original = new RetrievalError('unauthorized', 'the caller may not read this scope')
    expect(classifyFailure(original)).toBe(original)
  })

  it('reports a cancelled caller signal as cancelled', () => {
    const controller = new AbortController()
    controller.abort()
    const error = classifyFailure(new Error('fetch did not complete'), controller.signal)
    expect(error.code).toBe('cancelled')
    expect(error.message).toBe('retrieval(cancelled): the caller cancelled the operation')
    expect(error.retryable).toBe(false)
  })

  it('reports an AbortError from the backend as cancelled without a signal', () => {
    expect(classifyFailure(abortError()).code).toBe('cancelled')
    expect(classifyFailure(abortError(), new AbortController().signal).code).toBe('cancelled')
  })

  it('keeps a non-cancellation backend failure retryable and preserves its reason', () => {
    const error = classifyFailure(new Error('worker exited 1'))
    expect(error.code).toBe('backend_error')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('worker exited 1')
  })

  it('treats a non-Error throw as the backend reason', () => {
    expect(classifyFailure('boom').message).toBe('retrieval(backend_error): the backend failed: boom')
  })
})

describe('throwIfAborted', () => {
  it('does nothing when no cancellation was requested', () => {
    expect(() => {
      throwIfAborted(undefined, 'indexing')
    }).not.toThrow()
    expect(() => {
      throwIfAborted(new AbortController().signal, 'indexing')
    }).not.toThrow()
  })

  it('names the abandoned operation when the signal is aborted', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => {
      throwIfAborted(controller.signal, 'reembedding')
    }).toThrow('retrieval(cancelled): reembedding was cancelled')
  })
})
