/* eslint-disable treeport/no-record-string-unknown, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- CDP is an external method-dispatched JSON protocol. This file validates its envelope before it routes method-specific payloads. */
import crypto from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebContents } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'
import { ElectronBrowserVideo } from './browser-video'

interface CdpRequest {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

interface BrowserCdpBridgeDescriptor {
  endpoint: string
  panelId: string
  challenge: string
}

export interface BrowserCdpBridge {
  descriptor: BrowserCdpBridgeDescriptor
  stop(): Promise<void>
}

const ALLOWED_DOMAINS = new Set([
  'Accessibility',
  'DOM',
  'Emulation',
  'Input',
  'Log',
  'Network',
  'Page',
  'Performance',
  'Runtime',
  'Security',
  'Target'
])

export async function createBrowserCdpBridge(
  guest: WebContents,
  identity: { panelId: string; challenge: string }
): Promise<BrowserCdpBridge> {
  if (guest.isDestroyed()) {
    throw new Error('The Browser page is no longer available.')
  }

  const attachedByBridge = !guest.debugger.isAttached()

  const secret = crypto.randomBytes(32).toString('base64url')
  const basePath = `/${secret}/`
  let targetId = `treeport-${crypto.randomUUID()}`
  const pageSessions = new Set<string>()
  const browserSessions = new Set<string>()
  let primaryPageSession: string | null = null
  let pageSessionOrdinal = 0
  let browserSessionOrdinal = 0
  let server: Server | null = null
  let sockets: WebSocketServer | null = null
  let client: WebSocket | null = null
  let stopping = false
  let port = 0
  const video = new ElectronBrowserVideo(guest)
  let videoSession: string | null = null
  let videoTail: Promise<void> = Promise.resolve()

  const targetInfo = () => ({
    targetId,
    type: 'page',
    title: guest.isDestroyed() ? '' : guest.getTitle(),
    url: guest.isDestroyed() ? '' : guest.getURL(),
    attached: true,
    canAccessOpener: false,
    browserContextId: 'treeport-default-context'
  })
  const responseSession = (request: CdpRequest) =>
    request.sessionId ? { sessionId: request.sessionId } : {}
  const sendResult = (
    socket: WebSocket,
    request: CdpRequest,
    result: unknown
  ) => {
    if (socket.readyState === WebSocket.OPEN && socket === client) {
      socket.send(
        JSON.stringify({ id: request.id, result, ...responseSession(request) })
      )
    }
  }
  const sendEvent = (
    socket: WebSocket,
    method: string,
    params: unknown,
    sessionId?: string
  ) => {
    if (socket.readyState === WebSocket.OPEN && socket === client) {
      socket.send(
        JSON.stringify({
          method,
          params,
          ...(sessionId ? { sessionId } : {})
        })
      )
    }
  }
  const sendError = (
    socket: WebSocket,
    request: CdpRequest,
    message: string
  ) => {
    if (socket.readyState === WebSocket.OPEN && socket === client) {
      socket.send(
        JSON.stringify({
          id: request.id,
          error: { code: -32_000, message },
          ...responseSession(request)
        })
      )
    }
  }
  const resolveDebuggerSession = (sessionId?: string) =>
    sessionId && !pageSessions.has(sessionId) && !browserSessions.has(sessionId)
      ? sessionId
      : undefined

  const onDebuggerMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown,
    sessionId?: string
  ) => {
    const socket = client
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    const recipients =
      sessionId &&
      (pageSessions.has(sessionId) || browserSessions.has(sessionId))
        ? [sessionId]
        : pageSessions.size > 0
          ? [...pageSessions]
          : primaryPageSession
            ? [primaryPageSession]
            : [null]
    for (const recipient of recipients) {
      socket.send(
        JSON.stringify({
          method,
          params,
          ...(recipient ? { sessionId: recipient } : {})
        })
      )
    }
  }
  const stop = async () => {
    if (stopping) {
      return
    }

    stopping = true
    video.stop()
    await videoTail.catch(() => undefined)
    video.stop()
    guest.debugger.removeListener('message', onDebuggerMessage)
    guest.debugger.removeListener('detach', onDebuggerDetach)
    guest.removeListener('destroyed', onDestroyed)
    if (
      attachedByBridge &&
      !guest.isDestroyed() &&
      guest.debugger.isAttached()
    ) {
      guest.debugger.detach()
    }

    client?.close()
    client = null
    await new Promise<void>((resolve) => {
      if (!sockets) {
        resolve()
        return
      }

      sockets.close(() => resolve())
      sockets = null
    })
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve()
        return
      }

