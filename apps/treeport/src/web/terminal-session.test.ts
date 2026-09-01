import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { type JsonValue, type TerminalSize } from '@treeport/shared'
import type {
  terminalKeyboardInput as mapTerminalKeyboardInput,
  terminalOptions as createTerminalOptions,
  terminalProgressLabel as formatTerminalProgressLabel,
  TerminalSession as TerminalSessionInstance,
  TerminalSessionManager as TerminalSessionManagerInstance,
  TerminalSessionSnapshot,
  TerminalSocketFactory
} from './terminal-session'

interface TerminalSessionTestAccess {
  terminal: object
  fitAddon: { proposeDimensions: () => TerminalSize | undefined }
  appliedRevision: number
  proposedDimensions: unknown
  connect(): void
  fit(queueControllerResize?: boolean): void
  canInput(): boolean
  handleServerEvent(event: string, value: JsonValue): void
  enqueueRender(epoch: number, operation: () => void): void
}

function testAccess<Value extends object, Fixture extends object = object>(
  value: Fixture
): Value {
  // SAFETY: Each call names only fixture members installed by this test.
  return Object(value) as Value
}

function terminalSessionTestAccess<Session extends object>(
  session: Session
): TerminalSessionTestAccess {
  // SAFETY: Tests access actual TerminalSession members or fields installed by
  // the test before use.
  return session as TerminalSessionTestAccess
}

const socketClient = { io: vi.fn() }

class FakeSocketIO {
  connected = false
  readonly handlers = new Map<string, Array<(value: any) => void>>()
  readonly managerHandlers = new Map<string, Array<() => void>>()
  readonly emit = vi.fn()
  readonly volatile = { emit: vi.fn() }
  readonly reconnection = vi.fn()
  readonly io = {
    reconnection: this.reconnection,
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

type TerminalSessionConstructor = new (
  terminalId: string,
  createSocket?: TerminalSocketFactory
) => TerminalSessionInstance

type TerminalSessionManagerConstructor = new (
  maxSessions?: number,
  idleMs?: number,
  createSession?: (terminalId: string) => TerminalSessionInstance,
  acknowledgeBell?: (terminalId: string, sequence: number) => Promise<void>
) => TerminalSessionManagerInstance

let TerminalSession: TerminalSessionConstructor
let TerminalSessionManager: TerminalSessionManagerConstructor
let terminalKeyboardInput: typeof mapTerminalKeyboardInput
let terminalOptions: typeof createTerminalOptions
let terminalProgressLabel: typeof formatTerminalProgressLabel

class FakeSession {
  disposed = false
  initialSize = { cols: 120, rows: 40 }
  private readonly listeners = new Set<() => void>()
  private snapshot: TerminalSessionSnapshot = {
    phase: 'ready',
    degraded: false,
    controller: false,
    controlPending: false,
    title: null,
    bellActive: false,
    bellSerial: 0,
    exitSerial: 0,
    fileTransfer: null,
    hasSelection: false,
    pasteRequestSerial: 0,
    error: null
  }

  getSnapshot = () => this.snapshot
  getInitialSize = () => this.initialSize

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
  } = await import('./terminal-session'))
})

function createTerminalSession(terminalId: string): TerminalSessionInstance {
  return new TerminalSession(
    terminalId,
    testAccess<TerminalSocketFactory>(socketClient.io)
  )
}

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
      return testAccess<TerminalSessionInstance>(session)
    },
    acknowledgeBell
  )
  return { acknowledgeBell, manager, sessions }
}

function controllerSessionFixture() {
  const socket = new FakeSocketIO()
  socket.connected = true
  let proposal = { cols: 120, rows: 40 }
  const host = testAccess<HTMLElement>({})
  const resize = vi.fn()
  const session = createTerminalSession('terminal-one')
  Object.assign(session, {
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
      controlPending: false,
      title: null,
      bellActive: false,
      bellSerial: 0,
      exitSerial: 0,
      fileTransfer: null,
      hasSelection: false,
      pasteRequestSerial: 0,
      error: null
    }
  })
  const measure = (dimensions: { cols: number; rows: number }) => {
    proposal = dimensions
    terminalSessionTestAccess(session).fit(true)
  }
  const dimensions = (cols: number, rows: number, revision: number) => {
    terminalSessionTestAccess(session).handleServerEvent('dimensions', {
      cols,
      rows,
      revision
    })
  }
  const control = (controller: boolean, generation: number) => {
    terminalSessionTestAccess(session).handleServerEvent('control', {
      controller,
      generation
    })
  }
  return { control, dimensions, host, measure, resize, session, socket }
}

