#!/usr/bin/env node
/**
 * NVIDIA NIM custom endpoint helper for TestingPlatform.
 *
 * This is a stdlib-only Node helper. It does NOT store, print, or commit
 * any API key. The key is read only from the environment variable
 * NVIDIA_NIM_API_KEY at run time, on the machine running the helper.
 * Never put a key in this file, in a .env file you commit, or in a
 * session export / bundle sent to anyone.
 *
 * Usage:
 *   NVIDIA_NIM_API_KEY=... node demo-pack/nim-endpoint.mjs --list
 *   NVIDIA_NIM_API_KEY=... node demo-pack/nim-endpoint.mjs --test --model <model-id>
 *   NVIDIA_NIM_API_KEY=... node demo-pack/nim-endpoint.mjs --tool-test --model <model-id>
 *
 *   --base-url defaults to https://integrate.api.nvidia.com/v1
 *
 * --list prints every model id returned by GET /v1/models for your key.
 * That list is the "all models available" list: TestingPlatform's
 * Aggregate lane (plugins/dsh-our-free-model/src/aggregate.js) uses a
 * discovered list in preference to the registry's bundled models, and a
 * Model override can add any exact id. This helper does not restrict
 * the list to any bundled subset, and it does not label a model
 * "free" on its own: whether a model is free for your account is
 * decided by NVIDIA's build.nvidia.com model page and your account,
 * not by this listing. Check that page before running a model you
 * have not priced.
 *
 * --test is a text-only check ("Reply with exactly: OK").
 * --tool-test also sends a tool definition and reports whether the
 * model actually returned a tool call. A text test alone does NOT
 * prove a model works for TestingPlatform tasks, which use tools.
 */
import process from 'node:process'

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

function usage() {
  return [
    'Usage:',
    '  NVIDIA_NIM_API_KEY=... node demo-pack/nim-endpoint.mjs --list',
    '  NVIDIA_NIM_API_KEY=... node demo-pack/nim-endpoint.mjs --test --model <model-id>',
    '  NVIDIA_NIM_API_KEY=... node demo-pack/nim-endpoint.mjs --tool-test --model <model-id>',
    'Options: --base-url <url>  (default: ' + DEFAULT_BASE_URL + ')',
  ].join('\n')
}

function parseArgs(argv) {
  const args = { list: false, test: false, toolTest: false, model: '', baseUrl: DEFAULT_BASE_URL }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') args.list = true
    else if (a === '--test') args.test = true
    else if (a === '--tool-test') args.toolTest = true
    else if (a === '--model') args.model = argv[++i] ?? ''
    else if (a === '--base-url') args.baseUrl = argv[++i] ?? ''
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0) }
    else { console.error('Unknown argument: ' + a + '\n' + usage()); process.exit(2) }
  }
  return args
}

function redact(text, key) {
  if (!key) return text
  return String(text).split(key).join('[API key redacted]')
}

async function listModels(baseUrl, key) {
  const url = baseUrl.replace(/\/+$/, '') + '/models'
  const res = await fetch(url, { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } })
  const body = await res.text()
  if (!res.ok) throw new Error('GET ' + url + ' -> HTTP ' + res.status + ': ' + redact(body.slice(0, 500), key))
  let payload
  try { payload = JSON.parse(body) } catch { throw new Error('Model listing was not valid JSON') }
  const rows = Array.isArray(payload.data) ? payload.data : []
  const ids = rows.map((row) => row.id).filter((id) => typeof id === 'string' && id !== '')
  return ids
}

async function chatCompletion(baseUrl, key, model, withTools) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model,
    messages: [{ role: 'user', content: withTools ? 'Use the get_demo_value tool, then answer with its value.' : 'Reply with exactly: OK' }],
    max_tokens: 256,
  }
  if (withTools) {
    body.tools = [{
      type: 'function',
      function: {
        name: 'get_demo_value',
        description: 'Return a fixed demo value for testing tool calling.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }]
    body.tool_choice = 'auto'
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('POST ' + url + ' -> HTTP ' + res.status + ': ' + redact(text.slice(0, 500), key))
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error('Chat completion was not valid JSON') }
  return payload
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.list && !args.test && !args.toolTest) {
    console.error(usage())
    process.exit(2)
  }
  const key = (process.env.NVIDIA_NIM_API_KEY ?? '').trim()
  if (key === '') {
    console.error('NVIDIA_NIM_API_KEY is not set. Set it in your shell environment only; do not put it in a file you commit or send.')
    process.exit(2)
  }
  if ((args.test || args.toolTest) && args.model === '') {
    console.error('--model <model-id> is required for --test / --tool-test. Run --list first and pick an exact id.')
    process.exit(2)
  }
  if (args.list) {
    const ids = await listModels(args.baseUrl, key)
    console.log(ids.length + ' model(s) listed for this key:')
    for (const id of ids) console.log('  ' + id)
  }
  if (args.test || args.toolTest) {
    const payload = await chatCompletion(args.baseUrl, key, args.model, args.toolTest)
    const choice = payload.choices?.[0]
    const message = choice?.message ?? {}
    console.log('model: ' + args.model)
    console.log('text: ' + JSON.stringify(message.content ?? null))
    if (args.toolTest) {
      const calls = message.tool_calls ?? []
      console.log('tool_calls: ' + calls.length + (calls.length > 0 ? ' (' + calls.map((c) => c.function?.name ?? '').join(', ') + ')' : ''))
      if (calls.length === 0) console.log('NOTE: this model answered in text without calling the tool. Do not assume it will work for tool-using tasks; try a task with real tools (e.g. demo T1) before pooling it.')
    }
    if (payload.usage) console.log('usage: ' + JSON.stringify(payload.usage))
  }
}

main().catch((error) => {
  const key = (process.env.NVIDIA_NIM_API_KEY ?? '').trim()
  console.error('Error: ' + redact(error.message ?? String(error), key))
  process.exit(1)
})
