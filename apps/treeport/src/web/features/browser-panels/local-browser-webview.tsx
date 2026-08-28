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
import { useToolPicker } from '../panels/tool-picker-context'

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
  inputBlocked,
  onConnection,
  onMessage,
  onPaintRetentionChange,
  onFocusSurface
}: {
  panel: BrowserPanel
  inputBlocked: boolean
  onConnection: (connection: BrowserPanelConnection | null) => void
  onMessage: (message: BrowserServerMessage) => void
  onPaintRetentionChange: (retained: boolean) => Promise<boolean>
  onFocusSurface: () => void
}) {
  const { dismiss: dismissToolPicker } = useToolPicker()
  const webviewRef = useRef<TreeportBrowserWebview>(null)
  const inputBlockedRef = useRef(inputBlocked)
  inputBlockedRef.current = inputBlocked
  const initialPanelRef = useRef(panel)
  const ownerClientIdRef = useRef(crypto.randomUUID())
  const [agentLocked, setAgentLocked] = useState(false)
  const agentLockedRef = useRef(false)
  const bindWebview = useCallback(
    (webview: TreeportBrowserWebview | null) => {
      webviewRef.current = webview
      if (webview) {
        webview.setAttribute('partition', 'persist:treeport-browser')
        webview.setAttribute('allowpopups', 'true')
        webview.src = `about:blank#treeport-panel=${encodeURIComponent(
          panel.id
        )}`
      }
    },
    [panel.id]
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
    let previousAgentFocus: HTMLElement | null = null
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
    const clearLocalAgentControl = () => {
      agentLockedRef.current = false
      if (!disposed) {
        setAgentLocked(false)
      }

      void onPaintRetentionChange(false)
      if (
        previousAgentFocus?.isConnected &&
        (document.activeElement === webview ||
          document.activeElement === document.body) &&
        !previousAgentFocus.closest('[inert]')
      ) {
        previousAgentFocus.focus({ preventScroll: true })
      }

      previousAgentFocus = null
    }
    const releaseAgentControl = async (reportControlChange: boolean) => {
      const accepted = await bridge
        .setBrowserAgentControl(panel.id, false)
        .then(
          (result) => result,
          () => false
        )
      clearLocalAgentControl()
      if (reportControlChange) {
        emitState('controlChanged')
      }

      return accepted
    }
    const crashed = () => {
      const message = 'The local Browser page stopped.'
      owner?.sendCrash(message)
      void releaseAgentControl(false)
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
        clearLocalAgentControl()
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
                if (!locked) {
                  return releaseAgentControl(true)
                }

                const accepted = await bridge
                  .setBrowserAgentControl(panel.id, true)
                  .then(
                    (result) => result,
                    () => false
                  )
                if (!accepted || disposed) {
                  if (accepted) {
                    await releaseAgentControl(false)
                  }

                  return false
                }

                agentLockedRef.current = true
                setAgentLocked(true)
                const paintable = await onPaintRetentionChange(true).then(
                  (result) => result,
                  () => false
                )
                if (!paintable || disposed) {
                  await releaseAgentControl(false)
                  return false
                }

                previousAgentFocus =
                  document.activeElement instanceof HTMLElement &&
                  document.activeElement !== webview
                    ? document.activeElement
                    : null
                // Electron must focus the guest once after display:none.
                // The input barriers stay active during this brief preparation.
                const workspace = webview.closest('section')
                const workspaceWasInert = workspace?.inert === true
                if (workspaceWasInert) {
                  workspace.inert = false
                }

                webview.focus({ preventScroll: true })
                if (workspaceWasInert) {
                  workspace.inert = true
                }

                emitState('controlChanged')
                return true
              },
              requestClose: (force) =>
                bridge.requestBrowserClose(panel.id, force),
              closed(reason) {
                if (!disposed) {
                  clearLocalAgentControl()
                  onMessage({ type: 'closed', reason })
                  bridge.disposeBrowser(panel.id)
                }
              },
              disconnected() {
                clearLocalAgentControl()
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

    const focusBrowser = () => {
      if (inputBlockedRef.current || agentLockedRef.current) {
        return
      }

      dismissToolPicker()
      onFocusSurface()
    }
    const stopBrowserFocus = bridge.onBrowserFocus((panelId) => {
      if (panelId === panel.id) {
        focusBrowser()
      }
    })
    const refreshEventNames = [
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated'
    ]
    webview.addEventListener('focus', focusBrowser)
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
      stopBrowserFocus()
      stopPopup()
      webview.removeEventListener('focus', focusBrowser)
      webview.removeEventListener('did-start-loading', startLoading)
      webview.removeEventListener('did-stop-loading', stopLoading)
      webview.removeEventListener('render-process-gone', crashed)
      for (const eventName of refreshEventNames) {
        webview.removeEventListener(eventName, refresh)
      }
      webview.removeEventListener('dom-ready', register)
      connection.dispose()
    }
  }, [
    onConnection,
    onMessage,
    onPaintRetentionChange,
    onFocusSurface,
    dismissToolPicker,
    panel.id
  ])

  return (
    <webview
      ref={bindWebview}
      aria-label="Browser page"
      className={`flex size-full bg-zinc-950 ${
        inputBlocked || agentLocked ? 'pointer-events-none' : ''
      }`}
    />
  )
}
