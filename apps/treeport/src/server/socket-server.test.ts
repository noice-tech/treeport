import http, { type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { io as createClient, type Socket } from 'socket.io-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import {
  ProductEventBus,
  type AppConfig,
  type TreeportService,
  type TmuxAdapter
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
  EventsClientToServerEvents,
  EventsServerToClientEvents,
  TerminalClientToServerEvents,
  TerminalRuntimeMetadata,
  TerminalReady,
  TerminalServerToClientEvents
} from '@treeport/shared'
import {
  BROWSER_PROTOCOL_VERSION,
  parseEventsSnapshot,
  SOCKET_IO_PATH,
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

class FakePty {
  readonly pid = 1
  readonly cols = 100
  readonly rows = 30
  readonly process = 'tmux'
  handleFlowControl = false
  kills = 0
  writes: Array<string | Buffer> = []
  private dataListener: ((data: string) => void) | null = null
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null
  onData = (listener: (data: string) => void) => {
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
    this.dataListener?.(data)
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
  ptys: FakePty[]
  service: TreeportService
  close(): Promise<void>
}

const fixtures: NetworkFixture[] = []

async function fixture(
  browserSessions?: BrowserSessionController
): Promise<NetworkFixture> {
  const events = new ProductEventBus()
  const ptys: FakePty[] = []
  // SAFETY: The test fixture provides the asserted contract used here.
  const service = testAccess<TreeportService>({
    events,
    listWebPanels: vi.fn(async () => []),
    listBrowserPanels: vi.fn(async () => []),
    refreshTerminalStatus: vi.fn(async () => ({
      id: 'term',
      worktreeId: 'wt',
      tmuxSessionName: 'session',
      status: 'running',
      exitCode: null
    })),
    getWorktree: vi.fn(async () => ({
      id: 'wt',
      path: '/tmp',
      tmuxSocketName: 'socket'
    }))
  })
  // SAFETY: The test fixture provides the asserted contract used here.
  const tmux = testAccess<TmuxAdapter>({
    configureServer: vi.fn(async () => undefined),
    useManualWindowSize: vi.fn(async () => undefined),
    resizeWindow: vi.fn(async () => undefined),
    sessionSize: vi.fn(async () => ({ cols: 100, rows: 30 })),
    attachArgs: vi.fn(() => ['attach-session', '-t', 'session'])
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
    initialize: vi.fn(async () => undefined),
    snapshot: metadataSnapshot,
    get: vi.fn(() => currentMetadata),
    trackTerminal: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    viewingHistory: vi.fn(() => false),
    subscribeHistory: vi.fn(() => () => undefined)
  })
  const attachmentManager = new TerminalAttachmentManager(
    service,
    tmux,
    process.execPath,
    metadata,
    // SAFETY: The test fixture provides the asserted contract used here.
    (() => {
      const value = new FakePty()
      ptys.push(value)
      // SAFETY: The test fixture provides the asserted contract used here.
      return testAccess<IPty>(value)
    }) as never
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
    tmuxPath: process.execPath,
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1',
    daemonLifecycle: 'treeport',
    webDevelopment: false
  } satisfies AppConfig
  const socketServerDependencies = {
    service,
    config,
    tmux,
    terminalMetadata: metadata,
    attachmentManager
  }
  const { io, attachments } = browserSessions
    ? createSocketServer(server, {
        ...socketServerDependencies,
        browserSessions
      })
    : createSocketServer(server, socketServerDependencies)
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
    ptys,
    service,
    close: () =>
      new Promise<void>((resolve) => {
        attachments.dispose()
        io.close(() => resolve())
      })
  }
  fixtures.push(value)
  return value
}

function eventClient(
  url: string,
  options: { extraHeaders?: Record<string, string> } = {}
): Socket<EventsServerToClientEvents, EventsClientToServerEvents> {
  return createClient(`${url}/events`, {
    path: SOCKET_IO_PATH,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...options
  })
}

function terminalClient(
  url: string,
  clientId = 'tab-a',
  terminalProtocol: string | null = String(TERMINAL_PROTOCOL_VERSION),
  options: { extraHeaders?: Record<string, string> } = {}
): Socket<TerminalServerToClientEvents, TerminalClientToServerEvents> {
  const clientOptions: NonNullable<Parameters<typeof createClient>[1]> = {
    path: SOCKET_IO_PATH,
    transports: ['websocket'],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 10,
    auth: { terminalId: 'term', clientId, cols: 100, rows: 30 },
    ...options
  }
  if (terminalProtocol !== null) {
    clientOptions.query = { terminalProtocol }
  }

  return createClient(`${url}/terminals`, clientOptions)
}

async function closeClient(socket: Socket): Promise<void> {
  socket.removeAllListeners()
  socket.disconnect()
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.close()
  }
})

