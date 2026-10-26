import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { platformArguments, platformEnvironment, platformHome, pluginName, preparePlatformProfile, profileName, repositoryRoot } from './profile.mjs'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'testingplatform-profile-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

test('uses checkout-local state and honors an explicit home without changing the caller environment', () => {
  const original = { EXAMPLE: 'keep' }
  assert.equal(platformHome(original), resolve(repositoryRoot, '.testingplatform'))
  const result = platformEnvironment(original)
  assert.equal(result.DSH_TELEMETRY_DISABLED, '1')
  assert.deepEqual(original, { EXAMPLE: 'keep' })
  assert.equal(platformHome({ DSH_HOME: '/tmp/example-dsh' }), resolve('/tmp/example-dsh'))
  assert.throws(() => platformHome({ DSH_HOME: '' }), /DSH_HOME is empty/)
})

test('links the complete local bundle exactly once and preserves personal settings on repeated setup', t => {
  const home = fixture(t)
  const directory = preparePlatformProfile({ home })
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.dsh.profile.bundles.filter(name => name === pluginName).length, 1)
  assert.match(manifest.dependencies[pluginName], /^link:/)
  assert.equal(realpathSync(join(directory, 'node_modules', pluginName)), realpathSync(join(repositoryRoot, 'plugins', pluginName)))
  manifest.userSetting = 'preserved'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const patch = '# user-owned overrides\n[]\n'
  writeFileSync(join(directory, 'cordis.patch.yml'), patch)
  preparePlatformProfile({ home })
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).userSetting, 'preserved')
  assert.equal(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), patch)
})

test('refuses an unrelated profile without changing its manifest', t => {
  const home = fixture(t)
  const directory = join(home, 'profiles', profileName)
  mkdirSync(directory, { recursive: true })
  const content = '{"name":"personal-profile","private":true}\n'
  writeFileSync(join(directory, 'package.json'), content)
  assert.throws(() => preparePlatformProfile({ home }), /unrelated profile/)
  assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), content)
})

test('rejects duplicated plugin activation instead of booting two instances', t => {
  const home = fixture(t)
  const directory = preparePlatformProfile({ home })
  const path = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.dsh.profile.bundles.push(pluginName)
  writeFileSync(path, JSON.stringify(manifest))
  assert.throws(() => preparePlatformProfile({ home }), /single dsh-our-free-model/)
})

test('keeps a conflicting installed plugin intact', t => {
  const home = fixture(t)
  const modules = join(home, 'profiles', profileName, 'node_modules')
  mkdirSync(join(modules, pluginName), { recursive: true })
  writeFileSync(join(modules, pluginName, 'keep.txt'), 'existing installation')
  assert.throws(() => preparePlatformProfile({ home }), /not linked to this checkout/)
  assert.equal(readFileSync(join(modules, pluginName, 'keep.txt'), 'utf8'), 'existing installation')
})

test('selects the named profile, forwards application arguments, and prevents conflicting profile selection', () => {
  const args = platformArguments(['--port', '3081', '--no-open'])
  assert.deepEqual(args.slice(0, 2), ['--profile', profileName])
  assert.deepEqual(args.slice(-3), ['--port', '3081', '--no-open'])
  assert.throws(() => platformArguments(['--profile', 'web']), /owns its profile/)
  assert.throws(() => platformArguments(['--from-default-profile=web']), /owns its profile/)
})
