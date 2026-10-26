/** Check asset restoration, corruption handling, repeat setup, and concurrent publication. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { restoreNativeAssets } from './restore-native-assets.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'testing-platform-native-assets-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const binary = Buffer.from('TestingPlatform binary fixture\0\xff', 'latin1')
  const archive = gzipSync(binary)
  const archivePaths = [join(directory, 'part01'), join(directory, 'part02')]
  const split = Math.floor(archive.length / 2)
  await writeFile(archivePaths[0], archive.subarray(0, split))
  await writeFile(archivePaths[1], archive.subarray(split))
  return {
    directory, binary, archive,
    options: {
      archivePaths, targetPath: join(directory, 'engine.exe'),
      archiveSize: archive.length, archiveSha256: sha256(archive),
      binarySize: binary.length, binarySha256: sha256(binary),
    },
  }
}

async function assertNoPartialFiles(directory) {
  assert.equal((await readdir(directory)).some(name => name.startsWith('.restore-native-assets-')), false)
}

test('restores ordered parts and leaves an identical destination on repeat setup', async t => {
  const { directory, binary, options } = await fixture(t)
  assert.equal(await restoreNativeAssets(options), 'restored')
  assert.deepEqual(await readFile(options.targetPath), binary)
  assert.equal(await restoreNativeAssets(options), 'existing')
  await assertNoPartialFiles(directory)
})

test('rejects a damaged archive without publishing a destination or temporary output', async t => {
  const { directory, options } = await fixture(t)
  const bytes = await readFile(options.archivePaths[0])
  bytes[0] ^= 0xff
  await writeFile(options.archivePaths[0], bytes)
  await assert.rejects(restoreNativeAssets(options), /Cannot restore/)
  await assert.rejects(readFile(options.targetPath), { code: 'ENOENT' })
  await assertNoPartialFiles(directory)
})

test('rejects an altered expected archive hash even when gzip bytes are valid', async t => {
  const { directory, options } = await fixture(t)
  await assert.rejects(restoreNativeAssets({ ...options, archiveSha256: '0'.repeat(64) }), /archive SHA-256/)
  await assert.rejects(readFile(options.targetPath), { code: 'ENOENT' })
  await assertNoPartialFiles(directory)
})

test('rejects an altered executable hash before publishing output', async t => {
  const { directory, options } = await fixture(t)
  await assert.rejects(restoreNativeAssets({ ...options, binarySha256: '0'.repeat(64) }), /executable SHA-256/)
  await assert.rejects(readFile(options.targetPath), { code: 'ENOENT' })
  await assertNoPartialFiles(directory)
})

test('reports a missing archive part and leaves no partial destination', async t => {
  const { directory, options } = await fixture(t)
  await rm(options.archivePaths[1])
  await assert.rejects(restoreNativeAssets(options), /Cannot restore/)
  await assert.rejects(readFile(options.targetPath), { code: 'ENOENT' })
  await assertNoPartialFiles(directory)
})

test('preserves an existing conflicting executable', async t => {
  const { directory, options } = await fixture(t)
  const userFile = Buffer.from('Existing user executable')
  await writeFile(options.targetPath, userFile)
  await assert.rejects(restoreNativeAssets(options), /was preserved/)
  assert.deepEqual(await readFile(options.targetPath), userFile)
  await assertNoPartialFiles(directory)
})

test('concurrent restores converge on one verified executable', async t => {
  const { directory, binary, options } = await fixture(t)
  const results = await Promise.all([restoreNativeAssets(options), restoreNativeAssets(options)])
  assert.deepEqual(results.sort(), ['existing', 'restored'])
  assert.deepEqual(await readFile(options.targetPath), binary)
  await assertNoPartialFiles(directory)
})

test('restores the complete bundled engine byte for byte without executing it', async t => {
  const { directory } = await fixture(t)
  const manifest = JSON.parse(await readFile(new URL('./native-assets.json', import.meta.url), 'utf8'))
  const base = dirname(fileURLToPath(import.meta.url))
  const options = {
    archivePaths: manifest.archive.parts.map(part => join(base, part.path)),
    targetPath: join(directory, 'bundled-engine.exe'),
    archiveSize: manifest.archive.size, archiveSha256: manifest.archive.sha256,
    binarySize: manifest.binary.size, binarySha256: manifest.binary.sha256,
  }
  for (let index = 0; index < options.archivePaths.length; index += 1) {
    const bytes = await readFile(options.archivePaths[index])
    assert.equal(bytes.length, manifest.archive.parts[index].size)
    assert.equal(sha256(bytes), manifest.archive.parts[index].sha256)
  }
  assert.equal(await restoreNativeAssets(options), 'restored')
  const bytes = await readFile(options.targetPath)
  assert.equal(bytes.length, manifest.binary.size)
  assert.equal(sha256(bytes), manifest.binary.sha256)
  assert.equal(await restoreNativeAssets(options), 'existing')
  await assertNoPartialFiles(directory)
})
