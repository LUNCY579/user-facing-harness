#!/usr/bin/env node
/** Restore the bundled Windows engine without executing it or replacing an existing file. */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

const manifest = JSON.parse(readFileSync(new URL('./native-assets.json', import.meta.url), 'utf8'))
if (manifest.format_version !== 1) throw new Error('Unsupported native asset manifest; restore testing-platform/native-assets.json from Git.')
const defaults = {
  archivePaths: manifest.archive.parts.map(part => fileURLToPath(new URL(part.path, import.meta.url))),
  targetPath: fileURLToPath(new URL(manifest.target, import.meta.url)),
  archiveSize: manifest.archive.size,
  archiveSha256: manifest.archive.sha256,
  binarySize: manifest.binary.size,
  binarySha256: manifest.binary.sha256,
}

function hasCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function* readArchiveParts(paths) {
  for (const path of paths) yield* createReadStream(path)
}

function verifyStream(label, expectedSize, expectedHash) {
  const hash = createHash('sha256')
  let size = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > expectedSize) {
        callback(new Error(`${label} exceeds the expected ${expectedSize} bytes`))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
    flush(callback) {
      if (size !== expectedSize) {
        callback(new Error(`${label} has ${size} bytes; expected ${expectedSize}`))
      } else if (hash.digest('hex') !== expectedHash) {
        callback(new Error(`${label} SHA-256 does not match testing-platform/native-assets.json`))
      } else {
        callback()
      }
    },
  })
}

async function verifyExisting({ targetPath, binarySize, binarySha256 }) {
  let stat
  try {
    stat = await lstat(targetPath)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
  const mismatch = () => new Error(
    `Existing ${targetPath} differs from the bundled engine and was preserved. `
    + 'Move it aside, then rerun node testing-platform/restore-native-assets.mjs.',
  )
  if (!stat.isFile() || stat.size !== binarySize) throw mismatch()
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(targetPath)) {
    size += chunk.length
    hash.update(chunk)
  }
  if (size !== binarySize || hash.digest('hex') !== binarySha256) throw mismatch()
  return true
}

/**
 * Restore a fully verified executable, or verify an existing copy, without running it.
 * A failed restore removes its temporary output and preserves any existing destination.
 * @param options - Ordered archive paths, destination, byte sizes, and SHA-256 digests; defaults to the bundled asset manifest.
 * @returns Whether this call restored the executable or verified an existing copy.
 */
export async function restoreNativeAssets(options = defaults) {
  if (await verifyExisting(options)) return 'existing'
  await mkdir(dirname(options.targetPath), { recursive: true })
  const temporaryDirectory = await mkdtemp(join(dirname(options.targetPath), '.restore-native-assets-'))
  const temporaryPath = join(temporaryDirectory, 'magpie.exe')
  try {
    await pipeline(
      Readable.from(readArchiveParts(options.archivePaths), { objectMode: false }),
      verifyStream('Magpie archive', options.archiveSize, options.archiveSha256),
      createGunzip(),
      verifyStream('Magpie executable', options.binarySize, options.binarySha256),
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o644 }),
    )
    try {
      await link(temporaryPath, options.targetPath)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      if (await verifyExisting(options)) return 'existing'
      throw new Error(`The executable at ${options.targetPath} changed during restoration; retry the command.`)
    }
    return 'restored'
  } catch (error) {
    throw new Error(
      `Cannot restore ${options.targetPath}: ${error instanceof Error ? error.message : String(error)} `
      + 'Restore testing-platform/assets and native-assets.json from Git, then rerun node testing-platform/restore-native-assets.mjs.',
      { cause: error },
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

if (import.meta.main) {
  try {
    const result = await restoreNativeAssets()
    console.log(`TestingPlatform: bundled Magpie engine ${result === 'restored' ? 'restored' : 'verified'}; it was not executed.`)
  } catch (error) {
    console.error(`TestingPlatform: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
