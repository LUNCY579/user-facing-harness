/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Whether a WHATWG URL hostname names the local loopback authority: localhost
 * (including subdomains), IPv6 loopback, or any IPv4 address in 127/8.
 * @param hostname - the parsed URL's hostname (IPv6 literals retain brackets).
 */
function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/gu, '')
  if (bare === 'localhost' || bare === '::1' || bare.endsWith('.localhost')) return true
  const parts = bare.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Assert a Streamable HTTP endpoint's URL is safe to carry authenticated
 * traffic. Plain HTTP is accepted only for loopback endpoints (local dev
 * servers); a remote plaintext endpoint would send the configured headers —
 * often credentials — and every tool payload unencrypted. Fails loud at
 * plugin load instead of silently downgrading transport security.
 * @param url - the configured endpoint URL, verbatim.
 * @returns the parsed URL, ready for the transport.
 * @throws when the URL is unparsable, uses a non-HTTP(S) scheme, or serves
 *   plain HTTP to a non-loopback host.
 */
export function parseTransportUrl(url: string): URL {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`mcp-client: streamable-http endpoint must use http or https, got "${parsed.protocol}"`)
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`mcp-client: streamable-http endpoint ${url} serves plain HTTP to a non-loopback host; use https for remote servers`)
  }
  return parsed
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @returns an unstarted MCP transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        parseTransportUrl(config.url),
        { requestInit: { headers: config.headers } },
      )
  }
}
