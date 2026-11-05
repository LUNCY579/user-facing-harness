import { describe, expect, it } from 'vitest'
import { isRetrievalError } from '@deepseek-ai/dsh-retrieval'
import { Config, principalOf } from '../src/index.ts'

const EMPTY = {}

describe('local principal resolution', () => {
  it('uses the account name when the host has an account record', () => {
    expect(principalOf('operator', { USER: 'someone-else' }, 501)).toBe('operator')
  })

  it('falls back to the login environment when the account lookup found nothing', () => {
    expect(principalOf(undefined, { USER: 'container-operator' }, 1000)).toBe('container-operator')
    expect(principalOf(undefined, { USERNAME: 'windows-operator' }, undefined)).toBe('windows-operator')
  })

  it('names an environment that carries no user with the numeric uid', () => {
    expect(principalOf(undefined, EMPTY, 65534)).toBe('uid-65534')
    expect(principalOf(undefined, { USER: '' }, 0)).toBe('uid-0')
  })

  it('refuses a host that names no principal at all', () => {
    const failure = (() => {
      try {
        principalOf(undefined, EMPTY, undefined)
        return undefined
      } catch (error: unknown) {
        return error
      }
    })()
    expect(isRetrievalError(failure) ? failure.code : undefined).toBe('invalid_input')
    expect(isRetrievalError(failure) ? failure.message : '').toMatch(/set localPrincipal explicitly/u)
  })

  it('keeps an explicitly configured principal', () => {
    expect(Config({ localPrincipal: 'synthetic-operator' }).localPrincipal).toBe('synthetic-operator')
  })

  it('resolves this host as the principal for a profile that names none', () => {
    expect(Config({}).localPrincipal).toMatch(/\S/u)
  })
})
