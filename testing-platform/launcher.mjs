/** Launch the combined checkout through the existing dsh CLI. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { platformArguments, platformEnvironment, preparePlatformProfile, repositoryRoot } from './profile.mjs'
import { restoreNativeAssets } from './restore-native-assets.mjs'

const root = repositoryRoot
const environment = platformEnvironment()
const pnpm = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')

/** Run owned processes together; termination waits for every child to exit. */
function supervise(commands, childEnvironment = environment) {
  return new Promise((resolve, reject) => {
    const children = []
    let stopping = false
    let remaining = commands.length
    let result = 0
    let failure
    let timer
    const stop = (signal = 'SIGTERM') => {
      if (stopping) return
      stopping = true
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      timer = setTimeout(() => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 20_000)
      timer.unref()
    }
    const interrupt = () => { result = 130; stop('SIGINT') }
    const terminate = () => { result = 143; stop() }
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    for (const args of commands) {
      const child = spawn(process.execPath, args, { cwd: root, env: childEnvironment, stdio: 'inherit' })
      children.push(child)
      child.once('error', error => { failure ??= error; result = 1; stop() })
      child.once('close', (code, signal) => {
        if (!stopping) {
          result = code ?? (signal === 'SIGINT' ? 130 : 1)
          stop()
        }
        remaining -= 1
        if (remaining !== 0) return
        clearTimeout(timer)
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', terminate)
        if (failure) reject(failure)
        else resolve(result)
      })
    }
  })
}

/** Fail before launch when dependencies or built application assets are absent. */
function requireArtifacts() {
  for (const path of ['apps/cli/lib/bin.js', 'apps/web/dist/index.html']) {
    if (!existsSync(join(root, path))) throw new Error(`Missing ${path}; run pnpm install --frozen-lockfile and pnpm run setup.`)
  }
}

async function main() {
  const [command = 'start', ...args] = process.argv.slice(2)
  if (!['setup', 'start', 'dev', 'config'].includes(command)) throw new Error(`Unknown command ${command}; expected setup, start, dev, or config.`)
  if (!existsSync(pnpm)) throw new Error('Dependencies are missing; run pnpm install --frozen-lockfile first.')
  const profileArgs = platformArguments(args)
  if (command !== 'config') await restoreNativeAssets()
  if (command === 'setup' || command === 'dev') {
    if (command === 'setup' && args.length) throw new Error('setup takes no arguments.')
    const status = await supervise([[pnpm, 'run', 'build:artifacts']])
    if (status !== 0) return status
    if (command === 'setup') {
      const check = await supervise([[pnpm, 'run', 'build:check']], {
        ...environment, DSH_GATE_CONCURRENCY: environment.DSH_GATE_CONCURRENCY ?? '1',
      })
      if (check !== 0) return check
    }
  }
  requireArtifacts()
  const directory = preparePlatformProfile({ home: environment.DSH_HOME })
  if (command === 'setup') {
    console.log(`TestingPlatform ready. Profile: ${directory}\nStart the combined application with pnpm start.`)
    return 0
  }
  if (command === 'dev') {
    return supervise([
      ['--import', 'tsx', 'scripts/dev-web.ts', '--poll', '--skip-build', '--no-serve'],
      ['--watch', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...profileArgs],
    ])
  }
  const cliArgs = command === 'config' ? platformArguments(['--dump-config', ...args]) : profileArgs
  return supervise([['apps/cli/lib/bin.js', ...cliArgs]])
}

main().then(status => { process.exitCode = status }, error => {
  console.error(`TestingPlatform: ${error.message}`)
  process.exitCode = 1
})
