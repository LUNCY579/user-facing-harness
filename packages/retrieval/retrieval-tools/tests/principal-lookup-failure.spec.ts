/**
 * Import-safety lane for the local principal default. `vi.mock` is hoisted per file, so a host whose
 * account lookup throws needs its own spec: a host fact read while a plugin's schema object is being
 * constructed crashes every importer of that plugin, including a catalog check that never mounts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    default: actual,
    userInfo: () => {
      throw Object.assign(
        new Error('A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)'),
        { code: 'ERR_SYSTEM_ERROR' },
      )
    },
  }
})

describe('a host with no account record for this uid', () => {
  const account = { USER: process.env.USER, USERNAME: process.env.USERNAME, getuid: process.getuid }

  beforeEach(() => {
    delete process.env.USER
    delete process.env.USERNAME
    vi.resetModules()
  })

  afterEach(() => {
    if (account.USER === undefined) delete process.env.USER
    else process.env.USER = account.USER
    if (account.USERNAME === undefined) delete process.env.USERNAME
    else process.env.USERNAME = account.USERNAME
    if (account.getuid === undefined) delete process.getuid
    else process.getuid = account.getuid
    vi.resetModules()
  })

  async function resolveDefault(): Promise<string> {
    const { Config } = await import('../src/index.ts')
    return Config({}).localPrincipal
  }

  it('loads the plugin and names the login environment as the principal', async () => {
    process.env.USER = 'synthetic-container-operator'
    await expect(resolveDefault()).resolves.toBe('synthetic-container-operator')
  })

  it('names the numeric uid when the environment carries no user', async () => {
    const uid = process.getuid?.()
    await expect(resolveDefault()).resolves.toBe(`uid-${uid}`)
  })

  it('refuses a mount whose host names no principal at all', async () => {
    delete process.getuid
    await expect(resolveDefault()).rejects.toThrow(/set localPrincipal explicitly/u)
  })
})
