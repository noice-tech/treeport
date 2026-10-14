import type { DesktopBridge } from '@treeport/desktop-bridge'

declare global {
  interface TreeportBrowserWebview extends HTMLElement {
    src: string
    getWebContentsId(): number
    getURL(): string
    getTitle(): string
    executeJavaScript<T>(code: string): Promise<T>
    isLoading(): boolean
    canGoBack(): boolean
    canGoForward(): boolean
    loadURL(url: string): Promise<void>
    goBack(): void
    goForward(): void
    reload(): void
    stop(): void
    findInPage(
      text: string,
      options?: { forward?: boolean; findNext?: boolean }
    ): number
    stopFindInPage(action: 'clearSelection' | 'keepSelection'): void
  }

  interface Window {
    readonly treeportDesktop?: DesktopBridge
  }
}
