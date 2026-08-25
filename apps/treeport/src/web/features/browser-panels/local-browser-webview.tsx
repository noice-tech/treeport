import { useCallback, useEffect, useRef } from 'react'
import { browserUrlSchema } from '@treeport/shared'
import type {
  BrowserClientMessage,
  BrowserPanel,
  BrowserServerMessage,
  BrowserSessionState
} from '@treeport/shared'
import type { BrowserPanelConnection } from '../../browser-session-client'

function browserState(
  webview: TreeportBrowserWebview,
  loading = webview.isLoading()
): BrowserSessionState {
  return {
    url: webview.getURL() || 'about:blank',
    title: webview.getTitle(),
    loading,
    canGoBack: webview.canGoBack(),
    canGoForward: webview.canGoForward(),
    controlled: true,
    hasController: true,
    controller: 'you',
    viewport: { width: 0, height: 0 }
  }
}

export function LocalBrowserWebview({
  panel,
  computerId,
  inputBlocked,
  onConnection,
  onMessage
}: {
  panel: BrowserPanel
  computerId: string
  inputBlocked: boolean
  onConnection: (connection: BrowserPanelConnection | null) => void
  onMessage: (message: BrowserServerMessage) => void
}) {
  const webviewRef = useRef<TreeportBrowserWebview>(null)
  const initialPanelRef = useRef(panel)
  const bindWebview = useCallback(
    (webview: TreeportBrowserWebview | null) => {
      webviewRef.current = webview
      if (webview) {
        webview.setAttribute(
          'partition',
          `treeport-browser-${computerId}-${panel.id}`
        )
        webview.setAttribute('allowpopups', 'true')
        webview.src = initialPanelRef.current.url
      }
    },
    [computerId, panel.id]
  )

  useEffect(() => {
    const webview = webviewRef.current
    const bridge = window.treeportDesktop
    if (!webview || !bridge) {
      return
    }

    let disposed = false
    let ready = false
    let loading = false
    let persisted = `${initialPanelRef.current.url}\u0000${initialPanelRef.current.title}`
    let pendingPersistence: BrowserSessionState | null = null
    let persistence: Promise<void> | null = null

    const reportError = (cause: unknown) => {
      onMessage({
        type: 'browserUnavailable',
        message: cause instanceof Error ? cause.message : String(cause),
        installCommand: null
      })
    }
    const persist = (state: BrowserSessionState) => {
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
          const response = await fetch(
            `/api/panels/${encodeURIComponent(panel.id)}/browser-state`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url: next.url, title: next.title })
            }
          )
          if (!response.ok) {
            throw new Error('Could not save the local Browser state.')
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
    const emitState = (type: 'ready' | 'state' = 'state') => {
      if (disposed) {
        return
      }

      const state = browserState(webview, loading)
      onMessage({ type, state })
      persist(state)
    }
    const startLoading = () => {
      loading = true
      if (ready) {
        emitState()
      }
    }
    const stopLoading = () => {
      loading = false
      if (ready) {
        emitState()
      }
    }
    const register = () => {
      if (ready || disposed) {
        return
      }

      void bridge
        .registerBrowser(panel.id, webview.getWebContentsId())
        .then((registered) => {
          if (disposed) {
            return
          }

          if (!registered) {
            throw new Error('The desktop app rejected this Browser.')
          }

          loading = webview.isLoading()
          ready = true
          emitState('ready')
        })
        .catch(reportError)
    }
    const refresh = () => {
      if (ready) {
        emitState()
      }
    }
    const refreshEventNames = [
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated'
    ]
    webview.addEventListener('did-start-loading', startLoading)
    webview.addEventListener('did-stop-loading', stopLoading)
    for (const eventName of refreshEventNames) {
      webview.addEventListener(eventName, refresh)
    }
    webview.addEventListener('dom-ready', register)

    const stopPopup = bridge.onBrowserPopup((popup) => {
      if (disposed || popup.panelId !== panel.id) {
        return
      }

      void fetch(`/api/panels/${encodeURIComponent(panel.id)}/browser-popups`, {
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
    const connection: BrowserPanelConnection = {
      send(message: BrowserClientMessage) {
        if (disposed) {
          return
        }

        if (message.type === 'navigate') {
          startLoading()
          void webview.loadURL(message.url).catch(reportError)
        } else if (message.type === 'back' && webview.canGoBack()) {
          startLoading()
          webview.goBack()
        } else if (message.type === 'forward' && webview.canGoForward()) {
          startLoading()
          webview.goForward()
        } else if (message.type === 'reload') {
          startLoading()
          webview.reload()
        } else if (message.type === 'stop') {
          stopLoading()
          webview.stop()
        }
      },
      setVisible() {},
      dispose() {
        disposed = true
        stopPopup()
        webview.removeEventListener('did-start-loading', startLoading)
        webview.removeEventListener('did-stop-loading', stopLoading)
        for (const eventName of refreshEventNames) {
          webview.removeEventListener(eventName, refresh)
        }
        webview.removeEventListener('dom-ready', register)
        bridge.disposeBrowser(panel.id)
      }
    }
    onConnection(connection)
    return () => {
      onConnection(null)
      connection.dispose()
    }
  }, [onConnection, onMessage, panel.id])

  return (
    <webview
      ref={bindWebview}
      aria-label="Browser page"
      className={`flex size-full bg-white ${inputBlocked ? 'pointer-events-none' : ''}`}
    />
  )
}
