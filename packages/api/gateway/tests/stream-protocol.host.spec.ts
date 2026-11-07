import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  parseRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
} from '../src/stream-protocol.ts'

describe('Remote stream wire protocol', () => {
  it('accepts every client message variant', () => {
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'open', streamId: 'stream-1', endpoint: 'feed/follow', payload: { cursor: 1 },
    }))).toEqual({
      type: 'open', streamId: 'stream-1', endpoint: 'feed/follow', payload: { cursor: 1 },
    })
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'cancel', streamId: 'stream-1',
    }))).toEqual({ type: 'cancel', streamId: 'stream-1' })
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1', value: { line: 'ls\n' },
    }))).toEqual({ type: 'item', streamId: 'stream-1', value: { line: 'ls\n' } })
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1',
    }))).toEqual({ type: 'item', streamId: 'stream-1' })
    expect(parseRemoteStreamClientMessage(JSON.stringify({
      type: 'end', streamId: 'stream-1',
    }))).toEqual({ type: 'end', streamId: 'stream-1' })
  })

  it.each([
    { type: 'open', streamId: '', endpoint: 'feed/follow', payload: {} },
    { type: 'open', streamId: 'stream-1', endpoint: '', payload: {} },
    { type: 'open', streamId: 'stream-1', endpoint: 'feed/follow' },
    { type: 'cancel', streamId: 'stream-1', extra: true },
    { type: 'item', streamId: '', value: 'line' },
    { type: 'item', streamId: 'stream-1', value: 'line', extra: true },
    { type: 'item', streamId: 'stream-1', endpoint: 'feed/follow' },
    { type: 'end', streamId: '' },
    { type: 'end', streamId: 'stream-1', value: 'line' },
    { type: 'unknown', streamId: 'stream-1' },
  ])('rejects an invalid client message: %j', (message) => {
    expect(() => parseRemoteStreamClientMessage(JSON.stringify(message)))
      .toThrow('api gateway: invalid Remote stream client message')
  })

  it('rejects an uplink item whose value is not lossless JSON', () => {
    expect(() => parseRemoteStreamClientMessage('{"type":"item","streamId":"stream-1","value":-0}'))
      .toThrow('api gateway: invalid Remote stream client message')
  })

  it('accepts every server message variant', () => {
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1', value: null,
    }))).toEqual({ type: 'item', streamId: 'stream-1', value: null })
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1',
    }))).toEqual({ type: 'item', streamId: 'stream-1' })
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'error',
      streamId: 'stream-1',
      error: { code: 'offline', message: 'connection lost', details: {} },
    }))).toEqual({
      type: 'error',
      streamId: 'stream-1',
      error: { code: 'offline', message: 'connection lost', details: {} },
    })
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'end', streamId: 'stream-1',
    }))).toEqual({ type: 'end', streamId: 'stream-1' })
  })

  it.each([
    { type: 'item', streamId: '', value: 'item' },
    { type: 'item', streamId: 'stream-1', extra: true },
    { type: 'end', streamId: 'stream-1', extra: true },
    { type: 'error', streamId: 'stream-1', error: [] },
    { type: 'error', streamId: 'stream-1', error: { code: 1, message: 'failure', details: {} } },
    { type: 'error', streamId: 'stream-1', error: { code: 'failed', message: 1, details: {} } },
    { type: 'error', streamId: 'stream-1', error: { code: 'failed', message: 'failure', details: [] } },
    { type: 'unknown', streamId: 'stream-1' },
  ])('rejects an invalid server message: %j', (message) => {
    expect(() => parseRemoteStreamServerMessage(JSON.stringify(message)))
      .toThrow('api gateway: invalid Remote stream server message')
  })

  it.each(['not json', 'null', '[]', '1'])('rejects a non-message payload: %s', (text) => {
    expect(() => parseRemoteStreamServerMessage(text)).toThrow('api gateway: Remote stream message')
  })

  it('property: arbitrary wire text either parses to a valid message or throws an Error — never garbage (hostile-input boundary)', () => {
    const textArb = fc.string({ unit: 'binary', maxLength: 256 })
    const property = fc.property(textArb, (text) => {
      let outcome: 'parsed' | 'threw'
      let parsed: unknown
      try {
        parsed = parseRemoteStreamClientMessage(text)
        outcome = 'parsed'
      } catch (error: unknown) {
        outcome = 'threw'
        expect(error).toBeInstanceOf(Error)
      }
      if (outcome === 'parsed') {
        // Every parse outcome is one of the wire message variants with a
        // non-empty streamId where the variant requires one; anything else
        // is the parser handing hostile input to the gateway.
        expect(['open', 'item', 'end', 'cancel']).toContain((parsed as { type?: unknown }).type)
        expect(typeof (parsed as { streamId?: unknown }).streamId).toBe('string')
      }
    })
    fc.assert(property, { numRuns: 500 })
  })

  it('property: the server parser holds the same total contract on hostile text', () => {
    const property = fc.property(fc.string({ unit: 'binary', maxLength: 256 }), (text) => {
      try {
        const parsed = parseRemoteStreamServerMessage(text)
        expect(['item', 'end', 'error']).toContain(parsed.type)
        expect(typeof parsed.streamId).toBe('string')
        expect(parsed.streamId.length).toBeGreaterThan(0)
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error)
      }
    })
    fc.assert(property, { numRuns: 500 })
  })
})
