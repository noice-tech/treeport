import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { readFileSync } from 'node:fs'
import {
  type JsonValue,
  type TerminalActivity,
  type TerminalSize
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import { GhosttyTerminal } from '../ghostty-vt/ghostty-vt'
import { GhosttyTerminalCore } from './terminal-session-client/ghostty-core'
import type {
  terminalKeyboardInput as mapTerminalKeyboardInput,
  terminalOptions as createTerminalOptions,
  TerminalSession as TerminalSessionInstance,
  TerminalSessionManager as TerminalSessionManagerInstance,
  TerminalAttentionEvent,
  TerminalSessionSnapshot,
  TerminalSocketFactory
} from './terminal-session'

const IDLE: TerminalActivity = {
  state: 'idle',
  kind: null,
  progress: null,
  app: null,
  message: null,
  since: null
}

function working(progress: number | null): TerminalActivity {
  return { ...IDLE, state: 'working', progress }
}

interface TerminalSessionTestAccess {
  state: {
    terminal: object
    appliedRevision: number
    proposedDimensions: unknown
  }
  services: {
    connection: {
      connect(): void
      canInput(): boolean
    }
    protocol: { handleServerEvent(event: string, value: JsonValue): void }
    layout: { fit(queueControllerResize?: boolean): void }
    render: {
      enqueueRender(epoch: number, operation: Effect.Effect<void>): void
    }
  }
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

const socketClient = { create: vi.fn() }

class FakeProtocolSocket {
  connected = false
  readonly handlers = new Map<string, Array<(value: any) => void>>()
  readonly managerHandlers = new Map<string, Array<() => void>>()
  readonly emit = vi.fn()
  readonly volatile = { emit: vi.fn() }
  readonly reconnection = vi.fn()
  readonly manager = {
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

  removeAllListeners(): this {
    this.handlers.clear()
    this.managerHandlers.clear()
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
      this.emitServer('disconnect', 'client disconnect')
    }

    return this
  }

  emitServer(event: string, value: any): void {
    this.handlers.get(event)?.forEach((listener) => listener(value))
  }
}

const ghosttyModule = new WebAssembly.Module(
  readFileSync(new URL('../ghostty-vt/ghostty-vt.wasm', import.meta.url))
)

// The server's snapshot of a terminal that has parsed the given output.
function ghosttySnapshot(output = '', cols = 100, rows = 30): string {
  const terminal = GhosttyTerminal.create(
    ghosttyModule,
    cols,
    rows,
    {
      scrollbackLines: 1_000,
      continuationBytes: 0,
      imageStorageBytes: 0,
      foreground: 0,
      background: 0
    },
    {
      writePty: null,
      bell: null,
      titleChanged: null,
      progress: null,
      unknownOsc: null,
      renderHold: null,
      clipboardWrite: null
    }
  )
  terminal.write(output)
  const snapshot = Buffer.from(terminal.snapshot()).toString('base64')
  terminal.dispose()
  return snapshot
}

// The WTerm surface a session drives, over a real libghostty-vt core. Node
// tests have no DOM, so wterm's renderer is left out.
class GhosttyWTerm {
  readonly bridge: GhosttyTerminalCore
  readonly log: string[] = []
  private readonly style = new Map<string, string>()
  readonly element = {
    style: {
      setProperty: (name: string, value: string) => this.style.set(name, value),
      getPropertyValue: (name: string) => this.style.get(name) ?? ''
    },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    querySelector: () => null
  }

  measurement: TerminalSize | null = null
  onData: ((data: string) => void) | null = null
  readonly write = vi.fn((data: string) => {
    this.log.push(`write ${JSON.stringify(data)}`)
    this.bridge.writeString(data)
    const response = this.bridge.getResponse()
    if (response) {
      this.onData?.(response)
    }
  })

  readonly resize = vi.fn((cols: number, rows: number) => {
    this.log.push(`resize ${cols}x${rows}`)
    this.bridge.resize(cols, rows)
    this.cols = cols
    this.rows = rows
  })

  readonly fit = vi.fn()
  readonly _measureGridSize = vi.fn(() => this.measurement)
  readonly getSelectionText = vi.fn(() => '')
  readonly clearSelection = vi.fn()
  readonly focus = vi.fn()
  readonly setRenderingPaused = vi.fn()
  readonly destroy = vi.fn(() => this.bridge.dispose())

  constructor(
    public cols = 100,
    public rows = 30
  ) {
    this.bridge = new GhosttyTerminalCore(ghosttyModule, 1_000)
    this.bridge.init(cols, rows)
  }

  text(): string {
    const core = this.bridge
    return Array.from({ length: core.getRows() }, (_, row) =>
      Array.from({ length: core.getCols() }, (_, col) =>
        String.fromCodePoint(core.getCell(row, col).char || 32)
      )
        .join('')
        .trimEnd()
    )
      .join('\n')
      .trimEnd()
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
  acknowledgeAttention?: (terminalId: string, sequence: number) => Promise<void>
) => TerminalSessionManagerInstance

let TerminalSession: TerminalSessionConstructor
let TerminalSessionManager: TerminalSessionManagerConstructor
let terminalKeyboardInput: typeof mapTerminalKeyboardInput
let terminalOptions: typeof createTerminalOptions

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
    hoveredLink: null,
    pasteRequestSerial: 0,
    fontZoomPercent: null,
    inputError: null,
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
    terminalOptions
  } = await import('./terminal-session'))
})

