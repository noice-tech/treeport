import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import type {
  terminalKeyboardInput as mapTerminalKeyboardInput,
  terminalOptions as createTerminalOptions,
  terminalProgressLabel as formatTerminalProgressLabel,
  TerminalSession as TerminalSessionInstance,
  TerminalSessionManager as TerminalSessionManagerInstance,
  TerminalSessionSnapshot
} from './terminal-session.js'

const socketClient = vi.hoisted(() => ({ io: vi.fn() }))
vi.mock('socket.io-client', () => ({ io: socketClient.io }))

class FakeSocketIO {
  connected = false
  readonly handlers = new Map<string, Array<(value: any) => void>>()
  readonly managerHandlers = new Map<string, Array<() => void>>()
  readonly emit = vi.fn()
  readonly volatile = { emit: vi.fn() }
  readonly io = {
    on: (event: string, listener: () => void) => {
      this.managerHandlers.set(event, [
        ...(this.managerHandlers.get(event) ?? []),
        listener
      ])
    }
  }

  on(event: string, listener: (value: any) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }

  connect(): this {
    this.connected = true
    this.emitServer('connect', undefined)
    return this
  }

  disconnect(): this {
    const wasConnected = this.connected
    this.connected = false
    if (wasConnected) {
      this.emitServer('disconnect', 'io client disconnect')
    }

    return this
  }

  emitServer(event: string, value: any): void {
    this.handlers.get(event)?.forEach((listener) => listener(value))
  }
}

type TerminalSessionManagerConstructor = new (
  maxSessions?: number,
  idleMs?: number,
  createSession?: (terminalId: string) => TerminalSessionInstance,
  acknowledgeBell?: (terminalId: string, sequence: number) => Promise<unknown>
) => TerminalSessionManagerInstance

let TerminalSession: new (terminalId: string) => TerminalSessionInstance
let TerminalSessionManager: TerminalSessionManagerConstructor
let terminalKeyboardInput: typeof mapTerminalKeyboardInput
let terminalOptions: typeof createTerminalOptions
let terminalProgressLabel: typeof formatTerminalProgressLabel

class FakeSession {
  disposed = false
  private readonly listeners = new Set<() => void>()
  private snapshot: TerminalSessionSnapshot = {
    phase: 'ready',
    degraded: false,
    controller: false,
    title: null,
    bellActive: false,
    bellSerial: 0,
    exitSerial: 0,
    fileTransfer: null,
    error: null
  }

  getSnapshot = () => this.snapshot

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  ring(): void {
    this.snapshot = {
      ...this.snapshot,
      bellSerial: this.snapshot.bellSerial + 1
    }
    this.listeners.forEach((listener) => listener())
  }

