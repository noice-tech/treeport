import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent
} from 'react'
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ServerStackIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import type {
  BrowserFrame,
  BrowserPanel,
  BrowserServerMessage,
  BrowserSessionState,
  WorktreeListener,
  WorktreeListenerDiscovery
} from '@treeport/shared'
import { browserUrlSchema, decodeUnknownOrNull } from '@treeport/shared'
import { parseResponse, rpc } from '../../api'
import { Button } from '../../components/ui/button'
import { Empty, EmptyDescription, EmptyTitle } from '../../components/ui/empty'
import { Input } from '../../components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import {
  connectBrowserPanel,
  type BrowserPanelConnection
} from '../../browser-session-client'
import { useDesktopRuntime } from '../../desktop-runtime'
import { LocalBrowserWebview } from './local-browser-webview'

function parseBrowserAddress(value: string): URL | null {
  const input = value.trim()
  if (!input) {
    return null
  }

  const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
  const candidate = hasProtocol ? input : `http://${input}`
  const parsed = decodeUnknownOrNull(browserUrlSchema, candidate)
  if (parsed !== null) {
    const url = new URL(parsed)
    if (
      hasProtocol ||
      url.hostname === 'localhost' ||
      url.hostname.includes('.') ||
      url.hostname.includes(':') ||
      url.port
    ) {
      return url
    }
  }

  const candidateUrl = URL.canParse(candidate) ? new URL(candidate) : null
  if (hasProtocol || candidateUrl?.username || candidateUrl?.password) {
    return null
  }

  const search = new URL('https://www.google.com/search')
  search.searchParams.set('q', input)
  return decodeUnknownOrNull(browserUrlSchema, search.href) !== null
    ? search
    : null
}

function listenerUrl(listener: WorktreeListener): URL | null {
  let host = listener.host
  if (['*', '0.0.0.0', '::', '::1', '127.0.0.1'].includes(host)) {
    host = 'localhost'
  } else if (host.includes(':')) {
    host = `[${host}]`
  }

  const value = `http://${host}:${listener.port}/`
  return decodeUnknownOrNull(browserUrlSchema, value) !== null
    ? new URL(value)
    : null
}

