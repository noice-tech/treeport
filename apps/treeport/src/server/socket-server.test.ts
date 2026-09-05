import http, { type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProductEventBus,
  type AppConfig,
  type TreeportService
} from './core/index'
import type {
  BrowserClientMessage,
  BrowserClientToServerEvents,
  BrowserOwnerClientMessage,
  BrowserOwnerClientToServerEvents,
  BrowserOwnerServerMessage,
  BrowserOwnerServerToClientEvents,
  BrowserServerMessage,
  BrowserServerToClientEvents,
  TerminalClientToServerEvents,
  TerminalRuntimeMetadata,
  TerminalReady,
  TerminalRecord,
  TerminalServerToClientEvents,
  BrowserPanel,
  WebPanel,
  ProtocolSocket,
  ProtocolSocketOptions
} from '@treeport/shared'
import {
  BROWSER_PROTOCOL_VERSION,
  createProtocolSocket,
  TERMINAL_PROTOCOL_VERSION
} from '@treeport/shared'
import { testAccess } from './test-access'
import { TerminalAttachmentManager } from './terminal-attachments'
import {
  createSocketServer,
  type BrowserSessionController
} from './socket-server'
import type {
  BrowserOwnerTransport,
  BrowserTransport
} from './browser-sessions'
import type { TerminalMetadataManager } from './terminal-metadata'
import type { TerminalAttachmentBackend } from './terminal-host-sessions'

class FakePty {
  readonly pid = 1
  readonly cols = 100
  readonly rows = 30
  readonly process = 'shell'
  handleFlowControl = false
  kills = 0
  writes: Array<string | Buffer> = []
  private dataListener: ((data: string, sequence: number) => void) | null = null
  private sequence = 0
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null
  onData = (listener: (data: string, sequence: number) => void) => {
    this.dataListener = listener
    return { dispose: () => (this.dataListener = null) }
  }
  onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void
  ) => {
    this.exitListener = listener
    return { dispose: () => (this.exitListener = null) }
  }
  emit(data: string) {
    this.dataListener?.(data, ++this.sequence)
  }
  pause() {}
  resume() {}
  kill() {
    this.kills += 1
  }
  write(data: string | Buffer) {
    this.writes.push(data)
  }
  resize() {}
  clear() {}
}

interface NetworkFixture {
  server: HttpServer
  url: string
  attachments: TerminalAttachmentManager
  events: ProductEventBus
  metadata: TerminalMetadataManager
  metadataSnapshot: ReturnType<typeof vi.fn<() => TerminalRuntimeMetadata[]>>
  listWebPanels: ReturnType<typeof vi.fn<() => Promise<WebPanel[]>>>
  listBrowserPanels: ReturnType<typeof vi.fn<() => Promise<BrowserPanel[]>>>
  getTerminalForAttachment: ReturnType<
    typeof vi.fn<
      (terminalId?: string) => Effect.Effect<TerminalRecord, never, never>
    >
  >
  ptys: FakePty[]
  service: TreeportService
  closeConnections(): void
  close(): Promise<void>
}

const fixtures: NetworkFixture[] = []

