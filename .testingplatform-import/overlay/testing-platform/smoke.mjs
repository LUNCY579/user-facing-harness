/** Boot the built combined Web profile and verify its host and browser plugin faces. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { platformEnvironment, repositoryRoot } from './profile.mjs'

const root = repositoryRoot

function scrub(text) {
  return text.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[redacted]')
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'testingplatform-smoke-'))
  const environment = platformEnvironment({ ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' })
  let child
  let completion
  let forced = false
  try {
    const dump = spawnSync(process.execPath, ['testing-platform/launcher.mjs', 'config'], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    })
    if (dump.error) throw dump.error
    assert.equal(dump.signal, null, 'configuration dump must complete without a signal')
    assert.equal(dump.status, 0, scrub(dump.stderr))
    const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar', construct: value => value,
    }))
    const entries = yaml.load(dump.stdout, { schema })
    const pluginRows = entries.filter(entry => entry.id === 'our-free-model')
    assert.equal(pluginRows.length, 1, 'the host composition must activate exactly one local plugin')
    assert.equal(pluginRows[0].name, 'dsh-our-free-model')
    assert.equal(pluginRows[0].config.distribution, 'managed')

    child = spawn(process.execPath, [
      'testing-platform/launcher.mjs', 'start', '--no-open', '--host', '127.0.0.1', '--port', '0',
    ], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    completion = new Promise(resolve => {
      child.once('error', error => resolve({ error }))
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const url = await new Promise((resolve, reject) => {
      let output = ''
      let errors = ''
      const timeout = setTimeout(() => reject(new Error(`Web startup timed out.\n${scrub(errors)}`)), 90_000)
      child.stdout.on('data', chunk => {
        output += chunk
        const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
        if (match) { clearTimeout(timeout); resolve(match[1]) }
      })
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-16000) })
      completion.then(result => {
        clearTimeout(timeout)
        reject(result.error ?? new Error(`Web exited before readiness (${result.code ?? result.signal}).\n${scrub(errors)}`))
      })
    })
    const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie, 'the Web profile must issue its normal authenticated browser cookie')
    const headers = { cookie }
    const page = await fetch(new URL('/', url), { headers, signal: AbortSignal.timeout(15_000) })
    assert.equal(page.status, 200)
    const html = await page.text()
    const boot = /globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s.exec(html)
    assert.ok(boot, 'the Web page must carry its client module graph')
    const graph = JSON.parse(boot[1])
    const browserRows = graph.entries.filter(entry => entry.id === 'dsh-our-free-model')
    assert.equal(browserRows.length, 1, 'the browser half must appear exactly once')
    const client = await fetch(new URL(browserRows[0].url, url), { headers, signal: AbortSignal.timeout(15_000) })
    assert.equal(client.status, 200)
    assert.match(await client.text(), /dsh-our-free-model/)
    const response = await fetch(new URL('/api/our-free-model/meta', url), { headers, signal: AbortSignal.timeout(15_000) })
    assert.equal(response.status, 200, 'the host plugin must serve its settings API')
    const meta = await response.json()
    assert.equal(meta.distribution, 'managed')
    assert.equal(meta.update.managed, true)
    assert.equal(meta.feed.source, 'managed')
    console.log('PASS: one local host plugin, one served browser plugin, authenticated settings API, managed updates. No model completion requested.')
  } finally {
    if (child && completion) {
      child.kill('SIGTERM')
      const timeout = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 25_000)
      timeout.unref()
      await completion
      clearTimeout(timeout)
    }
    rmSync(home, { recursive: true, force: true })
    if (forced) throw new Error('The combined application did not stop within its shutdown deadline.')
  }
}

main().catch(error => {
  console.error(`TestingPlatform smoke failed: ${error.message}`)
  process.exitCode = 1
})
