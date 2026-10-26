/** Verify the built Web profile and a plugin completion against a local fixture. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { platformEnvironment, repositoryRoot } from './profile.mjs'

const root = repositoryRoot

function scrub(text) {
  return text.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[redacted]')
}

async function waitForCompletion(completion, milliseconds) {
  let timer
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stopApplication(child, completion) {
  const terminate = signal => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      // As in run-gates.ts, kill the tree while its root still exists: on
      // Windows SIGTERM kills the launcher without forwarding to its CLI child.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 10_000,
      })
    } else child.kill(signal)
  }
  try {
    terminate('SIGTERM')
    if (await waitForCompletion(completion, 25_000)) return
    terminate('SIGKILL')
    await waitForCompletion(completion, 5_000)
    throw new Error('The combined application did not stop within its shutdown deadline.')
  } finally {
    // A descendant holding an inherited pipe must not prevent the smoke from
    // reporting a shutdown failure and cleaning its other resources.
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
  }
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'testingplatform-smoke-'))
  const environment = platformEnvironment({ ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' })
  const requests = []
  const modelId = 'testingplatform-fixture'
  const reply = 'TestingPlatform plugin connection verified.'
  const fixture = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404)
      response.end()
      return
    }
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] }) + '\n\n')
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error.message }))
    }
  })
  let child
  let completion
  try {
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const fixtureBase = `http://127.0.0.1:${fixture.address().port}/v1`
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

    const post = async (path, body) => {
      const response = await fetch(new URL('/api/our-free-model' + path, url), {
        method: 'POST', headers: { ...headers, origin: new URL(url).origin, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      })
      const result = await response.json()
      assert.equal(response.status, 200, `${path}: ${result.error ?? response.status}`)
      return result
    }
    await post('/providers', { providerId: 'ollama', enabled: true, baseUrl: fixtureBase, models: [] })
    const discovered = await post('/providers/discover', { providerId: 'ollama' })
    assert.deepEqual(discovered.models, [modelId], 'saved local provider models must be discoverable')
    const summary = await fetch(new URL('/api/our-free-model/summary', url), { headers, signal: AbortSignal.timeout(15_000) })
    assert.equal(summary.status, 200)
    assert.ok((await summary.json()).catalog.some(entry => entry.id === 'ollama/' + modelId), 'the plugin catalog must include the configured model')
    const modelReply = await post('/bench', { model: 'ollama/' + modelId })
    assert.equal(modelReply.ok, true)
    assert.equal(modelReply.text, reply, 'the plugin must return the upstream response text')
    assert.equal(modelReply.persisted, true, 'the measured availability result must be saved')
    assert.equal(requests.length, 1, 'setup and discovery must not submit extra generations')
    assert.equal(requests[0].model, modelId, 'the adapter must strip the provider prefix on the wire')
    assert.equal(requests[0].stream, true)
    assert.ok(!requests[0].tools || requests[0].tools.length === 0, 'Text test must not request tools')
    assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content === 'Reply with exactly: OK'))
  } finally {
    try {
      if (child && completion) await stopApplication(child, completion)
    } finally {
      try {
        fixture.closeAllConnections()
        const closed = new Promise((resolve, reject) => fixture.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()))
        if (!await waitForCompletion(closed, 5_000)) throw new Error('The local fixture did not close within its shutdown deadline.')
      } finally {
        rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      }
    }
  }
  console.log('PASS: authenticated combined Web app, local plugin assets, saved provider discovery, and one streamed plugin completion with returned response text. No external model completion requested.')
}

main().catch(error => {
  console.error(`TestingPlatform smoke failed: ${error.message}`)
  process.exitCode = 1
})
