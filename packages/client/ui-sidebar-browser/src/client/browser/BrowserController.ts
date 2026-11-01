/** Carrier-independent tab commands and renderer-facing state. */
import { createSnapshotStore, type BoundActions, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserPage, BrowserPageFactory } from '../contract/BrowserPage.ts'
import { currentBrowserTarget, type BrowserTabState } from '../contract/BrowserPersistence.ts'
import type { BrowserStore } from '../contract/store.ts'
import type { BrowserControllerState, BrowserInjected } from '../contract/BrowserController.ts'
import { parseBrowserAddress, type BrowserAddressFailure } from '../contract/url.ts'

/** Construction inputs for one tab occurrence. */
export interface BrowserControllerOptions {
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly applicationOrigin: string
  readonly initial: BrowserTabState | undefined
  readonly actions: BoundActions<BrowserStore>
  readonly createPage: BrowserPageFactory
  readonly openTab: (url: string) => void
}

/** Owns input validation and page lifetime without inspecting the carrier type. */
export class BrowserController implements HostObservable<BrowserControllerState> {
  private readonly page: BrowserPage
  private readonly store: SnapshotStore<BrowserControllerState>
  private readonly unsubscribe: () => void
  private actions: BoundActions<BrowserStore>
  private checkpoint: BrowserTabState | undefined
  private started = false
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly abort = (): void => { void this.dispose() }

  /** @param options - identity, persistence, page factory and source-tab navigation. */
  constructor(private readonly options: BrowserControllerOptions) {
    this.actions = options.actions
    this.checkpoint = options.initial
    this.page = options.createPage({
      initial: options.initial,
      persist: (state) => {
        if (this.disposed) return
        this.checkpoint = state
        this.actions.replace(options.tabId, state)
      },
      openRequested: (value) => {
        if (this.disposed) return
        const result = parseBrowserAddress(value, options.applicationOrigin)
        if (!result.ok) { this.addressFailed(result.reason); return }
        options.openTab(result.target.url)
      },
    })
    this.store = createSnapshotStore({ frame: this.page.frame.getSnapshot(),
      restoreTarget: currentBrowserTarget(this.checkpoint), addressFailure: undefined, addressRevision: 0 })
    this.unsubscribe = this.page.frame.subscribe(() => {
      if (this.disposed) return
      const current = this.store.getSnapshot()
      const frame = this.page.frame.getSnapshot()
      const changed = frame.target?.url !== current.frame.target?.url
      this.store.set({ frame, restoreTarget: frame.target === undefined ? currentBrowserTarget(this.checkpoint) : undefined,
        addressFailure: changed ? undefined : current.addressFailure,
        addressRevision: current.addressRevision + Number(changed) })
    })
    options.signal.addEventListener('abort', this.abort, { once: true })
  }

  /** @returns immutable state for the common toolbar. */
  getSnapshot = (): BrowserControllerState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /**
   * Attach the page without transferring ownership of its tab occurrence.
   * @param viewportId - mounted content container.
   * @returns physical attachment cleanup only.
   */
  mount(viewportId: string): () => void {
    this.publishSaved()
    return this.page.presentation.mount(viewportId)
  }

  /**
   * Consume initial navigation once; a saved checkpoint alone never starts a page.
   * @param initialUrl - explicit typed-open address, or absence.
   */
  start(initialUrl: string | undefined): void {
    if (this.started || this.disposed) return
    this.started = true
    if (initialUrl !== undefined) this.loadUrl(initialUrl)
  }

  /** Load the saved address only after an explicit restore action. */
  restore(): void {
    const target = this.store.getSnapshot().restoreTarget
    if (target !== undefined) this.loadUrl(target.url)
  }

  /**
   * Validate an address before navigation, publishing invalid input for correction.
   * @param value - address-bar or typed-open input.
   */
  loadUrl(value: string): void {
    if (this.disposed) return
    const parsed = parseBrowserAddress(value, this.options.applicationOrigin)
    if (!parsed.ok) { this.addressFailed(parsed.reason); return }
    this.command(() => { this.page.frame.loadUrl(parsed.target) })
  }

