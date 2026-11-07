/**
 * Tests for the fixture secret scan: each shape detects its own shape,
 * synthetic placeholder text stays clean, and diagnostics never echo the
 * matched text.
 * @module scripts/verify-secrets-scan.spec
 */

import { describe, expect, it } from 'vitest'
import { scanText } from './verify-secrets-scan.ts'

describe('verify-secrets-scan', () => {
  it('detects each secret shape and reports file, line, and shape only', () => {
    const text = 'key: sk-abcdefghijklmnopqrstuvwx\nline two\n  token = "ghp_abcdefghijklmnopqrstuvwx"\n'
    const failures = scanText('snapshots/example.jsonl', text)
    expect(failures).toEqual([
      'snapshots/example.jsonl:1: OpenAI-style API key',
      'snapshots/example.jsonl:3: GitHub token',
      'snapshots/example.jsonl:3: bearer credential in committed text',
    ])
  })

  it('detects a PEM private key and a JWT', () => {
    const text = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
    ].join('\n')
    const failures = scanText('examples/demo.md', text)
    expect(failures).toContain('examples/demo.md:1: PEM private key')
    expect(failures).toContain('examples/demo.md:2: JWT')
  })

  it('leaves synthetic placeholder text clean', () => {
    const text = [
      'DEEPSEEK_API_KEY=sk-test-local-only',
      'apiKey: "<redacted>"',
      'token: test-key',
      'eyJhbGciOi is not a jwt alone',
    ].join('\n')
    expect(scanText('demo-pack/x.yaml', text)).toEqual([])
  })

  it('never echoes the matched text in a diagnostic', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx'
    const [failure] = scanText('snapshots/a.md', secret)
    expect(failure).toBeDefined()
    expect(failure).not.toContain(secret)
  })
})