async function fixture(
  browserSessions?: BrowserSessionController
): Promise<NetworkFixture> {
  const events = new ProductEventBus()
  const ptys: FakePty[] = []
  const listWebPanels = vi.fn<() => Promise<WebPanel[]>>(async () => [])
  const listBrowserPanels = vi.fn<() => Promise<BrowserPanel[]>>(async () => [])
  const getTerminalForAttachment = vi.fn<
    (terminalId?: string) => Effect.Effect<TerminalRecord, never, never>
  >(() =>
    Effect.succeed({
      id: 'term',
      worktreeId: 'wt',
      name: 'Terminal',
      argv: ['shell'],
      shellCommand: null,
      interactiveShell: false,
      status: 'running',
      exitCode: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
  )
  const getWorktree = vi.fn(() =>
    Effect.succeed({
      id: 'wt',
      path: '/tmp'
    })
  )
  // SAFETY: The test fixture provides the asserted contract used here.
  const service = testAccess<TreeportService>({
    events,
    listWebPanels,
    listBrowserPanels,
    panels: { listWebPanels, listBrowserPanels },
    getTerminalForAttachment,
    terminals: { getTerminalForAttachment },
    getWorktree,
    projects: { getWorktree },
    runEffect: vi.fn((effect) =>
      Effect.isEffect(effect)
        ? Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>)
        : effect
    ),
    forkEffect: vi.fn((effect) =>
      Effect.runFork(effect as Effect.Effect<void, unknown, never>)
    ),
    forkApplicationEffect: vi.fn((effect) => {
      // SAFETY: The socket fixture provides every service required by the effect.
      Effect.runFork(effect as Effect.Effect<void, never, never>)
    }),
    terminalAttachmentMutation: vi.fn((_terminalId, effect) => effect)
  })
  const child = new FakePty()
  ptys.push(child)
  // SAFETY: The test fixture provides the terminal-host attachment contract.
  const terminalHost = testAccess<TerminalAttachmentBackend>({
    attach: vi.fn(async (_terminalId, listener) => ({
      data: '',
      fence: 0,
      cols: 100,
      rows: 30,
      unsubscribe: child.onData(listener).dispose
    })),
    subscribeRuntime: vi.fn(() => () => undefined),
    terminalTitleState: vi.fn(async () => null),
    runtimeState: vi.fn(async () => ({
      title: null,
      status: 'running',
      progress: null,
      bell: null
    })),
    write: vi.fn((_terminalId, data) => child.write(data)),
    prepareQueryAuthority: vi.fn(async () => ({
      transitionId: 'transition',
      fence: 0
    })),
    activateQueryAuthority: vi.fn(async () => undefined),
    useHostQueryAuthority: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    dispose: vi.fn()
  })
  const currentMetadata: TerminalRuntimeMetadata = {
    terminalId: 'term',
    title: 'shell',
    program: null,
    progress: null,
    progressStartedAt: null,
    progressClearedAt: null,
    bell: null
  }
  const metadataSnapshot = vi.fn<() => TerminalRuntimeMetadata[]>(() => [
    currentMetadata
  ])
  // SAFETY: The test fixture provides the asserted contract used here.
  const metadata = testAccess<TerminalMetadataManager>({
    initialize: vi.fn(() => Effect.void),
    snapshot: metadataSnapshot,
    get: vi.fn(() => currentMetadata),
    trackTerminal: vi.fn(() => Effect.void),
    subscribe: vi.fn(() => () => undefined)
  })
  const attachmentManager = new TerminalAttachmentManager(
    service,
    metadata,
    terminalHost
  )
  const server = http.createServer((_request, response) => {
    response.statusCode = 404
    response.end()
  })
  const config = {
    host: '127.0.0.1',
    port: 0,
    databasePath: '/tmp/treeport-socket-test.db',
    dataDir: '/tmp',
    cacheDir: '/tmp',
    runtimeDir: '/tmp',
    shell: '/bin/sh',
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1',
    daemonLifecycle: 'treeport',
    webDevelopment: false
  } satisfies AppConfig
  const socketServerDependencies = {
    service,
    config,
    terminalMetadata: metadata,
    terminalHost,
    attachmentManager
  }
  const socketServer = browserSessions
    ? createSocketServer({
        ...socketServerDependencies,
        browserSessions
      })
    : createSocketServer(socketServerDependencies)
  const { attachments } = socketServer
  server.on('upgrade', (request, socket, head) => {
    if (!socketServer.handleUpgrade(request, socket, head)) {
      socket.destroy()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // SAFETY: The test fixture provides the asserted contract used here.
  const address = server.address() as AddressInfo
  const value: NetworkFixture = {
    server,
    url: `http://127.0.0.1:${address.port}`,
    attachments,
    events,
    metadata,
    metadataSnapshot,
    listWebPanels,
    listBrowserPanels,
    getTerminalForAttachment,
    ptys,
    service,
    closeConnections: socketServer.closeConnections,
    close: async () => {
      await socketServer.close()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
  fixtures.push(value)
  return value
}

function webSocketConstructor(extraHeaders?: Record<string, string>) {
  if (!extraHeaders) {
    return undefined
  }

  return (url: string, protocols?: string | string[]) => {
    const socket = new WebSocket(url, protocols, { headers: extraHeaders })
    // SAFETY: ws implements the WebSocket operations consumed by Effect Socket.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions -- The ws and DOM declarations describe the same runtime object differently.
    return socket as unknown as globalThis.WebSocket
  }
}

function terminalClient(
  url: string,
  clientId = 'tab-a',
  terminalProtocol: string | null = String(TERMINAL_PROTOCOL_VERSION),
  options: { extraHeaders?: Record<string, string> } = {}
): ProtocolSocket<TerminalServerToClientEvents, TerminalClientToServerEvents> {
  const query: Record<string, string> = {}
  if (terminalProtocol !== null) {
    query.terminalProtocol = terminalProtocol
  }

  const constructor = webSocketConstructor(options.extraHeaders)
  const socketOptions: ProtocolSocketOptions = {
    reconnection: true,
    reconnectionDelay: 10,
    auth: { terminalId: 'term', clientId, cols: 100, rows: 30 },
    query
  }
  return createProtocolSocket(
    `${url}/terminals`,
    constructor
      ? { ...socketOptions, webSocketConstructor: constructor }
      : socketOptions
  )
}

async function activateQueryAuthority(
  socket: ProtocolSocket<
    TerminalServerToClientEvents,
    TerminalClientToServerEvents
  >,
  generation: number
): Promise<void> {
  let phase = 0
  await new Promise<void>((resolve) => {
    socket.on('query_authority', (message) => {
      if (message.generation !== generation) {
        return
      }

      if (message.transitionId) {
        socket.emit('query_authority', {
          generation,
          transitionId: message.transitionId
        })
        phase += 1
      } else if (message.active && phase >= 2) {
        resolve()
      }
    })
    socket.emit('query_authority', { generation, transitionId: null })
  })
}

async function closeClient(socket: ProtocolSocket<any, any>): Promise<void> {
  socket.removeAllListeners()
  socket.disconnect()
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.close()
  }
})

describe('Effect WebSocket real network', () => {
  it('uses one-use browser authorization before relaying hosted browser commands', async () => {
    const messages: BrowserClientMessage[] = []
    const ownerMessages: BrowserOwnerClientMessage[] = []
    const closes: string[] = []
    const ownerCloses: string[] = []
    const transports = new Map<string, BrowserTransport>()
    const browserSessions = {
      accept: vi.fn((ticket: string, transport: BrowserTransport) =>
        Effect.sync(() => {
          expect(ticket).toBe('b'.repeat(43))
          transports.set('browser-connection', transport)
          transport.sendMessage({
            type: 'ready',
            state: {
              url: 'about:blank',
              title: '',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              controlled: true,
              hasController: true,
              controller: 'you',
              viewport: { width: 800, height: 600 }
            }
          })
          transport.sendFrame({
            sequence: 1,
            mimeType: 'video/vp8',
            keyframe: true,
            timestamp: 123,
            width: 800,
            height: 600,
            data: Uint8Array.from([1, 2, 3])
          })
          return 'browser-connection'
        })
      ),
      message: vi.fn((connectionId: string, message: BrowserClientMessage) => {
        messages.push(message)
        if (message.type === 'setVisible' && message.visible) {
          transports.get(connectionId)?.sendFrame({
            sequence: 2,
            mimeType: 'video/vp8',
            keyframe: false,
            timestamp: 456,
            width: 800,
            height: 600,
            data: Uint8Array.from([4, 5, 6])
          })
        }
      }),
      close: vi.fn((connectionId: string) => void closes.push(connectionId)),
      acceptOwner: vi.fn((auth, transport: BrowserOwnerTransport) =>
        Effect.sync(() => {
          expect(auth.endpoint).toBe('http://127.0.0.1:43210/private-owner/')
          transport.send({
            type: 'claimGranted',
            panelId: 'panel_browser',
            generation: 4,
            resumed: false,
            state: {
              url: 'about:blank',
              title: '',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              viewport: { width: 800, height: 600 }
            }
          })
          return 'browser-owner'
        })
      ),
      ownerMessage: vi.fn(
        (_connectionId: string, message: BrowserOwnerClientMessage) =>
          void ownerMessages.push(message)
      ),
      closeOwner: vi.fn(
        (connectionId: string) => void ownerCloses.push(connectionId)
      )
    } satisfies BrowserSessionController
    const value = await fixture(browserSessions)
    const browser = createProtocolSocket<
      BrowserServerToClientEvents,
      BrowserClientToServerEvents
    >(`${value.url}/browsers`, {
      reconnection: false,
      auth: {
        ticket: 'b'.repeat(43),
        protocolVersion: BROWSER_PROTOCOL_VERSION
      }
    })
    const frame = new Promise<
      Parameters<BrowserServerToClientEvents['frame']>[0]
    >((resolve) => browser.once('frame', resolve))
    const streamedFrames: number[] = []
    browser.on('frame', (received) => {
      streamedFrames.push(received.sequence)
      browser.emit('command', {
        type: 'frameAck',
        sequence: received.sequence
      })
    })
    const ready = await new Promise<BrowserServerMessage>((resolve) =>
      browser.once('message', (message) => {
        // The workspace requests frames synchronously when it receives ready.
        browser.emit('command', { type: 'setVisible', visible: true })
        resolve(message)
      })
    )
    expect(ready).toMatchObject({
      type: 'ready',
      state: { controlled: true, viewport: { width: 800, height: 600 } }
    })
    await expect(frame).resolves.toMatchObject({
      sequence: 1,
      data: Uint8Array.from([1, 2, 3])
    })
    await vi.waitFor(() => expect(streamedFrames).toEqual([1, 2]))
    browser.emit('command', { type: 'back' })
    await vi.waitFor(() =>
      expect(messages).toEqual([
        { type: 'setVisible', visible: true },
        { type: 'frameAck', sequence: 1 },
        { type: 'frameAck', sequence: 2 },
        { type: 'back' }
      ])
    )
    await closeClient(browser)
    await vi.waitFor(() => expect(closes).toEqual(['browser-connection']))

    const owner = createProtocolSocket<
      BrowserOwnerServerToClientEvents,
      BrowserOwnerClientToServerEvents
    >(`${value.url}/browser-owners`, {
      reconnection: false,
      auth: {
        ticket: 'o'.repeat(43),
        challenge: 'c'.repeat(43),
        endpoint: 'http://127.0.0.1:43210/private-owner/',
        protocolVersion: BROWSER_PROTOCOL_VERSION
      }
    })
    const claimed = await new Promise<BrowserOwnerServerMessage>((resolve) =>
      owner.once('ownerMessage', (message) => {
        if (message.type === 'claimGranted') {
          owner.emit('ownerMessage', {
            type: 'ready',
            generation: message.generation,
            revision: 1,
            state: message.state
          })
        }

        resolve(message)
      })
    )
    expect(claimed).toMatchObject({
      type: 'claimGranted',
      panelId: 'panel_browser',
      generation: 4
    })
    owner.emit('ownerMessage', {
      type: 'popup',
      generation: 4,
      url: 'https://example.com/popup'
    })
    await vi.waitFor(() =>
      expect(ownerMessages).toEqual([
        expect.objectContaining({ type: 'ready', generation: 4, revision: 1 }),
        {
          type: 'popup',
          generation: 4,
          url: 'https://example.com/popup'
        }
      ])
    )
    await closeClient(owner)
    await vi.waitFor(() => expect(ownerCloses).toEqual(['browser-owner']))
  })

  it('interrupts Browser attachment work when the client disconnects before ready', async () => {
    let started = false
    let interrupted = false
    const browserSessions: BrowserSessionController = {
      accept: vi.fn((_ticket, transport) =>
        Effect.sync(() => {
          started = true
          transport.sendMessage({
            type: 'navigationError',
            message: 'Queued before acceptance completes'
          })
        }).pipe(
          Effect.zipRight(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            })
          )
        )
      ),
      message: vi.fn(),
      close: vi.fn(),
      acceptOwner: vi.fn(() => Effect.succeed('owner')),
      ownerMessage: vi.fn(),
      closeOwner: vi.fn()
    }
    const value = await fixture(browserSessions)
    const browser = createProtocolSocket<
      BrowserServerToClientEvents,
      BrowserClientToServerEvents
    >(`${value.url}/browsers`, {
      reconnection: false,
      auth: {
        ticket: 'b'.repeat(43),
        protocolVersion: BROWSER_PROTOCOL_VERSION
      }
    })

    const received: BrowserServerMessage[] = []
    browser.on('message', (message) => received.push(message))
    await vi.waitFor(() => expect(started).toBe(true))
    browser.disconnect()
    await vi.waitFor(() => expect(interrupted).toBe(true))
    expect(received).toEqual([])
  })

  it('closes Browser attachments on output failure and permits a fresh connection', async () => {
    const transports: BrowserTransport[] = []
    const closed: string[] = []
    const browserSessions: BrowserSessionController = {
      accept: (_ticket, transport) =>
        Effect.sync(() => {
          transports.push(transport)
          return transport.id
        }),
      message: vi.fn(),
      close: (id) => void closed.push(id),
      acceptOwner: () => Effect.succeed('owner'),
      ownerMessage: vi.fn(),
      closeOwner: vi.fn()
    }
    const value = await fixture(browserSessions)
    const connect = () =>
      createProtocolSocket<
        BrowserServerToClientEvents,
        BrowserClientToServerEvents
      >(`${value.url}/browsers`, {
        reconnection: false,
        auth: {
          ticket: 'b'.repeat(43),
          protocolVersion: BROWSER_PROTOCOL_VERSION
        }
      })
    const browser = connect()
    await new Promise<void>((resolve) => browser.once('connect', resolve))
    const disconnected = vi.fn()
    browser.on('disconnect', disconnected)
    const frame = {
      sequence: 1,
      mimeType: 'video/vp8' as const,
      keyframe: true,
      timestamp: 123,
      width: 800,
      height: 600,
      data: Uint8Array.from([1, 2, 3])
    }
    // Only the server uses ws here; clients use the native WebSocket.
    const send = vi
      .spyOn(WebSocket.prototype, 'send')
      .mockImplementation(() => {
        throw new Error('Injected frame write failure')
      })
    try {
      expect(transports[0]!.sendFrame(frame)).toBe(true)
      await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce())
      expect(closed).toEqual([transports[0]!.id])
      expect(transports[0]!.sendFrame(frame)).toBe(false)
    } finally {
      send.mockRestore()
      await closeClient(browser)
    }

    const reconnected = connect()
    await new Promise<void>((resolve) => reconnected.once('connect', resolve))
    const nextFrame = new Promise((resolve) =>
      reconnected.once('frame', resolve)
    )
    expect(transports[1]!.sendFrame(frame)).toBe(true)
    await expect(nextFrame).resolves.toMatchObject(frame)
    await closeClient(reconnected)
    await vi.waitFor(() =>
      expect(closed).toEqual(transports.map((transport) => transport.id))
    )
  })

  it('authenticates local and Tailscale clients before accepting socket connections', async () => {
    const value = await fixture()
    const local = terminalClient(
      value.url,
      'tab-local',
      String(TERMINAL_PROTOCOL_VERSION),
      { extraHeaders: { Origin: value.url } }
    )
    await new Promise<void>((resolve, reject) => {
      local.once('ready', () => resolve())
      local.once('connect_error', reject)
    })

    const tailscaleHeaders = {
      Origin: 'https://feature.treeport.localhost',
      'Tailscale-User-Login': 'developer@example.test',
      'X-Forwarded-Host': 'feature.treeport.localhost',
      'X-Forwarded-Proto': 'https'
    }
    const proxied = terminalClient(
      value.url,
      'tab-proxied',
      String(TERMINAL_PROTOCOL_VERSION),
      { extraHeaders: tailscaleHeaders }
    )
    await new Promise<void>((resolve, reject) => {
      proxied.once('ready', () => resolve())
      proxied.once('connect_error', reject)
    })

    const bypassHeaders = {
      Host: 'feature.treeport.localhost',
      'X-Forwarded-Host': 'feature.treeport.localhost',
      'X-Forwarded-Proto': 'https'
    }
    const bypassed = terminalClient(
      value.url,
      'tab-bypassed',
      String(TERMINAL_PROTOCOL_VERSION),
      { extraHeaders: bypassHeaders }
    )
    bypassed.manager.reconnection(false)
    const bypassError = await new Promise<Error>((resolve) =>
      bypassed.once('connect_error', resolve)
    )
    expect(bypassError.message).toMatch(/websocket error/i)

    const foreignOrigin = terminalClient(
      value.url,
      'tab-foreign',
      String(TERMINAL_PROTOCOL_VERSION),
      { extraHeaders: { ...tailscaleHeaders, Origin: 'https://evil.example' } }
    )
    foreignOrigin.manager.reconnection(false)
    const originError = await new Promise<Error>((resolve) =>
      foreignOrigin.once('connect_error', resolve)
    )
    expect(originError.message).toMatch(/websocket error/i)

    const opaqueOrigin = terminalClient(
      value.url,
      'tab-opaque',
      String(TERMINAL_PROTOCOL_VERSION),
      { extraHeaders: { ...tailscaleHeaders, Origin: 'null' } }
    )
    opaqueOrigin.manager.reconnection(false)
    const opaqueOriginError = await new Promise<Error>((resolve) =>
      opaqueOrigin.once('connect_error', resolve)
    )
    expect(opaqueOriginError.message).toMatch(/websocket error/i)

    const originless = terminalClient(value.url, 'tab-originless')
    await new Promise<void>((resolve, reject) => {
      originless.once('ready', () => resolve())
      originless.once('connect_error', reject)
    })
    expect(value.getTerminalForAttachment).toHaveBeenCalledTimes(3)
    await Promise.all(
      [local, proxied, bypassed, foreignOrigin, opaqueOrigin, originless].map(
        closeClient
      )
    )
  })

  it('requires the exact terminal protocol version', async () => {
    const value = await fixture()
    const current = terminalClient(value.url, 'tab-current')
    const currentReady = await new Promise<TerminalReady>((resolve) =>
      current.once('ready', (payload) => resolve(payload))
    )
    expect(currentReady).toMatchObject({
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ''
    })

    const missing = terminalClient(value.url, 'tab-missing', null)
    missing.manager.reconnection(false)
    const missingError = await new Promise<Error>((resolve) =>
      missing.once('connect_error', resolve)
    )
    expect(missingError.message).toBe('UNSUPPORTED_TERMINAL_PROTOCOL')

    const unsupported = terminalClient(value.url, 'tab-unsupported', '2')
    unsupported.manager.reconnection(false)
    const error = await new Promise<Error>((resolve) =>
      unsupported.once('connect_error', resolve)
    )
    expect(error.message).toBe('UNSUPPORTED_TERMINAL_PROTOCOL')

    await closeClient(current)
    await closeClient(missing)
    await closeClient(unsupported)
  })

  it('does not finish attachment setup after a real pre-ready disconnect', async () => {
    const value = await fixture()
    let finishRefresh!: (terminal: TerminalRecord) => void
    vi.mocked(value.getTerminalForAttachment).mockReturnValueOnce(
      Effect.async<TerminalRecord>((resume) => {
        finishRefresh = (terminal) => resume(Effect.succeed(terminal))
      })
    )
    const closeAttachment = vi.spyOn(value.attachments, 'close')
    const socket = terminalClient(value.url)
    socket.manager.reconnection(false)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('connect_error', reject)
    })
    await vi.waitFor(() =>
      expect(value.getTerminalForAttachment).toHaveBeenCalledOnce()
    )

    socket.disconnect()
    await vi.waitFor(() => expect(closeAttachment).toHaveBeenCalledOnce())
    finishRefresh({
      id: 'term',
      worktreeId: 'wt',
      name: 'Terminal',
      argv: ['shell'],
      shellCommand: null,
      interactiveShell: false,
      status: 'running',
      exitCode: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    const probe = terminalClient(value.url, 'tab-probe')
    await new Promise<void>((resolve) => probe.once('ready', () => resolve()))
    expect(value.ptys).toHaveLength(1)
    await closeClient(socket)
    await closeClient(probe)
  })

  it('reconnects to the same hosted PTY with a fresh viewer stream', async () => {
    const value = await fixture()
    const socket = terminalClient(value.url)
    const readyEvents: Array<{
      streamId: string
      generation: number
      controller: boolean
    }> = []
    socket.on('ready', (ready) => readyEvents.push(ready))
    await vi.waitFor(() => expect(readyEvents).toHaveLength(1))
    expect(value.ptys).toHaveLength(1)
    await activateQueryAuthority(socket, readyEvents[0]!.generation)

    socket.volatile.emit('input', {
      generation: readyEvents[0]!.generation,
      data: 'before'
    })
    await vi.waitFor(() => expect(value.ptys[0]!.writes).toEqual(['before']))

    const disconnected = new Promise<void>((resolve) =>
      socket.once('disconnect', () => resolve())
    )
    value.closeConnections()
    await disconnected
    expect(socket.connected).toBe(false)
    socket.volatile.emit('input', {
      generation: readyEvents[0]!.generation,
      data: 'disconnected'
    })

    await vi.waitFor(() => expect(readyEvents).toHaveLength(2))

    expect(value.ptys).toHaveLength(1)
    expect(value.ptys[0]!.kills).toBe(0)
    expect(readyEvents[1]!.streamId).not.toBe(readyEvents[0]!.streamId)
    expect(value.ptys[0]!.writes).toEqual(['before'])
    await closeClient(socket)
  })

  it('rejects a missing terminal payload without crashing the daemon', async () => {
    const value = await fixture()
    const socket = terminalClient(value.url)
    socket.manager.reconnection(false)
    await new Promise<void>((resolve) => socket.once('ready', () => resolve()))

    // SAFETY: The test fixture provides the asserted contract used here.
    socket.emit('input', undefined as never)
    await vi.waitFor(() => expect(socket.connected).toBe(false))
    expect(value.ptys[0]!.kills).toBe(0)

    const probe = terminalClient(value.url, 'tab-probe')
    await new Promise<void>((resolve, reject) => {
      probe.once('ready', () => resolve())
      probe.once('connect_error', reject)
    })
    await closeClient(socket)
    await closeClient(probe)
  })

  it('enforces the WebSocket payload ceiling and cleans live viewers on shutdown', async () => {
    const value = await fixture()
    const socket = terminalClient(value.url)
    let generation = 0
    socket.on('ready', (ready) => {
      generation = ready.generation
    })
    await vi.waitFor(() => expect(generation).toBeGreaterThan(0))

    socket.manager.reconnection(false)
    socket.emit('input', {
      generation,
      data: 'x'.repeat(TERMINAL_TEST_OVERSIZED_BYTES)
    })
    await vi.waitFor(() => expect(socket.connected).toBe(false))
    expect(value.ptys[0]!.kills).toBe(0)

    const live = terminalClient(value.url, 'tab-b')
    await new Promise<void>((resolve) => live.once('ready', () => resolve()))
    await value.close()
    fixtures.splice(fixtures.indexOf(value), 1)
    await vi.waitFor(() => expect(live.connected).toBe(false))
    expect(value.ptys[0]!.kills).toBe(0)
    await closeClient(socket)
    await closeClient(live)
  })
})

const TERMINAL_TEST_OVERSIZED_BYTES = 160 * 1024