  /** Delegate Back to the page's navigation provider. */
  goBack(): void { this.command(() => { this.page.frame.goBack() }) }
  /** Delegate Forward to the page's navigation provider. */
  goForward(): void { this.command(() => { this.page.frame.goForward() }) }
  /** Restore a saved address, or reload the already requested page. */
  reload(): void {
    if (this.store.getSnapshot().restoreTarget !== undefined) this.restore()
    else this.command(() => { this.page.frame.reload() })
  }

  /**
   * Apply the optional embedding-sandbox control; unsupported providers remain unchanged.
   * @param enabled - whether to enforce the provider's embedding sandbox.
   */
  setSandbox(enabled: boolean): void {
    const sandbox = this.page.frame.sandbox
    if (sandbox !== undefined) this.command(() => { sandbox.setEnabled(enabled) })
  }

  /**
   * Redirect future checkpoint writes to a replacement Session binding.
   * @param actions - replacement persistence writer.
   */
  rebind(actions: BoundActions<BrowserStore>): void { this.actions = actions }

  /**
   * Release the page and detach occurrence and state listeners.
   * @returns after page teardown; repeated callers join the same disposal.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.options.signal.removeEventListener('abort', this.abort)
    this.unsubscribe()
    this.disposal = this.page.frame.dispose()
    return this.disposal
  }

  private publishSaved(): void {
    if (this.checkpoint !== undefined) this.actions.replace(this.options.tabId, this.checkpoint)
  }

  private addressFailed(reason: BrowserAddressFailure): void {
    this.store.set({ ...this.store.getSnapshot(), addressFailure: reason })
  }

  private command(run: () => void): void {
    if (this.disposed) return
    const current = this.store.getSnapshot()
    this.store.set({ ...current, addressFailure: undefined, addressRevision: current.addressRevision + 1 })
    run()
  }
}

/**
 * Own tab-occurrence controllers behind Session-scoped callbacks.
 * @param actions - persisted view-state writer.
 * @param createPage - composition-selected provider.
 * @param isTabOpen - authoritative layout membership, independent of mounted bodies and plugin lifetime.
 * @returns tab callbacks.
 */
export function createBrowserControllers(actions: BoundActions<BrowserStore>, createPage: BrowserPageFactory,
  isTabOpen: (tabId: TabId) => boolean): BrowserInjected {
  let currentActions = actions
  const controllers = new Map<TabId, {
    readonly signal: AbortSignal
    readonly controller: BrowserController
    readonly forget: () => void
  }>()
  const controller = (id: TabId): BrowserController | undefined => controllers.get(id)?.controller
  return {
    keyedHooks: { browserState: key => controller(key as TabId) },
    mount(request) {
      const { tabId, signal } = request
      if (signal.aborted) return () => {}
      let held = controllers.get(tabId)
      if (held?.signal !== signal) {
        if (held !== undefined) {
          held.signal.removeEventListener('abort', held.forget)
          void held.controller.dispose()
        }
        const created = new BrowserController({ ...request, actions: currentActions, createPage })
        const forget = (): void => {
          controllers.delete(tabId)
          // Plugin unload also aborts occurrences; only layout removal deletes saved navigation.
          if (!isTabOpen(tabId)) currentActions.forget(tabId)
        }
        held = { signal, controller: created, forget }
        controllers.set(tabId, held)
        signal.addEventListener('abort', forget, { once: true })
      }
      const hide = held.controller.mount(request.viewportId)
      held.controller.start(request.initialUrl)
      return hide
    },
    dispose: async () => {
      const pending = [...controllers.values()].map(({ signal, controller, forget }) => {
        signal.removeEventListener('abort', forget)
        return controller.dispose()
      })
      controllers.clear()
      await Promise.all(pending)
    },
    rebind: (actions) => {
      currentActions = actions
      for (const { controller } of controllers.values()) controller.rebind(actions)
    },
    loadUrl: (id, value) => { controller(id)?.loadUrl(value) },
    restore: (id) => { controller(id)?.restore() },
    goBack: (id) => { controller(id)?.goBack() },
    goForward: (id) => { controller(id)?.goForward() },
    reload: (id) => { controller(id)?.reload() },
    setSandbox: (id, enabled) => { controller(id)?.setSandbox(enabled) },
  }
}
