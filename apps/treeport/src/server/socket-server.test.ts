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
  EventsClientToServerEvents,
  EventsServerToClientEvents,
  TerminalClientToServerEvents,
  TerminalRuntimeMetadata,
  TerminalServerToClientEvents
} from '@treeport/shared'
import { SOCKET_IO_PATH, TERMINAL_PROTOCOL_VERSION } from '@treeport/shared'
import { TerminalAttachmentManager } from './terminal-attachments'
import { createSocketServer } from './socket-server'
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

async function fixture(): Promise<NetworkFixture> {
  const events = new ProductEventBus()
  const ptys: FakePty[] = []
  const service = {
    events,
    listWebPanels: vi.fn(async () => []),
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
  } as unknown as TreeportService
  const tmux = {
    configureServer: vi.fn(async () => undefined),
    useManualWindowSize: vi.fn(async () => undefined),
    resizeWindow: vi.fn(async () => undefined),
    sessionSize: vi.fn(async () => ({ cols: 100, rows: 30 })),
    attachArgs: vi.fn(() => ['attach-session', '-t', 'session'])
  } as unknown as TmuxAdapter
  const currentMetadata: TerminalRuntimeMetadata = {
    terminalId: 'term',
    title: 'shell',
    progress: null,
    progressStartedAt: null,
    progressClearedAt: null,
    bell: null
  }
  const metadataSnapshot = vi.fn<() => TerminalRuntimeMetadata[]>(() => [
    currentMetadata
  ])
  const metadata = {
    initialize: vi.fn(async () => undefined),
    snapshot: metadataSnapshot,
    get: vi.fn(() => currentMetadata),
    trackTerminal: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined)
  } as unknown as TerminalMetadataManager
  const attachmentManager = new TerminalAttachmentManager(
    service,
    tmux,
    process.execPath,
    metadata,
    (() => {
      const value = new FakePty()
      ptys.push(value)
      return value as unknown as IPty
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
    runtimeDir: '/tmp',
    shell: '/bin/sh',
    tmuxPath: process.execPath,
    gitPath: 'git',
    ghPath: 'gh',
    apiUrl: 'http://127.0.0.1',
    daemonLifecycle: 'treeport'
  } satisfies AppConfig
  const { io, attachments } = createSocketServer(server, {
    service,
    config,
    tmux,
    terminalMetadata: metadata,
    attachmentManager
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
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
  options: Record<string, unknown> = {}
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
  terminalProtocol: string | null = String(TERMINAL_PROTOCOL_VERSION)
): Socket<TerminalServerToClientEvents, TerminalClientToServerEvents> {
  return createClient(`${url}/terminals`, {
    path: SOCKET_IO_PATH,
    transports: ['websocket'],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 10,
    ...(terminalProtocol === null ? {} : { query: { terminalProtocol } }),
    auth: { terminalId: 'term', clientId, cols: 100, rows: 30 }
  })
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
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      })
      return [
        {
          terminalId: 'term',
          title: 'snapshot',
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
      received.push(`event:${String(event.data.title)}`)
    })

    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received).toEqual(['snapshot:snapshot', 'event:incremental'])
    await closeClient(socket)
  })

  it('snapshots durable web panels and broadcasts closure to every client', async () => {
    const value = await fixture()
    vi.mocked(value.service.listWebPanels).mockResolvedValue([
      {
        id: 'panel_review',
        kind: 'web',
        worktreeId: 'wt',
        definitionId: 'project:review',
        title: 'Review',
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
    expect(snapshots.map((snapshot) => snapshot.webPanels[0]?.id)).toEqual([
      'panel_review',
      'panel_review'
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
        firstEvents.push(event.data as TerminalRuntimeMetadata)
      }
    })
    second.on('product_event', (event) => {
      if (event.type === 'terminal.metadata') {
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

  it('accepts direct and reverse-proxied local clients but rejects foreign browser origins', async () => {
    const value = await fixture()
    const allowed = eventClient(value.url, {
      extraHeaders: { Origin: value.url }
    })
    await new Promise<void>((resolve, reject) => {
      allowed.once('connect', () => resolve())
      allowed.once('connect_error', reject)
    })

    const proxied = eventClient(value.url, {
      extraHeaders: {
        Origin: 'https://feature.treeport.localhost',
        'X-Forwarded-Host': 'feature.treeport.localhost'
      }
    })
    await new Promise<void>((resolve, reject) => {
      proxied.once('connect', () => resolve())
      proxied.once('connect_error', reject)
    })

    const rejected = eventClient(value.url, {
      extraHeaders: { Origin: 'https://evil.example' }
    })
    const error = await new Promise<Error>((resolve) =>
      rejected.once('connect_error', resolve)
    )
    expect(error.message).toMatch(/websocket error/i)

    const originless = eventClient(value.url)
    await new Promise<void>((resolve, reject) => {
      originless.once('connect', () => resolve())
      originless.once('connect_error', reject)
    })
    await closeClient(allowed)
    await closeClient(proxied)
    await closeClient(rejected)
    await closeClient(originless)
  })

  it('negotiates exact terminal protocol modes and rejects unsupported versions', async () => {
    const value = await fixture()
    const current = terminalClient(value.url, 'tab-current')
    const currentReady = await new Promise<Record<string, unknown>>((resolve) =>
      current.once('ready', (payload) => resolve(payload))
    )
    expect(currentReady).toMatchObject({ cols: 100, rows: 30, revision: 1 })

    const legacy = terminalClient(value.url, 'tab-legacy', null)
    const legacyReady = await new Promise<Record<string, unknown>>((resolve) =>
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
    let finishRefresh!: (terminal: unknown) => void
    vi.mocked(value.service.refreshTerminalStatus).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRefresh = resolve
      }) as never
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
      tmuxSessionName: 'session',
      status: 'running',
      exitCode: null
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
