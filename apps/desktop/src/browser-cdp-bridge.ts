/* eslint-disable treeport/no-record-string-unknown, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- CDP is an external method-dispatched JSON protocol. This file validates its envelope before it routes method-specific payloads. */
import crypto from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { clipboard, type WebContents } from 'electron'
import {
  BROWSER_MAX_UPLOAD_BYTES,
  browserClipboardSchema,
  browserVideoSettingsSchema,
  copyBrowserPage,
  decodeUnknownOrNull
} from '@treeport/shared/browser-host'
import { WebSocket, WebSocketServer } from 'ws'
import { ElectronBrowserVideo } from './browser-video'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'
import { DesktopRuntime } from './desktop-runtime'
import { preserveDesktopFocus } from './browser-focus'

interface CdpRequest {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

interface BrowserCdpBridgeDescriptor {
  endpoint: string
  appId: string
  challenge: string
}

export interface BrowserCdpBridge {
  descriptor: BrowserCdpBridgeDescriptor
  stop: Effect.Effect<void>
}

// EXTERNAL: The native clipboard is shared by all guests. Keep copy and read together.
const clipboardOperations = Effect.unsafeMakeSemaphore(1)

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

export function createBrowserCdpBridge(
  guest: WebContents,
  identity: { appId: string; challenge: string },
  parent: DesktopRuntime
) {
  return Effect.gen(function* () {
    if (guest.isDestroyed() || parent.isClosed) {
      return yield* Effect.fail(
        new Error('The Browser page is no longer available.')
      )
    }

    const runtime = new DesktopRuntime(parent)

    return yield* Effect.gen(function* () {
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
      let nativeBeforeUnload = false
      let port = 0
      const video = new ElectronBrowserVideo(guest, runtime)
      let videoSession: string | null = null
      const videoOperations = yield* Effect.makeSemaphore(1)
      const inputOperations = yield* Effect.makeSemaphore(1)

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
            JSON.stringify({
              id: request.id,
              result,
              ...responseSession(request)
            })
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
        sessionId &&
        !pageSessions.has(sessionId) &&
        !browserSessions.has(sessionId)
          ? sessionId
          : undefined

      const onDebuggerMessage = (
        _event: Electron.Event,
        method: string,
        params: unknown,
        sessionId?: string
      ) => {
        // EXTERNAL: Electron owns beforeunload and can close it before an automation
        // reply arrives. Never expose that native dialog to Playwright's
        // automatic accept path (which has an unobserved rejection).
        if (method === 'Page.javascriptDialogOpening') {
          const dialog = params as { type?: string }

          if (dialog.type === 'beforeunload') {
            nativeBeforeUnload = true

            return
          }
        }

        if (method === 'Page.javascriptDialogClosed' && nativeBeforeUnload) {
          nativeBeforeUnload = false
          const dialog = params as { result?: boolean }

          if (dialog.result === false) {
            onDebuggerMessage(
              _event,
              'Treeport.navigationCanceled',
              {},
              sessionId
            )
          }

          return
        }

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

      const cleanup = Effect.gen(function* () {
        stopping = true
        yield* video.stop
        guest.removeListener('destroyed', onDestroyed)

        if (!guest.isDestroyed()) {
          guest.debugger.removeListener('message', onDebuggerMessage)
          guest.debugger.removeListener('detach', onDebuggerDetach)

          if (guest.debugger.isAttached()) {
            yield* Effect.tryPromise(() =>
              guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
                enabled: false
              })
            ).pipe(Effect.timeout('1 second'), Effect.ignore)

            if (
              attachedByBridge &&
              !guest.isDestroyed() &&
              guest.debugger.isAttached()
            ) {
              guest.debugger.detach()
            }
          }
        }

        client = null
        yield* Effect.async<void>((resume) => {
          if (!sockets) {
            return resume(Effect.void)
          }

          for (const socket of sockets.clients) {
            socket.terminate()
          }

          sockets.close(() => resume(Effect.void))
          sockets = null
        })
        yield* Effect.async<void>((resume) => {
          if (!server) {
            return resume(Effect.void)
          }

          server.close(() => resume(Effect.void))
          server.closeAllConnections()
          server = null
        })
      })

      const stop = runtime.close

      const onDebuggerDetach = () => {
        parent.fork(stop)
      }

      const onDestroyed = () => {
        parent.fork(stop)
      }

      yield* Scope.addFinalizer(runtime.scope, cleanup)

      if (runtime.isClosed || guest.isDestroyed()) {
        return yield* Effect.interrupt
      }

      if (attachedByBridge) {
        guest.debugger.attach('1.3')
      }

      guest.debugger.on('message', onDebuggerMessage)
      guest.debugger.once('detach', onDebuggerDetach)
      guest.once('destroyed', onDestroyed)
      yield* Effect.tryPromise(() =>
        guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
          enabled: true
        })
      )

      const initialFrameTree = (yield* Effect.tryPromise(() =>
        guest.debugger.sendCommand('Page.getFrameTree')
      ).pipe(Effect.catchAll(() => Effect.succeed(null)))) as {
        frameTree?: { frame?: { id?: string } }
      } | null

      targetId = initialFrameTree?.frameTree?.frame?.id ?? targetId

      server = createServer((request, response) => {
        const address = request.url ?? '/'
        const base = `http://127.0.0.1:${port}`

        const pathname = URL.canParse(address, base)
          ? new URL(address, base).pathname
          : ''

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
      sockets = new WebSocketServer({
        noServer: true,
        // EXTERNAL: Playwright sends in-memory file uploads through Runtime.callFunctionOn
        // as base64. Leave room for the CDP envelope and file metadata too.
        maxPayload: 4 * Math.ceil(BROWSER_MAX_UPLOAD_BYTES / 3) + 1024 * 1024
      })

      const failed = (error: Error) => {
        parent.fork(
          Effect.logError('Browser bridge transport failed', error).pipe(
            Effect.zipRight(stop)
          )
        )
      }

      server.on('error', failed)
      sockets.on('error', failed)
      server.on('upgrade', (request, socket, head) => {
        const address = request.url ?? '/'

        const pathname = URL.canParse(address, 'http://127.0.0.1')
          ? new URL(address, 'http://127.0.0.1').pathname
          : ''

        if (
          stopping ||
          runtime.isClosed ||
          pathname !== `${basePath}devtools/browser` ||
          client
        ) {
          socket.destroy()

          return
        }

        sockets?.handleUpgrade(request, socket, head, (websocket) => {
          sockets?.emit('connection', websocket, request)
        })
      })
      sockets.on('connection', (socket) => {
        const connection = new DesktopRuntime(runtime)
        let pendingRequests = 0
        client = socket
        socket.on('error', () => socket.terminate())
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

          if (pendingRequests >= 256) {
            sendError(socket, request, 'The Browser command queue is full.')

            return
          }

          pendingRequests += 1

          const operation = Effect.gen(function* () {
            if (
              socket !== client ||
              stopping ||
              runtime.isClosed ||
              guest.isDestroyed()
            ) {
              return yield* Effect.interrupt
            }

            if (request.method.startsWith('Treeport.')) {
              if (!request.sessionId || !pageSessions.has(request.sessionId)) {
                sendError(
                  socket,
                  request,
                  'Browser commands require an attached page session.'
                )

                return
              }

              if (request.method === 'Treeport.copy') {
                const result = yield* clipboardOperations.withPermits(1)(
                  Effect.tryPromise(async () => {
                    const copied = await copyBrowserPage({
                      send: (method, params?) =>
                        guest.debugger.sendCommand(method, params)
                    })

                    if (!copied) {
                      return null
                    }

                    const image = clipboard.readImage()

                    const result = decodeUnknownOrNull(browserClipboardSchema, {
                      text: clipboard.readText() || null,
                      html: clipboard.readHTML() || null,
                      png: image.isEmpty()
                        ? null
                        : image.toPNG().toString('base64')
                    })

                    if (!result) {
                      throw new Error(
                        'The copied content is too large or unsupported.'
                      )
                    }

                    return result
                  })
                )

                sendResult(socket, request, result)

                return
              }

              const videoResult = yield* videoOperations.withPermits(1)(
                Effect.gen(function* () {
                  if (
                    stopping ||
                    socket !== client ||
                    !pageSessions.has(request.sessionId!)
                  ) {
                    throw new Error('The Browser video connection closed.')
                  }

                  if (request.method === 'Treeport.startVideo') {
                    const { width, height } = request.params

                    const settings = decodeUnknownOrNull(
                      browserVideoSettingsSchema,
                      request.params.settings
                    )

                    if (
                      !settings ||
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
                      yield* video.stop
                    }

                    videoSession = request.sessionId!
                    yield* video.start(width, height, settings, (message) => {
                      if (
                        videoSession === request.sessionId &&
                        pageSessions.has(request.sessionId!)
                      ) {
                        sendEvent(
                          socket,
                          'Treeport.videoError',
                          { message },
                          request.sessionId
                        )
                      }
                    })

                    if (stopping || socket !== client) {
                      yield* video.stop
                    }
                  } else if (
                    request.method === 'Treeport.stopVideo' &&
                    videoSession === request.sessionId
                  ) {
                    videoSession = null
                    yield* video.stop
                  } else if (
                    (request.method === 'Treeport.negotiateVideo' ||
                      request.method === 'Treeport.closeVideoPeer') &&
                    videoSession === request.sessionId
                  ) {
                    const { peerId, sdp } = request.params

                    if (typeof peerId !== 'string' || peerId.length > 128) {
                      throw new Error('Invalid Browser video peer.')
                    }

                    if (request.method === 'Treeport.closeVideoPeer') {
                      yield* video.closePeer(peerId)
                    } else {
                      if (typeof sdp !== 'string' || sdp.length > 65_536) {
                        throw new Error('Invalid Browser video offer.')
                      }

                      return yield* video.negotiate(peerId, sdp)
                    }
                  } else {
                    throw new Error(
                      'The Browser video command is not available.'
                    )
                  }
                })
              )

              sendResult(socket, request, videoResult ?? {})

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
              sendError(
                socket,
                request,
                'This Browser target cannot be replaced.'
              )

              return
            }

            if (request.method === 'Target.setAutoAttach') {
              if (
                request.params.autoAttach === true &&
                pageSessions.size === 0
              ) {
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
                sendError(
                  socket,
                  request,
                  'The Browser target is not available.'
                )
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
                sendError(
                  socket,
                  request,
                  'The Browser target is not available.'
                )

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
                  yield* video.stop
                }

                pageSessions.delete(sessionId)
                browserSessions.delete(sessionId)

                if (primaryPageSession === sessionId) {
                  primaryPageSession =
                    pageSessions.values().next().value ?? null
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
              yield* Effect.tryPromise(() =>
                guest.debugger.sendCommand(
                  request.method,
                  request.params,
                  resolveDebuggerSession(request.sessionId)
                )
              ).pipe(Effect.ignore)
              sendResult(socket, request, {})

              return
            }

            if (request.method === 'Page.bringToFront') {
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
              yield* Effect.all(
                [
                  Effect.tryPromise(() =>
                    guest.debugger.sendCommand('Network.enable', {}, sessionId)
                  ),
                  Effect.tryPromise(() =>
                    guest.debugger.sendCommand('Page.enable', {}, sessionId)
                  ),
                  Effect.tryPromise(() =>
                    guest.debugger.sendCommand(
                      'Page.setLifecycleEventsEnabled',
                      { enabled: true },
                      sessionId
                    )
                  )
                ],
                { concurrency: 'unbounded' }
              )

              const result = yield* Effect.tryPromise(() =>
                guest.debugger.sendCommand(
                  'Page.navigate',
                  request.params,
                  sessionId
                )
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
                (yield* Effect.tryPromise(async () =>
                  guest.hostWebContents?.executeJavaScript(
                    `[...document.querySelectorAll('webview')].some((element) => element.getWebContentsId() === ${guest.id} && element.checkVisibility())`
                  )
                )) ?? false

              if (!visible) {
                sendError(
                  socket,
                  request,
                  'The Browser app is not visible. Open it in the Treeport desktop app, then retry the screenshot.'
                )

                return
              }

              const clip = request.params.clip as
                | {
                    x?: unknown
                    y?: unknown
                    width?: unknown
                    height?: unknown
                  }
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

              const image = yield* Effect.tryPromise(() =>
                guest.capturePage(rectangle)
              )

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

            if (request.method === 'Input.insertText') {
              const text = request.params.text

              if (typeof text !== 'string') {
                sendError(socket, request, 'The Browser input text is invalid.')

                return
              }

              // EXTERNAL: CDP routes insertText via the embedder's focused widget. Target
              // the guest directly so terminal focus cannot swallow agent input.
              yield* Effect.tryPromise(() => guest.insertText(text))
              sendResult(socket, request, {})

              return
            }

            const domain = request.method.split('.', 1)[0] ?? ''

            if (!ALLOWED_DOMAINS.has(domain) || domain === 'Browser') {
              sendError(socket, request, 'This CDP command is not available.')

              return
            }

            const command = Effect.tryPromise(() =>
              guest.debugger.sendCommand(
                request.method,
                request.params,
                resolveDebuggerSession(request.sessionId)
              )
            )

            const result = yield* request.method === 'Input.dispatchKeyEvent'
              ? preserveDesktopFocus(guest, command, true)
              : request.method === 'Input.dispatchMouseEvent' ||
                  request.method === 'Input.dispatchTouchEvent'
                ? preserveDesktopFocus(guest, command)
                : command

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
          })

          connection.fork(
            (request.method.startsWith('Input.')
              ? inputOperations.withPermits(1)(operation)
              : operation
            ).pipe(
              Effect.timeout('30 seconds'),
              Effect.ensuring(
                Effect.sync(() => {
                  pendingRequests -= 1
                })
              ),
              Effect.catchAllCause((cause) =>
                Effect.sync(() => {
                  if (!Cause.isInterruptedOnly(cause)) {
                    const error = Cause.squash(cause)
                    sendError(
                      socket,
                      request,
                      String(
                        Cause.isUnknownException(error) ? error.cause : error
                      )
                    )
                  }
                })
              )
            )
          )
        })
        socket.once('close', () => {
          runtime.fork(connection.close)

          if (client === socket) {
            videoSession = null
            runtime.fork(
              videoOperations.withPermits(1)(
                Effect.suspend(() =>
                  videoSession === null ? video.stop : Effect.void
                )
              )
            )
            client = null
            pageSessions.clear()
            browserSessions.clear()
            primaryPageSession = null
          }
        })
      })

      yield* Effect.async<void, Error>((resume, signal) => {
        const listeningServer = server!
        const failed = (cause: Error) => resume(Effect.fail(cause))
        listeningServer.once('error', failed)
        listeningServer.listen({ port: 0, host: '127.0.0.1', signal }, () => {
          listeningServer.removeListener('error', failed)
          port = (listeningServer.address() as AddressInfo).port
          resume(Effect.void)
        })

        return Effect.sync(() =>
          listeningServer.removeListener('error', failed)
        )
      }).pipe(Effect.timeout('5 seconds'))

      return {
        descriptor: {
          endpoint: `http://127.0.0.1:${port}${basePath}`,
          appId: identity.appId,
          challenge: identity.challenge
        },
        stop
      } satisfies BrowserCdpBridge
    }).pipe(
      Effect.timeout('10 seconds'),
      Effect.onError(() => runtime.close)
    )
  })
}