describe('Socket.IO real network', () => {
  it('emits an authoritative snapshot before unrepresented ordered events', async () => {
    const value = await fixture()
    value.metadataSnapshot.mockImplementationOnce(() => {
      value.events.publish('terminal.metadata', {
        terminalId: 'term',
        title: 'snapshot',
        program: null,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      })
      return [
        {
          terminalId: 'term',
          title: 'snapshot',
          program: null,
          progress: null,
          progressStartedAt: null,
          progressClearedAt: null,
          bell: null
        }
      ]
    })
    const socket = eventClient(value.url)
    const received: string[] = []
    socket.on('snapshot', (snapshot) => {
      received.push(`snapshot:${snapshot.terminalMetadata[0]?.title}`)
      value.events.publish('terminal.metadata', {
        ...snapshot.terminalMetadata[0]!,
        title: 'incremental'
      })
    })
    socket.on('product_event', (event) => {
      if (event.type === 'terminal.metadata') {
        received.push(`event:${event.data.title}`)
      }
    })

    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received).toEqual(['snapshot:snapshot', 'event:incremental'])
    await closeClient(socket)
  })

  it('snapshots durable WebPanel and BrowserPanel records and broadcasts closure to every client', async () => {
    const value = await fixture()
    vi.mocked(value.service.listWebPanels).mockResolvedValue([
      {
        id: 'panel_review',
        kind: 'web',
        worktreeId: 'wt',
        definitionId: 'project:review',
        title: 'Review',
        launch: { input: null, cwd: null },
        permissions: [],
        sandbox: { allowSameOrigin: false },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
    vi.mocked(value.service.listBrowserPanels).mockResolvedValue([
      {
        id: 'panel_browser',
        kind: 'browser',
        worktreeId: 'wt',
        title: 'Example',
        url: 'https://example.com/',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
    const first = eventClient(value.url)
    const second = eventClient(value.url)
    const snapshots = await Promise.all(
      [first, second].map(
        (socket) =>
          new Promise<Parameters<EventsServerToClientEvents['snapshot']>[0]>(
            (resolve) => socket.once('snapshot', resolve)
          )
      )
    )
    expect(
      snapshots.map((snapshot) => parseEventsSnapshot(snapshot)?.webPanels[0])
    ).toEqual([
      expect.objectContaining({
        id: 'panel_review',
        sandbox: { allowSameOrigin: false }
      }),
      expect.objectContaining({
        id: 'panel_review',
        sandbox: { allowSameOrigin: false }
      })
    ])
    expect(
      snapshots.map(
        (snapshot) => parseEventsSnapshot(snapshot)?.browserPanels[0]
      )
    ).toEqual([
      expect.objectContaining({
        id: 'panel_browser',
        url: 'https://example.com/'
      }),
      expect.objectContaining({
        id: 'panel_browser',
        url: 'https://example.com/'
      })
    ])

    const closures = [first, second].map(
      (socket) =>
        new Promise<string>((resolve) =>
          socket.on('product_event', (event) => {
            if (event.type === 'panel.removed') {
              resolve(String(event.data.panelId))
            }
          })
        )
    )
    value.events.publish('panel.removed', {
      worktreeId: 'wt',
      panelId: 'panel_review'
    })
    await expect(Promise.all(closures)).resolves.toEqual([
      'panel_review',
      'panel_review'
    ])
    await Promise.all([closeClient(first), closeClient(second)])
  })

  it('broadcasts authoritative bell acknowledgement metadata to every client', async () => {
    const value = await fixture()
    const first = eventClient(value.url)
    const second = eventClient(value.url)
    const firstEvents: TerminalRuntimeMetadata[] = []
    const secondEvents: TerminalRuntimeMetadata[] = []
    first.on('product_event', (event) => {
      if (event.type === 'terminal.metadata') {
        // SAFETY: The test fixture provides the asserted contract used here.
        firstEvents.push(event.data as TerminalRuntimeMetadata)
      }
    })
    second.on('product_event', (event) => {
      if (event.type === 'terminal.metadata') {
        // SAFETY: The test fixture provides the asserted contract used here.
        secondEvents.push(event.data as TerminalRuntimeMetadata)
      }
    })
    await Promise.all([
      new Promise<void>((resolve) => first.once('snapshot', () => resolve())),
      new Promise<void>((resolve) => second.once('snapshot', () => resolve()))
    ])

    value.events.publish('terminal.metadata', {
      terminalId: 'term',
      title: 'shell',
      program: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 1,
        at: '2026-01-01T00:02:00.000Z',
        unread: false
      }
    })

    await vi.waitFor(() => {
      expect(firstEvents).toHaveLength(1)
      expect(secondEvents).toHaveLength(1)
    })
    expect(firstEvents[0]?.bell).toMatchObject({ sequence: 1, unread: false })
    expect(secondEvents[0]?.bell).toMatchObject({ sequence: 1, unread: false })
    await closeClient(first)
    await closeClient(second)
  })

  it('uses one-use browser authorization before relaying hosted browser commands', async () => {
    const messages: BrowserClientMessage[] = []
    const ownerMessages: BrowserOwnerClientMessage[] = []
    const closes: string[] = []
    const ownerCloses: string[] = []
    const browserSessions = {
      accept: vi.fn(async (ticket: string, transport: BrowserTransport) => {
        expect(ticket).toBe('b'.repeat(43))
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
        return 'browser-connection'
      }),
      message: vi.fn(
        (_connectionId: string, message: BrowserClientMessage) =>
          void messages.push(message)
      ),
      close: vi.fn((connectionId: string) => void closes.push(connectionId)),
      acceptOwner: vi.fn(async (auth, transport: BrowserOwnerTransport) => {
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
      }),
      ownerMessage: vi.fn(
        (_connectionId: string, message: BrowserOwnerClientMessage) =>
          void ownerMessages.push(message)
      ),
      closeOwner: vi.fn(
        (connectionId: string) => void ownerCloses.push(connectionId)
      )
    } satisfies BrowserSessionController
    const value = await fixture(browserSessions)
    const browser: Socket<
      BrowserServerToClientEvents,
      BrowserClientToServerEvents
    > = createClient(`${value.url}/browsers`, {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: {
        ticket: 'b'.repeat(43),
        protocolVersion: BROWSER_PROTOCOL_VERSION
      }
    })
    const ready = await new Promise<BrowserServerMessage>((resolve) =>
      browser.once('message', resolve)
    )
    expect(ready).toMatchObject({
      type: 'ready',
      state: { controlled: true, viewport: { width: 800, height: 600 } }
    })
    browser.emit('command', { type: 'back' })
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'back' }]))
    const socketId = browser.id!
    await closeClient(browser)
    await vi.waitFor(() => expect(closes).toEqual([socketId]))

    const owner: Socket<
      BrowserOwnerServerToClientEvents,
      BrowserOwnerClientToServerEvents
    > = createClient(`${value.url}/browser-owners`, {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: {
        ticket: 'o'.repeat(43),
        challenge: 'c'.repeat(43),
        endpoint: 'http://127.0.0.1:43210/private-owner/',
        protocolVersion: BROWSER_PROTOCOL_VERSION
      }
    })
    const claimed = await new Promise<BrowserOwnerServerMessage>((resolve) =>
      owner.once('ownerMessage', resolve)
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
        {
          type: 'popup',
          generation: 4,
          url: 'https://example.com/popup'
        }
      ])
    )
    const ownerSocketId = owner.id!
    await closeClient(owner)
    await vi.waitFor(() => expect(ownerCloses).toEqual([ownerSocketId]))
  })

  it('authenticates local and Tailscale clients before accepting either socket namespace', async () => {
    const value = await fixture()
    const local = eventClient(value.url, {
      extraHeaders: { Origin: value.url }
    })
    await new Promise<void>((resolve, reject) => {
      local.once('connect', () => resolve())
      local.once('connect_error', reject)
    })

    const tailscaleHeaders = {
      Origin: 'https://feature.treeport.localhost',
      'Tailscale-User-Login': 'developer@example.test',
      'X-Forwarded-Host': 'feature.treeport.localhost',
      'X-Forwarded-Proto': 'https'
    }
    const proxied = eventClient(value.url, {
      extraHeaders: tailscaleHeaders
    })
    await new Promise<void>((resolve, reject) => {
      proxied.once('connect', () => resolve())
      proxied.once('connect_error', reject)
    })

    const proxiedTerminal = terminalClient(
      value.url,
      'tab-proxied',
      String(TERMINAL_PROTOCOL_VERSION),
      { extraHeaders: tailscaleHeaders }
    )
    await new Promise<void>((resolve, reject) => {
      proxiedTerminal.once('ready', () => resolve())
      proxiedTerminal.once('connect_error', reject)
    })

    const bypassHeaders = {
      Host: 'feature.treeport.localhost',
      'X-Forwarded-Host': 'feature.treeport.localhost',
      'X-Forwarded-Proto': 'https'
    }
    const bypassedEvents = eventClient(value.url, {
      extraHeaders: bypassHeaders
    })
    const eventError = await new Promise<Error>((resolve) =>
      bypassedEvents.once('connect_error', resolve)
    )
    expect(eventError.message).toMatch(/websocket error/i)

    const bypassedTerminal = terminalClient(
      value.url,
      'tab-bypassed',
      String(TERMINAL_PROTOCOL_VERSION),
      { extraHeaders: bypassHeaders }
    )
    bypassedTerminal.io.reconnection(false)
    const terminalError = await new Promise<Error>((resolve) =>
      bypassedTerminal.once('connect_error', resolve)
    )
    expect(terminalError.message).toMatch(/websocket error/i)
    expect(value.service.refreshTerminalStatus).toHaveBeenCalledTimes(1)

    const foreignOrigin = eventClient(value.url, {
      extraHeaders: { ...tailscaleHeaders, Origin: 'https://evil.example' }
    })
    const originError = await new Promise<Error>((resolve) =>
      foreignOrigin.once('connect_error', resolve)
    )
    expect(originError.message).toMatch(/websocket error/i)

    const opaqueOrigin = eventClient(value.url, {
      extraHeaders: { ...tailscaleHeaders, Origin: 'null' }
    })
    const opaqueOriginError = await new Promise<Error>((resolve) =>
      opaqueOrigin.once('connect_error', resolve)
    )
    expect(opaqueOriginError.message).toMatch(/websocket error/i)

    const originless = eventClient(value.url)
    await new Promise<void>((resolve, reject) => {
      originless.once('connect', () => resolve())
      originless.once('connect_error', reject)
    })
    await Promise.all(
      [
        local,
        proxied,
        proxiedTerminal,
        bypassedEvents,
        bypassedTerminal,
        foreignOrigin,
        opaqueOrigin,
        originless
      ].map(closeClient)
    )
  })

  it('negotiates exact terminal protocol modes and rejects unsupported versions', async () => {
    const value = await fixture()
    const current = terminalClient(value.url, 'tab-current')
    const currentReady = await new Promise<TerminalReady>((resolve) =>
      current.once('ready', (payload) => resolve(payload))
    )
    expect(currentReady).toMatchObject({ cols: 100, rows: 30, revision: 1 })

    const legacy = terminalClient(value.url, 'tab-legacy', null)
    const legacyReady = await new Promise<TerminalReady>((resolve) =>
      legacy.once('ready', (payload) => resolve(payload))
    )
    expect(legacyReady).not.toHaveProperty('cols')
    expect(legacyReady).not.toHaveProperty('revision')

    const unsupported = terminalClient(value.url, 'tab-unsupported', '3')
    unsupported.io.reconnection(false)
    const error = await new Promise<Error>((resolve) =>
      unsupported.once('connect_error', resolve)
    )
    expect(error.message).toBe('UNSUPPORTED_TERMINAL_PROTOCOL')

    await closeClient(current)
    await closeClient(legacy)
    await closeClient(unsupported)
  })

  it('does not finish attachment setup after a real pre-ready disconnect', async () => {
    const value = await fixture()
    type RefreshedTerminal = Awaited<
      ReturnType<TreeportService['refreshTerminalStatus']>
    >
    let finishRefresh!: (terminal: RefreshedTerminal) => void
    vi.mocked(value.service.refreshTerminalStatus).mockReturnValueOnce(
      new Promise<RefreshedTerminal>((resolve) => {
        finishRefresh = resolve
      })
    )
    const closeAttachment = vi.spyOn(value.attachments, 'close')
    const socket = terminalClient(value.url)
    socket.io.reconnection(false)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('connect_error', reject)
    })
    await vi.waitFor(() =>
      expect(value.service.refreshTerminalStatus).toHaveBeenCalledOnce()
    )

    socket.disconnect()
    await vi.waitFor(() => expect(closeAttachment).toHaveBeenCalledOnce())
    finishRefresh({
      id: 'term',
      worktreeId: 'wt',
      name: 'Terminal',
      tmuxSessionName: 'session',
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

  it('reconnects with a fresh PTY and stream without replaying disconnected input', async () => {
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

    socket.volatile.emit('input', {
      generation: readyEvents[0]!.generation,
      data: 'before'
    })
    await vi.waitFor(() => expect(value.ptys[0]!.writes).toEqual(['before']))

    socket.io.engine?.close()
    await vi.waitFor(() => expect(socket.connected).toBe(false))
    if (socket.connected) {
      socket.volatile.emit('input', {
        generation: readyEvents[0]!.generation,
        data: 'disconnected'
      })
    }

    await vi.waitFor(() => expect(readyEvents).toHaveLength(2))

    expect(value.ptys).toHaveLength(2)
    expect(value.ptys[0]!.kills).toBe(1)
    expect(readyEvents[1]!.streamId).not.toBe(readyEvents[0]!.streamId)
    expect(value.ptys[1]!.writes).toHaveLength(0)
    await closeClient(socket)
  })

  it('rejects a missing terminal payload without crashing the daemon', async () => {
    const value = await fixture()
    const socket = terminalClient(value.url)
    socket.io.reconnection(false)
    await new Promise<void>((resolve) => socket.once('ready', () => resolve()))

    // SAFETY: The test fixture provides the asserted contract used here.
    socket.emit('input', undefined as never)
    await vi.waitFor(() => expect(socket.connected).toBe(false))
    expect(value.ptys[0]!.kills).toBe(1)

    const probe = eventClient(value.url)
    await new Promise<void>((resolve, reject) => {
      probe.once('connect', () => resolve())
      probe.once('connect_error', reject)
    })
    await closeClient(socket)
    await closeClient(probe)
  })

  it('enforces the Engine.IO payload ceiling and cleans live viewers on shutdown', async () => {
    const value = await fixture()
    const socket = terminalClient(value.url)
    let generation = 0
    socket.on('ready', (ready) => {
      generation = ready.generation
    })
    await vi.waitFor(() => expect(generation).toBeGreaterThan(0))

    socket.io.reconnection(false)
    socket.emit('input', {
      generation,
      data: 'x'.repeat(TERMINAL_TEST_OVERSIZED_BYTES)
    })
    await vi.waitFor(() => expect(socket.connected).toBe(false))
    expect(value.ptys[0]!.kills).toBe(1)

    const live = terminalClient(value.url, 'tab-b')
    await new Promise<void>((resolve) => live.once('ready', () => resolve()))
    await value.close()
    fixtures.splice(fixtures.indexOf(value), 1)
    await vi.waitFor(() => expect(live.connected).toBe(false))
    expect(value.ptys.at(-1)!.kills).toBe(1)
    await closeClient(socket)
    await closeClient(live)
  })
})

const TERMINAL_TEST_OVERSIZED_BYTES = 160 * 1024
