/** Persisted Browser tab snapshots shared by the body and title slots. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserTabState } from '../contract/BrowserPersistence.ts'
import type { BrowserState, BrowserStore } from '../contract/store.ts'

/**
 * Declare the Session-scoped Browser persistence store.
 * @returns a fresh store handle for Slot registration.
 */
export function createBrowserStore(): BrowserStore {
  return defineStore({
    init: (): BrowserState => ({ byTab: {} }),
    persist: 'dsh.sidebar-browser.v1',
    actions: {
      replace: (draft, tabId: TabId, state: BrowserTabState) => { draft.byTab[tabId] = state },
      forget: (draft, tabId: TabId) => {
        const byTab: BrowserState['byTab'] = {}
        for (const [id, state] of Object.entries(draft.byTab) as [TabId, BrowserTabState][]) {
          if (id !== tabId) byTab[id] = state
        }
        draft.byTab = byTab
      },
    },
  })
}
