import type {
  BrowserClientMessage,
  BrowserPanel,
  BrowserServerMessage,
  BrowserSessionState
} from '@treeport/shared'
import { browserUrlSchema } from '@treeport/shared'
import type {
  BrowserPanelBounds,
  BrowserPanelConnection
} from './browser-session-client'

function sessionState(state: TreeportDesktopBrowserState): BrowserSessionState {
  return {
    url: state.url,
    title: state.title,
    loading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    controlled: true,
    hasController: true,
    controller: 'you',
    viewport: { width: 0, height: 0 }
  }
}

export function nativeBrowserAvailable(
  bridge: TreeportDesktopBridge | undefined = window.treeportDesktop
): boolean {
  return Boolean(bridge?.openBrowser)
}

export function requestNativeBrowserClose(
  panelId: string,
  force: boolean,
  bridge: TreeportDesktopBridge | undefined = window.treeportDesktop
): Promise<boolean> {
  return bridge?.requestBrowserClose(panelId, force) ?? Promise.resolve(true)
}

export function connectNativeBrowserPanel(
  panel: BrowserPanel,
  initialVisible: boolean,
  handlers: {
    message(message: BrowserServerMessage): void
  },
  bridge: TreeportDesktopBridge | undefined = window.treeportDesktop,
  request: typeof fetch = fetch
): BrowserPanelConnection {
  if (!bridge) {
    throw new Error('The native Browser bridge is unavailable.')
  }

  let disposed = false
  let currentBounds: BrowserPanelBounds = {
    x: 0,
    y: 0,
    width: 0,
    height: 0
  }
  let currentVisible = initialVisible
  let persisted = `${panel.url}\u0000${panel.title}`
  let pendingPersistence: TreeportDesktopBrowserState | null = null
  let persistence: Promise<void> | null = null

  const reportError = (cause: unknown) => {
    handlers.message({
      type: 'browserUnavailable',
      message: cause instanceof Error ? cause.message : String(cause),
      installCommand: null
    })
  }
  const persist = (state: TreeportDesktopBrowserState) => {
    if (
      state.url !== 'about:blank' &&
      !browserUrlSchema.safeParse(state.url).success
    ) {
      return
    }

    const key = `${state.url}\u0000${state.title}`
    if (key === persisted) {
      return
    }

    pendingPersistence = state
    persistence ??= (async () => {
      while (pendingPersistence && !disposed) {
        const next = pendingPersistence
        pendingPersistence = null
        const response = await request(
          `/api/panels/${encodeURIComponent(panel.id)}/browser-state`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: next.url, title: next.title })
          }
        )
        if (!response.ok) {
          throw new Error('Could not save the native Browser state.')
        }

        persisted = `${next.url}\u0000${next.title}`
      }
    })().then(
      () => {
        persistence = null
        if (pendingPersistence && !disposed) {
          persist(pendingPersistence)
        }
      },
      (cause) => {
        persistence = null
        reportError(cause)
      }
    )
  }
  const receiveState = (state: TreeportDesktopBrowserState) => {
    if (disposed || state.panelId !== panel.id) {
      return
    }

    handlers.message({ type: 'state', state: sessionState(state) })
    persist(state)
  }
  const stopState = bridge.onBrowserState(receiveState)
  const stopPopup = bridge.onBrowserPopup((popup) => {
    if (disposed || popup.panelId !== panel.id) {
      return
    }

    void request(`/api/panels/${encodeURIComponent(panel.id)}/browser-popups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: popup.url })
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Could not open the Browser popup.')
        }
      })
      .catch(reportError)
  })

  void bridge.openBrowser(panel.id, panel.url).then((state) => {
    if (disposed) {
      return
    }

    if (!state) {
      reportError(new Error('The desktop app could not open Browser.'))
      return
    }

    bridge.setBrowserBounds(panel.id, currentBounds)
    bridge.setBrowserVisible(panel.id, currentVisible)
    handlers.message({ type: 'ready', state: sessionState(state) })
    persist(state)
  }, reportError)

  return {
    send(message: BrowserClientMessage) {
      if (disposed) {
        return
      }

      if (
        message.type === 'navigate' ||
        message.type === 'back' ||
        message.type === 'forward' ||
        message.type === 'reload' ||
        message.type === 'stop'
      ) {
        bridge.sendBrowserCommand(panel.id, message)
      }
    },
    setBounds(bounds) {
      currentBounds = bounds
      bridge.setBrowserBounds(panel.id, bounds)
    },
    setVisible(visible) {
      currentVisible = visible
      bridge.setBrowserVisible(panel.id, visible)
    },
    dispose() {
      disposed = true
      stopState()
      stopPopup()
      bridge.disposeBrowser(panel.id)
    }
  }
}
