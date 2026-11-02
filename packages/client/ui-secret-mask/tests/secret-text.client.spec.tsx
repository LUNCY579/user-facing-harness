// @vitest-environment jsdom
/** The masked credential renderer: reveal control, accessible names, and reset to masked. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SecretText } from '../src/client/SecretText.tsx'
import { en, zh } from '../src/client/locales.ts'
import { createSecretRule } from '../src/client/secret-rule.ts'

afterEach(cleanup)

type Props = ComponentProps<typeof SecretText>

// Assembled at run time so the repository holds no literal in a credential format.
const KEY = ['sk', '-', '0123456789abcdef0123456789abcdef'].join('')
const OTHER = ['sk', '-', 'fedcba9876543210fedcba9876543210'].join('')
const masked = (value: string): string => value.slice(0, 8) + '*'.repeat(value.length - 8)
const PRIVATE_KEY_BEGIN = ['-----BEGIN', ' PRIVATE KEY-----'].join('')
const PRIVATE_KEY_END = ['-----END', ' PRIVATE KEY-----'].join('')

function props(raw: string, interactive: boolean, dictionary: Record<string, string> = zh): Props {
  // The component reads only these owner and locale seats.
  return {
    node: { id: 'secret', start: 0, end: raw.length, data: { masked: masked(raw) } },
    raw, interactive, t: makeTranslate(dictionary),
  } as Props
}

function recognizedProps(source: string): Props {
  const node = createSecretRule().match(source, 0, { read: () => undefined })
  if (node?.id !== 'secret') throw new Error('fixture did not produce a credential node')
  return { ...props(KEY, true, en), node, raw: source.slice(node.start, node.end) }
}

describe('SecretText', () => {
  it('draws only the masked form without a control in non-interactive text', () => {
    const view = render(<div data-host><SecretText {...props(KEY, false)} /></div>)
    const run = view.container.querySelector('[data-secret]')!
    expect(run.textContent).toBe(masked(KEY))
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('reveals and hides the value from its own control', () => {
    const view = render(<SecretText {...props(KEY, true)} />)
    const run = view.container.querySelector('[data-secret]')!
    const reveal = view.getByRole('button', { name: '显示密钥' })
    expect(run.textContent).toBe(masked(KEY))
    expect(reveal.getAttribute('aria-pressed')).toBe('false')
    expect(reveal.querySelector('svg')).not.toBeNull()

    fireEvent.click(reveal)
    expect(run.textContent).toBe(KEY)
    const hide = view.getByRole('button', { name: '隐藏密钥' })
    expect(hide.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(hide)
    expect(run.textContent).toBe(masked(KEY))
  })

  it('starts masked again when a different credential reuses the same element', () => {
    const view = render(<SecretText {...props(KEY, true, en)} />)
    fireEvent.click(view.getByRole('button', { name: 'Show secret' }))
    view.rerender(<SecretText {...props(OTHER, true, en)} />)
    expect(view.container.querySelector('[data-secret]')!.textContent).toBe(masked(OTHER))
    expect(view.getByRole('button', { name: 'Show secret' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('retains the ASCII text fragment elements when revealing and hiding', () => {
    const view = render(<SecretText {...props(KEY, true, en)} />)
    const run = view.container.querySelector('[data-secret]')!
    const value = run.firstElementChild!
    const fragments = [...value.children]
    expect(fragments.map(fragment => fragment.textContent)).toEqual([KEY.slice(0, 8), '*'.repeat(KEY.length - 8)])
    fireEvent.click(view.getByRole('button', { name: 'Show secret' }))
    expect(fragments.map(fragment => fragment.textContent)).toEqual([KEY.slice(0, 8), KEY.slice(8)])
    for (const [index, fragment] of fragments.entries()) expect(value.children[index]).toBe(fragment)
    fireEvent.click(view.getByRole('button', { name: 'Hide secret' }))
    expect(run.textContent).toBe(masked(KEY))
    for (const [index, fragment] of fragments.entries()) expect(value.children[index]).toBe(fragment)
  })

  it.each([
    ['astral password', 'postgres://u:p\u{1f642}x@db'],
    ['astral-only password', 'postgres://u:\u{1f642}@db'],
    ['lone high-surrogate password', 'postgres://u:p\ud83dx@db'],
    ['lone low-surrogate password', 'postgres://u:p\udc00x@db'],
    ['mixed-surrogate password', 'postgres://u:p\u{1f642}\ud83dx@db'],
    ['Unicode private-key body', [PRIVATE_KEY_BEGIN, 'a\u{1f642}b\udc00c\ud83dx\ud83d', PRIVATE_KEY_END].join('\n')],
    ['Unicode private-key body with CRLF', [PRIVATE_KEY_BEGIN, 'a\u{1f642}b', '\ud83dx', PRIVATE_KEY_END].join('\r\n')],
    ['prefixed credential joined to a Unicode key block', `${KEY}${[PRIVATE_KEY_BEGIN, 'a\u{1f642}b', PRIVATE_KEY_END].join('\n')}`],
  ])('reveals the exact original %s and leaves only the mask when hidden', (_name, source) => {
    const input = recognizedProps(source)
    const view = render(<SecretText {...input} />)
    const run = view.container.querySelector('[data-secret]')!
    expect(run.textContent).toBe(input.node.data.masked)
    expect(run.innerHTML).not.toContain(input.raw)
    fireEvent.click(view.getByRole('button', { name: 'Show secret' }))
    expect(run.textContent).toBe(input.raw)
    fireEvent.click(view.getByRole('button', { name: 'Hide secret' }))
    expect(run.textContent).toBe(input.node.data.masked)
    expect(run.innerHTML).not.toContain(input.raw)
  })
})
