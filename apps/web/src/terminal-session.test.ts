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
  parseTerminalProgress as parseOscTerminalProgress,
  terminalProgressLabel as formatTerminalProgressLabel,
  TerminalSession,
  TerminalSessionManager as TerminalSessionManagerInstance,
  TerminalSessionSnapshot
} from './terminal-session.js'

type TerminalSessionManagerConstructor = new (
  maxSessions?: number,
  idleMs?: number,
  createSession?: (terminalId: string) => TerminalSession
) => TerminalSessionManagerInstance

let TerminalSessionManager: TerminalSessionManagerConstructor
let terminalKeyboardInput: typeof mapTerminalKeyboardInput
let terminalOptions: typeof createTerminalOptions
let parseTerminalProgress: typeof parseOscTerminalProgress
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
    progress: null,
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

  setWorking(working: boolean): void {
    this.snapshot = {
      ...this.snapshot,
      progress: working ? { state: 'indeterminate', value: null } : null
    }
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
    TerminalSessionManager,
    terminalKeyboardInput,
    terminalOptions,
    parseTerminalProgress,
    terminalProgressLabel
  } = await import('./terminal-session.js'))
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
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
      return session as unknown as TerminalSession
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
  it('parses OSC 9;4 progress states emitted by pi', () => {
    expect(parseTerminalProgress('4;3')).toEqual({
      state: 'indeterminate',
      value: null
    })
    expect(parseTerminalProgress('4;0;')).toBeNull()
  })

  it('supports determinate states and ignores unrelated or malformed OSC 9 commands', () => {
    expect(parseTerminalProgress('4;1;42')).toEqual({
      state: 'normal',
      value: 42
    })
    expect(parseTerminalProgress('4;2;100')).toEqual({
      state: 'error',
      value: 100
    })
    expect(parseTerminalProgress('4;4;7')).toEqual({
      state: 'paused',
      value: 7
    })
    expect(parseTerminalProgress('1;notification')).toBeUndefined()
    expect(parseTerminalProgress('4;1;101')).toBeUndefined()
    expect(parseTerminalProgress('4;1;1e2')).toBeUndefined()
    expect(parseTerminalProgress('4;1; 42')).toBeUndefined()
  })

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
      progress: { state: 'normal', value: 42 }
    })

    expect(manager.getTitleSnapshot().get('background')).toBe('pi · /repo')
    expect(manager.getProgressSnapshot().get('background')).toEqual({
      state: 'normal',
      value: 42
    })

    manager.replaceRuntimeMetadata([
      { terminalId: 'other', title: 'shell', progress: null }
    ])
    expect(manager.getTitleSnapshot().has('background')).toBe(false)
    expect(manager.getProgressSnapshot().has('background')).toBe(false)
    expect(manager.getTitleSnapshot().get('other')).toBe('shell')
  })

  it('retains progress across LRU eviction and clears it when metadata is removed', () => {
    const { manager, sessions } = fixture(1)
    manager.acquire('one')
    manager.release('one')
    sessions.get('one')?.setWorking(true)
    manager.acquire('two')
    expect(sessions.get('one')?.disposed).toBe(true)
    expect(manager.getProgressSnapshot().has('one')).toBe(true)

    manager.reconcile([{ id: 'two' }])
    expect(manager.getProgressSnapshot().has('one')).toBe(false)
  })

  it('publishes terminal progress and clears it when work stops or the terminal is forgotten', () => {
    const { manager, sessions } = fixture()
    manager.acquire('one')
    sessions.get('one')?.setWorking(true)
    expect(manager.getProgressSnapshot().get('one')).toEqual({
      state: 'indeterminate',
      value: null
    })

    sessions.get('one')?.setWorking(false)
    expect(manager.getProgressSnapshot().has('one')).toBe(false)

    sessions.get('one')?.setWorking(true)
    manager.forget('one')
    expect(manager.getProgressSnapshot().has('one')).toBe(false)
  })
})
