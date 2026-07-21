import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import type { WSContext } from 'hono/ws'
import type { TmuxAdapter, TaskTTYService } from '@tasktty/core'
import {
  TERMINAL_OUTPUT_HIGH_WATERMARK,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalServerMessage
} from '@tasktty/shared'
import { TerminalAttachmentManager } from './attachments.js'
import { TerminalMetadataManager } from './terminal-metadata.js'
import type {
  TerminalProgressObserver,
  TmuxProgressObserverOptions
} from './tmux-progress.js'

class FakePty {
  readonly pid = 1
  readonly cols = 100
  readonly rows = 30
  readonly process = 'tmux'
  handleFlowControl = false
  pauses = 0
  resumes = 0
  kills = 0
  writes: Array<string | Buffer> = []
  resizes: Array<[number, number]> = []
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
  pause() {
    this.pauses += 1
  }
  resume() {
    this.resumes += 1
  }
  kill() {
    this.kills += 1
  }
  write(data: string | Buffer) {
    this.writes.push(data)
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows])
  }
  clear() {}
}

class FakeProgressObserver implements TerminalProgressObserver {
  disposed = false

  constructor(readonly options: TmuxProgressObserverOptions) {}

  emit(progress: Parameters<TmuxProgressObserverOptions['onProgress']>[0]) {
    this.options.onProgress(progress)
  }

  exit() {
    this.options.onExit()
  }

  dispose() {
    this.disposed = true
  }
}

class FakeSocket {
  readyState = 1 as const
  sent: TerminalServerMessage[] = []
  closes: Array<[number | undefined, string | undefined]> = []
  failAfter: number | null = null
  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.failAfter !== null && this.sent.length >= this.failAfter) {
      throw new Error('send failed')
    }

    this.sent.push(JSON.parse(String(data)) as TerminalServerMessage)
  }
  close(code?: number, reason?: string) {
    this.closes.push([code, reason])
  }
}

const metadataManagers: TerminalMetadataManager[] = []

function fixture() {
  const ptys: FakePty[] = []
  const progressObservers: FakeProgressObserver[] = []
  const publish = vi.fn()
  const service = {
    refreshTerminalStatus: vi.fn(async () => ({
      id: 'term',
      worktreeId: 'wt',
      status: 'running',
      exitCode: null
    })),
    getWorktree: vi.fn(() => ({
      id: 'wt',
      path: '/tmp',
      tmuxSocketName: 'socket'
    })),
    events: { publish }
  } as unknown as TaskTTYService
  const tmux = {
    configPath: '/runtime/tmux.conf',
    configureServer: vi.fn(async () => undefined),
    sessionSize: vi.fn(async () => ({ cols: 100, rows: 30 })),
    sessionTitleState: vi.fn(async () => ({
      paneTitle: 'shell',
      currentCommand: 'zsh'
    })),
    attachArgs: vi.fn(() => ['attach-session', '-t', 'session'])
  } as unknown as TmuxAdapter
  const spawn = vi.fn(() => {
    const value = new FakePty()
    ptys.push(value)
    return value as unknown as IPty
  })
  const createProgressObserver = vi.fn(
    (options: TmuxProgressObserverOptions) => {
      const observer = new FakeProgressObserver(options)
      progressObservers.push(observer)
      return observer
    }
  )
  const metadata = new TerminalMetadataManager(
    service,
    tmux,
    process.execPath,
    createProgressObserver
  )
  metadataManagers.push(metadata)
  const manager = new TerminalAttachmentManager(
    service,
    tmux,
    process.execPath,
    metadata,
    spawn as never
  )
  return { manager, metadata, progressObservers, ptys, publish, tmux }
}

const hello = (clientId: string) =>
  JSON.stringify({
    version: TERMINAL_PROTOCOL_VERSION,
    type: 'hello',
    clientId,
    cols: 100,
    rows: 30
  })

async function ready(socket: FakeSocket) {
  await vi.waitFor(() =>
    expect(socket.sent.some((message) => message.type === 'ready')).toBe(true)
  )
}

afterEach(() => {
  for (const metadata of metadataManagers.splice(0)) {
    metadata.dispose()
  }
  vi.useRealTimers()
})

