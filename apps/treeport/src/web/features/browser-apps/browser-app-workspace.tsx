import type { DesktopBrowserPermissionPrompt } from '@treeport/desktop-bridge'
import { z } from 'zod'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from 'react'
import { traceBrowserOpen } from '../../browser-open-tracing'
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowsRightLeftIcon,
  ChartBarIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CodeBracketSquareIcon,
  DevicePhoneMobileIcon,
  EllipsisHorizontalIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import type {
  BrowserApp,
  BrowserClipboard,
  BrowserContextResult,
  BrowserContextAction,
  BrowserServerMessage,
  BrowserSessionState
} from '@treeport/shared'
import {
  browserUrlSchema,
  browserObservedUrlSchema,
  BROWSER_MAX_INSERT_TEXT_LENGTH,
  browserControllerDescription,
  decodeUnknownOrNull
} from '@treeport/shared'
import { cn } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator
} from '../../components/ui/context-menu'
import { Input } from '../../components/ui/input'
import { NativeSelect } from '../../components/ui/native-select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import type { BrowserAppConnection } from '../../browser-session-client'
import { getDesktopRuntime } from '../../desktop-runtime'
import { writeBrowserClipboard } from '../../browser-clipboard'
import {
  connectRemoteBrowser,
  type RemoteBrowserConnection
} from '../../browser-remote-connection'
import { LocalBrowserWebview } from './local-browser-webview'
import { BrowserStreamDiagnostics } from './browser-stream-diagnostics'
import { BrowserFilePicker } from './browser-file-picker'

const viewportPresetSchema = z.enum([
  'responsive',
  'phone',
  'tablet',
  'desktop'
])

const viewportSettingsSchema = z.object({
  viewport: z
    .object({
      width: z.number().int().min(1).max(3840),
      height: z.number().int().min(1).max(2160)
    })
    .nullable(),
  preset: viewportPresetSchema
})

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

