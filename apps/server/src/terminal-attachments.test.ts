import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import type { TmuxAdapter, TaskTTYService } from '@tasktty/core'
import {
  TERMINAL_OUTPUT_HIGH_WATERMARK,
  TERMINAL_OUTPUT_STALL_TIMEOUT_MS,
  type TerminalServerEvent,
  type TerminalServerPayload
} from '@tasktty/shared'
import {
  TerminalAttachmentManager,
  type TerminalTransport
} from './terminal-attachments.js'
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
  dataDisposals = 0
  exitDisposals = 0
  writes: Array<string | Buffer> = []
  resizes: Array<[number, number]> = []
  writeError: Error | null = null
  onDataError: Error | null = null
  onExitError: Error | null = null
  private dataListener: ((data: string) => void) | null = null
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null
  onData = (listener: (data: string) => void) => {
    if (this.onDataError) {
      throw this.onDataError
    }

    this.dataListener = listener
    return {
      dispose: () => {
        this.dataDisposals += 1
        this.dataListener = null
      }
    }
  }
  onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void
  ) => {
    if (this.onExitError) {
      throw this.onExitError
    }

    this.exitListener = listener
    return {
      dispose: () => {
        this.exitDisposals += 1
        this.exitListener = null
      }
    }
  }
  emit(data: string) {
    this.dataListener?.(data)
  }
  exit(exitCode: number) {
    this.exitListener?.({ exitCode })
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
    if (this.writeError) {
      throw this.writeError
    }

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

  dispose() {
    this.disposed = true
  }
}

class FakeTransport implements TerminalTransport {
  private static serial = 0
  readonly id = `socket-${++FakeTransport.serial}`
  connected = true
  sent: Array<{ type: TerminalServerEvent } & Record<string, unknown>> = []
  disconnects: boolean[] = []
  failAfter: number | null = null

  isConnected(): boolean {
    return this.connected
  }

  send(event: TerminalServerEvent, payload: TerminalServerPayload): boolean {
    if (
      !this.connected ||
      (this.failAfter !== null && this.sent.length >= this.failAfter)
    ) {
      return false
    }

    this.sent.push({ type: event, ...payload })
    return true
  }