  setTitle(title: string | null): void {
    this.snapshot = { ...this.snapshot, title }
    this.listeners.forEach((listener) => listener())
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

beforeAll(async () => {
  vi.stubGlobal('self', globalThis)
  ;({
    TerminalSession,
    TerminalSessionManager,
    terminalKeyboardInput,
    terminalOptions,
    terminalProgressLabel
  } = await import('./terminal-session.js'))
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fixture(maxSessions = 3, idleMs = 1_000) {
  const sessions = new Map<string, FakeSession>()
  const acknowledgeBell = vi.fn<
    (terminalId: string, sequence: number) => Promise<void>
  >(async () => undefined)
  const manager = new TerminalSessionManager(
    maxSessions,
    idleMs,
    (terminalId) => {
      const session = new FakeSession()
      sessions.set(terminalId, session)
      return session as unknown as TerminalSessionInstance
    },
    acknowledgeBell
  )
  return { acknowledgeBell, manager, sessions }
}

function controllerSessionFixture() {
  const socket = new FakeSocketIO()
  socket.connected = true
  let proposal = { cols: 120, rows: 40 }
  const host = {} as HTMLElement
  const resize = vi.fn()
  const session = new TerminalSession('terminal-one')
  Object.assign(session as unknown as Record<string, unknown>, {
    socket,
    ready: true,
    host,
    terminal: {
      cols: 100,
      rows: 30,
      options: { fontSize: 14 },
      reset: vi.fn(),
      resize,
      focus: vi.fn(),
      dispose: vi.fn()
    },
    fitAddon: {
      proposeDimensions: () => proposal
    },
    canonicalCols: 100,
    canonicalRows: 30,
    canonicalRevision: 1,
    appliedRevision: 1,
    controllerGeneration: 4,
    snapshotValue: {
      phase: 'ready',
      degraded: false,
      controller: true,
      title: null,
      bellActive: false,
      bellSerial: 0,
      exitSerial: 0,
      fileTransfer: null,
      error: null
    }
  })
  const measure = (dimensions: { cols: number; rows: number }) => {
    proposal = dimensions
    ;(session as unknown as { fit(queueControllerResize: boolean): void }).fit(
      true
    )
  }
  const dimensions = (cols: number, rows: number, revision: number) => {
    ;(
      session as unknown as {
        handleServerEvent(event: 'dimensions', value: unknown): void
      }
    ).handleServerEvent('dimensions', { cols, rows, revision })
  }
  const control = (controller: boolean, generation: number) => {
    ;(
      session as unknown as {
        handleServerEvent(event: 'control', value: unknown): void
      }
    ).handleServerEvent('control', { controller, generation })
  }
  return { control, dimensions, host, measure, resize, session, socket }
}

describe('terminal options', () => {
  it('opens OSC 8 links only on Cmd-click on Apple platforms', () => {
    const open = vi.fn()
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    vi.stubGlobal('window', { open })
    const handler = terminalOptions().linkHandler
    const url = 'https://github.com/acme/project/pull/123'

    handler.activate({ metaKey: false, ctrlKey: false } as MouseEvent, url)
    handler.activate({ metaKey: false, ctrlKey: true } as MouseEvent, url)
    expect(open).not.toHaveBeenCalled()

    handler.activate({ metaKey: true, ctrlKey: false } as MouseEvent, url)
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
  })

  it('opens OSC 8 links only on Ctrl-click on non-Apple platforms', () => {
    const open = vi.fn()
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    vi.stubGlobal('window', { open })
    const handler = terminalOptions().linkHandler
    const url = 'http://example.test/docs'

    handler.activate({ metaKey: false, ctrlKey: false } as MouseEvent, url)
    handler.activate({ metaKey: true, ctrlKey: false } as MouseEvent, url)
    expect(open).not.toHaveBeenCalled()

    handler.activate({ metaKey: false, ctrlKey: true } as MouseEvent, url)
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
  })

  it('rejects malformed and non-web OSC 8 link targets', () => {
    const open = vi.fn()
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    vi.stubGlobal('window', { open })
    const handler = terminalOptions().linkHandler
    const click = { metaKey: false, ctrlKey: true } as MouseEvent

    for (const url of [
      'https://',
      'javascript:alert(1)',
      'data:text/plain,hello',
      'file:///tmp/tasktty',
      'ssh://example.test'
    ]) {
      handler.activate(click, url)
    }

    expect(open).not.toHaveBeenCalled()
  })
})

describe('terminal progress', () => {
  it('describes non-running progress states without relying on color', () => {
    expect(terminalProgressLabel({ state: 'error', value: 42 })).toBe(
      'progress error, 42% complete'
    )
    expect(terminalProgressLabel({ state: 'paused', value: null })).toBe(
      'progress paused'
    )
  })
})

describe('terminal keyboard input', () => {
  const key = (overrides: Partial<KeyboardEvent> = {}) =>
    ({
      type: 'keydown',
      key: 'Enter',
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...overrides
    }) as KeyboardEvent

  it('encodes Shift+Enter as CSI-u without changing plain Enter', () => {
    expect(terminalKeyboardInput(key({ shiftKey: true }))).toBe('\u001b[13;2u')
    expect(terminalKeyboardInput(key())).toBeNull()
    expect(
      terminalKeyboardInput(key({ shiftKey: true, ctrlKey: true }))
    ).toBeNull()
    expect(
      terminalKeyboardInput(key({ shiftKey: true, isComposing: true }))
    ).toBeNull()
    expect(
      terminalKeyboardInput(key({ type: 'keyup', shiftKey: true }))
    ).toBeNull()
  })

  it('preserves xterm 5 Alt+Arrow word navigation', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(terminalKeyboardInput(key({ key: 'ArrowLeft', altKey: true }))).toBe(
      '\u001bb'
    )
    expect(
      terminalKeyboardInput(key({ key: 'ArrowRight', altKey: true }))
    ).toBe('\u001bf')
    expect(
      terminalKeyboardInput(key({ key: 'ArrowUp', altKey: true }))
    ).toBeNull()

    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(terminalKeyboardInput(key({ key: 'ArrowLeft', altKey: true }))).toBe(
      '\u001b[1;5D'
    )
    expect(
      terminalKeyboardInput(key({ key: 'ArrowRight', altKey: true }))
    ).toBe('\u001b[1;5C')
    expect(terminalKeyboardInput(key({ key: 'ArrowUp', altKey: true }))).toBe(
      '\u001b[1;5A'
    )
    expect(terminalKeyboardInput(key({ key: 'ArrowDown', altKey: true }))).toBe(
      '\u001b[1;5B'
    )
  })

  it('maps Cmd+Left/Right to Home/End in the current cursor-key mode', () => {
    expect(
      terminalKeyboardInput(key({ key: 'ArrowLeft', metaKey: true }))
    ).toBe('\u001b[H')
    expect(
      terminalKeyboardInput(key({ key: 'ArrowRight', metaKey: true }))
    ).toBe('\u001b[F')
    expect(
      terminalKeyboardInput(key({ key: 'ArrowLeft', metaKey: true }), true)
    ).toBe('\u001bOH')
    expect(
      terminalKeyboardInput(key({ key: 'ArrowRight', metaKey: true }), true)
    ).toBe('\u001bOF')
    expect(
      terminalKeyboardInput(
        key({ key: 'ArrowLeft', metaKey: true, shiftKey: true })
      )
    ).toBeNull()
  })
})

describe('TerminalSession', () => {
  beforeEach(() => {
    socketClient.io.mockReset()
    socketClient.io.mockImplementation(() => new FakeSocketIO())
  })

  it('uses an independent WebSocket-only Socket.IO connection with bounded auth', () => {
    const setItem = vi.fn()
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem
    })
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0x12)
    })

    const session = new TerminalSession('terminal-one')
    ;(session as unknown as { terminal: unknown }).terminal = {
      cols: 5_000,
      rows: 1,
      dispose: vi.fn()
    }
    ;(session as unknown as { connect(): void }).connect()
    expect(socketClient.io).toHaveBeenCalledWith(
      '/terminals',
      expect.objectContaining({
        path: '/api/socket.io/',
        transports: ['websocket'],
        forceNew: true,
        multiplex: false,
        retries: 0
      })
    )
    const options = socketClient.io.mock.calls[0]![1] as {
      auth: (authorize: (auth: unknown) => void) => void
    }
    const authorize = vi.fn()
    options.auth(authorize)
    expect(authorize).toHaveBeenCalledWith({
      terminalId: 'terminal-one',
      clientId: '12121212-1212-4212-9212-121212121212',
      cols: 1_000,
      rows: 2
    })
    expect(setItem).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('batches contiguous output writes while ACKing only parsed data', async () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = new TerminalSession('terminal-one')
    const writes: Array<{ data: string; callback: () => void }> = []
    const reset = vi.fn()
    ;(session as unknown as { terminal: unknown }).terminal = {
      reset,
      resize: vi.fn(),
      options: { fontSize: 14 },
      write: (data: string, callback: () => void) => {
        writes.push({ data, callback })
      },
      dispose: vi.fn()
    }
    ;(session as unknown as { connect(): void }).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: true,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1
    })
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 1,
      data: 'hello'
    })
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 2,
      data: ' world'
    })

    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.map(({ data }) => data)).toEqual(['hello', ' world'])
    expect(socket.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )

    writes[0]!.callback()
    writes[1]!.callback()
    expect(socket.emit).toHaveBeenLastCalledWith('output_ack', {
      streamId: 'stream-1',
      sequence: 2
    })
    expect(socket.volatile.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )

    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 3,
      data: 'later'
    })
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    socket.emitServer('disconnect', 'transport close')
    writes[2]!.callback()
    expect(socket.emit).toHaveBeenCalledTimes(2)
    session.dispose()
  })

  it('drains earlier output before resizing and admitting later output', async () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = new TerminalSession('terminal-one')
    const writes: Array<{ data: string; callback: () => void }> = []
    const resize = vi.fn()
    ;(session as unknown as { terminal: unknown }).terminal = {
      reset: vi.fn(),
      resize,
      options: { fontSize: 14 },
      write: (data: string, callback: () => void) => {
        writes.push({ data, callback })
      },
      dispose: vi.fn()
    }
    ;(session as unknown as { connect(): void }).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1
    })
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 1,
      data: 'old grid'
    })
    socket.emitServer('dimensions', { cols: 120, rows: 40, revision: 2 })
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 2,
      data: 'new grid'
    })

    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.map(({ data }) => data)).toEqual(['old grid', ''])
    expect(resize).toHaveBeenCalledTimes(1)

    writes[0]!.callback()
    expect(resize).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(2)
    writes[1]!.callback()

    await vi.waitFor(() => expect(resize).toHaveBeenLastCalledWith(120, 40))
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    expect(writes[2]!.data).toBe('new grid')
    session.dispose()
  })

  it('drains stale output before a new stream reset without ACKing it', async () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = new TerminalSession('terminal-one')
    const writes: Array<{ data: string; callback: () => void }> = []
    const reset = vi.fn()
    ;(session as unknown as { terminal: unknown }).terminal = {
      reset,
      resize: vi.fn(),
      options: { fontSize: 14 },
      write: (data: string, callback: () => void) => {
        writes.push({ data, callback })
      },
      dispose: vi.fn()
    }
    ;(session as unknown as { connect(): void }).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1
    })
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 1,
      data: 'stale'
    })
    await vi.waitFor(() => expect(writes).toHaveLength(1))

    socket.emitServer('ready', {
      connectionId: 'connection-2',
      streamId: 'stream-2',
      generation: 5,
      controller: false,
      reset: 'full',
      cols: 120,
      rows: 40,
      revision: 2
    })
    socket.emitServer('output', {
      streamId: 'stream-2',
      sequence: 1,
      data: 'fresh'
    })
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]!.data).toBe('')

    writes[0]!.callback()
    expect(socket.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )
    expect(reset).toHaveBeenCalledOnce()
    writes[1]!.callback()

    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    expect(writes[2]!.data).toBe('fresh')
    writes[2]!.callback()
    expect(socket.emit).toHaveBeenLastCalledWith('output_ack', {
      streamId: 'stream-2',
      sequence: 1
    })
    session.dispose()
  })

  it('coalesces repeated controller measurements to the latest bounded size', async () => {
    const { measure, resize, session, socket } = controllerSessionFixture()

    measure({ cols: 110, rows: 35 })
    await vi.advanceTimersByTimeAsync(100)
    measure({ cols: 130, rows: 42 })
    await vi.advanceTimersByTimeAsync(100)
    measure({ cols: 2_000, rows: 45 })
    await vi.advanceTimersByTimeAsync(149)
    expect(socket.emit).not.toHaveBeenCalledWith('resize', expect.anything())

    await vi.advanceTimersByTimeAsync(1)
    expect(socket.emit).toHaveBeenCalledOnce()
    expect(socket.emit).toHaveBeenCalledWith('resize', {
      generation: 4,
      cols: 1_000,
      rows: 45
    })
    session.sendText('blocked during resize')
    expect(socket.volatile.emit).not.toHaveBeenCalled()
    expect((session as unknown as { canInput(): boolean }).canInput()).toBe(
      false
    )
    expect(resize).not.toHaveBeenCalled()
    session.dispose()
  })

  it('does not send the next resize from an ACK during an ongoing gesture', async () => {
    const { dimensions, measure, session, socket } = controllerSessionFixture()

    measure({ cols: 120, rows: 40 })
    await vi.advanceTimersByTimeAsync(150)
    expect(socket.emit).toHaveBeenCalledTimes(1)

    measure({ cols: 130, rows: 45 })
    await vi.advanceTimersByTimeAsync(100)
    dimensions(120, 40, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(
      (session as unknown as { appliedRevision: number }).appliedRevision
    ).toBe(2)
    expect(socket.emit).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(49)
    expect(socket.emit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.emit).toHaveBeenLastCalledWith('resize', {
      generation: 4,
      cols: 130,
      rows: 45
    })
    session.dispose()
  })

  it('flushes one final quiet resize after an in-flight resize is ACKed', async () => {
    const { dimensions, measure, session, socket } = controllerSessionFixture()

    measure({ cols: 120, rows: 40 })
    await vi.advanceTimersByTimeAsync(150)
    measure({ cols: 100, rows: 30 })
    await vi.advanceTimersByTimeAsync(150)
    expect(socket.emit).toHaveBeenCalledTimes(1)

    dimensions(120, 40, 2)
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledTimes(2))
    expect(socket.emit).toHaveBeenLastCalledWith('resize', {
      generation: 4,
      cols: 100,
      rows: 30
    })
    session.dispose()
  })

  it('cancels stale resize intent on control loss and unmount', async () => {
    const { control, host, measure, session, socket } =
      controllerSessionFixture()

    measure({ cols: 120, rows: 40 })
    control(false, 5)
    await vi.advanceTimersByTimeAsync(150)
    expect(socket.emit).not.toHaveBeenCalled()

    control(true, 6)
    await vi.advanceTimersByTimeAsync(150)
    expect(socket.emit).not.toHaveBeenCalled()
    measure({ cols: 130, rows: 45 })
    session.unmount(host)
    await vi.advanceTimersByTimeAsync(150)
    expect(socket.emit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('cancels queued resize intent on a reconnect ready epoch', async () => {
    const { measure, session, socket } = controllerSessionFixture()

    measure({ cols: 120, rows: 40 })
    ;(
      session as unknown as {
        handleServerEvent(event: 'ready', value: unknown): void
      }
    ).handleServerEvent('ready', {
      connectionId: 'connection-2',
      streamId: 'stream-2',
      generation: 5,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 2
    })
    await vi.advanceTimersByTimeAsync(150)

    expect(socket.emit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('ignores hidden controller measurements instead of sending 2x2', async () => {
    const { measure, session, socket } = controllerSessionFixture()

    measure({ cols: 120, rows: 40 })
    await vi.advanceTimersByTimeAsync(100)
    measure({ cols: 1, rows: 1 })
    await vi.advanceTimersByTimeAsync(150)

    expect(socket.emit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('clears a pending resize when control is lost before a later takeover', () => {
    const session = new TerminalSession('terminal-one')
    Object.assign(session as unknown as Record<string, unknown>, {
      ready: true,
      resizePending: true,
      canonicalRevision: 1,
      appliedRevision: 1,
      snapshotValue: {
        phase: 'ready',
        degraded: false,
        controller: true,
        title: null,
        bellActive: false,
        bellSerial: 0,
        exitSerial: 0,
        fileTransfer: null,
        error: null
      }
    })
    const handleControl = (
      session as unknown as {
        handleServerEvent(event: 'control', value: unknown): void
      }
    ).handleServerEvent.bind(session)

    handleControl('control', { generation: 5, controller: false })
    handleControl('control', { generation: 6, controller: true })

    expect((session as unknown as { canInput(): boolean }).canInput()).toBe(
      true
    )
    session.dispose()
  })

  it('never buffers takeover while disconnected or before application ready', () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = new TerminalSession('terminal-one')
    ;(session as unknown as { connect(): void }).connect()
    session.takeControl()
    expect(socket.volatile.emit).not.toHaveBeenCalled()

    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 7,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1
    })
    ;(
      session as unknown as { proposedDimensions: unknown }
    ).proposedDimensions = {
      cols: 5_000,
      rows: 1
    }
    session.takeControl()
    expect(socket.emit).toHaveBeenCalledWith('take_control', {
      generation: 7,
      cols: 1_000,
      rows: 2
    })
    socket.emitServer('disconnect', 'transport close')
    session.takeControl()
    expect(socket.emit).toHaveBeenCalledTimes(1)
    session.dispose()
  })
})

describe('TerminalSessionManager', () => {
  it('evicts the least-recent unselected session over capacity', () => {
    const { manager, sessions } = fixture(2)
    manager.acquire('one')
    manager.release('one')
    manager.acquire('two')
    manager.release('two')
    manager.acquire('three')

    expect(sessions.get('one')?.disposed).toBe(true)
    expect(sessions.get('two')?.disposed).toBe(false)
    expect(sessions.get('three')?.disposed).toBe(false)
  })

  it('disposes an unselected session after the idle timeout', async () => {
    const { manager, sessions } = fixture()
    manager.acquire('one')
    manager.release('one')

    await vi.advanceTimersByTimeAsync(999)
    expect(sessions.get('one')?.disposed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(sessions.get('one')?.disposed).toBe(true)
  })

  it('does not derive durable attention from browser-observed BEL output', () => {
    const { acknowledgeBell, manager, sessions } = fixture()
    manager.acquire('one')
    manager.release('one')
    sessions.get('one')?.ring()

    expect(manager.getAttentionSnapshot().has('one')).toBe(false)
    expect(acknowledgeBell).not.toHaveBeenCalled()
  })

  it('publishes one runtime title snapshot and retains it across LRU eviction', () => {
    const { manager, sessions } = fixture(1)
    manager.acquire('one')
    manager.release('one')
    sessions.get('one')?.setTitle('vim · file.ts')
    expect(manager.getTitleSnapshot().get('one')).toBe('vim · file.ts')

    manager.acquire('two')
    expect(sessions.get('one')?.disposed).toBe(true)
    expect(manager.getTitleSnapshot().get('one')).toBe('vim · file.ts')

    manager.reconcile([{ id: 'two' }])
    expect(manager.getTitleSnapshot().has('one')).toBe(false)
  })

  it('clears a runtime title when the session reports an empty title', () => {
    const { manager, sessions } = fixture()
    manager.acquire('one')
    sessions.get('one')?.setTitle('shell')
    sessions.get('one')?.setTitle('')
    expect(manager.getTitleSnapshot().has('one')).toBe(false)
  })

  it('applies daemon metadata for terminals that have never been selected', () => {
    const { manager } = fixture()
    manager.applyRuntimeMetadata({
      terminalId: 'background',
      title: 'pi · /repo',
      hasForegroundProcess: true,
      progress: { state: 'normal', value: 42 },
      progressStartedAt: '2026-01-01T00:00:00.000Z',
      progressClearedAt: null,
      bell: null
    })

    expect(manager.getTitleSnapshot().get('background')).toBe('pi · /repo')
    expect(manager.getForegroundProcessSnapshot().has('background')).toBe(true)
    expect(manager.getProgressSnapshot().get('background')).toEqual({
      state: 'normal',
      value: 42
    })

    manager.replaceRuntimeMetadata([
      {
        terminalId: 'other',
        title: 'shell',
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])
    expect(manager.getTitleSnapshot().has('background')).toBe(false)
    expect(manager.getForegroundProcessSnapshot().has('background')).toBe(false)
    expect(manager.getProgressSnapshot().has('background')).toBe(false)
    expect(manager.getTitleSnapshot().get('other')).toBe('shell')
  })

  it('restores daemon attention and clears it only from authoritative metadata', async () => {
    const { acknowledgeBell, manager } = fixture()
    const metadata = {
      terminalId: 'background',
      title: 'Pi',
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        unread: true
      }
    } as const

    manager.replaceRuntimeMetadata([metadata])
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)

    manager.acquire('background')
    await vi.waitFor(() =>
      expect(acknowledgeBell).toHaveBeenCalledWith('background', 1)
    )
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)

    manager.applyRuntimeMetadata({
      ...metadata,
      bell: { ...metadata.bell, unread: false }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)

    manager.release('background')
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true
      }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
    expect(acknowledgeBell).toHaveBeenCalledTimes(1)

    manager.forget('background')
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)
    manager.applyRuntimeMetadata(metadata)
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
    manager.reconcile([])
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)
  })

  it('acknowledges an equal sequence again after a daemon snapshot', async () => {
    const { acknowledgeBell, manager } = fixture()
    const metadata = {
      terminalId: 'active',
      title: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 4,
        at: '2026-01-01T00:00:00.000Z',
        unread: true
      }
    } as const

    manager.acquire('active')
    manager.applyRuntimeMetadata(metadata)
    await vi.waitFor(() =>
      expect(acknowledgeBell).toHaveBeenNthCalledWith(1, 'active', 4)
    )
    manager.replaceRuntimeMetadata([metadata])
    await vi.waitFor(() =>
      expect(acknowledgeBell).toHaveBeenNthCalledWith(2, 'active', 4)
    )
  })

  it('ignores stale incremental bells but lets snapshots reset the sequence', () => {
    const { manager } = fixture()
    const metadata = {
      terminalId: 'background',
      title: 'first',
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true
      }
    } as const

    manager.applyRuntimeMetadata(metadata)
    manager.applyRuntimeMetadata({
      ...metadata,
      title: 'updated',
      progress: { state: 'normal', value: 50 },
      bell: {
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        unread: false
      }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
    expect(manager.getTitleSnapshot().get('background')).toBe('updated')
    expect(manager.getProgressSnapshot().get('background')).toEqual({
      state: 'normal',
      value: 50
    })

    manager.applyRuntimeMetadata({
      ...metadata,
      bell: { ...metadata.bell, unread: false }
    })
    manager.applyRuntimeMetadata(metadata)
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)

    manager.replaceRuntimeMetadata([
      {
        ...metadata,
        bell: {
          sequence: 1,
          at: '2026-01-01T00:02:00.000Z',
          unread: true
        }
      }
    ])
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
  })

  it('queues exact newer acknowledgements behind an in-flight request', async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { acknowledgeBell, manager } = fixture()
    acknowledgeBell.mockImplementationOnce(() => first)
    const metadata = {
      terminalId: 'active',
      title: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        unread: true
      }
    } as const

    manager.acquire('active')
    manager.applyRuntimeMetadata(metadata)
    await vi.waitFor(() => expect(acknowledgeBell).toHaveBeenCalledTimes(1))
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true
      }
    })
    expect(acknowledgeBell).toHaveBeenCalledTimes(1)

    releaseFirst()
    await vi.waitFor(() =>
      expect(acknowledgeBell).toHaveBeenNthCalledWith(2, 'active', 2)
    )
    expect(manager.getAttentionSnapshot().has('active')).toBe(true)
  })

  it('drops stale queued acknowledgements after a snapshot and release', async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { acknowledgeBell, manager } = fixture()
    acknowledgeBell.mockImplementationOnce(() => first)
    const metadata = {
      terminalId: 'active',
      title: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        unread: true
      }
    } as const

    manager.acquire('active')
    manager.applyRuntimeMetadata(metadata)
    await vi.waitFor(() => expect(acknowledgeBell).toHaveBeenCalledTimes(1))
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true
      }
    })
    manager.release('active')
    manager.replaceRuntimeMetadata([
      {
        ...metadata,
        bell: {
          sequence: 2,
          at: '2026-01-01T00:01:00.000Z',
          unread: true
        }
      }
    ])

    releaseFirst()
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledgeBell).toHaveBeenCalledTimes(1)
  })

  it('retains daemon progress across LRU eviction and clears it when metadata is removed', () => {
    const { manager, sessions } = fixture(1)
    manager.applyRuntimeMetadata({
      terminalId: 'one',
      title: null,
      progress: { state: 'indeterminate', value: null },
      progressStartedAt: '2026-01-01T00:00:00.000Z',
      progressClearedAt: null,
      bell: null
    })
    manager.acquire('one')
    manager.release('one')
    manager.acquire('two')
    expect(sessions.get('one')?.disposed).toBe(true)
    expect(manager.getProgressSnapshot().has('one')).toBe(true)

    manager.reconcile([{ id: 'two' }])
    expect(manager.getProgressSnapshot().has('one')).toBe(false)
  })

  it('does not let session churn resurrect progress after a daemon clear', () => {
    const { manager, sessions } = fixture(1)
    const active = {
      terminalId: 'one',
      title: null,
      progress: { state: 'indeterminate', value: null },
      progressStartedAt: '2026-01-01T00:00:00.000Z',
      progressClearedAt: null,
      bell: null
    } as const
    manager.applyRuntimeMetadata(active)
    manager.acquire('one')
    manager.release('one')
    manager.applyRuntimeMetadata({
      ...active,
      progress: null,
      progressClearedAt: '2026-01-01T00:00:01.000Z'
    })

    sessions.get('one')?.setTitle('late terminal title')
    manager.acquire('two')
    manager.acquire('one')
    expect(manager.getProgressSnapshot().has('one')).toBe(false)

    manager.applyRuntimeMetadata(active)
    expect(manager.getProgressSnapshot().get('one')).toEqual(active.progress)
    manager.forget('one')
    expect(manager.getProgressSnapshot().has('one')).toBe(false)
  })
})
