/** The measured ANN default stays within the native SDK's supported candidate bound. */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('Zvec ANN configuration', () => {
  it('defaults query ef to the measured value of 2048', () => {
    expect(Config({}).hnswEf).toBe(2048)
  })

  it('accepts the native maximum of 2048', () => {
    expect(Config({ hnswEf: 2048 }).hnswEf).toBe(2048)
  })

  it('rejects 2049 before opening a collection', () => {
    expect(() => Config({ hnswEf: 2049 })).toThrow()
  })
})
