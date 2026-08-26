import { useCallback, useEffect, useRef, useState } from 'react'
import { browserUrlSchema } from '@treeport/shared'
import type {
  BrowserClientMessage,
  BrowserPanel,
  BrowserRuntimeState,
  BrowserServerMessage,
  BrowserSessionState
} from '@treeport/shared'
import type { BrowserPanelConnection } from '../../browser-session-client'
import {
  connectLocalBrowserOwner,
  requestLocalBrowserOwnerTicket,
  type LocalBrowserOwnerConnection
} from '../../local-browser-owner-client'

function browserState(
  webview: TreeportBrowserWebview,
  fallbackUrl: string,
  loading = webview.isLoading()
): BrowserRuntimeState {
  const observedUrl = webview.getURL()
  const currentUrl =
    loading && observedUrl === 'about:blank' && fallbackUrl !== 'about:blank'
      ? fallbackUrl
      : observedUrl || fallbackUrl
  const url =
    currentUrl === 'about:blank' ||
    browserUrlSchema.safeParse(currentUrl).success
      ? currentUrl
      : fallbackUrl
  return {
    url,
    title: webview.getTitle(),
    loading,
    canGoBack: webview.canGoBack(),
    canGoForward: webview.canGoForward(),
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
  const ownerClientIdRef = useRef(crypto.randomUUID())
  const [agentLocked, setAgentLocked] = useState(false)
  const agentLockedRef = useRef(false)
  const bindWebview = useCallback(
    (webview: TreeportBrowserWebview | null) => {
      webviewRef.current = webview
      if (webview) {
        webview.setAttribute(
          'partition',
          `treeport-browser-${computerId}-${panel.id}`
        )
        webview.setAttribute('allowpopups', 'true')
        webview.src = 'about:blank'
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
    let registering = false
    let reporting = false
    let ready = false
    let loading = false
    let fallbackUrl = initialPanelRef.current.url
    let owner: LocalBrowserOwnerConnection | null = null
    let ownerTicket: Awaited<
      ReturnType<typeof requestLocalBrowserOwnerTicket>
    > | null = null

    const reportError = (cause: unknown) => {
      if (disposed) {
        return
      }

      onMessage({
        type: 'browserUnavailable',
        message: cause instanceof Error ? cause.message : String(cause),
        installCommand: null
      })
    }
    const sessionState = (state: BrowserRuntimeState): BrowserSessionState => ({
      ...state,
      controlled: !agentLockedRef.current,
      hasController: true,
      controller: agentLockedRef.current ? 'agent' : 'you'
    })
    const emitState = (
      type: 'ready' | 'state' | 'controlChanged' = 'state'
    ) => {
      if (disposed || !reporting) {
        return
      }

      const state = browserState(webview, fallbackUrl, loading)
      fallbackUrl = state.url
      onMessage({ type, state: sessionState(state) })
      if (type === 'ready') {
        owner?.sendReady(state)
      } else {
        owner?.sendState(state)
      }
    }
    const startLoading = () => {
      loading = true
      emitState()
    }
    const stopLoading = () => {
      loading = false
      emitState()
    }
    const refresh = () => emitState()
    const crashed = () => {
      const message = 'The local Browser page stopped.'
      owner?.sendCrash(message)
      onMessage({ type: 'browserCrashed', message })
    }

    const connection: BrowserPanelConnection = {
      send(message: BrowserClientMessage) {
        if (disposed || !ready || agentLockedRef.current) {
          return
        }

        if (
          message.type !== 'navigate' &&
          message.type !== 'back' &&
          message.type !== 'forward' &&
          message.type !== 'reload' &&
          message.type !== 'stop'
        ) {
          return
        }

        if (message.type === 'navigate') {
          fallbackUrl = message.url
          startLoading()
        } else if (
          message.type === 'back' ||
          message.type === 'forward' ||
          message.type === 'reload'
        ) {
          startLoading()
        } else {
          stopLoading()
        }

        void bridge.browserCommand(panel.id, message).then((result) => {
          if (!result.ok && result.error) {
            onMessage({ type: 'navigationError', message: result.error })
          }
        })
      },
      setVisible() {},
      dispose() {
        if (disposed) {
          return
        }

        disposed = true
        owner?.dispose()
        bridge.disposeBrowser(panel.id)
      }
    }
    onConnection(connection)

    const register = () => {
      if (disposed || registering || owner || !ownerTicket) {
        return
      }

      registering = true
      void bridge
        .registerBrowser(
          panel.id,
          webview.getWebContentsId(),
          ownerTicket.challenge
        )
        .then((descriptor) => {
          if (!descriptor || descriptor.panelId !== panel.id) {
            throw new Error('The desktop app rejected this Browser.')
          }

          return connectLocalBrowserOwner(
            panel.id,
            ownerTicket!,
            descriptor.endpoint,
            {
              async setAgentControl(locked) {
                const accepted = await bridge.setBrowserAgentControl(
                  panel.id,
                  locked
                )
                if (!accepted || disposed) {
                  return false
                }

                agentLockedRef.current = locked
                setAgentLocked(locked)
                if (locked) {
                  await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => resolve())
                  )
                }

                const state = browserState(webview, fallbackUrl, loading)
                onMessage({
                  type: 'controlChanged',
                  state: {
                    ...state,
                    controlled: !locked,
                    hasController: true,
                    controller: locked ? 'agent' : 'you'
                  }
                })
                return true
              },
              requestClose: (force) =>
                bridge.requestBrowserClose(panel.id, force),
              closed(reason) {
                if (!disposed) {
                  onMessage({ type: 'closed', reason })
                  bridge.disposeBrowser(panel.id)
                }
              },
              disconnected() {
                reportError('The local Browser owner disconnected.')
                bridge.disposeBrowser(panel.id)
              }
            }
          )
        })
        .then(async (connectionOwner) => {
          if (!connectionOwner || disposed) {
            connectionOwner?.dispose()
            return
          }

          owner = connectionOwner
          const initialUrl = connectionOwner.initialState.url
          fallbackUrl = initialUrl
          loading = initialUrl !== 'about:blank'
          reporting = true
          if (initialUrl === 'about:blank') {
            ready = true
            emitState('ready')
            return
          }

          emitState()
          const result = await bridge.browserCommand(panel.id, {
            type: 'navigate',
            url: initialUrl
          })
          if (disposed) {
            return
          }

          loading = false
          ready = true
          emitState('ready')
          if (!result.ok && result.error) {
            onMessage({ type: 'navigationError', message: result.error })
          }
        })
        .catch((cause) => {
          bridge.disposeBrowser(panel.id)
          reportError(cause)
        })
        .finally(() => {
          registering = false
        })
    }

    const refreshEventNames = [
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated'
    ]
    webview.addEventListener('did-start-loading', startLoading)
    webview.addEventListener('did-stop-loading', stopLoading)
    webview.addEventListener('render-process-gone', crashed)
    for (const eventName of refreshEventNames) {
      webview.addEventListener(eventName, refresh)
    }
    webview.addEventListener('dom-ready', register)

    const stopPopup = bridge.onBrowserPopup((popup) => {
      if (!disposed && popup.panelId === panel.id) {
        owner?.sendPopup(popup.url)
      }
    })
    void requestLocalBrowserOwnerTicket(
      panel.id,
      ownerClientIdRef.current
    ).then((ticket) => {
      ownerTicket = ticket
      register()
    }, reportError)

    return () => {
      onConnection(null)
      stopPopup()
      webview.removeEventListener('did-start-loading', startLoading)
      webview.removeEventListener('did-stop-loading', stopLoading)
      webview.removeEventListener('render-process-gone', crashed)
      for (const eventName of refreshEventNames) {
        webview.removeEventListener(eventName, refresh)
      }
      webview.removeEventListener('dom-ready', register)
      connection.dispose()
    }
  }, [onConnection, onMessage, panel.id])

  return (
    <webview
      ref={bindWebview}
      aria-label="Browser page"
      className={`flex size-full bg-white ${inputBlocked || agentLocked ? 'pointer-events-none' : ''}`}
    />
  )
}
