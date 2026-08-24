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
  ClipboardDocumentIcon,
  HomeIcon,
  StopIcon
} from '@heroicons/react/16/solid'
import { z } from 'zod'
import type {
  BrowserFrame,
  BrowserPanel,
  BrowserServerMessage,
  BrowserSessionState,
  WorktreeListener,
  WorktreeListenerDiscovery
} from '@treeport/shared'
import { browserUrlSchema } from '@treeport/shared'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  connectBrowserPanel,
  type BrowserPanelConnection
} from '../../browser-session-client'

const listenerDiscoverySchema: z.ZodType<WorktreeListenerDiscovery> =
  z.strictObject({
    supported: z.boolean(),
    message: z.string().nullable(),
    listeners: z.array(
      z.strictObject({
        pid: z.number().int(),
        command: z.string(),
        host: z.string(),
        port: z.number().int().min(1).max(65_535),
        terminalId: z.string().nullable()
      })
    )
  })

function listenerUrl(listener: WorktreeListener): URL | null {
  let host = listener.host
  if (['*', '0.0.0.0', '::', '::1', '127.0.0.1'].includes(host)) {
    host = 'localhost'
  } else if (host.includes(':')) {
    host = `[${host}]`
  }

  const value = `http://${host}:${listener.port}/`
  return browserUrlSchema.safeParse(value).success ? new URL(value) : null
}

