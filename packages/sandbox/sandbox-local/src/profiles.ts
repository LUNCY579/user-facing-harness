/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { SandboxUnsupportedPolicyError, workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Build the bwrap profile arguments for one policy. A `deny` network policy
 * unshares the network namespace, so the child sees no interfaces and cannot
 * open sockets — enforcement is complete by construction.
 * @param policy - policy to express as bwrap mounts and namespace flags.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.network === 'deny') args.push('--unshare-net')
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    for (const root of workspaceWritableRoots(policy)) args.push('--bind', root, root)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy. Landlock
 * cannot express a network rule, so a `deny` network policy never reaches
 * this builder: `confine` fails loud first.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', ...workspaceWritableRoots(policy))
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/**
 * Quote one path as an SBPL string literal. SBPL string literals have no
 * escape sequences — a backslash is an ordinary character and the first `"`
 * closes the literal — so a path carrying `"`, `\\`, or a C0 control
 * character cannot be represented without changing what the profile grants
 * (a crafted root can close the literal and inject `allow` forms). Such a
 * path is refused instead of granted with attacker-chosen semantics.
 * @param path - granted path to quote.
 * @returns the SBPL literal text.
 * @throws when the path cannot be expressed as one SBPL string literal.
 */
function sbplString(path: string): string {
  if (/["\\\u0000-\u001f]/u.test(path)) {
    throw new SandboxUnsupportedPolicyError('The Seatbelt sandbox backend cannot express a write root containing a quote, backslash, or control character: use a root without them')
  }
  return `"${path}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * workspace-owned writable roots (workspace plus explicit extra directories)
 * come from the shared {@link writableRoots} helper (canonical, deduplicated)
 * so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart; the helper adds the
 * documented Seatbelt temp areas.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  if (policy.network === 'deny') forms.push('(deny network*)')
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