function createTerminalSession(terminalId: string): TerminalSessionInstance {
  return new TerminalSession(
    terminalId,
    testAccess<TerminalSocketFactory>(socketClient.create)
  )
}

type FakeUploadTarget = {
  onprogress: ((event: { loaded: number }) => void) | null
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  // Model the browser upload transport while keeping the existing fetch
  // fixtures responsible for response timing, errors and abort observation.
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      upload: FakeUploadTarget = {
        onprogress: null
      }
      onprogress: (() => void) | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      status = 0
      statusText = ''
      responseText = ''
      url = ''
      method = ''
      headers = new Headers()
      controller = new AbortController()
      open(method: string, url: string) {
        this.method = method
        this.url = url
      }
      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value)
      }
      abort() {
        this.controller.abort()
        this.onabort?.()
      }
      send(body: File) {
        void fetch(this.url, {
          method: this.method,
          headers: this.headers,
          body,
          signal: this.controller.signal
        }).then(
          async (response) => {
            this.status = response.status
            this.statusText = response.statusText
            this.responseText = await response.text()
            this.upload.onprogress?.({ loaded: body.size })
            this.onload?.()
          },
          () => this.onerror?.()
        )
      }
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fixture(maxSessions = 3, idleMs = 1_000) {
  const sessions = new Map<string, FakeSession>()
  const acknowledgeAttention = vi.fn<
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
    acknowledgeAttention
  )
  return { acknowledgeAttention, manager, sessions }
}

function controllerSessionFixture() {
  const socket = new FakeProtocolSocket()
  socket.connected = true
  const host = testAccess<HTMLElement>({})
  const terminal = new GhosttyWTerm()
  terminal.measurement = { cols: 120, rows: 40 }
  const session = createTerminalSession('terminal-one')
  Object.assign(terminalSessionTestAccess(session).state, {
    socket,
    ready: true,
    host,
    terminal,
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
      hoveredLink: null,
      pasteRequestSerial: 0,
      fontZoomPercent: null,
      inputError: null,
      error: null
    }
  })
  const measure = (dimensions: { cols: number; rows: number }) => {
    terminal.measurement = dimensions
    terminalSessionTestAccess(session).services.layout.fit(true)
  }
  const dimensions = (cols: number, rows: number, revision: number) => {
    terminalSessionTestAccess(session).services.protocol.handleServerEvent(
      'dimensions',
      {
        cols,
        rows,
        revision
      }
    )
  }
  const control = (controller: boolean, generation: number) => {
    terminalSessionTestAccess(session).services.protocol.handleServerEvent(
      'control',
      {
        controller,
        generation
      }
    )
  }
  return {
    control,
    dimensions,
    host,
    measure,
    resize: terminal.resize,
    session,
    socket,
    terminal
  }
}