export function BrowserPanelWorkspace({
  panel,
  active,
  autoFocusBlocked
}: {
  panel: BrowserPanel
  active: boolean
  autoFocusBlocked: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const connectionRef = useRef<BrowserPanelConnection | null>(null)
  const stateRef = useRef<BrowserSessionState | null>(null)
  const viewportRef = useRef({ width: 1_280, height: 800 })
  const pointerActiveRef = useRef(false)
  const homepageRequestedRef = useRef(panel.url === 'about:blank')
  const [connectionRevision, setConnectionRevision] = useState(0)
  const [state, setState] = useState<BrowserSessionState | null>(null)
  const [inputValue, setInputValue] = useState(
    panel.url === 'about:blank' ? '' : panel.url
  )
  const [showHomepage, setShowHomepage] = useState(panel.url === 'about:blank')
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<{
    message: string
    installCommand: string | null
  } | null>(null)
  const [listeners, setListeners] = useState<WorktreeListenerDiscovery | null>(
    null
  )
  const [listenersLoading, setListenersLoading] = useState(false)

  const send = useCallback(
    (message: Parameters<BrowserPanelConnection['send']>[0]) => {
      connectionRef.current?.send(message)
    },
    []
  )

  const receiveMessage = useCallback((message: BrowserServerMessage) => {
    if (
      message.type === 'ready' ||
      message.type === 'state' ||
      message.type === 'controlChanged'
    ) {
      stateRef.current = message.state
      setState(message.state)
      setFailure(null)
      setError(null)
      if (message.state.url === 'about:blank') {
        homepageRequestedRef.current = true
        setShowHomepage(true)
        setInputValue('')
      } else if (browserUrlSchema.safeParse(message.state.url).success) {
        if (!homepageRequestedRef.current) {
          setShowHomepage(false)
        }

        setInputValue(message.state.url)
      }

      return
    }

    if (message.type === 'browserUnavailable') {
      setFailure({
        message: message.message,
        installCommand: message.installCommand
      })
      return
    }

    setError(message.type === 'closed' ? message.reason : message.message)
  }, [])

  const receiveFrame = useCallback(
    (frame: BrowserFrame) => {
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
    const connection = connectBrowserPanel(panel.id, active, {
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
  }, [connectionRevision, panel.id, receiveFrame, receiveMessage])

  useEffect(() => {
    connectionRef.current?.setVisible(active)
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return
      }

      if (timer) {
        clearTimeout(timer)
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
  }, [send])

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- Workspace route activation owns Browser panel focus. */
  useEffect(() => {
    if (!active || autoFocusBlocked) {
      return
    }

    if (showHomepage) {
      inputRef.current?.focus()
    }
  }, [active, autoFocusBlocked, showHomepage])
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  useEffect(() => {
    if (!active) {
      return
    }

    const find = (event: globalThis.KeyboardEvent) => {
      const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
        ? event.metaKey
        : event.ctrlKey
      if (
        !modifier ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'f'
      ) {
        return
      }

      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    document.addEventListener('keydown', find, true)
    return () => document.removeEventListener('keydown', find, true)
  }, [active])

  const discoverListeners = useCallback(async () => {
    setListenersLoading(true)
    try {
      const response = await fetch(
        `/api/panels/${encodeURIComponent(panel.id)}/network/listeners`
      )
      const parsed = z
        .object({ discovery: listenerDiscoverySchema })
        .parse(await response.json())
      if (!response.ok) {
        throw new Error('Could not scan for development servers')
      }

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

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- A restored blank Browser panel needs discovery without a local click. */
  useEffect(() => {
    if (showHomepage && listeners === null && !listenersLoading) {
      void discoverListeners()
    }
  }, [discoverListeners, listeners, listenersLoading, showHomepage])
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  const navigate = (value: string) => {
    const parsed = browserUrlSchema.safeParse(value.trim())
    if (!parsed.success) {
      setError('Enter an absolute HTTP or HTTPS URL without credentials.')
      return
    }

    setError(null)
    setFailure(null)
    homepageRequestedRef.current = false
    setShowHomepage(false)
    send({ type: 'takeControl' })
    send({ type: 'navigate', url: new URL(parsed.data).href })
  }

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const viewport = viewportRef.current
    return {
      x: Math.max(
        0,
        Math.min(
          viewport.width,
          ((event.clientX - bounds.left) / bounds.width) * viewport.width
        )
      ),
      y: Math.max(
        0,
        Math.min(
          viewport.height,
          ((event.clientY - bounds.top) / bounds.height) * viewport.height
        )
      )
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
      className={active ? 'flex h-full min-h-0 flex-col' : 'hidden'}
      aria-label={panel.title}
    >
      <form
        className="flex min-w-0 items-center gap-1.5 border-b border-white/8 bg-zinc-900 px-2 py-1.5"
        aria-label="Browser controls"
        onSubmit={submit}
      >
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Show development servers"
          title="Show development servers"
          onClick={() => {
            homepageRequestedRef.current = true
            setShowHomepage(true)
          }}
        >
          <HomeIcon />
        </Button>
        <Button
          type="button"
          variant="outline"
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
          variant="outline"
          size="icon-sm"
          aria-label="Go forward"
          title="Go forward"
          disabled={!state?.canGoForward || !state.controlled}
          onClick={() => send({ type: 'forward' })}
        >
          <ArrowRightIcon />
        </Button>
        <Input
          ref={inputRef}
          type="url"
          name="url"
          aria-label="Application URL"
          placeholder="http://localhost:3000/"
          maxLength={4_096}
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
        />
        {state?.loading ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Stop loading"
            title="Stop loading"
            disabled={!state.controlled}
            onClick={() => send({ type: 'stop' })}
          >
            <StopIcon />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Reload application"
            title="Reload application"
            disabled={!state?.controlled}
            onClick={() => send({ type: 'reload' })}
          >
            <ArrowPathIcon />
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Copy application URL"
          title="Copy application URL"
          disabled={!state || state.url === 'about:blank'}
          onClick={() => {
            if (state && state.url !== 'about:blank') {
              void navigator.clipboard
                .writeText(state.url)
                .catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : 'Could not copy the address.'
                  )
                )
            }
          }}
        >
          <ClipboardDocumentIcon />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!state?.controlled}
          onClick={() => {
            if (
              window.confirm(
                'Reset this disposable browser and delete its cookies and local data?'
              )
            ) {
              send({ type: 'reset' })
            }
          }}
        >
          Reset
        </Button>
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
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="block size-full bg-white object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300"
          aria-label="Browser viewport. Streamed page content is not available to assistive technology."
          onPointerMove={(event) => {
            if (!stateRef.current?.controlled && !pointerActiveRef.current) {
              return
            }

            send({ type: 'pointer', phase: 'move', ...point(event) })
          }}
          onPointerDown={(event) => {
            event.preventDefault()
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
        {showHomepage ? (
          <section
            className="absolute inset-0 overflow-auto bg-zinc-950 p-5 sm:p-10"
            aria-label="Development servers"
          >
            <div className="mx-auto flex max-w-3xl items-start justify-between gap-5">
              <div>
                <h1 className="text-xl font-semibold text-zinc-50">
                  Development servers
                </h1>
                <p className="mt-1 text-zinc-400">
                  Select a listening server from this tree.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={listenersLoading}
                onClick={() => void discoverListeners()}
              >
                Refresh servers
              </Button>
            </div>
            <div className="mx-auto mt-6 max-w-3xl">
              {listenersLoading ? (
                <p role="status" className="text-zinc-400">
                  Scanning for development servers…
                </p>
              ) : null}
              {!listenersLoading && listeners && !listeners.supported ? (
                <p role="status" className="text-zinc-400">
                  {listeners.message ??
                    'TCP listener discovery is unavailable.'}
                </p>
              ) : null}
              {!listenersLoading &&
              listeners?.supported &&
              discoveredServers.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/15 p-5 text-center text-zinc-400">
                  No listening servers were found. Start one from a Treeport
                  terminal, then refresh this list.
                </p>
              ) : null}
              <ul className="grid gap-2">
                {discoveredServers.map(({ url, listener }) => (
                  <li key={url.href}>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto w-full justify-start px-3 py-2 text-left"
                      aria-label={`Open ${url.href}, ${listener.command || 'unknown command'}`}
                      onClick={() => navigate(url.href)}
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
            </div>
          </section>
        ) : null}
        {state?.loading && !showHomepage ? (
          <div
            className="pointer-events-none absolute inset-0 grid place-items-center bg-zinc-950/70 text-zinc-300"
            role="status"
          >
            Loading application…
          </div>
        ) : null}
        {failure ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950 p-6 text-center text-zinc-400"
            role="alert"
          >
            <strong className="text-zinc-50">Browser unavailable</strong>
            <span>{failure.message}</span>
            {failure.installCommand ? (
              <code>{failure.installCommand}</code>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setFailure(null)
                setConnectionRevision((value) => value + 1)
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
