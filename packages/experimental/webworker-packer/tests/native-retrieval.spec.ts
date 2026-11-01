/** Native SDK replacement keeps disabled retrieval packable and refuses explicit use. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it, vi, type TestContext } from 'vitest'
import { createNodeBuiltins } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtins.ts'
import { loadVfsImage, WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime'
import { packVfsImage, type PackOptions } from '../src/pack.ts'

const SUBJECT = '@deepseek-ai/dsh-native-retrieval-fixture'

function fixture(test: TestContext, source: string): { root: string; options: PackOptions } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-retrieval-image-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: SUBJECT, type: 'module', files: ['lib'], main: 'lib/index.js',
    optionalDependencies: { '@zvec/zvec': '0.8.0' },
  }))
  writeFileSync(join(root, 'lib/index.js'), source)
  return {
    root,
    options: { profile: 'native-retrieval', roster: [SUBJECT], workspaces: new Map([[SUBJECT, root]]), resolveFrom: root, entries: [] },
  }
}

afterEach(() => { vi.restoreAllMocks() })

function hasActivation(value: unknown): value is { enable(): unknown } {
  return typeof value === 'object' && value !== null && 'enable' in value && typeof value.enable === 'function'
}

it('packs disabled native retrieval and rejects its explicit SDK import with a platform error', async (test) => {
  const { options } = fixture(test, "export const disabled = true; export async function enable() { return import('@zvec/zvec') }")
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  const table = createNodeBuiltins()
  expect(report).not.toHaveBeenCalled()
  const packed = packVfsImage(options)
  expect(packed.missing).toEqual([])
  expect(Object.keys(packed.files).some(file => file.startsWith('node_modules/@zvec/zvec/'))).toBe(false)
  const vfs = loadVfsImage(gunzipSync(packed.image))
  const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: table })
  const subject = loader.createRequire('/dsh/')(SUBJECT)
  if (!hasActivation(subject)) {
    throw new Error('packed fixture did not export its SDK activation function')
  }
  expect(subject).toHaveProperty('disabled', true)
  expect(report).not.toHaveBeenCalled()
  await expect(subject.enable()).rejects.toMatchObject({
    code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
    message: 'web-preview: @zvec/zvec.native SDK is not available in the worker host',
  })
  expect(report).toHaveBeenCalledOnce()
})

it('excludes an installed native SDK and binary even when named by the image roster', (test) => {
  const { root, options } = fixture(test, 'export const disabled = true')
  const native = join(root, 'native-sdk')
  mkdirSync(native)
  writeFileSync(join(native, 'package.json'), JSON.stringify({ name: '@zvec/zvec', files: ['index.js', 'addon.node'], main: 'index.js' }))
  writeFileSync(join(native, 'index.js'), 'module.exports = {}')
  writeFileSync(join(native, 'addon.node'), 'synthetic native payload')
  const packed = packVfsImage({
    ...options,
    roster: [...options.roster, '@zvec/zvec'],
    workspaces: new Map([...options.workspaces, ['@zvec/zvec', native]]),
  })
  expect(packed.missing).toEqual([])
  expect(packed.packages.has('@zvec/zvec')).toBe(false)
  expect(Object.keys(packed.files).some(file => file.startsWith('node_modules/@zvec/zvec/'))).toBe(false)
})

it('rejects an undeclared required module instead of treating it as a native replacement', (test) => {
  const { options } = fixture(test, "import 'required-missing-module'; export const disabled = true")
  expect(() => packVfsImage(options)).toThrow(/unresolvable module request.*[\s\S]*required-missing-module/)
})