export function BrowserPanelWorkspace({
  panel,
  active,
  autoFocusBlocked,
  inputBlocked,
  onLoadingChange,
  onFocusSurface
}: {
  panel: BrowserPanel
  active: boolean
  autoFocusBlocked: boolean
  inputBlocked: boolean
  onLoadingChange: (panelId: string, loading: boolean) => void
  onFocusSurface: () => void
}) {
  const sectionRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const connectionRef = useRef<BrowserPanelConnection | null>(null)
  const stateRef = useRef<BrowserSessionState | null>(null)
  const viewportRef = useRef({ width: 1_280, height: 800 })
  const pointerActiveRef = useRef(false)
  const addressPointerSelectAllRef = useRef(false)
  const addressDirtyRef = useRef(false)
  const autoFocusAddressRef = useRef(panel.url === 'about:blank')
  const pendingNavigationRef = useRef<{
    startUrl: string
    targetUrl: string
  } | null>(null)
  const [connectionRevision, setConnectionRevision] = useState(0)
  const [addressFocusRevision, setAddressFocusRevision] = useState(0)
  const [localBrowserPaintRetained, setLocalBrowserPaintRetained] =
    useState(false)
  const [state, setState] = useState<BrowserSessionState | null>(null)
  const [inputValue, setInputValue] = useState(
    panel.url === 'about:blank' ? '' : panel.url
  )
  const [serversOpen, setServersOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findValue, setFindValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<{
    message: string
    installCommand: string | null
  } | null>(null)
  const [installingBrowser, setInstallingBrowser] = useState(false)
  const [listeners, setListeners] = useState<WorktreeListenerDiscovery | null>(
    null
  )
  const [listenersLoading, setListenersLoading] = useState(false)
  const { localBrowser, computerId } = useDesktopRuntime()

  const send = useCallback(
    (message: Parameters<BrowserPanelConnection['send']>[0]) => {
      connectionRef.current?.send(message)
    },
    []
  )

  const focusPage = useCallback(() => {
    const page =
      canvasRef.current ??
      sectionRef.current?.querySelector<TreeportBrowserWebview>('webview')
    page?.focus({ preventScroll: true })
  }, [])

  const focusAddress = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.select()
  }, [])

  const focusFind = useCallback(() => {
    if (!stateRef.current?.controlled) {
      return
    }

    setFindOpen(true)
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus({ preventScroll: true })
      findInputRef.current?.select()
    })
  }, [])

  const findInPage = useCallback(
    (text: string, forward: boolean, findNext: boolean) => {
      const webview =
        sectionRef.current?.querySelector<TreeportBrowserWebview>('webview')
      if (webview) {
        if (text) {
          webview.findInPage(
            text,
            findNext ? { forward, findNext: true } : undefined
          )
        } else {
          webview.stopFindInPage('clearSelection')
        }

        return
      }

      if (!text) {
        send({ type: 'stopFind' })
        return
      }

      send({ type: 'takeControl' })
      send({ type: 'find', text, forward, findNext })
    },
    [send]
  )

  const closeFind = useCallback(() => {
    setFindOpen(false)
    findInPage('', true, false)
    window.requestAnimationFrame(focusPage)
  }, [findInPage, focusPage])

  const receiveMessage = useCallback(
    (message: BrowserServerMessage) => {
      if (
        message.type === 'ready' ||
        message.type === 'state' ||
        message.type === 'controlChanged'
      ) {
        const previousUrl = stateRef.current?.url ?? panel.url
        stateRef.current = message.state
        setState(message.state)

        if (message.type === 'ready') {
          setAddressFocusRevision((revision) => revision + 1)
        }

        onLoadingChange(panel.id, message.state.loading)
        setFailure(null)
        setInstallingBrowser(false)
        if (!addressDirtyRef.current) {
          setError(null)
        }

        const pendingNavigation = pendingNavigationRef.current
        const validUrl =
          decodeUnknownOrNull(browserUrlSchema, message.state.url) !== null
        // takeControl can report the old page before the queued navigation starts.
        const navigationStarted =
          pendingNavigation === null ||
          (validUrl &&
            (message.state.url === pendingNavigation.targetUrl ||
              message.state.url !== pendingNavigation.startUrl))
        if (!navigationStarted) {
          return
        }

        pendingNavigationRef.current = null
        const receivedAddress =
          message.state.url === 'about:blank'
            ? ''
            : validUrl
              ? message.state.url
              : null
        if (receivedAddress === null) {
          return
        }

        if (addressDirtyRef.current) {
          if (
            document.activeElement === inputRef.current ||
            message.state.url === previousUrl
          ) {
            return
          }

          addressDirtyRef.current = false
          setError(null)
        }

        setInputValue(receivedAddress)
        return
      }

      pendingNavigationRef.current = null
      onLoadingChange(panel.id, false)
      setInstallingBrowser(false)
      if (message.type === 'browserUnavailable') {
        setFailure({
          message: message.message,
          installCommand: message.installCommand
        })
        return
      }

      setError(message.type === 'closed' ? message.reason : message.message)
    },
    [onLoadingChange, panel.id]
  )

  const receiveFrame = useCallback(
    (frame: BrowserFrame) => {
      viewportRef.current = { width: frame.width, height: frame.height }
      const canvas = canvasRef.current
      const drawing = canvas?.getContext('2d', { alpha: false })
      if (!canvas || !drawing) {
        send({ type: 'frameAck', sequence: frame.sequence })
        return
      }

      const bytes = frame.data.slice()
      void createImageBitmap(new Blob([bytes], { type: frame.mimeType }))
        .then((bitmap) => {
          if (canvas.width !== frame.width || canvas.height !== frame.height) {
            canvas.width = frame.width
            canvas.height = frame.height
          }

          drawing.drawImage(bitmap, 0, 0, frame.width, frame.height)
          bitmap.close()
        })
        .finally(() => send({ type: 'frameAck', sequence: frame.sequence }))
    },
    [send]
  )

  useEffect(() => {
    if (localBrowser) {
      return
    }

    const connection = connectBrowserPanel(panel.id, false, {
      message: receiveMessage,
      frame: receiveFrame
    })
    connectionRef.current = connection
    return () => {
      if (connectionRef.current === connection) {
        connectionRef.current = null
      }

      connection.dispose()
    }
  }, [connectionRevision, localBrowser, panel.id, receiveFrame, receiveMessage])

  const setLocalConnection = useCallback(
    (connection: BrowserPanelConnection | null) => {
      connectionRef.current = connection
    },
    []
  )

  const setLocalBrowserPaintRetention = useCallback(
    async (retained: boolean) => {
      setLocalBrowserPaintRetained(retained)
      if (!retained) {
        return true
      }

      let timer: number | null = null
      const layoutReady = await Promise.race([
        new Promise<true>((resolve) =>
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(() => resolve(true))
          )
        ),
        new Promise<false>((resolve) => {
          timer = window.setTimeout(() => resolve(false), 2_000)
        })
      ])
      if (timer) {
        window.clearTimeout(timer)
      }

      const section = sectionRef.current
      const webview = section?.querySelector<TreeportBrowserWebview>('webview')
      if (
        !layoutReady ||
        !section?.isConnected ||
        !webview?.isConnected ||
        !section.checkVisibility() ||
        !webview.checkVisibility()
      ) {
        return false
      }

      const sectionBounds = section.getBoundingClientRect()
      const webviewBounds = webview.getBoundingClientRect()
      return (
        sectionBounds.width > 0 &&
        sectionBounds.height > 0 &&
        webviewBounds.width > 0 &&
        webviewBounds.height > 0
      )
    },
    []
  )

  useEffect(() => {
    if (!localBrowser) {
      connectionRef.current?.setVisible(active && !inputBlocked)
    }
  }, [active, inputBlocked, localBrowser])

  useEffect(() => {
    const canvas = canvasRef.current
    if (localBrowser || !canvas || !active) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(([entry]) => {
      if (timer) {
        clearTimeout(timer)
      }

      if (
        !entry ||
        entry.contentRect.width <= 0 ||
        entry.contentRect.height <= 0
      ) {
        return
      }

      timer = setTimeout(() => {
        const viewport = {
          width: Math.max(
            320,
            Math.min(3_840, Math.round(entry.contentRect.width))
          ),
          height: Math.max(
            200,
            Math.min(2_160, Math.round(entry.contentRect.height))
          )
        }
        viewportRef.current = viewport
        send({ type: 'resize', ...viewport })
      }, 100)
    })
    observer.observe(canvas)
    return () => {
      observer.disconnect()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [active, localBrowser, send])

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- Workspace route activation owns Browser focus. */
  useEffect(() => {
    if (
      !active ||
      autoFocusBlocked ||
      !autoFocusAddressRef.current ||
      stateRef.current === null
    ) {
      return
    }

    if (stateRef.current.url !== 'about:blank') {
      autoFocusAddressRef.current = false
      return
    }

    let frame = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const autoFocusAddress = () => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        frame = window.requestAnimationFrame(autoFocusAddress)
        return
      }

      timer = setTimeout(() => {
        const input = inputRef.current
        if (
          !input ||
          input.value !== '' ||
          stateRef.current?.url !== 'about:blank'
        ) {
          return
        }

        focusAddress()
        autoFocusAddressRef.current = false
      }, 50)
    }
    frame = window.requestAnimationFrame(autoFocusAddress)
    return () => {
      window.cancelAnimationFrame(frame)
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [active, addressFocusRevision, autoFocusBlocked, focusAddress])
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  useEffect(() => {
    if (!active) {
      return
    }

    const focusBrowserControl = (event: globalThis.KeyboardEvent) => {
      const applePlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      const modifier = applePlatform
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey
      const key = event.key.toLowerCase()
      if (
        !modifier ||
        event.altKey ||
        event.shiftKey ||
        (key !== 'f' && key !== 'l') ||
        autoFocusBlocked ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      if (key === 'f') {
        focusFind()
      } else {
        focusAddress()
      }
    }
    document.addEventListener('keydown', focusBrowserControl, true)
    return () =>
      document.removeEventListener('keydown', focusBrowserControl, true)
  }, [active, autoFocusBlocked, focusAddress, focusFind])

  useEffect(() => {
    const desktopBridge = window.treeportDesktop
    if (!active || !desktopBridge) {
      return
    }

    return desktopBridge.onCommand((command) => {
      if (
        (command !== 'find-in-page' && command !== 'focus-location') ||
        autoFocusBlocked ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        return
      }

      if (command === 'find-in-page') {
        focusFind()
      } else {
        focusAddress()
      }
    })
  }, [active, autoFocusBlocked, focusAddress, focusFind])

  const discoverListeners = useCallback(async () => {
    setListenersLoading(true)
    try {
      const parsed = await parseResponse(
        rpc.api.panels[':panelId'].network.listeners.$get({
          param: { panelId: panel.id }
        })
      )
      setListeners(parsed.discovery)
    } catch (cause) {
      setListeners({
        supported: false,
        message: cause instanceof Error ? cause.message : String(cause),
        listeners: []
      })
    } finally {
      setListenersLoading(false)
    }
  }, [panel.id])

  const navigate = (value: string) => {
    const parsed = parseBrowserAddress(value)
    if (!parsed) {
      addressDirtyRef.current = true
      setError(
        'Enter search terms or an HTTP or HTTPS address without credentials.'
      )
      inputRef.current?.focus({ preventScroll: true })
      return
    }

    const targetUrl = parsed.href
    setError(null)
    setFailure(null)
    addressDirtyRef.current = false
    pendingNavigationRef.current = {
      startUrl: stateRef.current?.url ?? panel.url,
      targetUrl
    }
    setInputValue(targetUrl)
    send({ type: 'takeControl' })
    send({ type: 'navigate', url: targetUrl })
    focusPage()
  }

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const viewport = viewportRef.current
    const scale = Math.min(
      bounds.width / viewport.width,
      bounds.height / viewport.height
    )
    const width = viewport.width * scale
    const height = viewport.height * scale
    const left = bounds.left + (bounds.width - width) / 2
    const top = bounds.top + (bounds.height - height) / 2
    return {
      x: Math.max(0, Math.min(viewport.width, (event.clientX - left) / scale)),
      y: Math.max(0, Math.min(viewport.height, (event.clientY - top) / scale))
    }
  }

  const button = (value: number): 'left' | 'right' | 'middle' =>
    value === 2 ? 'right' : value === 1 ? 'middle' : 'left'

  const submit = (event: FormEvent) => {
    event.preventDefault()
    navigate(inputValue)
  }

  const key = (
    event: KeyboardEvent<HTMLCanvasElement>,
    phase: 'down' | 'up'
  ) => {
    event.preventDefault()
    if (phase === 'down') {
      send({ type: 'takeControl' })
    }

    send({ type: 'key', phase, key: event.key })
  }

  const wheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    send({ type: 'takeControl' })
    send({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY })
  }

  const candidates = new Map<string, { url: URL; listener: WorktreeListener }>()
  for (const listener of listeners?.listeners ?? []) {
    const url = listenerUrl(listener)
    if (!url) {
      continue
    }

    const existing = candidates.get(url.href)
    if (!existing || (!existing.listener.terminalId && listener.terminalId)) {
      candidates.set(url.href, { url, listener })
    }
  }
  const discoveredServers = [...candidates.values()].sort(
    (left, right) =>
      left.listener.port - right.listener.port ||
      left.url.href.localeCompare(right.url.href)
  )

  return (
    <section
      ref={sectionRef}
      className={
        active
          ? 'relative z-10 flex h-full min-h-0 flex-col'
          : localBrowserPaintRetained
            ? 'pointer-events-none absolute inset-0 z-0 flex h-full min-h-0 flex-col opacity-0'
            : 'hidden'
      }
      aria-label={panel.title}
      aria-hidden={active ? undefined : true}
      inert={active ? undefined : true}
    >
      <form
        className="flex min-w-0 items-center gap-1.5 border-b border-white/8 bg-zinc-900 px-2 py-1.5"
        aria-label="Browser controls"
        onSubmit={submit}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Go back"
          title="Go back"
          disabled={!state?.canGoBack || !state.controlled}
          onClick={() => send({ type: 'back' })}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Go forward"
          title="Go forward"
          disabled={!state?.canGoForward || !state.controlled}
          onClick={() => send({ type: 'forward' })}
        >
          <ArrowRightIcon />
        </Button>
        {state?.loading ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Stop loading"
            title="Stop loading"
            disabled={!state.controlled}
            onClick={() => send({ type: 'stop' })}
          >
            <XMarkIcon />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reload application"
            title="Reload application"
            disabled={!state?.controlled}
            onClick={() => send({ type: 'reload' })}
          >
            <ArrowPathIcon />
          </Button>
        )}
        <Input
          ref={inputRef}
          type="text"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          name="url"
          aria-label="Application URL"
          className="rounded-full focus:ring-2 focus:ring-cyan-400"
          placeholder="Search Google or type a URL"
          maxLength={4_096}
          value={inputValue}
          onPointerDown={(event) => {
            addressPointerSelectAllRef.current =
              event.button === 0 &&
              document.activeElement !== event.currentTarget
          }}
          onPointerUp={(event) => {
            const selectAll = addressPointerSelectAllRef.current
            addressPointerSelectAllRef.current = false
            if (
              selectAll &&
              event.currentTarget.selectionStart ===
                event.currentTarget.selectionEnd
            ) {
              event.currentTarget.select()
            }
          }}
          onPointerCancel={() => {
            addressPointerSelectAllRef.current = false
          }}
          onChange={(event) => {
            addressDirtyRef.current = true
            setInputValue(event.target.value)
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Escape' ||
              event.shiftKey ||
              event.altKey ||
              event.metaKey ||
              event.ctrlKey
            ) {
              return
            }

            event.preventDefault()
            if (!addressDirtyRef.current) {
              focusPage()
              return
            }

            const acceptedAddress =
              pendingNavigationRef.current?.targetUrl ??
              stateRef.current?.url ??
              panel.url
            addressDirtyRef.current = false
            setError(null)
            setInputValue(
              acceptedAddress === 'about:blank' ? '' : acceptedAddress
            )
            window.requestAnimationFrame(() => inputRef.current?.select())
          }}
        />
        <Popover
          open={serversOpen}
          onOpenChange={(open) => {
            setServersOpen(open)
            if (open && !listenersLoading) {
              void discoverListeners()
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Development servers"
              title="Development servers"
            >
              <ServerStackIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex max-h-[min(28rem,50dvh)] w-[min(22rem,calc(100vw-1rem))] flex-col overflow-hidden p-0"
            aria-label="Development servers"
          >
            <div className="flex shrink-0 items-start justify-between gap-3 px-3 pt-3 pb-2">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Development servers</h2>
                <p className="text-xs text-zinc-400">
                  Select a listening server from this tree.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh development servers"
                title="Refresh development servers"
                disabled={listenersLoading}
                onClick={() => void discoverListeners()}
              >
                <ArrowPathIcon />
              </Button>
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
              {listenersLoading ? (
                <p className="px-2 py-4 text-sm text-zinc-400" role="status">
                  Scanning for development servers…
                </p>
              ) : null}
              {!listenersLoading && listeners && !listeners.supported ? (
                <Empty className="min-h-28 p-4">
                  <EmptyTitle>Server discovery unavailable</EmptyTitle>
                  <EmptyDescription>
                    {listeners.message ??
                      'TCP listener discovery is unavailable.'}
                  </EmptyDescription>
                </Empty>
              ) : null}
              {!listenersLoading &&
              listeners?.supported &&
              discoveredServers.length === 0 ? (
                <Empty className="min-h-28 p-4">
                  <EmptyTitle>No development servers</EmptyTitle>
                  <EmptyDescription>
                    Start a server in a Treeport terminal. Then, refresh this
                    list.
                  </EmptyDescription>
                </Empty>
              ) : null}
              {!listenersLoading && discoveredServers.length > 0 ? (
                <ul role="list" className="flex flex-col gap-0.5">
                  {discoveredServers.map(({ url, listener }) => (
                    <li key={url.href} className="min-w-0">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto w-full justify-start px-2 py-2 text-left"
                        aria-label={`Open ${url.href}, ${
                          listener.command || 'unknown command'
                        }`}
                        onClick={() => {
                          setServersOpen(false)
                          navigate(url.href)
                        }}
                      >
                        <span className="min-w-0">
                          <strong className="block truncate">{url.href}</strong>
                          <span className="mt-0.5 block truncate text-xs text-zinc-400">
                            {listener.command || 'Unknown command'}
                          </span>
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      </form>
      {error ? (
        <p className="bg-red-950 px-2.5 py-1.5 text-red-200" role="alert">
          {error}
        </p>
      ) : null}
      {state?.hasController && !state.controlled ? (
        <p className="bg-amber-950 px-2.5 py-1.5 text-amber-200" role="status">
          {state.controller === 'agent'
            ? 'A coding agent controls this browser. Interact with the viewport to take control.'
            : 'Another Treeport client controls this browser. Interact with the viewport to take control.'}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-zinc-950">
        {findOpen ? (
          <div
            className="absolute top-2 right-2 z-20 flex w-[min(20rem,calc(100%-1rem))] items-center gap-1 rounded-md border border-white/10 bg-zinc-900 p-1 shadow-lg"
            role="search"
            aria-label="Find in page"
          >
            <Input
              ref={findInputRef}
              type="text"
              name="find"
              aria-label="Find in page"
              className="h-8 min-w-0 flex-1"
              placeholder="Find in page"
              maxLength={4_096}
              value={findValue}
              onChange={(event) => {
                const value = event.target.value
                setFindValue(value)
                findInPage(value, true, false)
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Escape' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey
                ) {
                  event.preventDefault()
                  closeFind()
                } else if (
                  event.key === 'Enter' &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey
                ) {
                  event.preventDefault()
                  findInPage(findValue, !event.shiftKey, true)
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Find previous"
              title="Find previous"
              disabled={!findValue}
              onClick={() => findInPage(findValue, false, true)}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Find next"
              title="Find next"
              disabled={!findValue}
              onClick={() => findInPage(findValue, true, true)}
            >
              <ChevronDownIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close find"
              title="Close find"
              onClick={closeFind}
            >
              <XMarkIcon />
            </Button>
          </div>
        ) : null}
        {localBrowser && computerId ? (
          <LocalBrowserWebview
            key={connectionRevision}
            panel={panel}
            inputBlocked={inputBlocked}
            onConnection={setLocalConnection}
            onMessage={receiveMessage}
            onPaintRetentionChange={setLocalBrowserPaintRetention}
            onFocusSurface={onFocusSurface}
          />
        ) : (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            className="block size-full bg-zinc-950 object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300"
            aria-label="Browser viewport. Streamed page content is not available to assistive technology."
            onFocus={onFocusSurface}
            onPointerMove={(event) => {
              if (!stateRef.current?.controlled && !pointerActiveRef.current) {
                return
              }

              send({ type: 'pointer', phase: 'move', ...point(event) })
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              onFocusSurface()
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              pointerActiveRef.current = true
              send({ type: 'takeControl' })
              send({
                type: 'pointer',
                phase: 'down',
                ...point(event),
                button: button(event.button)
              })
            }}
            onPointerUp={(event) => {
              event.preventDefault()
              send({
                type: 'pointer',
                phase: 'up',
                ...point(event),
                button: button(event.button)
              })
              pointerActiveRef.current = false
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
            onPointerCancel={(event) => {
              send({
                type: 'pointer',
                phase: 'up',
                ...point(event),
                button: button(event.button)
              })
              pointerActiveRef.current = false
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
            onContextMenu={(event) => event.preventDefault()}
            onWheel={wheel}
            onKeyDown={(event) => key(event, 'down')}
            onKeyUp={(event) => key(event, 'up')}
            onPaste={(event) => {
              event.preventDefault()
              send({ type: 'takeControl' })
              send({
                type: 'insertText',
                text: event.clipboardData.getData('text/plain')
              })
            }}
          />
        )}
        {state === null || state.url === 'about:blank' ? (
          <div
            className="pointer-events-none absolute inset-0 bg-zinc-950"
            aria-hidden="true"
          />
        ) : null}
        {failure ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950 p-6 text-center text-zinc-400"
            role="alert"
          >
            <strong className="text-zinc-50">Browser unavailable</strong>
            <span>{failure.message}</span>
            <div className="flex items-center gap-2">
              {failure.installCommand ? (
                <Button
                  type="button"
                  disabled={installingBrowser}
                  onClick={() => {
                    setInstallingBrowser(true)
                    void parseResponse(rpc.api.browser.install.$post())
                      .then(() => {
                        setConnectionRevision((value) => value + 1)
                      })
                      .catch((cause) => {
                        setInstallingBrowser(false)
                        setFailure((current) =>
                          current
                            ? {
                                ...current,
                                message:
                                  cause instanceof Error
                                    ? cause.message
                                    : 'Could not install Chromium.'
                              }
                            : null
                        )
                      })
                  }}
                >
                  {installingBrowser ? (
                    <>
                      <ArrowPathIcon
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                      Installing Chromium…
                    </>
                  ) : (
                    'Install Chromium'
                  )}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={installingBrowser}
                onClick={() => {
                  setFailure(null)
                  setConnectionRevision((value) => value + 1)
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
