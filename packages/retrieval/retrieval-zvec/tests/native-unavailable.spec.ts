/** What the plugin reports when the optional native SDK cannot be loaded. */
import { Context } from '@deepseek-ai/cordis'
import { isRetrievalError } from '@deepseek-ai/dsh-retrieval'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@zvec/zvec', () => {
  throw new Error('zvec native binding is missing')
})

import { apply, Config } from '../src/index.ts'

/** Run {@link apply} and return whatever it rejected with. */
async function mountFailure(): Promise<unknown> {
  return apply(new Context(), Config({ indexDir: 'unused' })).catch((thrown: unknown) => thrown)
}

describe('native SDK load failure', () => {
  it('names the missing optional dependency and the operator choices', async () => {
    await expect(apply(new Context(), Config({ indexDir: 'unused' }))).rejects.toThrow(
      'retrieval(unavailable): Zvec native SDK is unavailable. Install optional dependencies on a supported platform, or disable retrieval.',
    )
  })

  it('wraps the loader failure as a non-retryable unavailable diagnostic', async () => {
    const error = await mountFailure()
    expect(isRetrievalError(error) && error.code).toBe('unavailable')
    expect(isRetrievalError(error) && error.retryable).toBe(false)
    expect(isRetrievalError(error) && 'cause' in error.detail).toBe(true)
  })
})