export function BrowserAppWorkspace({
  app,
  active,
  autoFocusBlocked,
  inputBlocked,
  permissionPrompt,
  onLoadingChange,
  onFaviconChange,
  onFocusSurface
}: {
  app: BrowserApp
  active: boolean
  autoFocusBlocked: boolean
  inputBlocked: boolean
  permissionPrompt: DesktopBrowserPermissionPrompt | null
  onLoadingChange: (appId: string, loading: boolean) => void
  onFaviconChange: (appId: string, faviconUrl: string | null) => void
  onFocusSurface: () => void
}) {
  const sectionRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const remoteConnectionRef = useRef<RemoteBrowserConnection | null>(null)
  const viewportAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const connectionRef = useRef<BrowserAppConnection | null>(null)

  const pendingCopiesRef = useRef(
    new Map<
      string,
      {
        resolve(clipboard: BrowserClipboard): void
        reject(reason: Error): void
      }
    >()
  )

  const stateRef = useRef<BrowserSessionState | null>(null)
  const viewportRef = useRef({ width: 1_280, height: 800 })

  const viewportDragRef = useRef<{
    x: number
    y: number
    width: number
    height: number
    scale: number
  } | null>(null)

  const contextRequestRef = useRef<string | null>(null)
  const contextTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contextRef = useRef<BrowserContextResult | null>(null)

  const contextActionRef = useRef<{
    requestId: string
    resolveCopy: ((value: Blob) => void) | null
    rejectCopy: ((reason: Error) => void) | null
    timeout: ReturnType<typeof setTimeout> | null
  } | null>(null)

  const [contextMenu, setContextMenu] = useState<BrowserContextResult | null>(
    null
  )

  const pointerActiveRef = useRef(false)

  const touchesRef = useRef(
    new Map<number, { id: number; x: number; y: number }>()
  )

  const addressPointerSelectAllRef = useRef(false)
  const addressDirtyRef = useRef(false)
  const autoFocusAddressRef = useRef(app.url === 'about:blank')

  const pendingNavigationRef = useRef<{
    startUrl: string
    targetUrl: string
  } | null>(null)

  const [streamStatus, setStreamStatus] = useState<string | null>(
    'Connecting to remote browser…'
  )

  const [fileChooser, setFileChooser] = useState<Extract<
    BrowserServerMessage,
    { type: 'fileChooser' }
  > | null>(null)

  const [connectionRevision, setConnectionRevision] = useState(0)
  const [addressFocusRevision, setAddressFocusRevision] = useState(0)

  const [localBrowserPaintRetained, setLocalBrowserPaintRetained] =
    useState(false)

  const [state, setState] = useState<BrowserSessionState | null>(null)

  const [inputValue, setInputValue] = useState(
    app.url === 'about:blank' ? '' : app.url
  )

  const [permissionsOpen, setPermissionsOpen] = useState(false)

  const [permissionSettings, setPermissionSettings] = useState<{
    origin: string | null
    decisions: Array<{ capability: string; label: string; allowed: boolean }>
  } | null>(null)

  const [permissionSettingsBusy, setPermissionSettingsBusy] = useState(false)

  const [permissionSettingsError, setPermissionSettingsError] = useState<
    string | null
  >(null)

  const [toolsOpen, setToolsOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)

  const [
    { viewport: viewportOverride, preset: viewportPreset },
    setViewportSettings
  ] = useState<z.infer<typeof viewportSettingsSchema>>(() => {
    try {
      const stored = sessionStorage.getItem(
        `treeport-browser-viewport:${app.id}`
      )

      const parsed = viewportSettingsSchema.safeParse(
        stored ? JSON.parse(stored) : null
      )

      if (parsed.success) {
        return parsed.data
      }
    } catch {}

    return { viewport: null, preset: 'responsive' }
  })

  const viewportOverrideRef = useRef(viewportOverride)
  const [viewportSpace, setViewportSpace] = useState({ width: 0, height: 0 })

  const [viewportWidth, setViewportWidth] = useState(
    String(viewportOverride?.width ?? 390)
  )

  const [viewportHeight, setViewportHeight] = useState(
    String(viewportOverride?.height ?? 844)
  )

  const [findOpen, setFindOpen] = useState(false)
  const [findValue, setFindValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [clipboardToCopy, setClipboardToCopy] =
    useState<BrowserClipboard | null>(null)

  const [failure, setFailure] = useState<{
    message: string
  } | null>(null)

  const { localBrowser, computerId } = getDesktopRuntime()

  useEffect(() => {
    if (!permissionsOpen || !localBrowser) {
      return
    }

    let current = true
    void window.treeportDesktop
      ?.browserPermissions?.(app.id)
      .then((settings) => {
        if (current) {
          setPermissionSettings(settings)
        }
      })
      .catch(() => {
        if (current) {
          setPermissionSettingsError('Could not load website permissions.')
        }
      })

    return () => {
      current = false
    }
  }, [localBrowser, app.id, permissionsOpen, state?.url])

  const resetPermissions = async (
    origin: string | null,
    capability: string | null
  ) => {
    if (!origin) {
      return
    }

    setPermissionSettingsBusy(true)
    setPermissionSettingsError(null)

    try {
      const bridge = window.treeportDesktop

      if (
        !bridge ||
        !(await bridge.resetBrowserPermissions?.(app.id, origin, capability))
      ) {
        setPermissionSettingsError(
          'Could not reset website permissions. The page may have navigated.'
        )

        return
      }

      const settings = (await bridge.browserPermissions?.(app.id)) ?? null
      setPermissionSettings(settings)
    } catch {
      setPermissionSettingsError('Could not reset website permissions.')
    } finally {
      setPermissionSettingsBusy(false)
    }
  }

  const respondPermission = (allow: boolean) => {
    if (!permissionPrompt) {
      return
    }

    window.treeportDesktop?.respondBrowserPermission?.(
      permissionPrompt.id,
      allow
    )
  }

  useEffect(() => {
    traceBrowserOpen(app.id, 'browser.open.app_committed', {
      active,
      localBrowser
    })
  }, [active, localBrowser, app])

  const send = useCallback(
    (message: Parameters<BrowserAppConnection['send']>[0]) => {
      connectionRef.current?.send(message)
    },
    []
  )

  const cancelTouches = useCallback(() => {
    if (touchesRef.current.size === 0) {
      return
    }

    touchesRef.current.clear()
    send({ type: 'touch', phase: 'cancel', points: [] })
  }, [send])

  const dismissContext = useCallback(() => {
    contextRequestRef.current = null

    if (contextTimeoutRef.current) {
      clearTimeout(contextTimeoutRef.current)
      contextTimeoutRef.current = null
    }

    if (contextRef.current?.contextId) {
      send({ type: 'dismissContext', contextId: contextRef.current.contextId })
    }

    contextRef.current = null
    setContextMenu(null)
  }, [send])

  useEffect(() => {
    if (!active || inputBlocked) {
      dismissContext()
    }

    const cancelPending = () => {
      if (contextRequestRef.current) {
        dismissContext()
      }
    }

    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelPending()
      }
    }

    document.addEventListener('pointerdown', cancelPending, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', dismissContext)

    return () => {
      document.removeEventListener('pointerdown', cancelPending, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', dismissContext)
      dismissContext()
      contextActionRef.current?.rejectCopy?.(
        new Error('Browser context closed.')
      )
      contextActionRef.current = null
    }
  }, [active, inputBlocked, connectionRevision, dismissContext])

  const contextAction = (action: BrowserContextAction) => {
    const context = contextRef.current

    if (!context?.contextId || inputBlocked || !active) {
      return
    }

    const requestId = crypto.randomUUID()

    const pending: NonNullable<typeof contextActionRef.current> = {
      requestId,
      resolveCopy: null,
      rejectCopy: null,
      timeout: null
    }

    contextActionRef.current = pending

    if (action === 'copyLink') {
      if (!navigator.clipboard || !window.ClipboardItem) {
        setError('Clipboard access is unavailable in this viewer.')
        contextActionRef.current = null
        dismissContext()

        return
      }

      const text = new Promise<Blob>((resolve, reject) => {
        pending.resolveCopy = resolve
        pending.rejectCopy = reject
      })

      void navigator.clipboard
        .write([new ClipboardItem({ 'text/plain': text })])
        .catch(() =>
          setError(
            'Could not copy the link address. Clipboard access is unavailable.'
          )
        )
    }

    send({
      type: 'contextAction',
      requestId,
      contextId: context.contextId,
      action
    })
    contextRef.current = null
    dismissContext()
    pending.timeout = setTimeout(() => {
      if (contextActionRef.current !== pending) {
        return
      }

      contextActionRef.current = null
      pending.rejectCopy?.(new Error('Browser action timed out.'))
      setError('The browser context action timed out. Right-click to retry.')
    }, 10_000)
  }

  const focusPage = useCallback(() => {
    const page =
      videoRef.current ??
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
        message.type === 'videoReady' ||
        message.type === 'videoAnswer' ||
        message.type === 'webcodecsReady'
      ) {
        return
      }

      if (message.type === 'fileChooser') {
        setFileChooser(message)

        return
      }

      if (message.type === 'fileChooserClosed') {
        setFileChooser((current) =>
          current?.requestId === message.requestId ? null : current
        )

        if (message.error) {
          setError(message.error)
        }

        return
      }

      if (message.type === 'download') {
        const link = document.createElement('a')
        link.href = `/api/browser-downloads/${encodeURIComponent(message.token)}`
        link.download = message.filename
        link.click()

        return
      }

      if (message.type === 'clipboardWrite') {
        if (
          !stateRef.current?.controlled ||
          !videoRef.current ||
          sectionRef.current?.inert
        ) {
          return
        }

        const clipboard = message.clipboard
        setError(null)
        setClipboardToCopy(clipboard)
        void writeBrowserClipboard(clipboard)
          .then(() =>
            setClipboardToCopy((current) =>
              current === clipboard ? null : current
            )
          )
          .catch((cause: unknown) =>
            setError(
              cause instanceof Error
                ? `Couldn’t copy: ${cause.message}`
                : 'Couldn’t copy. Click Copy to clipboard to retry.'
            )
          )

        return
      }

      if (message.type === 'copyResult') {
        const pending = pendingCopiesRef.current.get(message.requestId)

        if (message.error !== null || message.clipboard === null) {
          pending?.reject(
            new Error(message.error ?? 'Nothing is selected to copy.')
          )
        } else {
          pending?.resolve(message.clipboard)
        }

        return
      }

      const canvas = videoRef.current

      if (message.type === 'contextResult') {
        if (message.requestId !== contextRequestRef.current) {
          if (message.contextId) {
            send({ type: 'dismissContext', contextId: message.contextId })
          }

          return
        }

        contextRequestRef.current = null

        if (contextTimeoutRef.current) {
          clearTimeout(contextTimeoutRef.current)
          contextTimeoutRef.current = null
        }

        contextRef.current = message.contextId ? message : null
        setContextMenu(contextRef.current)

        return
      }

      if (message.type === 'contextActionResult') {
        const pending = contextActionRef.current

        if (message.requestId !== pending?.requestId) {
          return
        }

        contextActionRef.current = null

        if (pending.timeout) {
          clearTimeout(pending.timeout)
        }

        if (message.action === 'copyLink') {
          if (message.linkUrl) {
            pending.resolveCopy?.(
              new Blob([message.linkUrl], { type: 'text/plain' })
            )
          } else {
            pending.rejectCopy?.(new Error('The link is unavailable.'))
          }
        }

        if (message.action === 'inspect' && message.backendNodeId !== null) {
          void window.treeportDesktop
            ?.inspectBrowserElement?.(
              app.id,
              message.backendNodeId,
              message.targetId
            )
            .then((opened) => {
              if (!opened) {
                setError('Remote element inspection is unavailable.')
              }
            })
            .catch(() => setError('Could not open remote DevTools.'))
        }

        return
      }

      if (message.type === 'cursor') {
        if (canvas && stateRef.current?.controlled) {
          canvas.style.cursor = message.cursor
        }

        return
      }

      if (
        message.type === 'ready' ||
        message.type === 'state' ||
        message.type === 'controlChanged'
      ) {
        const previousUrl = stateRef.current?.url ?? app.url

        if (
          message.type === 'ready' ||
          !message.state.controlled ||
          message.state.loading ||
          message.state.url !== previousUrl
        ) {
          dismissContext()
          contextActionRef.current?.rejectCopy?.(
            new Error('The browser context changed.')
          )
          contextActionRef.current = null
        }

        if (
          canvas &&
          (message.type === 'ready' ||
            !message.state.controlled ||
            message.state.url !== previousUrl)
        ) {
          canvas.style.cursor = 'default'

          if (message.state.controlled && message.state.url !== previousUrl) {
            cancelTouches()
          } else {
            touchesRef.current.clear()
          }
        }

        stateRef.current = message.state

        if (
          message.state.viewport.width > 0 &&
          message.state.viewport.height > 0
        ) {
          viewportRef.current = message.state.viewport
        }

        setState(message.state)

        if (message.type === 'ready') {
          traceBrowserOpen(app.id, 'browser.open.runtime_ready')
          setAddressFocusRevision((revision) => revision + 1)
          setFailure(null)
        }

        onLoadingChange(app.id, message.state.loading)
        onFaviconChange(app.id, message.state.faviconUrl)

        if (!addressDirtyRef.current && message.state.url !== previousUrl) {
          setError(null)
        }

        const pendingNavigation = pendingNavigationRef.current

        const validUrl =
          decodeUnknownOrNull(browserObservedUrlSchema, message.state.url) !==
          null

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

      if (canvas) {
        canvas.style.cursor = 'default'
      }

      setFileChooser(null)
      dismissContext()
      contextActionRef.current?.rejectCopy?.(
        new Error('The browser action failed.')
      )
      contextActionRef.current = null
      onLoadingChange(app.id, false)

      if (
        message.type === 'browserUnavailable' ||
        message.type === 'videoUnavailable'
      ) {
        if (message.type === 'browserUnavailable') {
          stateRef.current = null
          setState(null)
          onFaviconChange(app.id, null)
        }

        setFailure({ message: message.message })

        return
      }

      pendingNavigationRef.current = null

      if (
        message.type === 'videoSettingsResult' ||
        message.type === 'videoChannel'
      ) {
        return
      }

      setError(message.type === 'closed' ? message.reason : message.message)
    },
    [
      cancelTouches,
      dismissContext,
      send,
      onLoadingChange,
      onFaviconChange,
      app.id
    ]
  )

  useEffect(() => {
    if (localBrowser) {
      return
    }

    traceBrowserOpen(app.id, 'browser.hosted.attach_started')
    const video = videoRef.current
    const canvasHost = canvasHostRef.current

    if (!video || !canvasHost) {
      return
    }

    // EXTERNAL: A worker takes over the canvas; control of a canvas transfers only once.
    const canvas = document.createElement('canvas')
    canvas.className = 'block size-full object-contain'
    canvasHost.replaceChildren(canvas)
    let firstFrame = true

    const playing = () => {
      if (firstFrame) {
        firstFrame = false
        traceBrowserOpen(app.id, 'browser.hosted.first_frame_drawn')
      }

      setStreamStatus(null)
      setFailure(null)
      setError(null)
    }

    video.addEventListener('playing', playing)

    const connection = connectRemoteBrowser(app.id, video, canvas, {
      message: receiveMessage,
      failed: (message) => setFailure({ message }),
      statusChanged: setStreamStatus,
      presented: playing
    })

    remoteConnectionRef.current = connection
    connectionRef.current = connection

    return () => {
      if (touchesRef.current.size > 0) {
        touchesRef.current.clear()
        connection.send({ type: 'touch', phase: 'cancel', points: [] })
      }

      if (connectionRef.current === connection) {
        connectionRef.current = null
      }

      if (videoRef.current) {
        videoRef.current.style.cursor = 'default'
      }

      for (const pending of pendingCopiesRef.current.values()) {
        pending.reject(
          new Error('Browser disconnected before copying finished.')
        )
      }

      pendingCopiesRef.current.clear()
      video.removeEventListener('playing', playing)

      if (remoteConnectionRef.current === connection) {
        remoteConnectionRef.current = null
      }

      connection.dispose()
      canvas.remove()
    }
  }, [connectionRevision, localBrowser, app.id, receiveMessage, send])

  const setLocalConnection = useCallback(
    (connection: BrowserAppConnection | null) => {
      connectionRef.current = connection
      const pendingNavigation = pendingNavigationRef.current

      if (connection && pendingNavigation) {
        connection.send({ type: 'navigate', url: pendingNavigation.targetUrl })
      }
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
    if (localBrowser) {
      return
    }

    const updateVisibility = () => {
      connectionRef.current?.setVisible(active && !document.hidden)
    }

    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)

    return () =>
      document.removeEventListener('visibilitychange', updateVisibility)
  }, [active, connectionRevision, localBrowser])

  useEffect(() => {
    cancelTouches()

    const visibility = () => {
      if (document.hidden) {
        cancelTouches()
      }
    }

    window.addEventListener('blur', cancelTouches)
    document.addEventListener('visibilitychange', visibility)

    return () => {
      window.removeEventListener('blur', cancelTouches)
      document.removeEventListener('visibilitychange', visibility)
      cancelTouches()
    }
  }, [active, cancelTouches, connectionRevision, inputBlocked])

  useEffect(() => {
    const canvas = videoRef.current

    if (localBrowser || !canvas || !active) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let viewport: { width: number; height: number } | null = null

    const observer = new ResizeObserver(([entry]) => {
      if (
        !entry ||
        entry.contentRect.width <= 0 ||
        entry.contentRect.height <= 0
      ) {
        return
      }

      viewport = viewportOverrideRef.current ?? {
        width: Math.max(
          2,
          Math.min(3_840, Math.floor(entry.contentRect.width / 2) * 2)
        ),
        height: Math.max(
          2,
          Math.min(2_160, Math.floor(entry.contentRect.height / 2) * 2)
        )
      }
      timer ??= setTimeout(() => {
        timer = null

        if (viewport) {
          send({ type: 'resize', ...viewport })
        }
      }, 100)
    })

    observer.observe(canvas)

    return () => {
      observer.disconnect()

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [active, connectionRevision, localBrowser, send])

  useEffect(() => {
    const area = viewportAreaRef.current

    if (!area || !active) {
      return
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setViewportSpace({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        })
      }
    })

    observer.observe(area)

    return () => observer.disconnect()
  }, [active])

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- Workspace route activation owns Browser focus. */
  useEffect(() => {
    if (!active || autoFocusBlocked || !autoFocusAddressRef.current) {
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
          (stateRef.current?.url ?? 'about:blank') !== 'about:blank'
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

    if (!active || !desktopBridge?.onCommand) {
      return
    }

    return desktopBridge.onCommand((command) => {
      if (command === 'reload') {
        send({ type: 'reload' })

        return
      }

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
  }, [active, autoFocusBlocked, focusAddress, focusFind, send])

  const navigate = (value: string) => {
    const parsed = parseBrowserAddress(value)

    if (!parsed) {
      addressDirtyRef.current = true
      setError(
        'Enter search terms or an HTTP, HTTPS, chrome://, or local file address without credentials.'
      )
      inputRef.current?.focus({ preventScroll: true })

      return
    }

    const targetUrl = parsed.href
    setError(null)
    addressDirtyRef.current = false
    pendingNavigationRef.current = {
      startUrl: stateRef.current?.url ?? app.url,
      targetUrl
    }
    setInputValue(targetUrl)
    send({ type: 'takeControl' })
    send({ type: 'navigate', url: targetUrl })
    focusPage()
  }

  const resizeViewport = (
    size: { width: number; height: number } | null,
    preset: z.infer<typeof viewportSettingsSchema>['preset'] = 'responsive'
  ) => {
    const settings = { viewport: size, preset }
    setViewportSettings(settings)

    try {
      sessionStorage.setItem(
        `treeport-browser-viewport:${app.id}`,
        JSON.stringify(settings)
      )
    } catch {}

    const needsControl = !stateRef.current?.controlled
    viewportOverrideRef.current = size

    if (needsControl) {
      send({ type: 'takeControl' })
    }

    if (size) {
      setViewportWidth(String(size.width))
      setViewportHeight(String(size.height))

      if (!localBrowser) {
        send({ type: 'resize', ...size })
      }
    } else {
      const bounds = videoRef.current?.getBoundingClientRect()

      if (bounds && bounds.width > 0 && bounds.height > 0) {
        send({
          type: 'resize',
          width: Math.max(1, Math.min(3_840, Math.round(bounds.width))),
          height: Math.max(1, Math.min(2_160, Math.round(bounds.height)))
        })
      }
    }
  }

  const point = useCallback(
    (event: {
      currentTarget: HTMLVideoElement
      clientX: number
      clientY: number
    }) => {
      const canvas = event.currentTarget
      const bounds = canvas.getBoundingClientRect()
      const viewport = stateRef.current?.viewport ?? viewportRef.current

      const image =
        canvas.videoWidth && canvas.videoHeight
          ? { width: canvas.videoWidth, height: canvas.videoHeight }
          : viewport

      const scale = Math.min(
        bounds.width / image.width,
        bounds.height / image.height
      )

      const width = image.width * scale
      const height = image.height * scale
      const left = bounds.left + (bounds.width - width) / 2
      const top = bounds.top + (bounds.height - height) / 2

      return {
        x: Math.max(
          0,
          Math.min(
            viewport.width,
            ((event.clientX - left) / width) * viewport.width
          )
        ),
        y: Math.max(
          0,
          Math.min(
            viewport.height,
            ((event.clientY - top) / height) * viewport.height
          )
        )
      }
    },
    []
  )

  const button = (value: number): 'left' | 'right' | 'middle' =>
    value === 2 ? 'right' : value === 1 ? 'middle' : 'left'

  const submit = (event: FormEvent) => {
    event.preventDefault()
    navigate(inputValue)
  }

  const key = (
    event: KeyboardEvent<HTMLVideoElement>,
    phase: 'down' | 'up'
  ) => {
    const isCopyShortcut =
      event.key.toLowerCase() === 'c' &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey

    if (isCopyShortcut) {
      event.preventDefault()

      if (phase !== 'down' || event.repeat) {
        return
      }

      if (!connectionRef.current || inputBlocked) {
        setError('Copy is unavailable. Reconnect, then retry.')

        return
      }

      setClipboardToCopy(null)
      setError(null)
      const requestId = crypto.randomUUID()
      let timer: ReturnType<typeof setTimeout> | null = null

      const result = new Promise<BrowserClipboard>((resolve, reject) => {
        pendingCopiesRef.current.set(requestId, { resolve, reject })
        timer = setTimeout(
          () =>
            reject(new Error('Copy timed out. Select the text and try again.')),
          10_000
        )
        send({ type: 'takeControl' })
        send({ type: 'copy', requestId })
      }).finally(() => {
        if (timer !== null) {
          clearTimeout(timer)
        }

        pendingCopiesRef.current.delete(requestId)
      })

      void result
        .then((clipboard) => {
          // EXTERNAL: A browser may require a fresh gesture once the remote response has
          // arrived. Retain the exact payload for the explicit retry button.
          setClipboardToCopy(clipboard)

          return writeBrowserClipboard(clipboard).then(() =>
            setClipboardToCopy(null)
          )
        })
        .catch((cause: unknown) =>
          setError(
            cause instanceof Error
              ? `Couldn’t copy: ${cause.message}`
              : 'Couldn’t copy the selected content. Try again.'
          )
        )

      return
    }

    const isPasteShortcut =
      event.key.toLowerCase() === 'v' &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey

    const isShiftInsert =
      event.key === 'Insert' &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey

    if (isPasteShortcut || isShiftInsert) {
      return
    }

    event.preventDefault()

    if (phase === 'down') {
      send({ type: 'takeControl' })
    }

    send({
      type: 'key',
      phase,
      key: event.key,
      modifiers:
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0)
    })
  }

  useEffect(() => {
    const canvas = videoRef.current

    if (localBrowser || !canvas || !active || inputBlocked) {
      return
    }

    const wheel = (event: WheelEvent) => {
      event.preventDefault()

      if (!stateRef.current?.controlled) {
        send({ type: 'takeControl' })
      }

      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? canvas.clientHeight
            : 1

      send({
        type: 'wheel',
        ...point({
          currentTarget: canvas,
          clientX: event.clientX,
          clientY: event.clientY
        }),
        modifiers:
          (event.altKey ? 1 : 0) |
          (event.ctrlKey ? 2 : 0) |
          (event.metaKey ? 4 : 0) |
          (event.shiftKey ? 8 : 0),
        deltaX: Math.max(-10_000, Math.min(10_000, event.deltaX * unit)),
        deltaY: Math.max(-10_000, Math.min(10_000, event.deltaY * unit))
      })
    }

    // EXTERNAL: React's delegated wheel listener is passive and cannot prevent the
    // containing workspace from scrolling along with the streamed page.
    canvas.addEventListener('wheel', wheel, { passive: false })

    return () => canvas.removeEventListener('wheel', wheel)
  }, [active, inputBlocked, localBrowser, point, send])

  const sitePermissions =
    permissionSettings &&
    (!state?.url ||
      (URL.canParse(state.url) &&
        new URL(state.url).origin === permissionSettings.origin))
      ? permissionSettings
      : null

  const viewportScale = viewportOverride
    ? Math.max(
        0.01,
        Math.min(
          1,
          (viewportSpace.width - 40) / viewportOverride.width,
          (viewportSpace.height - 40) / viewportOverride.height
        )
      )
    : 1

  const applyViewportDimensions = () => {
    const width = Number(viewportWidth)
    const height = Number(viewportHeight)

    if (
      Number.isInteger(width) &&
      width >= 1 &&
      width <= 3840 &&
      Number.isInteger(height) &&
      height >= 1 &&
      height <= 2160
    ) {
      resizeViewport({ width, height })
    } else {
      setViewportWidth(String(viewportOverride?.width ?? 390))
      setViewportHeight(String(viewportOverride?.height ?? 844))
    }
  }

  const viewportControls = (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      <NativeSelect
        aria-label="Viewport preset"
        value={viewportPreset}
        onChange={(event) => {
          const preset = viewportPresetSchema.parse(event.target.value)

          const size = {
            responsive: null,
            phone: { width: 390, height: 844 },
            tablet: { width: 768, height: 1024 },
            desktop: { width: 1280, height: 800 }
          }[preset]

          resizeViewport(
            size ?? viewportOverride ?? { width: 390, height: 844 },
            preset
          )
        }}
      >
        <option value="responsive">Responsive</option>
        <option value="phone">Phone</option>
        <option value="tablet">Tablet</option>
        <option value="desktop">Desktop</option>
      </NativeSelect>
      <Input
        type="number"
        name="viewport-width"
        min={1}
        max={3840}
        aria-label="Viewport width"
        className="h-8 w-20"
        value={viewportWidth}
        onChange={(event) => setViewportWidth(event.target.value)}
        onBlur={applyViewportDimensions}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            applyViewportDimensions()
          }
        }}
      />
      <span className="text-muted-foreground" aria-hidden="true">
        ×
      </span>
      <Input
        type="number"
        name="viewport-height"
        min={1}
        max={2160}
        aria-label="Viewport height"
        className="h-8 w-20"
        value={viewportHeight}
        onChange={(event) => setViewportHeight(event.target.value)}
        onBlur={applyViewportDimensions}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            applyViewportDimensions()
          }
        }}
      />
      <span
        className="px-1 text-sm text-muted-foreground tabular-nums"
        title="Preview scale; page dimensions are unchanged"
      >
        Fit to window · {Math.round(viewportScale * 100)}%
      </span>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Rotate viewport"
        title="Rotate viewport"
        disabled={!viewportOverride || viewportOverride.width > 2160}
        onClick={() => {
          if (viewportOverride) {
            resizeViewport({
              width: viewportOverride.height,
              height: viewportOverride.width
            })
          }
        }}
      >
        <ArrowsRightLeftIcon />
      </Button>
    </div>
  )

  return (
    <section
      ref={sectionRef}
      className={
        active
          ? '@container/browser-toolbar relative z-10 flex h-full min-h-0 flex-col'
          : localBrowserPaintRetained
            ? '@container/browser-toolbar pointer-events-none absolute inset-0 z-0 flex h-full min-h-0 flex-col opacity-0'
            : 'hidden'
      }
      aria-label={app.title}
      aria-hidden={active ? undefined : true}
      inert={active ? undefined : true}
    >
      <form
        className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-white/8 bg-zinc-900 px-2 py-1.5 @max-[40rem]/browser-toolbar:gap-1 @max-[40rem]/browser-toolbar:px-1.5 @max-[40rem]/browser-toolbar:py-1 @max-[40rem]/browser-toolbar:[&>button]:size-8"
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
          className="@max-[40rem]/browser-toolbar:hidden"
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
          className="min-w-0 flex-1 rounded-full focus-visible:ring-border @max-[40rem]/browser-toolbar:h-8"
          placeholder="Search or enter URL"
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
              app.url

            addressDirtyRef.current = false
            setError(null)
            setInputValue(
              acceptedAddress === 'about:blank' ? '' : acceptedAddress
            )
            window.requestAnimationFrame(() => inputRef.current?.select())
          }}
        />
        {localBrowser && permissionPrompt?.appId === app.id ? (
          <Popover
            open={active}
            onOpenChange={(open) => {
              if (!open) {
                respondPermission(false)
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Website permission request"
                title="Website permission request"
              >
                <ShieldExclamationIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="flex w-80 flex-col gap-3 p-4"
              aria-label="Website permission request"
            >
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">
                  Treeport Browser permission
                </p>
                <p className="break-all text-sm font-medium">
                  {permissionPrompt.origin}
                </p>
                <p className="text-sm text-muted-foreground">
                  Wants to {permissionPrompt.capability}.
                </p>
                {permissionPrompt.destination ? (
                  <p className="break-all text-xs text-muted-foreground">
                    Destination: {permissionPrompt.destination}
                  </p>
                ) : null}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => respondPermission(false)}
                >
                  Block
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => respondPermission(true)}
                >
                  Allow
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
        <Button
          type="button"
          variant={viewportOverride ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label="Responsive mode"
          aria-pressed={viewportOverride !== null}
          title="Responsive mode"
          disabled={!state}
          onClick={() =>
            resizeViewport(
              viewportOverride ? null : { width: 390, height: 844 }
            )
          }
        >
          <DevicePhoneMobileIcon />
        </Button>
        {!localBrowser && window.treeportDesktop?.openBrowserDevtools ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open DevTools"
            title="Open DevTools"
            disabled={!state}
            onClick={() => {
              void window.treeportDesktop?.openBrowserDevtools?.(app.id)
            }}
          >
            <CodeBracketSquareIcon />
          </Button>
        ) : null}
        {localBrowser &&
        window.treeportDesktop?.browserPermissions &&
        window.treeportDesktop.resetBrowserPermissions ? (
          <Popover
            open={permissionsOpen}
            onOpenChange={(open) => {
              setPermissionsOpen(open)

              if (open) {
                setPermissionSettings(null)
                setPermissionSettingsError(null)
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Website permissions"
                title="Website permissions"
              >
                <ShieldCheckIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="flex w-[min(22rem,calc(100vw-1rem))] flex-col gap-3 p-3"
              aria-label="Website permissions"
            >
              <h2 className="text-sm font-semibold">Website permissions</h2>
              {sitePermissions ? (
                sitePermissions.decisions.length ? (
                  <ul
                    className="flex max-h-48 flex-col gap-2 overflow-y-auto py-1 pr-2 pl-1"
                    aria-label="Remembered decisions for this website"
                  >
                    {sitePermissions.decisions.map((decision) => (
                      <li
                        key={decision.capability}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="min-w-0">
                          {decision.label.charAt(0).toUpperCase() +
                            decision.label.slice(1)}{' '}
                          · {decision.allowed ? 'Allowed' : 'Blocked'}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={permissionSettingsBusy}
                          aria-label={`Reset ${decision.label.charAt(0).toUpperCase() + decision.label.slice(1)}`}
                          onClick={() =>
                            void resetPermissions(
                              sitePermissions.origin,
                              decision.capability
                            )
                          }
                        >
                          Reset
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {sitePermissions.origin
                      ? 'No saved decisions for this website.'
                      : 'No website open.'}
                  </p>
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  Loading permissions…
                </p>
              )}
              {sitePermissions?.origin &&
              sitePermissions.decisions.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={permissionSettingsBusy}
                  onClick={() =>
                    void resetPermissions(sitePermissions.origin, null)
                  }
                >
                  Reset this website
                </Button>
              ) : null}
              {permissionSettingsError ? (
                <p className="text-xs text-destructive" role="alert">
                  {permissionSettingsError}
                </p>
              ) : null}
            </PopoverContent>
          </Popover>
        ) : null}
        {!localBrowser ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Stream diagnostics"
            title="Stream diagnostics"
            aria-pressed={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}
          >
            <ChartBarIcon />
          </Button>
        ) : null}
        <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="@min-[40rem]/browser-toolbar:hidden"
              aria-label="More browser controls"
              title="More browser controls"
            >
              <EllipsisHorizontalIcon />
              <span className="touch-target" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex max-h-[min(28rem,70dvh)] w-[min(18rem,calc(100vw-1rem))] flex-col gap-3 overflow-y-auto p-3 shadow-none"
            aria-label="More browser controls"
          >
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start"
              disabled={!state?.canGoForward || !state.controlled}
              onClick={() => {
                send({ type: 'forward' })
                setToolsOpen(false)
              }}
            >
              <ArrowRightIcon data-icon="inline-start" />
              Go forward
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                resizeViewport(
                  viewportOverride ? null : { width: 390, height: 844 }
                )
                setToolsOpen(false)
              }}
            >
              <DevicePhoneMobileIcon data-icon="inline-start" />
              {viewportOverride ? 'Exit responsive mode' : 'Responsive mode'}
            </Button>
          </PopoverContent>
        </Popover>
      </form>
      {error ? (
        <div
          className="flex items-center gap-2 bg-destructive/10 px-2.5 py-1.5 text-destructive"
          role="alert"
        >
          <span>{error}</span>
          {clipboardToCopy ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void writeBrowserClipboard(clipboardToCopy)
                  .then(() => {
                    setClipboardToCopy(null)
                    setError(null)
                  })
                  .catch(() =>
                    setError(
                      'Clipboard access was denied. Allow clipboard access for Treeport, then retry.'
                    )
                  )
              }}
            >
              Copy to clipboard
            </Button>
          ) : null}
        </div>
      ) : null}
      {state?.hasController && !state.controlled ? (
        <p className="bg-amber-950 px-2.5 py-1.5 text-amber-200" role="status">
          {browserControllerDescription(state.controllerDetails)} Interact with
          the viewport to take control.
        </p>
      ) : null}
      {viewportOverride ? (
        <div
          className="shrink-0 border-b border-border bg-background p-2"
          aria-label="Responsive mode controls"
        >
          {viewportControls}
        </div>
      ) : null}
      <div
        ref={viewportAreaRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden',
          viewportOverride ? 'bg-muted/40' : 'bg-zinc-950'
        )}
      >
        <div
          className={cn('relative', viewportOverride ? 'mx-auto' : 'size-full')}
          style={
            viewportOverride
              ? {
                  width: viewportOverride.width * viewportScale + 40,
                  height: viewportOverride.height * viewportScale + 40
                }
              : undefined
          }
        >
          {viewportOverride ? (
            <div
              className="group/viewport-handles pointer-events-none absolute inset-0 z-10"
              inert={inputBlocked ? true : undefined}
            >
              {[
                {
                  edge: 'left',
                  label: 'Resize viewport width from left',
                  x: -2,
                  y: 0,
                  className: 'left-0 top-5 bottom-5 w-5 cursor-ew-resize',
                  grip: 'h-10 w-1 border-x-2'
                },
                {
                  edge: 'right',
                  label: 'Resize viewport width',
                  x: 2,
                  y: 0,
                  className: 'right-0 top-5 bottom-5 w-5 cursor-ew-resize',
                  grip: 'h-10 w-1 border-x-2'
                },
                {
                  edge: 'top',
                  label: 'Resize viewport height from top',
                  x: 0,
                  y: -1,
                  className: 'top-0 left-5 right-5 h-5 cursor-ns-resize',
                  grip: 'h-1 w-10 border-y-2'
                },
                {
                  edge: 'bottom',
                  label: 'Resize viewport height',
                  x: 0,
                  y: 1,
                  className: 'bottom-0 left-5 right-5 h-5 cursor-ns-resize',
                  grip: 'h-1 w-10 border-y-2'
                },
                {
                  edge: 'corner',
                  label: 'Resize responsive viewport',
                  x: 2,
                  y: 1,
                  className: 'right-0 bottom-0 size-5 cursor-nwse-resize',
                  grip: 'size-3 border-r-2 border-b-2'
                }
              ].map(({ edge, label, x, y, className, grip }) => (
                <button
                  key={edge}
                  type="button"
                  data-axis={x && y ? 'both' : x ? 'width' : 'height'}
                  className={cn(
                    'pointer-events-auto absolute flex touch-none items-center justify-center bg-muted/60 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
                    x && y
                      ? 'hover:opacity-100 focus-visible:opacity-100 active:opacity-100'
                      : x
                        ? 'group-has-[[data-axis=width]:is(:hover,:focus-visible,:active)]/viewport-handles:opacity-100'
                        : 'group-has-[[data-axis=height]:is(:hover,:focus-visible,:active)]/viewport-handles:opacity-100',
                    className
                  )}
                  aria-label={label}
                  title="Drag to resize; arrow keys resize by 10 px"
                  onPointerDown={(event) => {
                    if (event.button !== 0) {
                      return
                    }

                    event.preventDefault()
                    viewportDragRef.current = {
                      x: event.clientX,
                      y: event.clientY,
                      ...viewportOverride,
                      scale: viewportScale
                    }
                    event.currentTarget.setPointerCapture(event.pointerId)
                  }}
                  onPointerMove={(event) => {
                    const drag = viewportDragRef.current

                    if (
                      !drag ||
                      !event.currentTarget.hasPointerCapture(event.pointerId)
                    ) {
                      return
                    }

                    resizeViewport({
                      width: Math.max(
                        1,
                        Math.min(
                          3840,
                          Math.round(
                            drag.width +
                              (x * (event.clientX - drag.x)) / drag.scale
                          )
                        )
                      ),
                      height: Math.max(
                        1,
                        Math.min(
                          2160,
                          Math.round(
                            drag.height +
                              (y * (event.clientY - drag.y)) / drag.scale
                          )
                        )
                      )
                    })
                  }}
                  onPointerUp={(event) => {
                    if (
                      event.currentTarget.hasPointerCapture(event.pointerId)
                    ) {
                      event.currentTarget.releasePointerCapture(event.pointerId)
                    }
                  }}
                  onLostPointerCapture={() => {
                    viewportDragRef.current = null
                  }}
                  onKeyDown={(event) => {
                    const dx =
                      x &&
                      (event.key === 'ArrowRight'
                        ? 10
                        : event.key === 'ArrowLeft'
                          ? -10
                          : 0)

                    const dy =
                      y &&
                      (event.key === 'ArrowDown'
                        ? 10
                        : event.key === 'ArrowUp'
                          ? -10
                          : 0)

                    if (!dx && !dy) {
                      return
                    }

                    event.preventDefault()
                    resizeViewport({
                      width: Math.max(
                        1,
                        Math.min(3840, viewportOverride.width + dx)
                      ),
                      height: Math.max(
                        1,
                        Math.min(2160, viewportOverride.height + dy)
                      )
                    })
                  }}
                >
                  <span
                    className={cn('rounded-sm border-current', grip)}
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          ) : null}
          <div
            className={cn(
              viewportOverride
                ? 'absolute top-5 left-5 origin-top-left'
                : 'relative size-full'
            )}
            style={
              viewportOverride
                ? {
                    width: viewportOverride.width,
                    height: viewportOverride.height,
                    transform: `scale(${viewportScale})`
                  }
                : undefined
            }
          >
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
                app={app}
                active={active}
                inputBlocked={inputBlocked}
                viewport={viewportOverride}
                onConnection={setLocalConnection}
                onMessage={receiveMessage}
                onPaintRetentionChange={setLocalBrowserPaintRetention}
                onFocusSurface={onFocusSurface}
              />
            ) : (
              <ContextMenu
                open={contextMenu !== null}
                onOpenChange={(open) => {
                  if (!open) {
                    dismissContext()
                  }
                }}
              >
                <ContextMenuTrigger asChild disabled={inputBlocked || !active}>
                  <video
                    autoPlay
                    muted
                    playsInline
                    disablePictureInPicture
                    ref={videoRef}
                    tabIndex={0}
                    className={cn(
                      'block size-full touch-none select-none bg-zinc-950 object-contain outline-none',
                      viewportOverride && 'ring-1 ring-border'
                    )}
                    aria-label="Browser viewport. Streamed page content is not available to assistive technology."
                    onFocus={onFocusSurface}
                    onPointerMove={(event) => {
                      if (
                        contextRequestRef.current ||
                        contextRef.current ||
                        event.pointerType !== 'touch' ||
                        !touchesRef.current.has(event.pointerId)
                      ) {
                        return
                      }

                      touchesRef.current.set(event.pointerId, {
                        id: touchesRef.current.get(event.pointerId)!.id,
                        ...point(event)
                      })
                      send({
                        type: 'touch',
                        phase: 'move',
                        points: [...touchesRef.current.values()]
                      })
                    }}
                    onMouseMove={(event) => {
                      if (
                        contextRequestRef.current ||
                        contextRef.current ||
                        (!stateRef.current?.controlled &&
                          !pointerActiveRef.current)
                      ) {
                        return
                      }

                      send({ type: 'pointer', phase: 'move', ...point(event) })
                    }}
                    onPointerLeave={(event) => {
                      event.currentTarget.style.cursor = 'default'
                    }}
                    onPointerDown={(event) => {
                      if (
                        inputBlocked ||
                        !active ||
                        (event.pointerType === 'touch' &&
                          touchesRef.current.size >= 10)
                      ) {
                        return
                      }

                      if (event.pointerType === 'touch') {
                        event.preventDefault()
                      }

                      onFocusSurface()
                      event.currentTarget.focus({ preventScroll: true })

                      if (event.button === 2) {
                        return
                      }

                      event.currentTarget.setPointerCapture(event.pointerId)

                      if (event.pointerType === 'touch') {
                        if (touchesRef.current.size === 0) {
                          send({ type: 'takeControl' })
                        }

                        // EXTERNAL: iOS pointer IDs can be negative or exceed int32, so
                        // send each contact as its lowest free slot instead.
                        const ids = new Set(
                          [...touchesRef.current.values()].map(
                            (touch) => touch.id
                          )
                        )

                        let id = 0

                        while (ids.has(id)) {
                          id++
                        }

                        touchesRef.current.set(event.pointerId, {
                          id,
                          ...point(event)
                        })
                        send({
                          type: 'touch',
                          phase: 'start',
                          points: [...touchesRef.current.values()]
                        })

                        return
                      }

                      pointerActiveRef.current = true
                      send({ type: 'takeControl' })
                    }}
                    onPointerUp={(event) => {
                      event.preventDefault()

                      if (event.button === 2) {
                        return
                      }

                      if (event.pointerType === 'touch') {
                        const touch = touchesRef.current.get(event.pointerId)

                        if (touch) {
                          touchesRef.current.delete(event.pointerId)
                          send({
                            type: 'touch',
                            phase: 'end',
                            points: [{ id: touch.id, ...point(event) }]
                          })
                        }

                        if (
                          event.currentTarget.hasPointerCapture(event.pointerId)
                        ) {
                          event.currentTarget.releasePointerCapture(
                            event.pointerId
                          )
                        }

                        return
                      }

                      pointerActiveRef.current = false

                      if (
                        event.currentTarget.hasPointerCapture(event.pointerId)
                      ) {
                        event.currentTarget.releasePointerCapture(
                          event.pointerId
                        )
                      }
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault()

                      if (event.button === 2 || inputBlocked || !active) {
                        return
                      }

                      send({
                        type: 'pointer',
                        phase: 'down',
                        ...point(event),
                        button: button(event.button),
                        clickCount: Math.max(1, event.detail)
                      })
                    }}
                    onMouseUp={(event) => {
                      event.preventDefault()

                      if (event.button === 2) {
                        return
                      }

                      send({
                        type: 'pointer',
                        phase: 'up',
                        ...point(event),
                        button: button(event.button),
                        clickCount: Math.max(1, event.detail)
                      })
                    }}
                    onLostPointerCapture={(event) => {
                      if (touchesRef.current.has(event.pointerId)) {
                        cancelTouches()
                      }
                    }}
                    onPointerCancel={(event) => {
                      if (event.pointerType === 'touch') {
                        cancelTouches()

                        return
                      }

                      send({
                        type: 'pointer',
                        phase: 'up',
                        ...point(event),
                        button: button(event.button)
                      })
                      pointerActiveRef.current = false

                      if (
                        event.currentTarget.hasPointerCapture(event.pointerId)
                      ) {
                        event.currentTarget.releasePointerCapture(
                          event.pointerId
                        )
                      }
                    }}
                    onBlur={cancelTouches}
                    onContextMenu={(event) => {
                      if (!active || inputBlocked || !connectionRef.current) {
                        event.preventDefault()

                        return
                      }

                      dismissContext()
                      cancelTouches()
                      const requestId = crypto.randomUUID()
                      contextRequestRef.current = requestId
                      contextTimeoutRef.current = setTimeout(() => {
                        dismissContext()
                        setError(
                          'The browser context request timed out. Right-click to retry.'
                        )
                      }, 10_000)
                      send({ type: 'takeControl' })
                      send({ type: 'contextMenu', requestId, ...point(event) })
                    }}
                    onKeyDown={(event) => key(event, 'down')}
                    onKeyUp={(event) => key(event, 'up')}
                    onPaste={(event) => {
                      event.preventDefault()

                      if (!event.clipboardData.types.includes('text/plain')) {
                        setError(
                          'Paste was not sent. Only plain text is supported; copy text and try again.'
                        )

                        return
                      }

                      const text = event.clipboardData.getData('text/plain')

                      if (text.length > BROWSER_MAX_INSERT_TEXT_LENGTH) {
                        setError(
                          'Paste was not sent. The limit is 1,048,576 UTF-16 code units; paste smaller portions. No text was inserted.'
                        )

                        return
                      }

                      if (!connectionRef.current || inputBlocked) {
                        setError(
                          'Paste was not sent. Wait for the browser to become available, then retry.'
                        )

                        return
                      }

                      send({ type: 'takeControl' })
                      send({ type: 'insertText', text })
                    }}
                  />
                </ContextMenuTrigger>
                <ContextMenuContent
                  onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    focusPage()
                  }}
                >
                  {contextMenu?.linkUrl ? (
                    <>
                      <ContextMenuGroup>
                        <ContextMenuItem
                          disabled={!contextMenu.canOpenLink}
                          onSelect={() => contextAction('openLink')}
                        >
                          Open Link in New Tab
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() => contextAction('copyLink')}
                        >
                          Copy Link Address
                        </ContextMenuItem>
                      </ContextMenuGroup>
                      <ContextMenuSeparator />
                    </>
                  ) : null}
                  <ContextMenuGroup>
                    <ContextMenuItem
                      disabled={!state?.canGoBack}
                      onSelect={() => contextAction('back')}
                    >
                      Back
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={!state?.canGoForward}
                      onSelect={() => contextAction('forward')}
                    >
                      Forward
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => contextAction('reload')}>
                      Reload
                    </ContextMenuItem>
                  </ContextMenuGroup>
                  {window.treeportDesktop?.inspectBrowserElement ? (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuGroup>
                        <ContextMenuItem
                          disabled={!contextMenu?.canInspect}
                          onSelect={() => contextAction('inspect')}
                        >
                          Inspect Element
                        </ContextMenuItem>
                      </ContextMenuGroup>
                    </>
                  ) : null}
                </ContextMenuContent>
              </ContextMenu>
            )}
            {localBrowser ? null : (
              <div
                ref={canvasHostRef}
                className="pointer-events-none absolute inset-0"
                aria-hidden="true"
              />
            )}
            {state === null || state.url === 'about:blank' ? (
              <div
                className="pointer-events-none absolute inset-0 bg-zinc-950"
                aria-hidden="true"
              />
            ) : null}
            {!localBrowser &&
            (state?.url ?? app.url) !== 'about:blank' &&
            streamStatus &&
            !failure ? (
              <div
                className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <ArrowPathIcon
                  className="size-6 motion-safe:animate-spin"
                  aria-hidden="true"
                />
                <span className="text-sm">{streamStatus}</span>
              </div>
            ) : null}
            {fileChooser &&
            connectionRef.current &&
            state?.controlled &&
            active &&
            !inputBlocked ? (
              <BrowserFilePicker
                key={fileChooser.requestId}
                request={fileChooser}
                connection={connectionRef.current}
                onCancel={() => setFileChooser(null)}
              />
            ) : null}
            {failure ? (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950 p-6 text-center text-zinc-400"
                role="alert"
              >
                <strong className="text-zinc-50">Browser unavailable</strong>
                <span className="max-w-2xl whitespace-pre-line break-words">
                  {failure.message}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setFailure(null)
                      setStreamStatus('Connecting to remote browser…')
                      setConnectionRevision((value) => value + 1)
                    }}
                  >
                    Retry
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {diagnosticsOpen &&
        active &&
        !inputBlocked &&
        !localBrowser &&
        state?.videoSettings ? (
          <BrowserStreamDiagnostics
            videoRef={videoRef}
            receiverRef={remoteConnectionRef}
            settings={state.videoSettings}
            canConfigure={state.controlled && !failure}
            onConfigure={(settings) =>
              remoteConnectionRef.current?.configureVideo(settings) ??
              Promise.reject(new Error('Browser stream is not connected.'))
            }
          />
        ) : null}
      </div>
    </section>
  )
}
