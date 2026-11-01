/** Browser persistence data and mutations shared by controller and Slot views. */
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserTabState } from './BrowserPersistence.ts'

/** All Browser tabs in one Session-scoped store. */
export interface BrowserState {
  byTab: Record<TabId, BrowserTabState>
}

type BrowserActions = {
  replace: (draft: BrowserState, tabId: TabId, state: BrowserTabState) => void
  forget: (draft: BrowserState, tabId: TabId) => void
}

/** Browser store handle shared by body and title registrations. */
export type BrowserStore = EngineStoreHandle<BrowserState, BrowserActions>