      server.close(() => resolve())
      server = null
    })
  }
  const onDebuggerDetach = () => void stop()
  const onDestroyed = () => void stop()

  if (attachedByBridge) {
    guest.debugger.attach('1.3')
  }

  guest.debugger.on('message', onDebuggerMessage)
  guest.debugger.once('detach', onDebuggerDetach)
  guest.once('destroyed', onDestroyed)
  const initialFrameTree = (await guest.debugger
    .sendCommand('Page.getFrameTree')
    .catch(() => null)) as { frameTree?: { frame?: { id?: string } } } | null
  targetId = initialFrameTree?.frameTree?.frame?.id ?? targetId

  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      .pathname
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json')

    if (pathname === `${basePath}identity`) {
      response.end(JSON.stringify(identity))
      return
    }

    if (
      pathname === `${basePath}json/version` ||
      pathname === `${basePath}json/version/`
    ) {
      response.end(
        JSON.stringify({
          Browser: `Chrome/${process.versions.chrome ?? '0.0.0.0'}`,
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}${basePath}devtools/browser`
        })
      )
      return
    }

    if (
      pathname === `${basePath}json` ||
      pathname === `${basePath}json/` ||
      pathname === `${basePath}json/list` ||
      pathname === `${basePath}json/list/`
    ) {
      response.end(
        JSON.stringify([
          {
            ...targetInfo(),
            id: targetId,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}${basePath}devtools/browser`
          }
        ])
      )
      return
    }

    response.statusCode = 404
    response.end('{}')
  })
  sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== `${basePath}devtools/browser` || client) {
      socket.destroy()
      return
    }

    sockets?.handleUpgrade(request, socket, head, (websocket) => {
      sockets?.emit('connection', websocket, request)
    })
  })
  sockets.on('connection', (socket) => {
    client = socket
    pageSessions.clear()
    browserSessions.clear()
    primaryPageSession = null
    socket.on('message', (data) => {
      if (socket !== client || guest.isDestroyed()) {
        return
      }

      let request: CdpRequest
      try {
        const value = JSON.parse(data.toString()) as Partial<CdpRequest>
        if (
          !Number.isInteger(value.id) ||
          typeof value.method !== 'string' ||
          value.method.length > 256 ||
          (value.sessionId !== undefined &&
            typeof value.sessionId !== 'string') ||
          (value.params !== undefined &&
            (value.params === null ||
              typeof value.params !== 'object' ||
              Array.isArray(value.params)))
        ) {
          return
        }

        request = {
          id: value.id!,
          method: value.method,
          params: value.params ?? {},
          ...(value.sessionId ? { sessionId: value.sessionId } : {})
        }
      } catch {
        return
      }

      void (async () => {
        if (request.method.startsWith('Treeport.')) {
          if (!request.sessionId || !pageSessions.has(request.sessionId)) {
            sendError(
              socket,
              request,
              'Browser video requires an attached page session.'
            )
            return
          }

          const operation = videoTail.then(async () => {
            if (
              stopping ||
              socket !== client ||
              !pageSessions.has(request.sessionId!)
            ) {
              throw new Error('The Browser video connection closed.')
            }

            if (request.method === 'Treeport.startVideo') {
              const { width, height } = request.params
              if (
                typeof width !== 'number' ||
                typeof height !== 'number' ||
                !Number.isInteger(width) ||
                !Number.isInteger(height) ||
                width < 1 ||
                width > 3_840 ||
                height < 1 ||
                height > 2_160
              ) {
                throw new Error('The Browser video viewport is invalid.')
              }

              if (videoSession !== request.sessionId) {
                video.stop()
              }

              videoSession = request.sessionId!
              await video.start(width, height, (payload) => {
                if (
                  videoSession === request.sessionId &&
                  pageSessions.has(request.sessionId!)
                ) {
                  if (socket.bufferedAmount > 8 * 1024 * 1024) {
                    video.stop()
                    socket.close(1013, 'Browser video reader is too slow')
                    return
                  }

                  sendEvent(
                    socket,
                    'Treeport.videoFrame',
                    { payload },
                    request.sessionId
                  )
                }
              })
              if (stopping || socket !== client) {
                video.stop()
              }
            } else if (
              request.method === 'Treeport.stopVideo' &&
              videoSession === request.sessionId
            ) {
              videoSession = null
              video.stop()
            } else if (
              request.method === 'Treeport.requestVideoKeyframe' &&
              videoSession === request.sessionId
            ) {
              await video.requestKeyframe()
            } else {
              throw new Error('The Browser video command is not available.')
            }
          })
          videoTail = operation.catch(() => undefined)
          await operation
          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Browser.getVersion') {
          sendResult(socket, request, {
            protocolVersion: '1.3',
            product: `Chrome/${process.versions.chrome ?? '0.0.0.0'}`,
            revision: '',
            userAgent: guest.session.getUserAgent(),
            jsVersion: process.versions.v8 ?? ''
          })
          return
        }

        if (request.method === 'Browser.setDownloadBehavior') {
          sendResult(socket, request, {})
          return
        }

        if (
          request.method === 'Browser.close' ||
          request.method === 'Target.closeTarget' ||
          request.method === 'Target.activateTarget'
        ) {
          sendError(socket, request, 'This Browser target cannot be replaced.')
          return
        }

        if (request.method === 'Target.setAutoAttach') {
          if (request.params.autoAttach === true && pageSessions.size === 0) {
            const sessionId = `treeport-page-session-${++pageSessionOrdinal}`
            pageSessions.add(sessionId)
            primaryPageSession = sessionId
            sendEvent(
              socket,
              'Target.attachedToTarget',
              {
                sessionId,
                targetInfo: targetInfo(),
                waitingForDebugger: false
              },
              request.sessionId
            )
          }

          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Target.createTarget') {
          if (pageSessions.size === 0) {
            const sessionId = `treeport-page-session-${++pageSessionOrdinal}`
            pageSessions.add(sessionId)
            primaryPageSession = sessionId
            sendEvent(
              socket,
              'Target.attachedToTarget',
              {
                sessionId,
                targetInfo: targetInfo(),
                waitingForDebugger: false
              },
              request.sessionId
            )
          }

          sendResult(socket, request, { targetId })
          return
        }

        if (request.method === 'Target.getTargets') {
          sendResult(socket, request, { targetInfos: [targetInfo()] })
          return
        }

        if (request.method === 'Target.getTargetInfo') {
          const requestedTarget = request.params.targetId
          if (requestedTarget && requestedTarget !== targetId) {
            sendError(socket, request, 'The Browser target is not available.')
          } else {
            sendResult(socket, request, { targetInfo: targetInfo() })
          }

          return
        }

        if (request.method === 'Target.attachToBrowserTarget') {
          const sessionId = `treeport-browser-session-${++browserSessionOrdinal}`
          browserSessions.add(sessionId)
          sendResult(socket, request, { sessionId })
          return
        }

        if (request.method === 'Target.attachToTarget') {
          if (request.params.targetId !== targetId) {
            sendError(socket, request, 'The Browser target is not available.')
            return
          }

          const sessionId = `treeport-page-session-${++pageSessionOrdinal}`
          pageSessions.add(sessionId)
          primaryPageSession ??= sessionId
          sendResult(socket, request, { sessionId })
          return
        }

        if (request.method === 'Target.detachFromTarget') {
          const sessionId = request.params.sessionId
          if (typeof sessionId === 'string') {
            if (videoSession === sessionId) {
              videoSession = null
              video.stop()
            }

            pageSessions.delete(sessionId)
            browserSessions.delete(sessionId)
            if (primaryPageSession === sessionId) {
              primaryPageSession = pageSessions.values().next().value ?? null
            }
          }

          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Target.setDiscoverTargets') {
          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Runtime.runIfWaitingForDebugger') {
          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Page.setInterceptFileChooserDialog') {
          void guest.debugger
            .sendCommand(
              request.method,
              request.params,
              resolveDebuggerSession(request.sessionId)
            )
            .catch(() => undefined)
          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Page.bringToFront') {
          guest.focus()
          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Page.getNavigationHistory') {
          const entries = guest.navigationHistory.getAllEntries()
          sendResult(socket, request, {
            currentIndex: guest.navigationHistory.getActiveIndex(),
            entries: entries.map((entry, index) => ({
              id: index + 1,
              url: entry.url,
              userTypedURL: entry.url,
              title: entry.title,
              transitionType: 'typed'
            }))
          })
          return
        }

        if (request.method === 'Page.navigateToHistoryEntry') {
          const entryId = request.params.entryId
          if (
            typeof entryId !== 'number' ||
            !Number.isInteger(entryId) ||
            !guest.navigationHistory.getEntryAtIndex(entryId - 1)
          ) {
            sendError(
              socket,
              request,
              'The Browser history entry is not available.'
            )
            return
          }

          guest.navigationHistory.goToIndex(entryId - 1)
          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Page.navigate') {
          const url = request.params.url
          if (typeof url !== 'string') {
            sendError(socket, request, 'The Browser address is invalid.')
            return
          }

          const sessionId = resolveDebuggerSession(request.sessionId)
          await Promise.all([
            guest.debugger.sendCommand('Network.enable', {}, sessionId),
            guest.debugger.sendCommand('Page.enable', {}, sessionId),
            guest.debugger.sendCommand(
              'Page.setLifecycleEventsEnabled',
              { enabled: true },
              sessionId
            )
          ])
          guest.focus()
          const result = await guest.debugger.sendCommand(
            'Page.navigate',
            request.params,
            sessionId
          )
          sendResult(socket, request, result)
          return
        }

        if (request.method === 'Page.reload') {
          if (request.params.ignoreCache === true) {
            guest.reloadIgnoringCache()
          } else {
            guest.reload()
          }

          sendResult(socket, request, {})
          return
        }

        if (request.method === 'Page.captureScreenshot') {
          const visible =
            (await guest.hostWebContents?.executeJavaScript(
              `[...document.querySelectorAll('webview')].some((element) => element.getWebContentsId() === ${guest.id} && element.checkVisibility())`
            )) ?? false
          if (!visible) {
            sendError(
              socket,
              request,
              'The Browser panel is not visible. Open it in the Treeport desktop app, then retry the screenshot.'
            )
            return
          }

          const clip = request.params.clip as
            | { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
            | undefined
          const rectangle =
            clip &&
            [clip.x, clip.y, clip.width, clip.height].every(
              (value) => typeof value === 'number' && Number.isFinite(value)
            )
              ? {
                  x: Math.max(0, Math.floor(clip.x as number)),
                  y: Math.max(0, Math.floor(clip.y as number)),
                  width: Math.max(1, Math.ceil(clip.width as number)),
                  height: Math.max(1, Math.ceil(clip.height as number))
                }
              : undefined
          const image = await guest.capturePage(rectangle)
          const data =
            request.params.format === 'jpeg'
              ? image.toJPEG(
                  typeof request.params.quality === 'number'
                    ? Math.max(0, Math.min(100, request.params.quality))
                    : 80
                )
              : image.toPNG()
          sendResult(socket, request, { data: data.toString('base64') })
          return
        }

        const domain = request.method.split('.', 1)[0] ?? ''
        if (!ALLOWED_DOMAINS.has(domain) || domain === 'Browser') {
          sendError(socket, request, 'This CDP command is not available.')
          return
        }

        if (
          domain === 'Input' ||
          request.method === 'DOM.focus' ||
          request.method === 'Runtime.callFunctionOn'
        ) {
          guest.focus()
        }

        const result = await guest.debugger.sendCommand(
          request.method,
          request.params,
          resolveDebuggerSession(request.sessionId)
        )
        sendResult(socket, request, result)
        if (request.method === 'Page.getFrameTree') {
          const frameTree = result as { frameTree?: { frame?: unknown } }
          if (frameTree.frameTree?.frame) {
            sendEvent(
              socket,
              'Page.frameNavigated',
              { frame: frameTree.frameTree.frame, type: 'Navigation' },
              request.sessionId
            )
          }
        }
      })().catch((cause) =>
        sendError(
          socket,
          request,
          cause instanceof Error ? cause.message : String(cause)
        )
      )
    })
    socket.once('close', () => {
      if (client === socket) {
        videoSession = null
        video.stop()
        client = null
        pageSessions.clear()
        browserSessions.clear()
        primaryPageSession = null
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    const failed = (cause: Error) => reject(cause)
    server!.once('error', failed)
    server!.listen(0, '127.0.0.1', () => {
      server!.removeListener('error', failed)
      port = (server!.address() as AddressInfo).port
      resolve()
    })
  }).catch(async (cause) => {
    await stop()
    throw cause
  })

  return {
    descriptor: {
      endpoint: `http://127.0.0.1:${port}${basePath}`,
      panelId: identity.panelId,
      challenge: identity.challenge
    },
    stop
  }
}