describe('TerminalAttachmentManager', () => {
  it('reapplies tmux server configuration before reading or attaching the session', async () => {
    const { manager, tmux } = fixture()
    const socket = new FakeSocket()
    manager.message(
      manager.accept('term', socket as unknown as WSContext),
      hello('tab-a')
    )
    await ready(socket)
    expect(tmux.configureServer).toHaveBeenCalledWith('socket')
    expect(
      vi.mocked(tmux.configureServer).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(tmux.sessionSize).mock.invocationCallOrder[0]!)
    expect(
      vi.mocked(tmux.configureServer).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(tmux.attachArgs).mock.invocationCallOrder[0]!)
  })

  it('requires hello, sends ready before output, and applies ACK backpressure', async () => {
    const { manager, ptys } = fixture()
    const socket = new FakeSocket()
    const id = manager.accept('term', socket as unknown as WSContext)
    manager.message(id, hello('tab-a'))
    await ready(socket)
    const pty = ptys[0]!
    pty.emit('x'.repeat(TERMINAL_OUTPUT_HIGH_WATERMARK))
    const output = socket.sent.find((message) => message.type === 'output')
    expect(socket.sent[0]?.type).toBe('ready')
    expect(socket.sent[0]).not.toHaveProperty('controllerClientId')
    expect(output?.type).toBe('output')
    expect(pty.pauses).toBeGreaterThanOrEqual(2)
    if (output?.type === 'output') {
      manager.message(
        id,
        JSON.stringify({
          version: TERMINAL_PROTOCOL_VERSION,
          type: 'output_ack',
          streamId: output.streamId,
          sequence: output.sequence
        })
      )
    }

    expect(pty.resumes).toBeGreaterThanOrEqual(2)
    manager.close(id)
    expect(pty.kills).toBe(1)
  })

  it('announces an empty title so clients can clear stale runtime titles', async () => {
    const { manager, tmux } = fixture()
    vi.mocked(tmux.sessionTitleState).mockResolvedValueOnce(null)
    const socket = new FakeSocket()
    const id = manager.accept('term', socket as unknown as WSContext)
    manager.message(id, hello('tab-a'))
    await ready(socket)
    expect(socket.sent).toContainEqual({
      version: TERMINAL_PROTOCOL_VERSION,
      type: 'title',
      title: ''
    })
  })

  it('fans daemon-owned progress out to every viewer and caches it for new viewers', async () => {
    const { manager, metadata, progressObservers } = fixture()
    const first = new FakeSocket()
    const firstId = manager.accept('term', first as unknown as WSContext)
    manager.message(firstId, hello('tab-a'))
    await ready(first)

    expect(progressObservers).toHaveLength(1)
    expect(progressObservers[0]!.options.args).toContain('-r')
    expect(progressObservers[0]!.options.args).not.toContain('refresh-client')
    progressObservers[0]!.emit({ state: 'indeterminate', value: null })
    expect(first.sent.at(-1)).toMatchObject({
      type: 'progress',
      progress: { state: 'indeterminate', value: null }
    })

    const viewer = new FakeSocket()
    const viewerId = manager.accept('term', viewer as unknown as WSContext)
    manager.message(viewerId, hello('tab-b'))
    await ready(viewer)
    expect(progressObservers).toHaveLength(1)
    expect(viewer.sent).toContainEqual({
      version: TERMINAL_PROTOCOL_VERSION,
      type: 'progress',
      progress: { state: 'indeterminate', value: null }
    })

    progressObservers[0]!.emit(null)
    expect(first.sent.at(-1)).toMatchObject({
      type: 'progress',
      progress: null
    })
    expect(viewer.sent.at(-1)).toMatchObject({
      type: 'progress',
      progress: null
    })

    manager.close(firstId)
    expect(progressObservers[0]!.disposed).toBe(false)
    manager.close(viewerId)
    expect(progressObservers[0]!.disposed).toBe(false)
    metadata.dispose()
    expect(progressObservers[0]!.disposed).toBe(true)
  })

  it('clears progress if the observer exits without disrupting terminal output', async () => {
    const { manager, progressObservers, ptys } = fixture()
    const socket = new FakeSocket()
    const id = manager.accept('term', socket as unknown as WSContext)
    manager.message(id, hello('tab-a'))
    await ready(socket)

    progressObservers[0]!.emit({ state: 'normal', value: 25 })
    progressObservers[0]!.exit()
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'progress',
      progress: null
    })

    ptys[0]!.emit('still attached')
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'output',
      data: 'still attached'
    })
    manager.close(id)
  })

  it('extends the stall deadline when acknowledgements make progress', async () => {
    const { manager, ptys } = fixture()
    const socket = new FakeSocket()
    const id = manager.accept('term', socket as unknown as WSContext)
    manager.message(id, hello('tab-a'))
    await ready(socket)
    vi.useFakeTimers()
    const pty = ptys[0]!
    pty.emit('a'.repeat(200 * 1024))
    pty.emit('b'.repeat(200 * 1024))
    const outputs = socket.sent.filter((message) => message.type === 'output')
    expect(outputs).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(20_000)
    const first = outputs[0]!
    if (first.type === 'output') {
      manager.message(
        id,
        JSON.stringify({
          version: TERMINAL_PROTOCOL_VERSION,
          type: 'output_ack',
          streamId: first.streamId,
          sequence: first.sequence
        })
      )
    }

    await vi.advanceTimersByTimeAsync(20_000)
    expect(socket.closes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(socket.closes.at(-1)?.[1]).toContain('stalled')
  })

  it('does not continue initialization after a send failure', async () => {
    const { manager, ptys } = fixture()
    const socket = new FakeSocket()
    socket.failAfter = 1
    const id = manager.accept('term', socket as unknown as WSContext)
    manager.message(id, hello('tab-a'))
    await vi.waitFor(() => expect(ptys).toHaveLength(1))
    await vi.waitFor(() => expect(ptys[0]!.kills).toBe(1))
    expect(ptys[0]!.resumes).toBe(0)
    manager.close(id)
  })

  it('rejects oversized frames before parsing', () => {
    const { manager } = fixture()
    const socket = new FakeSocket()
    manager.message(
      manager.accept('term', socket as unknown as WSContext),
      'x'.repeat(128 * 1024 + 1)
    )
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'error',
      code: 'MESSAGE_TOO_LARGE'
    })
    expect(socket.closes.at(-1)?.[0]).toBe(1009)
  })

  it('preserves binary input bytes for the controller', async () => {
    const { manager, ptys } = fixture()
    const socket = new FakeSocket()
    const id = manager.accept('term', socket as unknown as WSContext)
    manager.message(id, hello('tab-a'))
    await ready(socket)
    manager.message(
      id,
      JSON.stringify({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'binary',
        data: '\0ÿ'
      })
    )
    expect(Buffer.isBuffer(ptys[0]!.writes[0])).toBe(true)
    expect((ptys[0]!.writes[0] as Buffer).equals(Buffer.from([0, 255]))).toBe(
      true
    )
    manager.close(id)
  })

  it('does not expose the reconnect credential in controller events', async () => {
    const { manager, publish } = fixture()
    const first = new FakeSocket()
    const viewer = new FakeSocket()
    const firstId = manager.accept('term', first as unknown as WSContext)
    manager.message(firstId, hello('tab-secret-a'))
    await ready(first)
    const viewerId = manager.accept('term', viewer as unknown as WSContext)
    manager.message(viewerId, hello('tab-secret-b'))
    await ready(viewer)
    manager.message(
      viewerId,
      JSON.stringify({
        version: TERMINAL_PROTOCOL_VERSION,
        type: 'take_control'
      })
    )

    const eventData = publish.mock.calls.at(-1)?.[1]
    expect(eventData).toEqual({ terminalId: 'term', controlled: true })
    expect(JSON.stringify(eventData)).not.toContain('tab-secret')
    manager.close(firstId)
    manager.close(viewerId)
  })

  it('restores controller ownership to the same tab during reconnect grace', async () => {
    const { manager } = fixture()
    const first = new FakeSocket()
    const viewer = new FakeSocket()
    const firstId = manager.accept('term', first as unknown as WSContext)
    manager.message(firstId, hello('tab-a'))
    await ready(first)
    const viewerId = manager.accept('term', viewer as unknown as WSContext)
    manager.message(viewerId, hello('tab-b'))
    await ready(viewer)
    manager.close(firstId)
    const reconnect = new FakeSocket()
    const reconnectId = manager.accept(
      'term',
      reconnect as unknown as WSContext
    )
    manager.message(reconnectId, hello('tab-a'))
    await ready(reconnect)
    const readyMessage = reconnect.sent.find(
      (message) => message.type === 'ready'
    )
    expect(readyMessage?.type === 'ready' && readyMessage.controller).toBe(true)
    manager.close(viewerId)
    manager.close(reconnectId)
  })
})
