/** Pack the managed plugin with its external host compatibility ranges. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Existing external compatibility; workspace development always uses local peers. */
export const pluginPeers = Object.freeze({
  '@deepseek-ai/cordis': '^4.0.2',
  '@deepseek-ai/dsh-commands': '^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1',
  '@deepseek-ai/dsh-credentials': '^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1',
  '@deepseek-ai/dsh-llm': '^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1',
  '@deepseek-ai/schemastery': '^3.18.4',
})

/**
 * Resolve the tarball manifest without exposing workspace-only dependencies.
 * @param {object} source - The plugin's parsed source manifest.
 * @returns {object} The external manifest, retaining the private publication guard.
 */
export function pluginPackageManifest(source) {
  if (JSON.stringify(Object.keys(source.peerDependencies ?? {}).sort()) !== JSON.stringify(Object.keys(pluginPeers).sort())) {
    throw new Error('Review external compatibility ranges for every plugin peer before packing')
  }
  const manifest = { ...source, peerDependencies: { ...pluginPeers } }
  delete manifest.devDependencies
  for (const section of ['dependencies', 'optionalDependencies']) {
    if (Object.values(manifest[section] ?? {}).some(range => String(range).startsWith('workspace:'))) {
      throw new Error(`Resolve external ${section} before packing the plugin`)
    }
  }
  return manifest
}

/**
 * Create a tarball from a private snapshot; lifecycle scripts never execute.
 * @param {object} options - Absolute source/output paths and an optional package-manager entrypoint.
 * @returns {string} The new archive's absolute path; an existing archive is never replaced.
 */
export function packPlugin({ root = fileURLToPath(new URL('..', import.meta.url)), destination, packageManager = process.env.npm_execpath }) {
  const entrypoint = packageManager
  if (!entrypoint) throw new Error('Run through pnpm run pack:plugin --pack-destination DIRECTORY')
  const command = /\.[cm]?js$/i.test(entrypoint) ? process.execPath : entrypoint
  const prefix = command === process.execPath ? [entrypoint] : []
  const ignoreScripts = /(?:^|[\\/])npm-cli\.[cm]?js$/i.test(entrypoint)
    ? '--ignore-scripts' : '--config.ignore-scripts=true'
  const pack = (cwd, args) => {
    const result = JSON.parse(execFileSync(command, [...prefix, 'pack', '--json', ignoreScripts, ...args], {
      cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    }))
    return Array.isArray(result) ? result[0] : result
  }
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const manifest = pluginPackageManifest(source)
  const selection = pack(root, ['--dry-run'])
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-plugin-pack-'))
  try {
    for (const { path: relative } of selection.files) {
      if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0')
        || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Package file list contains an unsafe path')
      }
      const original = path.join(root, relative)
      if (!fs.lstatSync(original).isFile()) throw new Error(`Package source must be a regular file: ${relative}`)
      const target = path.join(scratch, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL)
    }
    fs.writeFileSync(path.join(scratch, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const output = pack(scratch, [])
    const filename = path.basename(output.filename)
    if (filename !== output.filename) throw new Error('Package manager returned an unsafe archive filename')
    fs.mkdirSync(destination, { recursive: true })
    const archive = path.join(destination, filename)
    fs.copyFileSync(path.join(scratch, filename), archive, fs.constants.COPYFILE_EXCL)
    return archive
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== '--pack-destination' || !args[1]) {
      throw new Error('usage: pnpm run pack:plugin --pack-destination DIRECTORY')
    }
    console.log(packPlugin({ destination: path.resolve(args[1]) }))
  } catch (error) {
    console.error(`Plugin packaging failed: ${error.message}`)
    process.exitCode = 1
  }
}