  disconnect(retryable: boolean): void {
    this.disconnects.push(retryable)
    this.connected = false
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
      tmuxSessionName: 'session',
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
    useManualWindowSize: vi.fn(async () => undefined),
    resizeWindow: vi.fn(async () => undefined),
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
  return {
    manager,
    metadata,
    progressObservers,
    ptys,
    publish,
    service,
    spawn,
    tmux
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function attach(
  manager: TerminalAttachmentManager,
  transport: FakeTransport,
  clientId: string,
  protocolVersion: 1 | 2 = 2
): string {
  return manager.accept(
    { terminalId: 'term', clientId, cols: 100, rows: 30 },
    transport,
    protocolVersion
  )
}

async function ready(transport: FakeTransport) {
  await vi.waitFor(() =>
    expect(transport.sent.some((message) => message.type === 'ready')).toBe(
      true
    )
  )
  return transport.sent.find((message) => message.type === 'ready')!
}

afterEach(() => {
  for (const metadata of metadataManagers.splice(0)) {
    metadata.dispose()
  }
  vi.useRealTimers()
})

describe('TerminalAttachmentManager', () => {
  it('configures tmux, announces a fresh stream before output, and ACKs consumption', async () => {
    const { manager, ptys, tmux } = fixture()
    const transport = new FakeTransport()
    const id = attach(manager, transport, 'tab-a')
    const readyMessage = await ready(transport)

    expect(tmux.configureServer).toHaveBeenCalledWith('socket')
    expect(
      vi.mocked(tmux.configureServer).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(tmux.sessionSize).mock.invocationCallOrder[0]!)
    expect(readyMessage).toMatchObject({
      type: 'ready',
      reset: 'full',
      controller: true,
      generation: 1,
      cols: 100,
      rows: 30,
      revision: 1
    })

    const pty = ptys[0]!
    pty.emit('x'.repeat(TERMINAL_OUTPUT_HIGH_WATERMARK))
    const output = transport.sent.find((message) => message.type === 'output')!
    expect(transport.sent[0]?.type).toBe('ready')
    expect(pty.pauses).toBeGreaterThanOrEqual(2)
    manager.message(id, 'output_ack', {
      streamId: output.streamId,
      sequence: output.sequence
    })
    expect(pty.resumes).toBeGreaterThanOrEqual(2)
  })

  it('serves exact legacy ready and takeover contracts without dimensions events', async () => {
    const { manager, tmux } = fixture()
    const controller = new FakeTransport()
    attach(manager, controller, 'tab-a')
    await ready(controller)
    const legacy = new FakeTransport()
    const legacyId = attach(manager, legacy, 'tab-b', 1)
    const legacyReady = await ready(legacy)

    expect(legacyReady).toMatchObject({ type: 'ready', reset: 'full' })
    expect(legacyReady).not.toHaveProperty('cols')
    expect(legacyReady).not.toHaveProperty('rows')
    expect(legacyReady).not.toHaveProperty('revision')

    manager.message(legacyId, 'take_control', { generation: 1 })
    await vi.waitFor(() =>
      expect(legacy.sent.at(-1)).toMatchObject({
        type: 'control',
        controller: true,
        generation: 2
      })
    )
    manager.message(legacyId, 'resize', {
      generation: 2,
      cols: 120,
      rows: 40
    })
    await vi.waitFor(() =>
      expect(tmux.resizeWindow).toHaveBeenCalledWith(
        'socket',
        'session',
        120,
        40
      )
    )
    expect(legacy.sent.some((message) => message.type === 'dimensions')).toBe(
      false
    )
  })

  it('rejects dimensionless takeover from a negotiated v2 client', async () => {
    const { manager } = fixture()
    const transport = new FakeTransport()
    const id = attach(manager, transport, 'tab-a')
    await ready(transport)

    manager.message(id, 'take_control', { generation: 1 })

    expect(transport.sent.at(-1)).toMatchObject({
      type: 'terminal_error',
      code: 'INVALID_MESSAGE'
    })
    expect(transport.disconnects).toEqual([false])
  })

  it('validates tmux dimensions and applies fallback dimensions before ready', async () => {
    const invalid = fixture()
    vi.mocked(invalid.tmux.sessionSize).mockResolvedValueOnce({
      cols: 1_001,
      rows: 30
    })
    const invalidTransport = new FakeTransport()
    attach(invalid.manager, invalidTransport, 'tab-invalid')
    await vi.waitFor(() =>
      expect(invalidTransport.sent.at(-1)).toMatchObject({
        type: 'terminal_error',
        code: 'ATTACH_FAILED',
        retryable: false
      })
    )
    expect(invalid.ptys).toHaveLength(0)

    const fallback = fixture()
    vi.mocked(fallback.tmux.sessionSize).mockResolvedValueOnce(null)
    const fallbackTransport = new FakeTransport()
    attach(fallback.manager, fallbackTransport, 'tab-fallback')
    await ready(fallbackTransport)
    expect(fallback.tmux.resizeWindow).toHaveBeenCalledWith(
      'socket',
      'session',
      100,
      30
    )
    expect(
      vi.mocked(fallback.tmux.resizeWindow).mock.invocationCallOrder[0]
    ).toBeLessThan(fallback.spawn.mock.invocationCallOrder[0]!)
  })

  it('does not cache or spawn after fallback resize failure and allows retry', async () => {
    const { manager, ptys, tmux } = fixture()
    vi.mocked(tmux.sessionSize).mockResolvedValue(null)
    vi.mocked(tmux.resizeWindow)
      .mockRejectedValueOnce(new Error('resize unavailable'))
      .mockResolvedValueOnce(undefined)
    const failed = new FakeTransport()
    attach(manager, failed, 'tab-failed')
    await vi.waitFor(() =>
      expect(failed.sent.at(-1)).toMatchObject({
        type: 'terminal_error',
        code: 'ATTACH_FAILED'
      })
    )
    expect(ptys).toHaveLength(0)

    const retry = new FakeTransport()
    attach(manager, retry, 'tab-retry')
    await ready(retry)
    expect(tmux.resizeWindow).toHaveBeenCalledTimes(2)
    expect(ptys).toHaveLength(1)
  })

  it('fans daemon metadata to every viewer without making it terminal output authority', async () => {
    const { manager, progressObservers, tmux } = fixture()
    vi.mocked(tmux.sessionTitleState).mockResolvedValueOnce(null)
    const first = new FakeTransport()
    const second = new FakeTransport()
    attach(manager, first, 'tab-a')
    await ready(first)
    attach(manager, second, 'tab-b')
    await ready(second)

    expect(first.sent).toContainEqual({ type: 'title', title: '' })
    expect(progressObservers).toHaveLength(1)
    progressObservers[0]!.emit({ state: 'indeterminate', value: null })
    expect(first.sent.at(-1)).toMatchObject({
      type: 'progress',
      progress: { state: 'indeterminate', value: null }
    })
    expect(second.sent.at(-1)).toMatchObject({
      type: 'progress',
      progress: { state: 'indeterminate', value: null }
    })
  })

  it('isolates a slow viewer and keeps another viewer consuming output', async () => {
    const { manager, ptys } = fixture()
    const slow = new FakeTransport()
    const fast = new FakeTransport()
    attach(manager, slow, 'tab-a')
    await ready(slow)
    const fastId = attach(manager, fast, 'tab-b')
    await ready(fast)
    vi.useFakeTimers()

    ptys[0]!.emit('s'.repeat(TERMINAL_OUTPUT_HIGH_WATERMARK))
    ptys[1]!.emit('fast')
    const fastOutput = fast.sent.find((message) => message.type === 'output')!
    manager.message(fastId, 'output_ack', {
      streamId: fastOutput.streamId,
      sequence: fastOutput.sequence
    })

    expect(ptys[0]!.pauses).toBeGreaterThan(ptys[1]!.pauses)
    await vi.advanceTimersByTimeAsync(TERMINAL_OUTPUT_STALL_TIMEOUT_MS)
    expect(slow.disconnects).toEqual([true])
    expect(ptys[0]!.kills).toBe(1)
    expect(fast.connected).toBe(true)
    expect(ptys[1]!.kills).toBe(0)
  })

  it('broadcasts canonical dimensions before resizing every active attachment and tmux', async () => {
    const { manager, ptys, tmux } = fixture()
    const controller = new FakeTransport()
    const viewer = new FakeTransport()
    const controllerId = attach(manager, controller, 'tab-a')
    await ready(controller)
    attach(manager, viewer, 'tab-b')
    await ready(viewer)

    manager.message(controllerId, 'resize', {
      generation: 1,
      cols: 132,
      rows: 47
    })

    await vi.waitFor(() =>
      expect(tmux.resizeWindow).toHaveBeenCalledWith(
        'socket',
        'session',
        132,
        47
      )
    )
    expect(ptys.map((pty) => pty.resizes)).toEqual([[[132, 47]], [[132, 47]]])
    expect(controller.sent).toContainEqual({
      type: 'dimensions',
      cols: 132,
      rows: 47,
      revision: 2
    })
    expect(viewer.sent).toContainEqual({
      type: 'dimensions',
      cols: 132,
      rows: 47,
      revision: 2
    })
  })

  it('queues input behind an in-flight canonical resize', async () => {
    const { manager, ptys, tmux } = fixture()
    let finishResize!: () => void
    vi.mocked(tmux.resizeWindow).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishResize = resolve
        })
    )
    const controller = new FakeTransport()
    const controllerId = attach(manager, controller, 'tab-a')
    await ready(controller)

    manager.message(controllerId, 'resize', {
      generation: 1,
      cols: 120,
      rows: 40
    })
    await vi.waitFor(() => expect(tmux.resizeWindow).toHaveBeenCalledOnce())
    manager.message(controllerId, 'input', {
      generation: 1,
      data: 'after resize'
    })

    await Promise.resolve()
    expect(ptys[0]!.writes).toEqual([])
    finishResize()
    await vi.waitFor(() => expect(ptys[0]!.writes).toEqual(['after resize']))
  })

  it('bounds queued input by message count and bytes during a stalled resize', async () => {
    const countFixture = fixture()
    let finishCountResize!: () => void
    vi.mocked(countFixture.tmux.resizeWindow).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCountResize = resolve
        })
    )
    const countTransport = new FakeTransport()
    const countId = attach(countFixture.manager, countTransport, 'tab-count')
    await ready(countTransport)
    countFixture.manager.message(countId, 'resize', {
      generation: 1,
      cols: 120,
      rows: 40
    })
    await vi.waitFor(() =>
      expect(countFixture.tmux.resizeWindow).toHaveBeenCalledOnce()
    )
    for (let index = 0; index < 257; index += 1) {
      countFixture.manager.message(countId, 'input', {
        generation: 1,
        data: ''
      })
    }
    expect(countTransport.sent.at(-1)).toMatchObject({
      type: 'terminal_error',
      code: 'INPUT_QUEUE_FULL',
      retryable: false
    })
    expect(countTransport.disconnects).toEqual([false])
    finishCountResize()

