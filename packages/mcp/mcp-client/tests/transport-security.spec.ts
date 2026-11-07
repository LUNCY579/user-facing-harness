/**
 * Transport URL security: a Streamable HTTP endpoint must not send the
 * configured headers and tool payloads over plaintext to a remote host.
 * @module packages/mcp/mcp-client/tests/transport-security.spec
 */

import { describe, expect, it } from 'vitest'
import { parseTransportUrl } from '../src/transport.ts'

describe('parseTransportUrl', () => {
  it('accepts https for any host', () => {
    expect(parseTransportUrl('https://mcp.example.com/mcp').hostname).toBe('mcp.example.com')
  })

  it('accepts plain http for loopback endpoints', () => {
    for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.1:8765/mcp', 'http://[::1]:9000/mcp', 'http://dev.localhost:4000/mcp']) {
      expect(parseTransportUrl(url).protocol).toBe('http:')
    }
  })

  it('refuses plain http to a remote host', () => {
    expect(() => parseTransportUrl('http://mcp.example.com/mcp'))
      .toThrow('plain HTTP to a non-loopback host')
  })

  it('refuses non-HTTP schemes', () => {
    for (const url of ['file:///etc/passwd', 'ftp://mcp.example.com/x', 'javascript://alert(1)']) {
      expect(() => parseTransportUrl(url)).toThrow('must use http or https')
    }
  })

  it('refuses an unparsable endpoint', () => {
    expect(() => parseTransportUrl('not a url at all')).toThrow()
  })
})
