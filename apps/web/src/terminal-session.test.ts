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
  createSession?: (terminalId: string) => TerminalSessionInstance
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
  const manager = new TerminalSessionManager(
    maxSessions,
    idleMs,
    (terminalId) => {
      const session = new FakeSession()
      sessions.set(terminalId, session)
      return session as unknown as TerminalSessionInstance
    }
  )
  return { manager, sessions }
}

describe('terminal options', () => {
  it('lets Option or a normalized plain macOS drag select while mouse reporting is active', () => {
    expect(terminalOptions().macOptionClickForcesSelection).toBe(true)
  })

  it('opens OSC 8 links in a new tab only on Cmd/Ctrl-click', () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    const handler = terminalOptions().linkHandler
    const url = 'https://github.com/acme/project/pull/123'

    handler.activate({ metaKey: false, ctrlKey: false } as MouseEvent, url)
    expect(open).not.toHaveBeenCalled()

    handler.activate({ metaKey: true, ctrlKey: false } as MouseEvent, url)
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
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
      cols: 100,
      rows: 30
    })
    expect(setItem).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('ACKs only after xterm consumption and ignores a stale stream callback', () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = new TerminalSession('terminal-one')
    let consumed: (() => void) | null = null
    const reset = vi.fn()
    ;(session as unknown as { terminal: unknown }).terminal = {
      reset,
      write: (_data: string, callback: () => void) => {
        consumed = callback
      },
      dispose: vi.fn()
    }
    ;(session as unknown as { connect(): void }).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: true,
      reset: 'full'
    })
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 1,
      data: 'hello'
    })

    expect(reset).toHaveBeenCalledOnce()
    expect(socket.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )
    ;(consumed as (() => void) | null)?.()
    expect(socket.emit).toHaveBeenCalledWith('output_ack', {
      streamId: 'stream-1',
      sequence: 1
    })
    expect(socket.volatile.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )

    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 2,
      data: 'later'
    })
    socket.emitServer('disconnect', 'transport close')
    ;(consumed as (() => void) | null)?.()
    expect(socket.emit).toHaveBeenCalledTimes(1)
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
      reset: 'full'
    })
    session.takeControl()
    expect(socket.volatile.emit).toHaveBeenCalledWith('take_control', {
      generation: 7
    })
    socket.emitServer('disconnect', 'transport close')
    session.takeControl()
    expect(socket.volatile.emit).toHaveBeenCalledTimes(1)
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

  it('retains and clears attention from background BEL events', () => {
    const { manager, sessions } = fixture()
    manager.acquire('one')
    manager.release('one')
    sessions.get('one')?.ring()

    expect(manager.getAttentionSnapshot().has('one')).toBe(true)
    manager.acquire('one')
    expect(manager.getAttentionSnapshot().has('one')).toBe(false)
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
      progress: { state: 'normal', value: 42 },
      progressStartedAt: '2026-01-01T00:00:00.000Z',
      progressClearedAt: null,
      bell: null
    })

    expect(manager.getTitleSnapshot().get('background')).toBe('pi · /repo')
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
    expect(manager.getProgressSnapshot().has('background')).toBe(false)
    expect(manager.getTitleSnapshot().get('other')).toBe('shell')
  })

  it('baselines daemon bells and marks only later bells on unviewed terminals', () => {
    const { manager } = fixture()
    const metadata = {
      terminalId: 'background',
      title: 'Pi',
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: { sequence: 1, at: '2026-01-01T00:00:00.000Z' }
    } as const

    manager.replaceRuntimeMetadata([metadata])
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)

    manager.applyRuntimeMetadata({
      ...metadata,
      bell: { sequence: 2, at: '2026-01-01T00:01:00.000Z' }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
    manager.clearAttention('background')
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: { sequence: 2, at: '2026-01-01T00:01:00.000Z' }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)

    manager.acquire('background')
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: { sequence: 3, at: '2026-01-01T00:02:00.000Z' }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)
    manager.release('background')
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: { sequence: 4, at: '2026-01-01T00:03:00.000Z' }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)

    manager.forget('background')
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)
    manager.applyRuntimeMetadata(metadata)
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
    manager.reconcile([])
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)
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