describe('terminal options', () => {
  it('does not activate links on modifier-right-click or middle-click', () => {
    const request = vi.fn()
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    vi.stubGlobal('fetch', request)
    const handler = terminalOptions('term_source').linkHandler
    for (const button of [1, 2]) {
      handler.activate(
        testAccess<MouseEvent>({ button, ctrlKey: true }),
        'https://example.test/'
      )
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('opens OSC 8 links in Browser on Apple Cmd-click or touch', () => {
    const request = vi.fn(() => Promise.resolve(new Response()))
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    vi.stubGlobal('fetch', request)
    const handler = terminalOptions('term_source').linkHandler
    const url = 'https://github.com/acme/project/pull/123'

    handler.activate(
      testAccess<MouseEvent>({ button: 0, metaKey: false, ctrlKey: false }),
      url
    )
    handler.activate(
      testAccess<MouseEvent>({ button: 0, metaKey: false, ctrlKey: true }),
      url
    )
    expect(request).not.toHaveBeenCalled()

    handler.activate(
      testAccess<MouseEvent>({ button: 0, metaKey: true, ctrlKey: false }),
      url
    )
    expect(request).toHaveBeenCalledWith(
      '/api/terminals/term_source/browser-apps/open',
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
      testAccess<MouseEvent>({ button: 0, metaKey: false, ctrlKey: false }),
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
      testAccess<MouseEvent>({ button: 0, metaKey: false, ctrlKey: false }),
      url
    )
    handler.activate(
      testAccess<MouseEvent>({ button: 0, metaKey: true, ctrlKey: false }),
      url
    )
    expect(request).not.toHaveBeenCalled()

    handler.activate(
      testAccess<MouseEvent>({ button: 0, metaKey: false, ctrlKey: true }),
      url
    )
    expect(request).toHaveBeenCalledWith(
      '/api/terminals/term_source/browser-apps/open',
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
      testAccess<MouseEvent>({ button: 0, metaKey: false, ctrlKey: false }),
      url
    )
    handler.activate(
      testAccess<MouseEvent>({ button: 0, metaKey: false, ctrlKey: true }),
      url
    )
    expect(openFileUrl).not.toHaveBeenCalled()

    handler.activate(
      testAccess<MouseEvent>({ button: 0, metaKey: true, ctrlKey: false }),
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
    const click = testAccess<MouseEvent>({
      button: 0,
      metaKey: false,
      ctrlKey: true
    })

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
    socketClient.create.mockReset()
    socketClient.create.mockImplementation(() => new FakeProtocolSocket())
  })

  it('reports the proposed viewport size for a new terminal launch', () => {
    const { measure, session } = controllerSessionFixture()

    expect(session.getInitialSize()).toEqual({ cols: 100, rows: 30 })
    measure({ cols: 132, rows: 47 })
    expect(session.getInitialSize()).toEqual({ cols: 132, rows: 47 })
  })

  it('uses an independent Effect WebSocket connection with bounded auth', () => {
    const clientId = '12121212-1212-4212-9212-121212121212'
    const setItem = vi.fn()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) =>
        key === 'treeport-terminal-client-id' ? clientId : null,
      setItem
    })
    const session = createTerminalSession('terminal-one')
    terminalSessionTestAccess(session).state.terminal = {
      cols: 5_000,
      rows: 1,
      destroy: vi.fn()
    }
    terminalSessionTestAccess(session).services.connection.connect()
    expect(socketClient.create).toHaveBeenCalledWith(
      '/terminals',
      expect.objectContaining({
        autoConnect: false,
        reconnection: true,
        reconnectionDelay: 100,
        reconnectionDelayMax: 1_000,
        randomizationFactor: 0.2,
        query: { terminalProtocol: '10' }
      })
    )
    const options = testAccess<{
      authorize: () => {
        terminalId: string
        clientId: string
        cols: number
        rows: number
      }
    }>(socketClient.create.mock.calls[0]![1])
    expect(options.authorize()).toEqual({
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
    const socket = new FakeProtocolSocket()
    socket.connected = true
    const session = createTerminalSession('terminal-one')
    const host = testAccess<HTMLElement>({ appendChild: vi.fn() })
    const wrapper = { remove: vi.fn() }
    Object.assign(terminalSessionTestAccess(session).state, {
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
    const firstSocket = new FakeProtocolSocket()
    const secondSocket = new FakeProtocolSocket()
    const sockets = [firstSocket, secondSocket]
    socketClient.create.mockImplementation(() => sockets.shift()!)
    const firstSession = createTerminalSession('terminal-one')
    const secondSession = createTerminalSession('terminal-one')
    const terminals = [new GhosttyWTerm(80, 24), new GhosttyWTerm(80, 24)]
    for (const [index, session] of [firstSession, secondSession].entries()) {
      terminals[index]!.getSelectionText.mockReturnValue('selected')
      terminalSessionTestAccess(session).state.terminal = terminals[index]!
      terminalSessionTestAccess(session).services.connection.connect()
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
        snapshot: ghosttySnapshot('shared history\r\n', 80, 24)
      })
      socket.emitServer('output', {
        streamId: 'stream',
        sequence: 1,
        data: 'shared live output\r\n'
      })
    }
    await vi.waitFor(() =>
      expect(terminals.map((terminal) => terminal.text())).toEqual([
        'shared history\nshared live output',
        'shared history\nshared live output'
      ])
    )

    firstSession.clearSelection()
    expect(terminals[0]!.clearSelection).toHaveBeenCalledOnce()
    expect(terminals[1]!.clearSelection).not.toHaveBeenCalled()
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
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm(80, 24)
    terminal.onData = (data) => session.sendText(data, { focus: false })
    terminalSessionTestAccess(session).state.terminal = terminal
    terminalSessionTestAccess(session).services.connection.connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 1,
      controller: true,
      reset: 'full',
      cols: 80,
      rows: 24,
      revision: 1,
      snapshot: ghosttySnapshot('historical output', 80, 24)
    })
    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith('query_authority', {
        generation: 1,
        cellSize: null,
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
          cellSize: null,
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
          cellSize: null,
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
        cellSize: null,
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

  it('restores synchronized output from the snapshot', async () => {
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm()
    terminalSessionTestAccess(session).state.terminal = terminal
    terminalSessionTestAccess(session).services.connection.connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 1,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ghosttySnapshot('\x1b[?2026hpartial frame')
    })
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('ready'))
    expect(terminal.bridge.synchronizedOutput()).toBe(true)
    expect(terminal.text()).toBe('partial frame')
    session.dispose()
  })

  it('ACKs output only after writing it to the terminal', async () => {
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm()
    terminalSessionTestAccess(session).state.terminal = terminal
    terminalSessionTestAccess(session).services.connection.connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: true,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ghosttySnapshot()
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
    expect(socket.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenLastCalledWith('output_ack', {
        streamId: 'stream-1',
        sequence: 2
      })
    )
    expect(terminal.text()).toBe('hello world')
    expect(socket.volatile.emit).not.toHaveBeenCalledWith(
      'output_ack',
      expect.anything()
    )

    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 3,
      data: '!'
    })
    socket.emitServer('disconnect', 'transport close')
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.emit).not.toHaveBeenCalledWith('output_ack', {
      streamId: 'stream-1',
      sequence: 3
    })
    session.dispose()
  })

  it('writes earlier output before resizing and admitting later output', async () => {
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm()
    terminalSessionTestAccess(session).state.terminal = terminal
    terminalSessionTestAccess(session).services.connection.connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ghosttySnapshot()
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

    await vi.waitFor(() =>
      expect(terminal.write).toHaveBeenLastCalledWith('new grid')
    )
    expect(terminal.log).toEqual([
      'write ""',
      'resize 100x30',
      'write "old grid"',
      'resize 120x40',
      'write "new grid"'
    ])
    session.dispose()
  })

  it('drops stale output across a new stream reset without ACKing it', async () => {
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm()
    terminalSessionTestAccess(session).state.terminal = terminal
    terminalSessionTestAccess(session).services.connection.connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ghosttySnapshot('first stream\r\n')
    })
    socket.emitServer('output', {
      streamId: 'stream-1',
      sequence: 1,
      data: 'stale'
    })
    socket.emitServer('ready', {
      connectionId: 'connection-2',
      streamId: 'stream-2',
      generation: 5,
      controller: false,
      reset: 'full',
      cols: 120,
      rows: 40,
      revision: 2,
      snapshot: ghosttySnapshot('second stream\r\n', 120, 40)
    })
    socket.emitServer('output', {
      streamId: 'stream-2',
      sequence: 1,
      data: 'fresh'
    })

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith('output_ack', {
        streamId: 'stream-2',
        sequence: 1
      })
    )
    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'output_ack')
    ).toHaveLength(1)
    expect(terminal.text()).toBe('second stream\nfresh')
    expect(terminal.cols).toBe(120)
    session.dispose()
  })

  it('refits as a viewer when takeover dimensions arrive before control loss', async () => {
    const { control, dimensions, resize, session, socket, terminal } =
      controllerSessionFixture()
    terminal.measurement = { cols: 60, rows: 20 }

    dimensions(120, 40, 2)
    await vi.waitFor(() => expect(resize).toHaveBeenLastCalledWith(120, 40))
    control(false, 5)
    const fitCallback = vi.mocked(requestAnimationFrame).mock.calls.at(-1)?.[0]
    fitCallback?.(0)

    expect(terminal.element.style.getPropertyValue('--term-font-size')).toBe(
      '7px'
    )
    expect(resize).toHaveBeenLastCalledWith(120, 40)
    expect(socket.emit).not.toHaveBeenCalledWith('resize', expect.anything())
    session.dispose()
  })

  it('closes on render queue failure and does not run later operations', async () => {
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm()
    terminal.write.mockImplementation(() => {
      throw new Error('repaint failed')
    })
    terminalSessionTestAccess(session).state.terminal = terminal
    terminalSessionTestAccess(session).services.connection.connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 4,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ghosttySnapshot()
    })
    await vi.waitFor(() =>
      expect(session.getSnapshot()).toMatchObject({
        phase: 'closed',
        error: 'Terminal rendering failed: repaint failed'
      })
    )
    const sentinel = vi.fn()
    terminalSessionTestAccess(session).services.render.enqueueRender(
      1,
      Effect.sync(sentinel)
    )
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

  it('releases all scoped resources even if a browser disposer throws', async () => {
    const session = createTerminalSession('terminal-one')
    const destroy = vi.fn()
    const remove = vi.fn()
    const disconnect = vi.fn()
    Object.assign(terminalSessionTestAccess(session).state, {
      terminal: { destroy },
      wrapper: { remove },
      socket: { disconnect, removeAllListeners: vi.fn() },
      selectionDragCancel: () => {
        throw new Error('selection cleanup failed')
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    session.dispose()
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce())
    expect(remove).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      destroy.mock.invocationCallOrder[0]!
    )
    session.dispose()
    expect(destroy).toHaveBeenCalledOnce()
    log.mockRestore()
  })

  it('ignores events from a replaced socket', () => {
    const first = new FakeProtocolSocket()
    const second = new FakeProtocolSocket()
    socketClient.create.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const session = createTerminalSession('terminal-one')
    terminalSessionTestAccess(session).services.connection.connect()
    first.disconnect()
    Object.assign(terminalSessionTestAccess(session).state, { socket: null })
    terminalSessionTestAccess(session).services.connection.connect()
    first.emitServer('title', { title: 'stale' })
    first.emitServer('output', {
      streamId: 'stale',
      sequence: 100,
      data: 'stale'
    })
    expect(session.getSnapshot().title).toBe(null)
    expect(session.getSnapshot().error).toBe(null)
    expect(second.connected).toBe(true)
    session.dispose()
  })

  it('fails closed instead of dropping renders when the bounded queue fills', () => {
    const session = createTerminalSession('terminal-one')
    for (let index = 0; index < 1_026; index += 1) {
      terminalSessionTestAccess(session).services.render.enqueueRender(
        0,
        Effect.never
      )
    }
    expect(session.getSnapshot()).toMatchObject({
      phase: 'closed',
      error:
        'Terminal rendering failed: Terminal render queue capacity exceeded'
    })
    session.dispose()
  })

  it('aborts an in-flight upload and never starts queued uploads after disposal', async () => {
    const { session } = controllerSessionFixture()
    terminalSessionTestAccess(session).services.protocol.handleServerEvent(
      'query_authority',
      {
        generation: 4,
        active: true,
        transitionId: null
      }
    )
    vi.stubGlobal('location', { hostname: 'remote.example' })
    const signals: AbortSignal[] = []
    const request = vi.fn((_input: RequestInfo | URL, init: RequestInit) => {
      signals.push(init.signal!)
      return new Promise<Response>(() => undefined)
    })
    vi.stubGlobal('fetch', request)
    session.pasteFiles([new File(['one'], 'one.txt')])
    session.pasteFiles([new File(['two'], 'two.txt')])
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    session.cancelFileTransfers()
    await vi.advanceTimersByTimeAsync(0)
    expect(signals[0]!.aborted).toBe(true)
    expect(session.getSnapshot().fileTransfer).toBe(null)
    expect(request).toHaveBeenCalledOnce()

    session.pasteFiles([new File(['three'], 'three.txt')])
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(signals[1]!.aborted).toBe(true)
    expect(session.getSnapshot().fileTransfer).toMatchObject({
      state: 'error',
      message: expect.stringContaining('Upload stalled')
    })

    session.pasteFiles([new File(['four'], 'four.txt')])
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    session.dispose()
    const snapshot = session.getSnapshot()
    await vi.advanceTimersByTimeAsync(0)
    expect(signals[2]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(request).toHaveBeenCalledTimes(3)
    expect(session.getSnapshot()).toBe(snapshot)
  })

  it('continues the ordered transfer worker after an upload fails', async () => {
    const { session, terminal } = controllerSessionFixture()
    terminalSessionTestAccess(session).services.protocol.handleServerEvent(
      'query_authority',
      {
        generation: 4,
        active: true,
        transitionId: null
      }
    )
    vi.stubGlobal('location', { hostname: 'remote.example' })
    const pending: Array<() => void> = []
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockImplementation((_input: RequestInfo | URL, init: RequestInit) => {
        const file = init.body
        if (!(file instanceof File)) {
          throw new Error('Expected file body')
        }

        return new Promise<Response>((resolve) => {
          pending.push(() =>
            resolve(Response.json({ file: { path: `/tmp/${file.name}` } }))
          )
        })
      })
    vi.stubGlobal('fetch', request)
    const paste = vi.fn()
    terminal.onData = paste
    const files = Array.from(
      { length: 12 },
      (_, index) => new File(['two'], `${index}.txt`)
    )
    Object.defineProperty(files[0], 'size', { value: 60 * 1024 * 1024 })
    session.pasteFiles([new File(['one'], 'one.txt')])
    session.pasteFiles(files)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4))
    expect(session.getSnapshot().fileTransfer).toMatchObject({
      state: 'uploading',
      queuedFiles: 9,
      message: expect.stringContaining('0/12 files · 0%')
    })
    // Finish each wave out of order: only three run at a time, and the
    // eventual terminal input must still preserve the selection order.
    for (let completed = 0; completed < 12; completed += 3) {
      expect(paste).not.toHaveBeenCalled()
      pending
        .splice(0)
        .reverse()
        .forEach((finish) => finish())
      if (completed < 9) {
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledTimes(completed + 7)
        )
      }
    }
    await vi.waitFor(() =>
      expect(paste).toHaveBeenCalledExactlyOnceWith(
        files.map((file) => `/tmp/${file.name}`).join(' ')
      )
    )
    expect(request).toHaveBeenCalledTimes(13)
    expect(session.getSnapshot().fileTransfer).toBe(null)

    vi.stubGlobal('location', { hostname: 'localhost' })
    const localFiles = files.map((file) => {
      const local = new File([], file.name)
      Object.defineProperties(local, {
        path: { value: `/local/${file.name}` },
        size: { value: 60 * 1024 * 1024 * 1024 }
      })
      return local
    })
    session.pasteFiles(localFiles)
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(2))
    expect(paste).toHaveBeenLastCalledWith(
      localFiles.map((file) => `/local/${file.name}`).join(' ')
    )
    expect(request).toHaveBeenCalledTimes(13)
    session.dispose()
  })

  it('does not paste an upload after losing and reacquiring control', async () => {
    const { session, control, terminal } = controllerSessionFixture()
    terminalSessionTestAccess(session).services.protocol.handleServerEvent(
      'query_authority',
      {
        generation: 4,
        active: true,
        transitionId: null
      }
    )
    vi.stubGlobal('location', { hostname: 'remote.example' })
    let finish: (response: Response) => void = () => undefined
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    vi.stubGlobal('fetch', request)
    const paste = vi.fn()
    terminal.onData = paste
    session.pasteFiles([new File(['one'], 'one.txt')])
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    control(false, 5)
    control(true, 6)
    finish(Response.json({ file: { path: '/tmp/one.txt' } }))
    await vi.waitFor(() =>
      expect(session.getSnapshot().fileTransfer).toMatchObject({
        state: 'error',
        message: expect.stringContaining('control was lost')
      })
    )
    expect(paste).not.toHaveBeenCalled()
    session.dispose()
  })

  it('translates wterm measurement exceptions through the fatal rendering boundary', () => {
    const socket = new FakeProtocolSocket()
    socket.connected = true
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm()
    terminal._measureGridSize.mockImplementation(() => {
      throw new Error('measurement failed')
    })
    Object.assign(terminalSessionTestAccess(session).state, {
      socket,
      ready: true,
      host: {},
      terminal,
      canonicalRevision: 1,
      appliedRevision: 1
    })

    terminalSessionTestAccess(session).services.layout.fit()

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
    expect(
      terminalSessionTestAccess(session).services.connection.canInput()
    ).toBe(false)
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
    expect(terminalSessionTestAccess(session).state.appliedRevision).toBe(2)
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
        cellSize: null,
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

  it('publishes ready after the initial snapshot and then fits the controller viewport', async () => {
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm(80, 24)
    terminal.measurement = { cols: 120, rows: 40 }
    terminalSessionTestAccess(session).state.terminal = terminal
    Object.assign(terminalSessionTestAccess(session).state, {
      wrapper: {
        style: { visibility: '' },
        dataset: {},
        contains: () => false,
        remove: vi.fn(),
        classList: {
          contains: () => false,
          toggle: vi.fn(),
          add: vi.fn(),
          remove: vi.fn()
        }
      },
      host: {},
      focusAfterRender: true
    })
    terminalSessionTestAccess(session).services.connection.connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 1,
      controller: true,
      reset: 'full',
      cols: 80,
      rows: 24,
      revision: 1,
      snapshot: ghosttySnapshot('initial output', 80, 24)
    })
    expect(session.getSnapshot().phase).toBe('connecting')
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('ready'))
    expect(terminal.text()).toBe('initial output')
    expect(session.getSnapshot().controller).toBe(true)
    expect(terminal.focus).toHaveBeenCalledOnce()

    const fitController = vi
      .mocked(requestAnimationFrame)
      .mock.calls.at(-1)?.[0]
    fitController?.(0)
    await vi.advanceTimersByTimeAsync(150)
    expect(socket.emit).toHaveBeenCalledWith('resize', {
      generation: 1,
      cols: 120,
      rows: 40
    })
    session.dispose()
  })

  it('cancels queued resize intent on a reconnect ready epoch', async () => {
    const { measure, session, socket } = controllerSessionFixture()

    measure({ cols: 120, rows: 40 })
    terminalSessionTestAccess(session).services.protocol.handleServerEvent(
      'ready',
      {
        connectionId: 'connection-2',
        streamId: 'stream-2',
        generation: 5,
        controller: false,
        reset: 'full',
        cols: 100,
        rows: 30,
        revision: 2,
        snapshot: ghosttySnapshot()
      }
    )
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
    Object.assign(terminalSessionTestAccess(session).state, {
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
        hoveredLink: null,
        pasteRequestSerial: 0,
        fontZoomPercent: null,
        inputError: null,
        error: null
      }
    })
    const handleControl =
      terminalSessionTestAccess(
        session
      ).services.protocol.handleServerEvent.bind(session)

    handleControl('control', { generation: 5, controller: false })
    handleControl('control', { generation: 6, controller: true })

    expect(
      terminalSessionTestAccess(session).services.connection.canInput()
    ).toBe(false)
    terminalSessionTestAccess(session).services.protocol.handleServerEvent(
      'query_authority',
      {
        generation: 6,
        transitionId: null,
        active: true
      }
    )
    expect(
      terminalSessionTestAccess(session).services.connection.canInput()
    ).toBe(true)
    session.dispose()
  })

  it('never buffers takeover while disconnected or before application ready', () => {
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    terminalSessionTestAccess(session).services.connection.connect()
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
      snapshot: ghosttySnapshot()
    })
    terminalSessionTestAccess(session).state.proposedDimensions = {
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
    const socket = new FakeProtocolSocket()
    socketClient.create.mockReturnValue(socket)
    const session = createTerminalSession('terminal-one')
    const terminal = new GhosttyWTerm()
    const focus = terminal.focus
    terminalSessionTestAccess(session).state.terminal = terminal
    terminalSessionTestAccess(session).services.connection.connect()
    socket.emitServer('ready', {
      connectionId: 'connection-1',
      streamId: 'stream-1',
      generation: 2,
      controller: false,
      reset: 'full',
      cols: 100,
      rows: 30,
      revision: 1,
      snapshot: ghosttySnapshot()
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
      activity: working(25),
      attention: null
    })
    const first = manager.acquire('one')
    const second = manager.acquire('one')

    manager.release('one')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(first).toBe(second)
    expect(sessions.get('one')?.disposed).toBe(false)
    expect(manager.getActivitySnapshot().get('one')).toEqual(working(25))

    manager.release('one')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sessions.get('one')?.disposed).toBe(true)
    expect(manager.getActivitySnapshot().get('one')).toEqual(working(25))
  })

  it('does not derive durable attention from browser-observed BEL output', () => {
    const { acknowledgeAttention, manager, sessions } = fixture()
    manager.acquire('one')
    manager.release('one')
    sessions.get('one')?.ring()

    expect(manager.getAttentionSnapshot().has('one')).toBe(false)
    expect(acknowledgeAttention).not.toHaveBeenCalled()
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
      activity: working(42),
      attention: null
    })

    expect(manager.getTitleSnapshot().get('background')).toBe('pi · /repo')
    expect(manager.getProgramSnapshot().get('background')).toBe('pi')
    expect(manager.getForegroundProcessSnapshot().has('background')).toBe(true)
    expect(manager.getActivitySnapshot().get('background')).toEqual(working(42))

    manager.replaceRuntimeMetadata([
      {
        terminalId: 'other',
        title: 'shell',
        program: null,
        activity: IDLE,
        attention: null
      }
    ])
    expect(manager.getTitleSnapshot().has('background')).toBe(false)
    expect(manager.getProgramSnapshot().has('background')).toBe(false)
    expect(manager.getForegroundProcessSnapshot().has('background')).toBe(false)
    expect(manager.getActivitySnapshot().has('background')).toBe(false)
    expect(manager.getTitleSnapshot().get('other')).toBe('shell')
  })

  it('publishes each runtime update once with complete snapshots before its attention event', () => {
    const { manager, sessions } = fixture()
    const order: string[] = []
    const observed: Array<{
      title: string | undefined
      foreground: boolean
      activity: TerminalActivity | undefined
      attention: boolean
      entry: { sequence: number; unread: boolean } | undefined
    }> = []
    manager.subscribe(() => {
      order.push('store')
      observed.push({
        title: manager.getTitleSnapshot().get('background'),
        foreground: manager.getForegroundProcessSnapshot().has('background'),
        activity: manager.getActivitySnapshot().get('background'),
        attention: manager.getAttentionSnapshot().has('background'),
        entry: manager.getAttentionMetadataSnapshot().get('background')
      })
    })
    manager.subscribeAttentionEvents(() => {
      order.push('attention')
      expect(manager.getTitleSnapshot().get('background')).toBe('Pi build')
      expect(manager.getAttentionSnapshot().has('background')).toBe(true)
      expect(manager.getForegroundProcessSnapshot().has('background')).toBe(
        true
      )
      expect(manager.getActivitySnapshot().get('background')).toEqual(
        working(61)
      )
      expect(
        manager.getAttentionMetadataSnapshot().get('background')
      ).toMatchObject({
        sequence: 1,
        unread: true
      })
    })

    manager.applyRuntimeMetadata({
      terminalId: 'background',
      title: 'Pi build',
      hasForegroundProcess: true,
      activity: working(61),
      attention: {
        sequence: 1,
        at: '2026-01-01T00:01:00.000Z',
        unread: true,
        reason: 'bell'
      }
    })

    expect(order).toEqual(['store', 'attention'])
    expect(observed).toEqual([
      {
        title: 'Pi build',
        foreground: true,
        activity: working(61),
        attention: true,
        entry: {
          sequence: 1,
          at: '2026-01-01T00:01:00.000Z',
          unread: true,
          reason: 'bell'
        }
      }
    ])

    manager.acquire('background')
    sessions.get('background')?.setTitle('live session title')
    expect(order).toEqual(['store', 'attention', 'store'])
    expect(observed.at(-1)?.title).toBe('live session title')
  })

  it('emits only newer incremental attention events and keeps snapshots presentation-silent', () => {
    const { manager } = fixture()
    const events: TerminalAttentionEvent[] = []
    manager.subscribeAttentionEvents((event) => events.push(event))
    const metadata = {
      terminalId: 'background',
      title: 'Pi',
      activity: IDLE,
      attention: {
        sequence: 2,
        at: '2026-01-01T00:02:00.000Z',
        unread: true,
        reason: 'bell'
      }
    } as const

    manager.replaceRuntimeMetadata([metadata])
    expect(events).toEqual([])
    expect(manager.getAttentionMetadataSnapshot().get('background')).toEqual(
      metadata.attention
    )

    manager.applyRuntimeMetadata(metadata)
    manager.applyRuntimeMetadata({
      ...metadata,
      attention: { ...metadata.attention, unread: false }
    })
    expect(events).toEqual([])

    const next = {
      ...metadata,
      attention: {
        sequence: 3,
        at: '2026-01-01T00:03:00.000Z',
        unread: true,
        reason: 'bell'
      }
    } as const
    manager.applyRuntimeMetadata(next)
    expect(events).toEqual([
      {
        terminalId: 'background',
        sequence: 3,
        at: '2026-01-01T00:03:00.000Z',
        reason: 'bell'
      }
    ])
    expect(manager.getAttentionMetadataSnapshot().get('background')).toEqual(
      next.attention
    )
  })

  it('restores daemon attention and clears it only from authoritative metadata', async () => {
    const { acknowledgeAttention, manager } = fixture()
    const metadata = {
      terminalId: 'background',
      title: 'Pi',
      activity: IDLE,
      attention: {
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        unread: true,
        reason: 'bell'
      }
    } as const

    manager.replaceRuntimeMetadata([metadata])
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)

    manager.acquire('background')
    expect(acknowledgeAttention).not.toHaveBeenCalled()
    await manager.acknowledgeAttention('background', 1)
    expect(acknowledgeAttention).toHaveBeenCalledWith('background', 1)
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)

    manager.applyRuntimeMetadata({
      ...metadata,
      attention: { ...metadata.attention, unread: false }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)

    manager.release('background')
    manager.applyRuntimeMetadata({
      ...metadata,
      attention: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true,
        reason: 'bell'
      }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
    expect(acknowledgeAttention).toHaveBeenCalledTimes(1)

    manager.forget('background')
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)
    manager.applyRuntimeMetadata(metadata)
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
    manager.reconcile([])
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)
  })

  it('acknowledges an equal sequence again after a daemon snapshot', async () => {
    const { acknowledgeAttention, manager } = fixture()
    const metadata = {
      terminalId: 'active',
      title: null,
      activity: IDLE,
      attention: {
        sequence: 4,
        at: '2026-01-01T00:00:00.000Z',
        unread: true,
        reason: 'bell'
      }
    } as const

    manager.acquire('active')
    manager.applyRuntimeMetadata(metadata)
    await manager.acknowledgeAttention('active', 4)
    expect(acknowledgeAttention).toHaveBeenNthCalledWith(1, 'active', 4)
    manager.replaceRuntimeMetadata([metadata])
    await manager.acknowledgeAttention('active', 4)
    expect(acknowledgeAttention).toHaveBeenNthCalledWith(2, 'active', 4)
  })

  it('ignores stale incremental attention but lets snapshots reset the sequence', () => {
    const { manager } = fixture()
    const metadata = {
      terminalId: 'background',
      title: 'first',
      activity: IDLE,
      attention: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true,
        reason: 'bell'
      }
    } as const

    manager.applyRuntimeMetadata(metadata)
    manager.applyRuntimeMetadata({
      ...metadata,
      title: 'updated',
      activity: working(50),
      attention: {
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        unread: false,
        reason: 'bell'
      }
    })
    expect(manager.getAttentionSnapshot().has('background')).toBe(true)
    expect(manager.getTitleSnapshot().get('background')).toBe('updated')
    expect(manager.getActivitySnapshot().get('background')).toEqual(working(50))

    manager.applyRuntimeMetadata({
      ...metadata,
      attention: { ...metadata.attention, unread: false }
    })
    manager.applyRuntimeMetadata(metadata)
    expect(manager.getAttentionSnapshot().has('background')).toBe(false)

    manager.replaceRuntimeMetadata([
      {
        ...metadata,
        attention: {
          sequence: 1,
          at: '2026-01-01T00:02:00.000Z',
          unread: true,
          reason: 'bell'
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
    const { acknowledgeAttention, manager } = fixture()
    acknowledgeAttention.mockImplementationOnce(() => first)
    const metadata = {
      terminalId: 'active',
      title: null,
      activity: IDLE,
      attention: {
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        unread: true,
        reason: 'bell'
      }
    } as const

    manager.acquire('active')
    manager.applyRuntimeMetadata(metadata)
    void manager.acknowledgeAttention('active', 1)
    await vi.waitFor(() =>
      expect(acknowledgeAttention).toHaveBeenCalledTimes(1)
    )
    manager.applyRuntimeMetadata({
      ...metadata,
      attention: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true,
        reason: 'bell'
      }
    })
    void manager.acknowledgeAttention('active', 2)
    expect(acknowledgeAttention).toHaveBeenCalledTimes(1)

    releaseFirst()
    await vi.waitFor(() =>
      expect(acknowledgeAttention).toHaveBeenNthCalledWith(2, 'active', 2)
    )
    expect(manager.getAttentionSnapshot().has('active')).toBe(true)
  })

  it('drops stale queued acknowledgements after a snapshot reset', async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { acknowledgeAttention, manager } = fixture()
    acknowledgeAttention.mockImplementationOnce(() => first)
    const metadata = {
      terminalId: 'active',
      title: null,
      activity: IDLE,
      attention: {
        sequence: 1,
        at: '2026-01-01T00:00:00.000Z',
        unread: true,
        reason: 'bell'
      }
    } as const

    manager.acquire('active')
    manager.applyRuntimeMetadata(metadata)
    void manager.acknowledgeAttention('active', 1)
    await vi.waitFor(() =>
      expect(acknowledgeAttention).toHaveBeenCalledTimes(1)
    )
    manager.applyRuntimeMetadata({
      ...metadata,
      attention: {
        sequence: 2,
        at: '2026-01-01T00:01:00.000Z',
        unread: true,
        reason: 'bell'
      }
    })
    void manager.acknowledgeAttention('active', 2)
    manager.replaceRuntimeMetadata([
      {
        ...metadata,
        attention: {
          sequence: 2,
          at: '2026-01-01T00:01:00.000Z',
          unread: true,
          reason: 'bell'
        }
      }
    ])

    releaseFirst()
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledgeAttention).toHaveBeenCalledTimes(1)
  })

  it('allows an exact acknowledgement to be retried after failure', async () => {
    const { acknowledgeAttention, manager } = fixture()
    acknowledgeAttention.mockRejectedValueOnce(new Error('offline'))
    manager.applyRuntimeMetadata({
      terminalId: 'active',
      title: null,
      activity: IDLE,
      attention: {
        sequence: 8,
        at: '2026-01-01T00:08:00.000Z',
        unread: true,
        reason: 'bell'
      }
    })

    await expect(manager.acknowledgeAttention('active', 8)).rejects.toThrow(
      'offline'
    )
    await manager.acknowledgeAttention('active', 8)
    expect(acknowledgeAttention).toHaveBeenCalledTimes(2)
  })

  it('retains daemon activity across LRU eviction and clears it when metadata is removed', () => {
    const { manager, sessions } = fixture(1)
    manager.applyRuntimeMetadata({
      terminalId: 'one',
      title: null,
      activity: working(null),
      attention: null
    })
    manager.acquire('one')
    manager.release('one')
    manager.acquire('two')
    expect(sessions.get('one')?.disposed).toBe(true)
    expect(manager.getActivitySnapshot().has('one')).toBe(true)

    manager.reconcile([{ id: 'two' }])
    expect(manager.getActivitySnapshot().has('one')).toBe(false)
  })

  it('does not let session churn resurrect activity after a daemon clear', () => {
    const { manager, sessions } = fixture(1)
    const active = {
      terminalId: 'one',
      title: null,
      activity: working(null),
      attention: null
    } as const
    manager.applyRuntimeMetadata(active)
    manager.acquire('one')
    manager.release('one')
    manager.applyRuntimeMetadata({
      ...active,
      activity: IDLE
    })

    sessions.get('one')?.setTitle('late terminal title')
    manager.acquire('two')
    manager.acquire('one')
    expect(manager.getActivitySnapshot().has('one')).toBe(false)

    manager.applyRuntimeMetadata(active)
    expect(manager.getActivitySnapshot().get('one')).toEqual(active.activity)
    manager.forget('one')
    expect(manager.getActivitySnapshot().has('one')).toBe(false)
  })
})
