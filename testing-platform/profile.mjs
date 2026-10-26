/** Repository-local profile preparation. Existing user settings are never replaced. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
export const profileName = 'testing-platform'
export const pluginName = 'dsh-our-free-model'

/** Resolve the explicit Harness home, or the ignored state directory in this checkout. */
export function platformHome(environment = process.env, root = repositoryRoot) {
  if (environment.DSH_HOME !== undefined && environment.DSH_HOME.trim() === '') {
    throw new Error('DSH_HOME is empty; unset it to use this checkout or specify an absolute directory.')
  }
  return resolve(root, environment.DSH_HOME ?? '.testingplatform')
}

/** Create a missing file exclusively and leave an existing file intact. */
function createFile(path, content) {
  try {
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

/**
 * Prepare the named local profile and link its bundle directly to this checkout.
 * Existing manifests and patch files are preserved; conflicting installations fail.
 * @param options - Absolute repository and Harness home directories.
 * @returns The prepared profile directory.
 */
export function preparePlatformProfile({ root = repositoryRoot, home = platformHome(process.env, root) } = {}) {
  const pluginDirectory = join(root, 'plugins', pluginName)
  const sourceManifest = JSON.parse(readFileSync(join(pluginDirectory, 'package.json'), 'utf8'))
  if (sourceManifest.name !== pluginName || sourceManifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error(`The local plugin at ${pluginDirectory} does not declare the expected bundle.`)
  }
  const directory = join(home, 'profiles', profileName)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(join(root, 'testing-platform', 'profile.json'), 'utf8'))
  manifest.dependencies = { [pluginName]: `link:${relative(directory, pluginDirectory).split(sep).join('/')}` }
  createFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const saved = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (saved.testingPlatform !== 1) {
    throw new Error(`An unrelated profile already exists at ${directory}; choose another DSH_HOME.`)
  }
  const bundles = saved.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.filter(name => name === pluginName).length !== 1
    || !bundles.includes('@deepseek-ai/dsh-base') || !bundles.includes('@deepseek-ai/dsh-web-app')) {
    throw new Error(`Restore the base, web-app, and single ${pluginName} bundle in ${manifestPath}.`)
  }
  if (!saved.dependencies || !(pluginName in saved.dependencies)) {
    throw new Error(`Restore the local ${pluginName} dependency in ${manifestPath}.`)
  }
  createFile(join(directory, 'cordis.patch.yml'), '# Personal overrides for this TestingPlatform profile.\n[]\n')
  createFile(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const modules = join(directory, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const link = join(modules, pluginName)
  try {
    symlinkSync(pluginDirectory, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!lstatSync(link).isSymbolicLink() || !existsSync(link)
      || realpathSync(link) !== realpathSync(pluginDirectory)) {
      throw new Error(`The profile's ${link} is not linked to this checkout; move that entry aside and rerun setup.`)
    }
  }
  return directory
}

/** Environment for the isolated experiment; upstream telemetry is disabled by default. */
export function platformEnvironment(environment = process.env, root = repositoryRoot) {
  return {
    ...environment,
    DSH_HOME: platformHome(environment, root),
    DSH_TELEMETRY_DISABLED: environment.DSH_TELEMETRY_DISABLED ?? '1',
  }
}

/** CLI arguments selecting the local profile and its managed plugin configuration. */
export function platformArguments(extra = [], root = repositoryRoot) {
  if (extra.some(value => value === '--profile' || value.startsWith('--profile=')
    || value === '--from-default-profile' || value.startsWith('--from-default-profile='))) {
    throw new Error('TestingPlatform owns its profile; use pnpm dsh directly to select another profile.')
  }
  return ['--profile', profileName, '--patch', join(root, 'testing-platform', 'managed.patch.yml'), ...extra]
}
