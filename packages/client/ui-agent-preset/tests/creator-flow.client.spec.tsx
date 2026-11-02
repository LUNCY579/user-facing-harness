// @vitest-environment jsdom
/** Settings follows the active Creator action through its cached renderer injection. */
import { act, fireEvent, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { en } from '../src/client/locales.ts'

usePinnedBrowserLanguages('en')

it.each([false, true])('updates one mounted Settings entry through Creator provider replacement (initially active: %s)', async (initiallyActive) => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const form = stubConfigForm()
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) }, get: () => form.scope,
  })
  const startSession = vi.fn()
  runtime.ctx.provide('uiWorkspace', { startSession })
  runtime.remote.provideNamespaces({
    settings: {},
    agentPresets: { list: async () => ({ ok: true, value: { presets: [
      { id: 'standard', isDefault: true }, { id: 'cordis', isDefault: false },
    ] } }) },
  })
  await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' } })
  const provideConversation = async () => {
    const provider = runtime.ctx.plugin({ apply(ctx) { ctx.provide('conversation', {}) } })
    await provider.await()
    return provider
  }
  let provider = initiallyActive ? await provideConversation() : undefined
  await runtime.mount({ inject: [...inject], apply })
  const entry = runtime.slots.entries('settings.section')[0]!
  const originalInject = entry.inject
  if (originalInject === undefined) throw new Error('Settings entry has no inject factory')
  let injectCalls = 0
  entry.inject = (...args) => {
    injectCalls++
    return originalInject(...args)
  }
  onTestFinished(() => { entry.inject = originalInject })
  const view = runtime.renderSlot('settings.section', { close: vi.fn() })
  await waitFor(() => { expect(view.view.getByRole('button', { name: `${en.inUse}: ${en.presetStandardName}` })).toBeTruthy() })
  const section = view.container.querySelector('section')
  expect(section).not.toBeNull()
  await waitFor(() => { expect(view.view.queryByRole('button', { name: en.creatorDraft }) !== null).toBe(initiallyActive) })
  if (!initiallyActive) {
    await act(async () => {
      provider = await provideConversation()
      await runtime.flush()
    })
    await waitFor(() => { expect(view.view.getByRole('button', { name: en.creatorDraft })).toBeTruthy() })
  }
  fireEvent.click(view.view.getByRole('button', { name: en.creatorDraft }))
  expect(startSession).toHaveBeenCalledExactlyOnceWith(undefined, { clearPreviousDraft: false, agentPreset: 'cordis' })
  if (provider === undefined) throw new Error('Creator provider was not installed')
  const previousProvider = provider
  await act(async () => { await previousProvider.dispose() })
  expect(view.view.queryByRole('button', { name: en.creatorDraft })).toBeNull()
  expect(view.container.querySelector('section')).toBe(section)
  expect(runtime.slots.entries('settings.section')[0]).toBe(entry)
  await act(async () => {
    provider = await provideConversation()
    await runtime.flush()
  })
  await waitFor(() => { expect(view.view.getByRole('button', { name: en.creatorDraft })).toBeTruthy() })
  fireEvent.click(view.view.getByRole('button', { name: en.creatorDraft }))
  expect(startSession).toHaveBeenCalledTimes(2)
  expect(startSession).toHaveBeenLastCalledWith(undefined, { clearPreviousDraft: false, agentPreset: 'cordis' })
  expect(view.container.querySelector('section')).toBe(section)
  expect(runtime.slots.entries('settings.section')[0]).toBe(entry)
  expect(injectCalls).toBe(1)
})