describe('terminal options', () => {
  it('retains useful browser-owned scrollback', () => {
    expect(terminalOptions().scrollback).toBe(50_000)
  })

  it('opens OSC 8 links in Browser on Apple Cmd-click or touch', () => {
    const request = vi.fn(() => Promise.resolve(new Response()))
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    vi.stubGlobal('fetch', request)
    const handler = terminalOptions('term_source').linkHandler
    const url = 'https://github.com/acme/project/pull/123'

    handler.activate(
      testAccess<MouseEvent>({ metaKey: false, ctrlKey: false }),
      url
    )
    handler.activate(
      testAccess<MouseEvent>({ metaKey: false, ctrlKey: true }),
      url
    )
    expect(request).not.toHaveBeenCalled()

    handler.activate(
      testAccess<MouseEvent>({ metaKey: true, ctrlKey: false }),
      url
    )
    expect(request).toHaveBeenCalledWith(
      '/api/terminals/term_source/browser-panels/open',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url })
      })
    )

    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => testAccess<MediaQueryList>({ matches: true }))
    )
    handler.activate(
      testAccess<MouseEvent>({ metaKey: false, ctrlKey: false }),
      url
    )
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('opens OSC 8 links in Browser only on Ctrl-click on non-Apple platforms', () => {
    const request = vi.fn(() => Promise.resolve(new Response()))
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    vi.stubGlobal('fetch', request)
    const handler = terminalOptions('term_source').linkHandler
    const url = 'http://example.test/docs'

    handler.activate(
      testAccess<MouseEvent>({ metaKey: false, ctrlKey: false }),
      url
    )
    handler.activate(
      testAccess<MouseEvent>({ metaKey: true, ctrlKey: false }),
      url
    )
    expect(request).not.toHaveBeenCalled()

    handler.activate(
      testAccess<MouseEvent>({ metaKey: false, ctrlKey: true }),
      url
    )
    expect(request).toHaveBeenCalledWith(
      '/api/terminals/term_source/browser-panels/open',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url })
      })
    )
  })

  it('opens file OSC 8 links through the desktop bridge on modifier-click', () => {
    const open = vi.fn()
    const openFileUrl = vi.fn(() => Promise.resolve(true))
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    vi.stubGlobal('window', {
      open,
      treeportDesktop: { openFileUrl }
    })
    const handler = terminalOptions().linkHandler
    const url = 'file:///Users/example/project/readme%20draft.md'

    handler.activate(
      testAccess<MouseEvent>({ metaKey: false, ctrlKey: false }),
      url
    )
    handler.activate(
      testAccess<MouseEvent>({ metaKey: false, ctrlKey: true }),
      url
    )
    expect(openFileUrl).not.toHaveBeenCalled()

    handler.activate(
      testAccess<MouseEvent>({ metaKey: true, ctrlKey: false }),
      url
    )
    expect(openFileUrl).toHaveBeenCalledOnce()
    expect(openFileUrl).toHaveBeenCalledWith(url)
    expect(open).not.toHaveBeenCalled()
  })

  it('ignores file links outside the desktop app and rejects unsafe targets', () => {
    const open = vi.fn()
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    vi.stubGlobal('window', { open })
    const handler = terminalOptions().linkHandler
    const click = testAccess<MouseEvent>({ metaKey: false, ctrlKey: true })

    for (const url of [
      'https://',
      'javascript:alert(1)',
      'data:text/plain,hello',
      'file:///tmp/treeport',
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
    testAccess<KeyboardEvent>({
      type: 'keydown',
      key: 'Enter',
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...overrides
    })

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

  it('reports the proposed viewport size for a new terminal launch', () => {
    const { measure, session } = controllerSessionFixture()

    expect(session.getInitialSize()).toEqual({ cols: 100, rows: 30 })
    measure({ cols: 132, rows: 47 })
    expect(session.getInitialSize()).toEqual({ cols: 132, rows: 47 })
  })

  it('uses an independent WebSocket-only Socket.IO connection with bounded auth', () => {
    const clientId = '12121212-1212-4212-9212-121212121212'
    const setItem = vi.fn()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) =>
        key === 'treeport-terminal-client-id' ? clientId : null,
      setItem
    })
    const session = createTerminalSession('terminal-one')
    terminalSessionTestAccess(session).terminal = {
      cols: 5_000,
      rows: 1,
      options: { disableStdin: false },
      dispose: vi.fn()
    }
    terminalSessionTestAccess(session).connect()
    expect(socketClient.io).toHaveBeenCalledWith(
      '/terminals',
      expect.objectContaining({
        path: '/api/socket.io/',
        transports: ['websocket'],
        forceNew: true,
        multiplex: false,
        reconnectionDelay: 100,
        reconnectionDelayMax: 1_000,
        randomizationFactor: 0.2,
        retries: 0,
        query: { terminalProtocol: '5' }
      })
    )
    const options = testAccess<{
      auth: (
        authorize: (auth: {
          terminalId: string
          clientId: string
          cols: number
          rows: number
        }) => void
      ) => void
    }>(socketClient.io.mock.calls[0]![1])
    const authorize = vi.fn()
    options.auth(authorize)
    expect(authorize).toHaveBeenCalledWith({
      terminalId: 'terminal-one',
      clientId,
      cols: 1_000,
      rows: 2
    })
    expect(setItem.mock.calls).toEqual([
      ['treeport-terminal-client-id', clientId]
    ])
    session.dispose()
  })

  it('reconnects only mounted terminal sessions after a server interruption', () => {
    const socket = new FakeSocketIO()
    socket.connected = true
    const session = createTerminalSession('terminal-one')
    const host = testAccess<HTMLElement>({ appendChild: vi.fn() })
    const wrapper = { remove: vi.fn() }
    Object.assign(session, {
      socket,
      ready: true,
      opened: true,
      host,
      wrapper
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    vi.stubGlobal('addEventListener', vi.fn())
    vi.stubGlobal('removeEventListener', vi.fn())
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    session.unmount(host)
    expect(socket.reconnection).toHaveBeenLastCalledWith(false)

    session.mount(host)
    expect(socket.reconnection).toHaveBeenLastCalledWith(true)
    session.dispose()
  })

  it('keeps two synchronized clients scroll and selection independent', async () => {
    const firstSocket = new FakeSocketIO()
    const secondSocket = new FakeSocketIO()
    const sockets = [firstSocket, secondSocket]
    socketClient.io.mockImplementation(() => sockets.shift()!)
    const firstSession = createTerminalSession('terminal-one')
    const secondSession = createTerminalSession('terminal-one')
    const content = ['', '']
    const clearSelection = [vi.fn(), vi.fn()]
    const selected = [true, true]
    for (const [index, session] of [firstSession, secondSession].entries()) {
      terminalSessionTestAccess(session).terminal = {
        reset: vi.fn(() => {
          content[index] = ''
        }),
        resize: vi.fn(),
        options: { fontSize: 14 },
        write: (data: string, callback: () => void) => {
          content[index] += data
          callback()
        },
        focus: vi.fn(),
        hasSelection: () => selected[index],
        clearSelection: () => {
          selected[index] = false
          clearSelection[index]!()
        },
        dispose: vi.fn()
      }
      terminalSessionTestAccess(session).connect()
    }
    for (const [index, socket] of [firstSocket, secondSocket].entries()) {
      socket.emitServer('ready', {
        connectionId: `connection-${index}`,
        streamId: 'stream',
        generation: 1,
        controller: false,
        reset: 'full',
        cols: 80,
        rows: 24,
        revision: 1,
        snapshot: 'shared history\r\n'
      })
      socket.emitServer('output', {
        streamId: 'stream',
        sequence: 1,
        data: 'shared live output\r\n'
      })
    }
    await vi.waitFor(() =>
      expect(content).toEqual([
        'shared history\r\nshared live output\r\n',
        'shared history\r\nshared live output\r\n'
      ])
    )

    firstSession.clearSelection()
    expect(clearSelection[0]).toHaveBeenCalledOnce()
    expect(clearSelection[1]).not.toHaveBeenCalled()
    expect(firstSocket.volatile.emit).not.toHaveBeenCalledWith(
      'input',
      expect.anything()
    )
    expect(secondSocket.volatile.emit).not.toHaveBeenCalledWith(
      'input',
      expect.anything()
    )
    firstSession.dispose()
    secondSession.dispose()
  })

  it('answers queries only after fenced controller authority and through handoff', async () => {
    const { Terminal: BrowserTerminal } = await import('@xterm/xterm')
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new BrowserTerminal({
      cols: 80,
      rows: 24,
      scrollback: 50_000,
      allowProposedApi: true
    })
    terminal.onData((data) => session.sendText(data, { focus: false }))
    terminalSessionTestAccess(session).terminal = terminal
    terminalSessionTestAccess(session).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 1,
      controller: true,
      reset: 'full',
      cols: 80,
      rows: 24,
      revision: 1,
      snapshot: 'historical query: \u001b[6n'
    })
    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith('query_authority', {
        generation: 1,
        transitionId: null
      })
    )
    expect(socket.volatile.emit).not.toHaveBeenCalledWith(
      'input',
      expect.anything()
    )

    const grant = async (generation: number, transitionId: string) => {
      socket.emitServer('query_authority', {
        generation,
        transitionId,
        active: false
      })
      await vi.waitFor(() =>
        expect(socket.emit).toHaveBeenCalledWith('query_authority', {
          generation,
          transitionId
        })
      )
      socket.emit.mockClear()
      socket.emitServer('query_authority', {
        generation,
        transitionId,
        active: true
      })
      await vi.waitFor(() =>
        expect(socket.emit).toHaveBeenCalledWith('query_authority', {
          generation,
          transitionId
        })
      )
      socket.emitServer('query_authority', {
        generation,
        transitionId: null,
        active: true
      })
    }

    await grant(1, 'transition-1')
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 1,
      data: '\u001b[6n'
    })
    await vi.waitFor(() =>
      expect(socket.volatile.emit).toHaveBeenCalledWith('input', {
        generation: 1,
        data: expect.stringMatching(
          new RegExp(String.raw`^\u001b\[\d+;\d+R$`, 'u')
        )
      })
    )
    expect(
      socket.volatile.emit.mock.calls.filter(([event]) => event === 'input')
    ).toHaveLength(1)

    socket.emitServer('control', { generation: 2, controller: false })
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 2,
      data: '\u001b[6n'
    })
    await Promise.resolve()
    expect(
      socket.volatile.emit.mock.calls.filter(([event]) => event === 'input')
    ).toHaveLength(1)

    socket.emitServer('control', { generation: 3, controller: true })
    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith('query_authority', {
        generation: 3,
        transitionId: null
      })
    )
    socket.emit.mockClear()
    await grant(3, 'transition-2')
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 3,
      data: '\u001b[6n'
    })
    await vi.waitFor(() =>
      expect(
        socket.volatile.emit.mock.calls.filter(([event]) => event === 'input')
      ).toHaveLength(2)
    )
    session.dispose()
  })

  it('batches contiguous output writes while ACKing only parsed data', async () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const writes: Array<{ data: string; callback: () => void }> = []
    const reset = vi.fn()
    terminalSessionTestAccess(session).terminal = {
      reset,
      resize: vi.fn(),
      options: { fontSize: 14 },
      write: (data: string, callback: () => void) => {
        writes.push({ data, callback })
      },
      dispose: vi.fn()
    }
    terminalSessionTestAccess(session).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: true,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ''
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
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.data).toBe('')
    expect(socket.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )

    writes[0]!.callback()
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    expect(writes.slice(1).map(({ data }) => data)).toEqual(['hello', ' world'])
    writes[1]!.callback()
    writes[2]!.callback()
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
    await vi.waitFor(() => expect(writes).toHaveLength(4))
    const emitCountBeforeDisconnect = socket.emit.mock.calls.length
    socket.emitServer('disconnect', 'transport close')
    writes[3]!.callback()
    expect(socket.emit).toHaveBeenCalledTimes(emitCountBeforeDisconnect)
    session.dispose()
  })

  it('drains earlier output before resizing and admitting later output', async () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const writes: Array<{ data: string; callback: () => void }> = []
    const resize = vi.fn()
    terminalSessionTestAccess(session).terminal = {
      reset: vi.fn(),
      resize,
      options: { fontSize: 14 },
      write: (data: string, callback: () => void) => {
        writes.push({ data, callback })
      },
      dispose: vi.fn()
    }
    terminalSessionTestAccess(session).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ''
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

    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.data).toBe('')
    expect(resize).toHaveBeenCalledTimes(1)

    writes[0]!.callback()
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    expect(writes.slice(1).map(({ data }) => data)).toEqual(['old grid', ''])
    writes[1]!.callback()
    expect(resize).toHaveBeenCalledTimes(1)
    writes[2]!.callback()

    await vi.waitFor(() => expect(resize).toHaveBeenLastCalledWith(120, 40))
    await vi.waitFor(() => expect(writes).toHaveLength(4))
    expect(writes[3]!.data).toBe('new grid')
    session.dispose()
  })

  it('drains stale output before a new stream reset without ACKing it', async () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const writes: Array<{ data: string; callback: () => void }> = []
    const reset = vi.fn()
    terminalSessionTestAccess(session).terminal = {
      reset,
      resize: vi.fn(),
      options: { fontSize: 14 },
      write: (data: string, callback: () => void) => {
        writes.push({ data, callback })
      },
      dispose: vi.fn()
    }
    terminalSessionTestAccess(session).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ''
    })
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.data).toBe('')
    writes[0]!.callback()
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 1,
      data: 'stale'
    })
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]!.data).toBe('stale')

    socket.emitServer('ready', {
      connectionId: 'connection-2',
      streamId: 'stream-2',
      generation: 5,
      controller: false,
      reset: 'full',
      cols: 120,
      rows: 40,
      revision: 2,
      snapshot: ''
    })
    socket.emitServer('output', {
      streamId: 'stream-2',
      sequence: 1,
      data: 'fresh'
    })
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    expect(writes[2]!.data).toBe('')

    writes[1]!.callback()
    expect(socket.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )
    expect(reset).toHaveBeenCalledOnce()
    writes[2]!.callback()

    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(writes).toHaveLength(4))
    expect(writes[3]!.data).toBe('')
    writes[3]!.callback()
    await vi.waitFor(() => expect(writes).toHaveLength(5))
    expect(writes[4]!.data).toBe('fresh')
    writes[4]!.callback()
    expect(socket.emit).toHaveBeenLastCalledWith('output_ack', {
      streamId: 'stream-2',
      sequence: 1
    })
    session.dispose()
  })

  it('refits as a viewer when takeover dimensions arrive before control loss', async () => {
    const { control, dimensions, resize, session, socket } =
      controllerSessionFixture()
    terminalSessionTestAccess(session).fitAddon.proposeDimensions = () => ({
      cols: 60,
      rows: 20
    })

    dimensions(120, 40, 2)
    await vi.waitFor(() => expect(resize).toHaveBeenLastCalledWith(120, 40))
    control(false, 5)
    const fitCallback = vi.mocked(requestAnimationFrame).mock.calls.at(-1)?.[0]
    fitCallback?.(0)

    expect(
      testAccess<{ options: { fontSize: number } }>(
        terminalSessionTestAccess(session).terminal
      ).options.fontSize
    ).toBe(7)
    expect(resize).toHaveBeenLastCalledWith(120, 40)
    expect(socket.emit).not.toHaveBeenCalledWith('resize', expect.anything())
    session.dispose()
  })

  it('closes on render queue failure and does not run later operations', async () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    terminalSessionTestAccess(session).terminal = {
      reset: () => {
        throw new Error('reset failed')
      },
      resize: vi.fn(),
      options: { fontSize: 14 },
      dispose: vi.fn()
    }
    terminalSessionTestAccess(session).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ''
    })
    await vi.waitFor(() =>
      expect(session.getSnapshot()).toMatchObject({
        phase: 'closed',
        error: 'Terminal rendering failed: reset failed'
      })
    )
    const sentinel = vi.fn()
    terminalSessionTestAccess(session).enqueueRender(1, sentinel)
    await Promise.resolve()
    await Promise.resolve()
    expect(sentinel).not.toHaveBeenCalled()

    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    session.retry()
    expect(reload).toHaveBeenCalledOnce()
    expect(socket.connected).toBe(false)
    session.dispose()
  })

  it('translates FitAddon exceptions through the fatal rendering boundary', () => {
    const socket = new FakeSocketIO()
    socket.connected = true
    const session = createTerminalSession('terminal-one')
    Object.assign(session, {
      socket,
      ready: true,
      host: {},
      terminal: {
        cols: 100,
        rows: 30,
        options: { fontSize: 14 },
        dispose: vi.fn()
      },
      fitAddon: {
        proposeDimensions: () => {
          throw new Error('measurement failed')
        }
      },
      canonicalRevision: 1,
      appliedRevision: 1
    })

    terminalSessionTestAccess(session).fit()

    expect(session.getSnapshot()).toMatchObject({
      phase: 'closed',
      error: 'Terminal rendering failed: measurement failed'
    })
    expect(socket.connected).toBe(false)
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
    expect(terminalSessionTestAccess(session).canInput()).toBe(false)
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
    expect(terminalSessionTestAccess(session).appliedRevision).toBe(2)
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
    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith('query_authority', {
        generation: 6,
        transitionId: null
      })
    )
    socket.emit.mockClear()
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
    terminalSessionTestAccess(session).handleServerEvent('ready', {
      connectionId: 'connection-2',
      streamId: 'stream-2',
      generation: 5,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 2,
      snapshot: ''
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

  it('waits for query authority after clearing a pending resize on takeover', () => {
    const session = createTerminalSession('terminal-one')
    Object.assign(session, {
      ready: true,
      resizePending: true,
      canonicalRevision: 1,
      appliedRevision: 1,
      snapshotValue: {
        phase: 'ready',
        degraded: false,
        controller: true,
        controlPending: false,
        title: null,
        bellActive: false,
        bellSerial: 0,
        exitSerial: 0,
        fileTransfer: null,
        hasSelection: false,
        pasteRequestSerial: 0,
        error: null
      }
    })
    const handleControl =
      terminalSessionTestAccess(session).handleServerEvent.bind(session)

    handleControl('control', { generation: 5, controller: false })
    handleControl('control', { generation: 6, controller: true })

    expect(terminalSessionTestAccess(session).canInput()).toBe(false)
    terminalSessionTestAccess(session).handleServerEvent('query_authority', {
      generation: 6,
      transitionId: null,
      active: true
    })
    expect(terminalSessionTestAccess(session).canInput()).toBe(true)
    session.dispose()
  })

  it('never buffers takeover while disconnected or before application ready', () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    terminalSessionTestAccess(session).connect()
    session.requestControl()
    expect(socket.emit).not.toHaveBeenCalled()

    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 7,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ''
    })
    terminalSessionTestAccess(session).proposedDimensions = {
      cols: 5_000,
      rows: 1
    }
    session.requestControl()
    session.requestControl()
    expect(session.getSnapshot().controlPending).toBe(true)
    expect(socket.emit).toHaveBeenCalledWith('take_control', {
      generation: 7,
      cols: 1_000,
      rows: 2
    })
    expect(socket.emit).toHaveBeenCalledTimes(1)

    session.sendText('not replayed')
    expect(socket.volatile.emit).not.toHaveBeenCalledWith(
      'input',
      expect.anything()
    )
    socket.emitServer('control', { generation: 8, controller: true })
    expect(session.getSnapshot()).toMatchObject({
      controller: true,
      controlPending: false
    })
    expect(socket.volatile.emit).not.toHaveBeenCalledWith(
      'input',
      expect.anything()
    )

    socket.emitServer('disconnect', 'transport close')
    expect(session.getSnapshot().controlPending).toBe(false)
    session.requestControl()
    expect(socket.emit).toHaveBeenCalledTimes(1)
    session.dispose()
  })

  it('requests control only when focus is explicitly user-initiated', () => {
    const socket = new FakeSocketIO()
    socketClient.io.mockReturnValue(socket)
    const focus = vi.fn()
    const session = createTerminalSession('terminal-one')
    Object.assign(session, {
      terminal: {
        cols: 100,
        rows: 30,
        options: { fontSize: 14 },
        focus,
        reset: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn()
      }
    })
    terminalSessionTestAccess(session).connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 2,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ''
    })

    session.focus()
    expect(focus).toHaveBeenCalledOnce()
    expect(socket.emit).not.toHaveBeenCalledWith(
      'take_control',
      expect.anything()
    )

    session.focus({ requestControl: true })
    expect(focus).toHaveBeenCalledTimes(2)
    expect(socket.emit).toHaveBeenCalledWith('take_control', {
      generation: 2,
      cols: 100,
      rows: 30
    })
    session.dispose()
  })
})

