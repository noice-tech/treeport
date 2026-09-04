import { useCallback, useEffect, useRef, useState } from 'react'
import { browserUrlSchema, decodeUnknownOrNull } from '@treeport/shared'
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
    decodeUnknownOrNull(browserUrlSchema, currentUrl) !== null
      ? currentUrl
      : fallbackUrl
  const bounds = webview.getBoundingClientRect()
  return {
    url,
    title: webview.getTitle(),
    loading,
    canGoBack: webview.canGoBack(),
    canGoForward: webview.canGoForward(),
    viewport: {
      width: Math.max(0, Math.min(3_840, Math.round(bounds.width))),
      height: Math.max(0, Math.min(2_160, Math.round(bounds.height)))
    }
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
  const [externalController, setExternalController] = useState<
    'agent' | 'other' | null
  >(null)
  const externalControllerRef = useRef<'agent' | 'other' | null>(null)
  const retainPaintRef = useRef(false)
  const takeControlRef = useRef<() => void>(() => undefined)
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
    let previousExternalFocus: HTMLElement | null = null
    let owner: LocalBrowserOwnerConnection | null = null
    let descriptor: Awaited<ReturnType<typeof bridge.registerBrowser>> = null
    let descriptorChallenge: string | null = null
    let reconnectTimer: number | null = null
    let domReady = false
    let hasOwnedRuntime = false

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
      controlled: externalControllerRef.current === null,
      hasController: true,
      controller: externalControllerRef.current ?? 'you'
    })
    const emitState = (
      type: 'ready' | 'state' | 'controlChanged' = 'state',
      reportToOwner = true
    ) => {
      if (disposed || !reporting) {
        return
      }

      const state = browserState(webview, fallbackUrl, loading)
      fallbackUrl = state.url
      onMessage({ type, state: sessionState(state) })
      if (!reportToOwner) {
        return
      }

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
    const clearRuntimeControl = () => {
      externalControllerRef.current = null
      retainPaintRef.current = false
      if (!disposed) {
        setExternalController(null)
      }

      void bridge.setBrowserInputControl(panel.id, false).catch(() => false)
      void onPaintRetentionChange(false)
      previousExternalFocus = null
    }
    const setRuntimeControl = async (
      controller: 'agent' | 'other' | 'none',
      retainPaint: boolean
    ) => {
      const previousController = externalControllerRef.current
      const previousRetainPaint = retainPaintRef.current
      const locked = controller !== 'none'
      const prepareWithInputLocked = locked || retainPaint
      const prepared = await bridge
        .setBrowserInputControl(panel.id, prepareWithInputLocked)
        .then(
          (result) => result,
          () => false
        )
      if (!prepared || disposed) {
        return false
      }

      const paintable = await onPaintRetentionChange(retainPaint).then(
        (result) => result,
        () => false
      )
      if (!paintable || disposed) {
        await bridge
          .setBrowserInputControl(panel.id, previousController !== null)
          .catch(() => false)
        await onPaintRetentionChange(previousRetainPaint).catch(() => false)
        return false
      }

      if (locked && previousController === null) {
        previousExternalFocus =
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== webview
            ? document.activeElement
            : null
      }

      if (retainPaint) {
        // Electron must focus the guest once after display:none.
        // The input barrier stays active during this brief preparation.
        const workspace = webview.closest('section')
        const workspaceWasInert = workspace?.inert === true
        if (workspaceWasInert) {
          workspace.inert = false
        }

        webview.focus({ preventScroll: true })
        if (workspaceWasInert) {
          workspace.inert = true
        }
      }

      if (!locked && prepareWithInputLocked) {
        const unlocked = await bridge
          .setBrowserInputControl(panel.id, false)
          .then(
            (result) => result,
            () => false
          )
        if (!unlocked || disposed) {
          await bridge
            .setBrowserInputControl(panel.id, previousController !== null)
            .catch(() => false)
          await onPaintRetentionChange(previousRetainPaint).catch(() => false)
          return false
        }
      }

      externalControllerRef.current = locked ? controller : null
      retainPaintRef.current = retainPaint
      setExternalController(locked ? controller : null)
      if (!locked) {
        if (
          previousController === 'other' &&
          webview.checkVisibility() &&
          !webview.closest('[inert]')
        ) {
          webview.focus({ preventScroll: true })
        } else if (
          previousExternalFocus?.isConnected &&
          !previousExternalFocus.closest('[inert]')
        ) {
          previousExternalFocus.focus({ preventScroll: true })
        }

        previousExternalFocus = null
      }

      emitState('controlChanged', false)
      return true
    }
    const crashed = () => {
      const message = 'The local Browser page stopped.'
      owner?.sendCrash(message)
      clearRuntimeControl()
      onMessage({ type: 'browserCrashed', message })
    }

    const connection: BrowserPanelConnection = {
      send(message: BrowserClientMessage) {
        if (disposed || !ready || externalControllerRef.current !== null) {
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
        clearRuntimeControl()
        owner?.dispose()
        bridge.disposeBrowser(panel.id)
      }
    }
    onConnection(connection)

    const queueReconnect = (cause: unknown) => {
      if (disposed) {
        return
      }

      owner = null
      takeControlRef.current = () => undefined
      reportError(cause)
      if (reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          connectOwner()
        }, 500)
      }
    }
    const connectOwner = () => {
      if (disposed || registering || owner || !domReady) {
        return
      }

      registering = true
      void (async () => {
        const ownerTicket = await requestLocalBrowserOwnerTicket(
          panel.id,
          ownerClientIdRef.current
        )
        if (!descriptor || descriptorChallenge !== ownerTicket.challenge) {
          descriptor = await bridge.registerBrowser(
            panel.id,
            webview.getWebContentsId(),
            ownerTicket.challenge
          )
          descriptorChallenge = ownerTicket.challenge
        }

        if (!descriptor || descriptor.panelId !== panel.id) {
          throw new Error('The desktop app rejected this Browser.')
        }

        let connectionOwner: LocalBrowserOwnerConnection | null = null
        connectionOwner = await connectLocalBrowserOwner(
          panel.id,
          ownerTicket,
          descriptor.endpoint,
          {
            setRuntimeControl,
            requestClose: (force) =>
              bridge.requestBrowserClose(panel.id, force),
            closed(reason) {
              if (!disposed) {
                clearRuntimeControl()
                onMessage({ type: 'closed', reason })
                bridge.disposeBrowser(panel.id)
              }
            },
            disconnected() {
              if (!owner || owner === connectionOwner) {
                queueReconnect('The local Browser owner disconnected.')
              }
            }
          }
        )
        if (disposed) {
          connectionOwner.dispose()
          return
        }

        owner = connectionOwner
        takeControlRef.current = () => owner?.takeControl()
        if (hasOwnedRuntime || connectionOwner.resumed) {
          loading = webview.isLoading()
          ready = true
          reporting = true
          emitState('ready')
          return
        }

        hasOwnedRuntime = true
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
      })()
        .catch((cause) => {
          descriptor = null
          descriptorChallenge = null
          queueReconnect(cause)
        })
        .finally(() => {
          registering = false
        })
    }

    const focusBrowser = () => {
      if (inputBlockedRef.current || externalControllerRef.current !== null) {
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
    const browserReady = () => {
      domReady = true
      connectOwner()
    }
    webview.addEventListener('dom-ready', browserReady)
    const resizeObserver = new ResizeObserver(() => emitState())
    resizeObserver.observe(webview)

    const stopPopup = bridge.onBrowserPopup((popup) => {
      if (!disposed && popup.panelId === panel.id) {
        owner?.sendPopup(popup.url)
      }
    })

    return () => {
      onConnection(null)
      takeControlRef.current = () => undefined
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
      }

      resizeObserver.disconnect()
      stopBrowserFocus()
      stopPopup()
      webview.removeEventListener('focus', focusBrowser)
      webview.removeEventListener('did-start-loading', startLoading)
      webview.removeEventListener('did-stop-loading', stopLoading)
      webview.removeEventListener('render-process-gone', crashed)
      for (const eventName of refreshEventNames) {
        webview.removeEventListener(eventName, refresh)
      }
      webview.removeEventListener('dom-ready', browserReady)
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
    <div className="relative size-full">
      <webview
        ref={bindWebview}
        aria-label="Browser page"
        className={`flex size-full bg-zinc-950 ${
          inputBlocked || externalController ? 'pointer-events-none' : ''
        }`}
      />
      {externalController ? (
        <button
          type="button"
          className="absolute inset-0 cursor-pointer bg-transparent"
          aria-label="Take control of Browser"
          title="Take control of Browser"
          onClick={() => takeControlRef.current()}
        />
      ) : null}
    </div>
  )
}
