/** External tarballs keep compatible peers, omit workspace refs, and never run hooks. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { x as extract } from 'tar'
import { packPlugin, pluginPackageManifest, pluginPeers } from './pack-plugin.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-plugin-package-test-'))
try {
  const root = path.join(scratch, 'source with spaces')
  const destination = path.join(scratch, 'archives with spaces')
  fs.mkdirSync(root)
  const sentinel = path.join(scratch, 'hook-ran')
  const source = {
    name: 'dsh-our-free-model', version: '2.7.1', private: true, type: 'module',
    main: 'index.js', files: ['index.js', 'fixture.dat'],
    peerDependencies: Object.fromEntries(Object.keys(pluginPeers).map(name => [name, 'workspace:*'])),
    devDependencies: { '@deepseek-ai/dsh-llm': 'workspace:*' },
    scripts: { prepack: 'node prepack.cjs' },
  }
  const original = `${JSON.stringify(source, null, 2)}\n`
  fs.writeFileSync(path.join(root, 'package.json'), original)
  fs.writeFileSync(path.join(root, 'index.js'), 'export const fixture = true\n')
  fs.writeFileSync(path.join(root, 'fixture.dat'), Buffer.from([0, 255, 13, 10]))
  fs.writeFileSync(path.join(root, 'prepack.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')\n`)
  execFileSync(process.execPath, ['prepack.cjs'], { cwd: root, timeout: 10000 })
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'ran')
  fs.unlinkSync(sentinel)
  const feed = '{"signature":"publisher-owned-fixture"}\n'
  fs.mkdirSync(path.join(root, 'feed'))
  fs.writeFileSync(path.join(root, 'feed/manifest.json'), feed)
  // Dry-run resolves workspace peers even though it writes no tarball.
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n  - peers/*\n')
  for (const [index, name] of Object.keys(pluginPeers).entries()) {
    const directory = path.join(root, 'peers', String(index))
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  const archive = packPlugin({ root, destination })
  const unpacked = path.join(scratch, 'unpacked')
  fs.mkdirSync(unpacked)
  await extract({ file: archive, cwd: unpacked, strict: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package/package.json'), 'utf8'))
  assert.deepEqual(manifest.peerDependencies, {
    '@deepseek-ai/cordis': '^4.0.2',
    '@deepseek-ai/dsh-commands': '^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1',
    '@deepseek-ai/dsh-credentials': '^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1',
    '@deepseek-ai/dsh-llm': '^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1',
    '@deepseek-ai/schemastery': '^3.18.4',
  })
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.private, true)
  assert.equal(JSON.stringify(manifest).includes('workspace:'), false)
  assert.deepEqual(fs.readFileSync(path.join(unpacked, 'package/fixture.dat')), Buffer.from([0, 255, 13, 10]))
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), original)
  assert.equal(fs.readFileSync(path.join(root, 'feed/manifest.json'), 'utf8'), feed)
  assert.equal(fs.existsSync(path.join(unpacked, 'package/feed')), false)
  assert.equal(fs.existsSync(sentinel), false)
  assert.throws(() => packPlugin({ root, destination }), /EEXIST/)
  assert.equal(fs.existsSync(sentinel), false)
  assert.throws(() => pluginPackageManifest({ ...source, peerDependencies: {} }), /every plugin peer/)
  assert.throws(() => pluginPackageManifest({ ...source, dependencies: { extra: 'workspace:*' } }), /external dependencies/)
  console.log('plugin-package: tarball compatibility, source isolation, hooks, overwrite and incomplete mapping checks passed')
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