describe('TerminalSessionManager', () => {
  it('reports the mounted session size for a new terminal launch', () => {
    const { manager, sessions } = fixture()
    manager.acquire('one')

    expect(manager.getInitialSize('one')).toEqual({ cols: 120, rows: 40 })
    sessions.get('one')!.initialSize = { cols: 132, rows: 47 }
    expect(manager.getInitialSize('one')).toEqual({ cols: 132, rows: 47 })
    expect(manager.getInitialSize('missing')).toBeNull()
  })

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

  it('keeps retained sessions alive until their final release without dropping daemon metadata', async () => {
    const { manager, sessions } = fixture()
    manager.applyRuntimeMetadata({
      terminalId: 'one',
      title: 'Pi',
      progress: { state: 'normal', value: 25 },
      progressStartedAt: '2026-01-01T00:00:00.000Z',
      progressClearedAt: null,
      bell: null
    })
    const first = manager.acquire('one')
    const second = manager.acquire('one')

    manager.release('one')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(first).toBe(second)
    expect(sessions.get('one')?.disposed).toBe(false)
    expect(manager.getProgressSnapshot().get('one')).toEqual({
      state: 'normal',
      value: 25
    })

    manager.release('one')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sessions.get('one')?.disposed).toBe(true)
    expect(manager.getProgressSnapshot().get('one')).toEqual({
      state: 'normal',
      value: 25
    })
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
      program: 'pi',
      hasForegroundProcess: true,
      progress: { state: 'normal', value: 42 },
      progressStartedAt: '2026-01-01T00:00:00.000Z',
      progressClearedAt: null,
      bell: null
    })

    expect(manager.getTitleSnapshot().get('background')).toBe('pi · /repo')
    expect(manager.getProgramSnapshot().get('background')).toBe('pi')
    expect(manager.getForegroundProcessSnapshot().has('background')).toBe(true)
    expect(manager.getProgressSnapshot().get('background')).toEqual({
      state: 'normal',
      value: 42
    })

    manager.replaceRuntimeMetadata([
      {
        terminalId: 'other',
        title: 'shell',
        program: null,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])
    expect(manager.getTitleSnapshot().has('background')).toBe(false)
    expect(manager.getProgramSnapshot().has('background')).toBe(false)
    expect(manager.getForegroundProcessSnapshot().has('background')).toBe(false)
    expect(manager.getProgressSnapshot().has('background')).toBe(false)
    expect(manager.getTitleSnapshot().get('other')).toBe('shell')
  })

  it('publishes each runtime update once with complete snapshots before its BEL event', () => {
    const { manager, sessions } = fixture()
    const order: string[] = []
    const observed: Array<{
      title: string | undefined
      foreground: boolean
      progress: { state: string; value: number | null } | undefined
      attention: boolean
      bell: { sequence: number; unread: boolean } | undefined
    }> = []
    manager.subscribe(() => {
      order.push('store')
      observed.push({
        title: manager.getTitleSnapshot().get('background'),
        foreground: manager.getForegroundProcessSnapshot().has('background'),
        progress: manager.getProgressSnapshot().get('background'),
        attention: manager.getAttentionSnapshot().has('background'),
        bell: manager.getBellSnapshot().get('background')
      })
    })
    manager.subscribeBellEvents(() => {
      order.push('bell')
      expect(manager.getTitleSnapshot().get('background')).toBe('Pi build')
      expect(manager.getAttentionSnapshot().has('background')).toBe(true)
      expect(manager.getForegroundProcessSnapshot().has('background')).toBe(
        true
      )
      expect(manager.getProgressSnapshot().get('background')).toEqual({
        state: 'normal',
        value: 61
      })
      expect(manager.getBellSnapshot().get('background')).toMatchObject({
        sequence: 1,
        unread: true
      })
    })

    manager.applyRuntimeMetadata({
      terminalId: 'background',
      title: 'Pi build',
      hasForegroundProcess: true,
      progress: { state: 'normal', value: 61 },
      progressStartedAt: '2026-01-01T00:00:00.000Z',
      progressClearedAt: null,
      bell: {
        sequence: 1,
        at: '2026-01-01T00:01:00.000Z',
        unread: true
      }
    })

    expect(order).toEqual(['store', 'bell'])
    expect(observed).toEqual([
      {
        title: 'Pi build',
        foreground: true,
        progress: { state: 'normal', value: 61 },
        attention: true,
        bell: { sequence: 1, at: '2026-01-01T00:01:00.000Z', unread: true }
      }
    ])

    manager.acquire('background')
    sessions.get('background')?.setTitle('live session title')
    expect(order).toEqual(['store', 'bell', 'store'])
    expect(observed.at(-1)?.title).toBe('live session title')
  })

  it('retains equal per-terminal progress identity across collection updates', () => {
    const { manager } = fixture()
    const first = {
      terminalId: 'one',
      title: 'One',
      progress: { state: 'normal' as const, value: 25 },
      progressStartedAt: '2026-01-01T00:00:00.000Z',
      progressClearedAt: null,
      bell: null
    }
    manager.replaceRuntimeMetadata([
      first,
      {
        ...first,
        terminalId: 'two',
        title: 'Two',
        progress: { state: 'normal', value: 50 }
      }
    ])
    const firstProgress = manager.getProgressSnapshot().get('one')

    manager.replaceRuntimeMetadata([
      { ...first, progress: { ...first.progress } },
      {
        ...first,
        terminalId: 'two',
        title: 'Two',
        progress: { state: 'normal', value: 75 }
      }
    ])

    expect(manager.getProgressSnapshot().get('one')).toBe(firstProgress)
    expect(manager.getProgressSnapshot().get('two')).toEqual({
      state: 'normal',
      value: 75
    })
  })

  it('emits only newer incremental BELs and keeps snapshots presentation-silent', () => {
    const { manager } = fixture()
    const events: Array<{ terminalId: string; sequence: number; at: string }> =
      []
    manager.subscribeBellEvents((event) => events.push(event))
    const metadata = {
      terminalId: 'background',
      title: 'Pi',
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 2,
        at: '2026-01-01T00:02:00.000Z',
        unread: true
      }
    } as const

    manager.replaceRuntimeMetadata([metadata])
    expect(events).toEqual([])
    expect(manager.getBellSnapshot().get('background')).toEqual(metadata.bell)

    manager.applyRuntimeMetadata(metadata)
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: { ...metadata.bell, unread: false }
    })
    expect(events).toEqual([])

    const next = {
      ...metadata,
      bell: {
        sequence: 3,
        at: '2026-01-01T00:03:00.000Z',
        unread: true
      }
    } as const
    manager.applyRuntimeMetadata(next)
    expect(events).toEqual([
      {
        terminalId: 'background',
        sequence: 3,
        at: '2026-01-01T00:03:00.000Z'
      }
    ])
    expect(manager.getBellSnapshot().get('background')).toEqual(next.bell)
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
    expect(acknowledgeBell).not.toHaveBeenCalled()
    await manager.acknowledgeBell('background', 1)
    expect(acknowledgeBell).toHaveBeenCalledWith('background', 1)
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
    await manager.acknowledgeBell('active', 4)
    expect(acknowledgeBell).toHaveBeenNthCalledWith(1, 'active', 4)
    manager.replaceRuntimeMetadata([metadata])
    await manager.acknowledgeBell('active', 4)
    expect(acknowledgeBell).toHaveBeenNthCalledWith(2, 'active', 4)
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
    void manager.acknowledgeBell('active', 1)
    await vi.waitFor(() => expect(acknowledgeBell).toHaveBeenCalledTimes(1))
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true
      }
    })
    void manager.acknowledgeBell('active', 2)
    expect(acknowledgeBell).toHaveBeenCalledTimes(1)

    releaseFirst()
    await vi.waitFor(() =>
      expect(acknowledgeBell).toHaveBeenNthCalledWith(2, 'active', 2)
    )
    expect(manager.getAttentionSnapshot().has('active')).toBe(true)
  })

  it('drops stale queued acknowledgements after a snapshot reset', async () => {
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
    void manager.acknowledgeBell('active', 1)
    await vi.waitFor(() => expect(acknowledgeBell).toHaveBeenCalledTimes(1))
    manager.applyRuntimeMetadata({
      ...metadata,
      bell: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true
      }
    })
    void manager.acknowledgeBell('active', 2)
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

  it('allows an exact acknowledgement to be retried after failure', async () => {
    const { acknowledgeBell, manager } = fixture()
    acknowledgeBell.mockRejectedValueOnce(new Error('offline'))
    manager.applyRuntimeMetadata({
      terminalId: 'active',
      title: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: {
        sequence: 8,
        at: '2026-01-01T00:08:00.000Z',
        unread: true
      }
    })

    await expect(manager.acknowledgeBell('active', 8)).rejects.toThrow(
      'offline'
    )
    await manager.acknowledgeBell('active', 8)
    expect(acknowledgeBell).toHaveBeenCalledTimes(2)
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
