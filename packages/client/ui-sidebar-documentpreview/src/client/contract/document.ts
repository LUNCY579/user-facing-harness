/** Document renderer slot: the owner supplies shared file state, renderers own their presentation. */
import type { PropsRuntime, SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RefCallback } from 'react'

/** Stable plain-text fallback identity shared by the host and its renderer. */
export const PLAIN_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/text'

/** Shared text or byte reads, or content loading owned by the renderer. */
export type DocumentLoadMode = 'text-pages' | 'bytes-complete' | 'renderer'

/** One renderer implementation, independent of its component registration. */
export interface DocumentPreviewDefinition {
  /** Unique implementation name, also used as the document slot key. */
  readonly id: string
  /** File suffixes without a leading dot; compound suffixes such as tar.gz are accepted. */
  readonly extensions: readonly string[]
  /**
   * Suffixes among `extensions` whose bytes are not readable text; a file
   * matching one loses the plain-text fallback among its viewer choices.
   * Every entry must appear in `extensions`; `register` rejects strays.
   */
  readonly binaryExtensions?: readonly string[]
  /** External implementations win over product implementations; defaults to extension. */
  readonly priority?: 'builtin' | 'extension'
  /** Localized implementation label, evaluated when the toolbar renders. @returns the visible name. */
  readonly title: () => string
  /** Content delivery mode supplied by the document owner. */
  readonly loading: DocumentLoadMode
  /** Whether the implementation consumes the document's wrap preference. */
  readonly wrap?: boolean
  /**
   * Whether a `text-pages` body exposes source-line anchors for line navigation;
   * without it, a navigation to a line is answered without moving the body.
   */
  readonly sourceLines?: boolean
}

/** One loaded text window, retaining source line positions. */
export interface DocumentTextPage {
  readonly offset: number
  readonly text: string
  readonly lines: number
}

/**
 * Ordinary file contents, or a request for the selected renderer to load its content.
 * Byte arrays are transient UI input, never persisted layout or Session data.
 */
export type DocumentContent =
  | { readonly kind: 'text'; readonly text: string; readonly pages: readonly DocumentTextPage[]; readonly eof: boolean }
  | { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> }
  | {
    readonly kind: 'renderer'
    /** Changes on reload or implementation replacement; retained contents belong to one revision. */
    readonly revision: number
    /** Report the displayed source version; stale revisions cannot update the owner. @param version - loaded source version. */
    readonly loaded: (version: string) => void
    /** End a failed load; a later file change can start another revision. */
    readonly failed: () => void
    /** Cancel the current load and start a new revision. */
    readonly reload: () => void
  }

/** Content and viewing inputs shared by document bodies and nested PDF presentation. */
export interface DocumentBodyOwner {
  /** Observe a file read by this renderer. @param address - complete file resource address. */
  readonly addResource: (address: string) => void
  /** Replace this renderer's dependencies. @param addresses - complete file resource addresses. */
  readonly setResources: (addresses: readonly string[]) => void
  /** Original file address, also readable through the standard useResource hook. */
  readonly resourceAddress: string
  /** Ordinary file content or a renderer-owned loading request; text accumulates until eof. */
  readonly content: DocumentContent
  /** The document toolbar's current wrapping preference. */
  readonly wrap: boolean
  /** Report a renderer-owned scrollport; passing `null` restores the shared body as the owner. */
  readonly scrollportRef: RefCallback<HTMLElement>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Document body selected by a registered implementation id. */
    'sidebar.right.tab.document': {
      kind: 'keyed'
      scope: 'session'
      owner: DocumentBodyOwner
      hookContext: UseSidebarRightTabInfo
      inject: {
        hooks: {
          tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo>
        }
      }
    }
    /**
     * Header toolbar contributions acting on the previewed file, rendered
     * after the preview's own controls once the file's Host path is known.
     */
    'sidebar.right.tab.document.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** Absolute path in the file's execution environment; native actions must verify a Host mapping. */
        readonly absolutePath: string
      }
    }
    /**
     * Empty-state contributions for a file this preview cannot render,
     * offered where Retry would stand once the file's Host path is known.
     */
    'sidebar.right.tab.document.unpreviewable': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** Absolute path in the file's execution environment; native actions must verify a Host mapping. */
        readonly absolutePath: string
      }
    }
    /** Renderer-specific controls before the document toolbar's reload button. */
    'sidebar.right.tab.document.action': {
      kind: 'keyed'
      scope: 'session'
      owner: { readonly content: DocumentContent }
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> } }
    }
  }
}

/** Standard input for every document body; entry-local stores and locale props can be intersected with it. */
export type DocumentPreviewProps = PropsRuntime<'sidebar.right.tab.document'>

/**
 * Forward the framework's tab reader to the selected document body.
 * @param _standard - framework standard props.
 * @param useTabInfo - enclosing tab's bound reader.
 * @returns the same reader, without another subscription adapter.
 */
export const documentTabInfoFactory: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> =
  (_standard, useTabInfo) => useTabInfo

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** PDF presentation supplied with Office-owned converted bytes. */
    'sidebar.right.tab.document.office.pdf': {
      kind: 'keyed'
      scope: 'session'
      owner: DocumentBodyOwner
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> } }
    }
  }
}