    const byteFixture = fixture()
    let finishByteResize!: () => void
    vi.mocked(byteFixture.tmux.resizeWindow).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishByteResize = resolve
        })
    )
    const byteTransport = new FakeTransport()
    const byteId = attach(byteFixture.manager, byteTransport, 'tab-bytes')
    await ready(byteTransport)
    byteFixture.manager.message(byteId, 'resize', {
      generation: 1,
      cols: 120,
      rows: 40
    })
    await vi.waitFor(() =>
      expect(byteFixture.tmux.resizeWindow).toHaveBeenCalledOnce()
    )
    for (let index = 0; index < 17; index += 1) {
      byteFixture.manager.message(byteId, 'input', {
        generation: 1,
        data: 'x'.repeat(64 * 1024)
      })
    }
    expect(byteTransport.sent.at(-1)).toMatchObject({
      type: 'terminal_error',
      code: 'INPUT_QUEUE_FULL'
    })
    finishByteResize()
  })

  it('translates an unexpected PTY input failure into a retryable boundary', async () => {
    const { manager, ptys } = fixture()
    const transport = new FakeTransport()
    const id = attach(manager, transport, 'tab-a')
    await ready(transport)
    ptys[0]!.writeError = new Error('pty write failed')

    manager.message(id, 'input', { generation: 1, data: 'x' })

    await vi.waitFor(() =>
      expect(transport.sent.at(-1)).toMatchObject({
        type: 'terminal_error',
        code: 'INPUT_FAILED',
        retryable: true
      })
    )
    expect(transport.disconnects).toEqual([true])
  })

  it('reconnects a paused viewer before a canonical grid boundary', async () => {
    const { manager, ptys, tmux } = fixture()
    const controller = new FakeTransport()
    const viewer = new FakeTransport()
    const controllerId = attach(manager, controller, 'tab-a')
    await ready(controller)
    attach(manager, viewer, 'tab-b')
    await ready(viewer)
    ptys[1]!.emit('x'.repeat(TERMINAL_OUTPUT_HIGH_WATERMARK))

    manager.message(controllerId, 'resize', {
      generation: 1,
      cols: 120,
      rows: 40
    })

    await vi.waitFor(() => expect(tmux.resizeWindow).toHaveBeenCalled())
    expect(viewer.disconnects).toEqual([true])
    expect(ptys[1]!.kills).toBe(1)
    expect(ptys[1]!.resizes).toEqual([])
    expect(ptys[0]!.resizes).toEqual([[120, 40]])
  })

  it('extends a stalled viewer deadline only when ACK progress is made', async () => {
    const { manager, ptys } = fixture()
    const transport = new FakeTransport()
    const id = attach(manager, transport, 'tab-a')
    await ready(transport)
    vi.useFakeTimers()
    ptys[0]!.emit('a'.repeat(200 * 1024))
    ptys[0]!.emit('b'.repeat(200 * 1024))
    const outputs = transport.sent.filter(
      (message) => message.type === 'output'
    )

    await vi.advanceTimersByTimeAsync(20_000)
    manager.message(id, 'output_ack', {
      streamId: outputs[0]!.streamId,
      sequence: outputs[0]!.sequence
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(transport.disconnects).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(transport.disconnects).toEqual([true])
  })

  it('enforces packet and UTF-8 input byte limits before writing to tmux', async () => {
    const { manager, ptys } = fixture()
    const oversizedPacket = new FakeTransport()
    const firstId = attach(manager, oversizedPacket, 'tab-a')
    await ready(oversizedPacket)
    manager.message(firstId, 'input', {
      generation: 1,
      data: 'x'.repeat(128 * 1024 + 1)
    })
    expect(oversizedPacket.sent.at(-1)).toMatchObject({
      type: 'terminal_error',
      code: 'MESSAGE_TOO_LARGE'
    })

    const multibyte = new FakeTransport()
    const secondId = attach(manager, multibyte, 'tab-b')
    await ready(multibyte)
    manager.message(secondId, 'take_control', {
      generation: 1,
      cols: 100,
      rows: 30
    })
    const control = multibyte.sent.at(-1)!
    manager.message(secondId, 'input', {
      generation: control.generation,
      data: '💥'.repeat(20_000)
    })
    expect(multibyte.sent.at(-1)).toMatchObject({
      type: 'terminal_error',
      code: 'INVALID_MESSAGE'
    })
    expect(ptys[1]!.writes).toHaveLength(0)
  })

  it('preserves binary bytes and rejects stale controller generations', async () => {
    const { manager, ptys, publish } = fixture()
    const first = new FakeTransport()
    const viewer = new FakeTransport()
    const firstId = attach(manager, first, 'tab-secret-a')
    const firstReady = await ready(first)
    const viewerId = attach(manager, viewer, 'tab-secret-b')
    await ready(viewer)

    manager.message(viewerId, 'take_control', {
      generation: 0,
      cols: 100,
      rows: 30
    })
    expect(viewer.sent.at(-1)).toMatchObject({
      type: 'control',
      controller: false,
      generation: firstReady.generation
    })
    manager.message(viewerId, 'take_control', {
      generation: firstReady.generation,
      cols: 120,
      rows: 40
    })
    await vi.waitFor(() =>
      expect(viewer.sent.at(-1)).toMatchObject({
        type: 'control',
        controller: true,
        generation: 2
      })
    )
    const viewerControl = viewer.sent.at(-1)!

    manager.message(firstId, 'input', { generation: 1, data: 'stale' })
    manager.message(viewerId, 'binary', {
      generation: viewerControl.generation,
      data: '\0ÿ'
    })
    await vi.waitFor(() => expect(ptys[1]!.writes).toHaveLength(1))
    expect(ptys[0]!.writes).toHaveLength(0)
    expect(Buffer.isBuffer(ptys[1]!.writes[0])).toBe(true)
    expect((ptys[1]!.writes[0] as Buffer).equals(Buffer.from([0, 255]))).toBe(
      true
    )
    const eventData = publish.mock.calls.at(-1)?.[1]
    expect(eventData).toEqual({ terminalId: 'term', controlled: true })
    expect(JSON.stringify(eventData)).not.toContain('tab-secret')
  })

  it('does not publish stale control after a takeover disconnects during resize', async () => {
    const { manager, publish, tmux } = fixture()
    const controller = new FakeTransport()
    const viewer = new FakeTransport()
    attach(manager, controller, 'tab-a')
    await ready(controller)
    const viewerId = attach(manager, viewer, 'tab-b')
    await ready(viewer)
    publish.mockClear()
    let finishResize!: () => void
    vi.mocked(tmux.resizeWindow).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishResize = resolve
        })
    )

    manager.message(viewerId, 'take_control', {
      generation: 1,
      cols: 120,
      rows: 40
    })
    await vi.waitFor(() => expect(tmux.resizeWindow).toHaveBeenCalledOnce())
    manager.close(viewerId)
    finishResize()
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith('terminal.controller_changed', {
        terminalId: 'term',
        controlled: false
      })
    )
    expect(
      publish.mock.calls.some(([, data]) => data.controlled === true)
    ).toBe(false)
  })

  it('reclaims control with a fresh PTY and stream during same-tab reconnect grace', async () => {
    const { manager, ptys } = fixture()
    const first = new FakeTransport()
    const firstId = attach(manager, first, 'tab-a')
    const initialReady = await ready(first)
    manager.close(firstId)

    const reconnect = new FakeTransport()
    const reconnectId = attach(manager, reconnect, 'tab-a')
    const reconnectReady = await ready(reconnect)
    expect(reconnectReady).toMatchObject({
      type: 'ready',
      controller: true,
      generation: initialReady.generation
    })
    expect(reconnectReady.streamId).not.toBe(initialReady.streamId)
    expect(ptys).toHaveLength(2)
    expect(ptys[0]!.kills).toBe(1)

    ptys[0]!.emit('old output')
    expect(
      reconnect.sent.some((message) => message.data === 'old output')
    ).toBe(false)
    manager.close(reconnectId)
  })

  it('abandons every pending initialization phase after close, including late promise completion', async () => {
    const phases = [
      'refresh',
      'configure',
      'metadata',
      'manual-size',
      'session-size',
      'fallback-resize'
    ] as const

    for (const phase of phases) {
      const value = fixture()
      const pending = deferred<unknown>()
      if (phase === 'refresh') {
        vi.mocked(value.service.refreshTerminalStatus).mockReturnValueOnce(
          pending.promise as never
        )
      } else if (phase === 'configure') {
        vi.mocked(value.tmux.configureServer).mockReturnValueOnce(
          pending.promise as Promise<void>
        )
      } else if (phase === 'metadata') {
        vi.spyOn(value.metadata, 'trackTerminal').mockReturnValueOnce(
          pending.promise as Promise<void>
        )
      } else if (phase === 'manual-size') {
        vi.mocked(value.tmux.useManualWindowSize).mockReturnValueOnce(
          pending.promise as Promise<void>
        )
      } else if (phase === 'session-size') {
        vi.mocked(value.tmux.sessionSize).mockReturnValueOnce(
          pending.promise as never
        )
      } else {
        vi.mocked(value.tmux.sessionSize).mockResolvedValueOnce(null)
        vi.mocked(value.tmux.resizeWindow).mockReturnValueOnce(
          pending.promise as Promise<void>
        )
      }

      const transport = new FakeTransport()
      const id = attach(value.manager, transport, `tab-${phase}`)
      await vi.waitFor(() => {
        const started =
          phase === 'refresh'
            ? value.service.refreshTerminalStatus
            : phase === 'configure'
              ? value.tmux.configureServer
              : phase === 'metadata'
                ? value.metadata.trackTerminal
                : phase === 'manual-size'
                  ? value.tmux.useManualWindowSize
                  : phase === 'session-size'
                    ? value.tmux.sessionSize
                    : value.tmux.resizeWindow
        expect(started).toHaveBeenCalled()
      })

      value.manager.close(id)
      pending.resolve(
        phase === 'refresh'
          ? {
              id: 'term',
              worktreeId: 'wt',
              tmuxSessionName: 'session',
              status: 'running',
              exitCode: null
            }
          : phase === 'session-size'
            ? { cols: 100, rows: 30 }
            : undefined
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(value.spawn, phase).not.toHaveBeenCalled()
      expect(
        transport.sent.some((message) => message.type === 'ready'),
        phase
      ).toBe(false)
      expect(
        transport.sent.some((message) => message.type === 'terminal_error'),
        phase
      ).toBe(false)
    }
  })

  it('releases partial acquisitions exactly once when subscription setup fails', async () => {
    const value = fixture()
    const unsubscribe = vi.fn()
    vi.spyOn(value.metadata, 'subscribe').mockReturnValue(unsubscribe)
    value.spawn.mockImplementationOnce(() => {
      const pty = new FakePty()
      pty.onExitError = new Error('exit subscription failed')
      value.ptys.push(pty)
      return pty as unknown as IPty
    })
    const transport = new FakeTransport()

    attach(value.manager, transport, 'tab-partial')
    await vi.waitFor(() =>
      expect(transport.sent.at(-1)).toMatchObject({
        type: 'terminal_error',
        code: 'ATTACH_FAILED'
      })
    )

    expect(value.ptys[0]!.kills).toBe(1)
    expect(value.ptys[0]!.dataDisposals).toBe(1)
    expect(value.ptys[0]!.exitDisposals).toBe(0)
    expect(unsubscribe).toHaveBeenCalledOnce()
    value.manager.dispose()
    expect(value.ptys[0]!.kills).toBe(1)
    expect(value.ptys[0]!.dataDisposals).toBe(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('revalidates canonical dimensions before ready when resize queues behind initialization', async () => {
    const value = fixture()
    const controller = new FakeTransport()
    const controllerId = attach(value.manager, controller, 'tab-controller')
    await ready(controller)

    const finishManualSize = deferred<void>()
    vi.mocked(value.tmux.useManualWindowSize).mockReturnValueOnce(
      finishManualSize.promise
    )
    const joining = new FakeTransport()
    attach(value.manager, joining, 'tab-joining')
    await vi.waitFor(() =>
      expect(value.tmux.useManualWindowSize).toHaveBeenCalledTimes(2)
    )

    value.manager.message(controllerId, 'resize', {
      generation: 1,
      cols: 120,
      rows: 40
    })
    finishManualSize.resolve()
    const joiningReady = await ready(joining)

    expect(joiningReady).toMatchObject({
      cols: 120,
      rows: 40,
      revision: 2
    })
    expect(value.ptys[1]!.resizes).toEqual([[120, 40]])
    expect(value.tmux.resizeWindow).toHaveBeenCalledWith(
      'socket',
      'session',
      120,
      40
    )
  })

  it('closes queued initialization without occupying or poisoning the terminal queue', async () => {
    const value = fixture()
    const pending = deferred<{ cols: number; rows: number } | null>()
    vi.mocked(value.tmux.sessionSize).mockReturnValueOnce(pending.promise)
    const first = new FakeTransport()
    attach(value.manager, first, 'tab-first')
    await vi.waitFor(() =>
      expect(value.tmux.sessionSize).toHaveBeenCalledOnce()
    )

    const queued = new FakeTransport()
    const queuedId = attach(value.manager, queued, 'tab-queued')
    await vi.waitFor(() =>
      expect(value.tmux.configureServer).toHaveBeenCalledTimes(2)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    value.manager.close(queuedId)
    pending.resolve({ cols: 100, rows: 30 })
    await ready(first)

    const later = new FakeTransport()
    attach(value.manager, later, 'tab-later')
    await ready(later)
    expect(value.ptys).toHaveLength(2)
    expect(queued.sent).toEqual([])
  })

  it('releases scoped resources when transport send self-closes initialization', async () => {
    const value = fixture()
    const unsubscribe = vi.fn()
    vi.spyOn(value.metadata, 'subscribe').mockReturnValue(unsubscribe)
    const transport = new FakeTransport()
    transport.failAfter = 1

    attach(value.manager, transport, 'tab-send-close')
    await vi.waitFor(() => expect(value.ptys).toHaveLength(1))
    await vi.waitFor(() => expect(value.ptys[0]!.kills).toBe(1))

    expect(transport.sent.map((message) => message.type)).toEqual(['ready'])
    expect(value.ptys[0]!.dataDisposals).toBe(1)
    expect(value.ptys[0]!.exitDisposals).toBe(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps close and dispose synchronous and idempotent after ready', async () => {
    const value = fixture()
    const unsubscribe = vi.fn()
    vi.spyOn(value.metadata, 'subscribe').mockReturnValue(unsubscribe)
    const transport = new FakeTransport()
    const id = attach(value.manager, transport, 'tab-a')
    await ready(transport)

    value.manager.close(id)
    value.manager.close(id)
    value.manager.dispose()
    value.manager.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(value.ptys[0]!.kills).toBe(1)
    expect(value.ptys[0]!.dataDisposals).toBe(1)
    expect(value.ptys[0]!.exitDisposals).toBe(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('cleans up all per-view resources during daemon shutdown', async () => {
    const { manager, ptys } = fixture()
    const first = new FakeTransport()
    const second = new FakeTransport()
    attach(manager, first, 'tab-a')
    await ready(first)
    attach(manager, second, 'tab-b')
    await ready(second)

    manager.dispose()
    expect(first.disconnects).toEqual([false])
    expect(second.disconnects).toEqual([false])
    expect(ptys.map((pty) => pty.kills)).toEqual([1, 1])
  })
})
