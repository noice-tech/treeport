import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalProgress,
  TerminalRecord,
  WorktreeRecord
} from '@tasktty/shared'
import {
  ProductEventBus,
  type TaskTTYService,
  type TmuxAdapter,
  type TmuxSessionTitleState
} from '@tasktty/core'
import {
  TerminalMetadataManager,
  TERMINAL_METADATA_POLL_MS,
  TERMINAL_PROGRESS_STALE_MS
} from './terminal-metadata.js'
import type {
  TerminalProgressObserver,
  TmuxProgressObserverOptions
} from './tmux-progress.js'

class FakeObserver implements TerminalProgressObserver {
  disposed = false

  constructor(readonly options: TmuxProgressObserverOptions) {}

  title(title: string): void {
    this.options.onTitle?.(title)
  }

  progress(
    progress: Parameters<TmuxProgressObserverOptions['onProgress']>[0]
  ): void {
    this.options.onProgress(progress)
  }

  bell(): void {
    this.options.onBell?.()
  }

  exit(): void {
    this.options.onExit()
  }

  dispose(): void {
    this.disposed = true
  }
}

const worktree = {
  id: 'wt',
  projectId: 'project',
  path: '/repo',
  tmuxSocketName: 'socket',
  terminals: []
} as unknown as WorktreeRecord

function terminal(id: string): TerminalRecord {
  return {
    id,
    worktreeId: worktree.id,
    name: 'Terminal',
    tmuxSessionName: `session-${id}`,
    argv: ['pi'],
    status: 'running',
    exitCode: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01'
  }
}

function fixture(initialTerminals: TerminalRecord[]) {
  const terminals = new Map(initialTerminals.map((item) => [item.id, item]))
  const events = new ProductEventBus()
  const refreshTerminalStatus = vi.fn(async (terminalId: string) =>
    terminals.get(terminalId)!
  )
  const service = {
    events,
    database: {
      worktree: (worktreeId: string) =>
        worktreeId === worktree.id ? worktree : undefined
    },
    listProjects: vi.fn(async () => [
      { worktrees: [{ ...worktree, terminals: [...terminals.values()] }] }
    ]),
    getTerminal: vi.fn(async (terminalId: string) => {
      const item = terminals.get(terminalId)
      if (!item) {
        throw new Error('missing')
      }

      return item
    }),
    refreshTerminalStatus
  } as unknown as TaskTTYService
  const sessionTitleState = vi.fn(
    async (
      _socket: string,
      sessionName: string
    ): Promise<TmuxSessionTitleState> => ({
      paneTitle: `title ${sessionName}`,
      currentCommand: 'node',
      shellTitle: null
    })
  )
  const setSessionShellTitle = vi.fn(async () => undefined)
  const tmux = {
    configPath: '/runtime/tmux.conf',
    sessionTitleState,
    setSessionShellTitle
  } as unknown as TmuxAdapter
  const observers: FakeObserver[] = []
  const createObserver = vi.fn((options: TmuxProgressObserverOptions) => {
    const observer = new FakeObserver(options)
    observers.push(observer)
    return observer
  })
  const manager = new TerminalMetadataManager(
    service,
    tmux,
    process.execPath,
    createObserver
  )
  return {
    manager,
    events,
    observers,
    refreshTerminalStatus,
    sessionTitleState,
    setSessionShellTitle,
    terminals
  }
}

const managers: TerminalMetadataManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.dispose()
  }
  vi.useRealTimers()
})

describe('TerminalMetadataManager', () => {
  it('observes every running terminal for the daemon lifetime and publishes metadata', async () => {
    const first = terminal('one')
    const second = terminal('two')
    const { manager, events, observers } = fixture([first, second])
    managers.push(manager)
    const published: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'terminal.metadata') {
        published.push(event.data)
      }
    })

    await manager.initialize()
    expect(observers).toHaveLength(2)
    expect(manager.snapshot()).toEqual([
      {
        terminalId: 'one',
        title: 'title session-one',
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      },
      {
        terminalId: 'two',
        title: 'title session-two',
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])

    observers[1]!.title('pi · /repo')
    observers[1]!.progress({ state: 'indeterminate', value: null })
    expect(manager.get('two')).toEqual({
      terminalId: 'two',
      title: 'pi · /repo',
      progress: { state: 'indeterminate', value: null },
      progressStartedAt: expect.any(String),
      progressClearedAt: null,
      bell: null
    })
    expect(published).toContainEqual({
      terminalId: 'two',
      title: 'pi · /repo',
      progress: { state: 'indeterminate', value: null },
      progressStartedAt: expect.any(String),
      progressClearedAt: null,
      bell: null
    })
  })

  it('polls unviewed terminals for title/status changes and stops exited observers', async () => {
    vi.useFakeTimers()
    const item = terminal('one')
    const {
      manager,
      observers,
      refreshTerminalStatus,
      sessionTitleState,
      terminals
    } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    observers[0]!.progress({ state: 'normal', value: 40 })
    terminals.set('one', { ...item, status: 'exited', exitCode: 0 })
    sessionTitleState.mockResolvedValue({
      paneTitle: 'finished',
      currentCommand: 'node'
    })

    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)

    expect(refreshTerminalStatus).toHaveBeenCalledWith('one', false)
    expect(manager.get('one')).toEqual({
      terminalId: 'one',
      title: 'finished',
      progress: null,
      progressStartedAt: expect.any(String),
      progressClearedAt: expect.any(String),
      bell: null
    })
    expect(observers[0]!.disposed).toBe(true)
  })

  it('shows a foreground command and restores the shell pane title when it exits', async () => {
    vi.useFakeTimers()
    const item = { ...terminal('one'), argv: ['/bin/zsh', '-l'] }
    const { manager, sessionTitleState } = fixture([item])
    managers.push(manager)
    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'zsh'
    })
    await manager.initialize()

    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'nano'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('nano')

    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'zsh'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('tasktty')
  })

  it('prefers an existing application title when tracking starts while it is running', async () => {
    vi.useFakeTimers()
    const item = { ...terminal('one'), argv: ['/bin/zsh', '-l'] }
    const { manager, sessionTitleState } = fixture([item])
    managers.push(manager)
    sessionTitleState.mockResolvedValue({
      paneTitle: 'π',
      currentCommand: 'node',
      shellTitle: 'tasktty'
    })
    await manager.initialize()
    expect(manager.get(item.id).title).toBe('π')

    sessionTitleState.mockResolvedValue({
      paneTitle: 'π',
      currentCommand: 'rg',
      shellTitle: 'tasktty'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('π')

    sessionTitleState.mockResolvedValue({
      paneTitle: 'π',
      currentCommand: 'zsh',
      shellTitle: 'tasktty'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('tasktty')
  })

  it('prefers the existing pane title when no remembered shell title can identify it as stale', async () => {
    const item = { ...terminal('one'), argv: ['/bin/zsh', '-l'] }
    const { manager, sessionTitleState } = fixture([item])
    managers.push(manager)
    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'nano'
    })

    await manager.initialize()

    expect(manager.get(item.id).title).toBe('tasktty')
  })

  it('waits for a fresh shell title after an application started without a remembered shell title', async () => {
    vi.useFakeTimers()
    const item = { ...terminal('one'), argv: ['/bin/zsh', '-l'] }
    const { manager, sessionTitleState, setSessionShellTitle } = fixture([item])
    managers.push(manager)
    sessionTitleState.mockResolvedValue({
      paneTitle: 'π',
      currentCommand: 'node'
    })
    await manager.initialize()
    expect(manager.get(item.id).title).toBe('π')

    sessionTitleState.mockResolvedValue({
      paneTitle: 'π',
      currentCommand: 'zsh'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS * 2)
    expect(manager.get(item.id).title).toBe('zsh')
    expect(setSessionShellTitle).not.toHaveBeenCalled()

    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'zsh'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('tasktty')
    await vi.waitFor(() =>
      expect(setSessionShellTitle).toHaveBeenCalledWith(
        'socket',
        item.tmuxSessionName,
        'tasktty'
      )
    )
  })

  it('uses a remembered shell title to identify a title-less foreground command after restart', async () => {
    vi.useFakeTimers()
    const item = { ...terminal('one'), argv: ['/bin/zsh', '-l'] }
    const { manager, sessionTitleState } = fixture([item])
    managers.push(manager)
    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'npm',
      shellTitle: 'tasktty'
    })
    await manager.initialize()
    expect(manager.get(item.id).title).toBe('npm')

    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'zsh',
      shellTitle: 'tasktty'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('tasktty')
  })

  it('retries a failed shell title persistence write on a later reconciliation', async () => {
    vi.useFakeTimers()
    const item = { ...terminal('one'), argv: ['/bin/zsh', '-l'] }
    const { manager, sessionTitleState, setSessionShellTitle } = fixture([item])
    managers.push(manager)
    setSessionShellTitle.mockRejectedValueOnce(new Error('tmux unavailable'))
    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'zsh'
    })
    await manager.initialize()
    await vi.waitFor(() =>
      expect(setSessionShellTitle).toHaveBeenCalledTimes(1)
    )

    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'nano'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)

    await vi.waitFor(() =>
      expect(setSessionShellTitle).toHaveBeenCalledTimes(2)
    )
    expect(manager.get(item.id).title).toBe('nano')
  })

  it('keeps an application title while the application runs helper processes', async () => {
    vi.useFakeTimers()
    const item = { ...terminal('one'), argv: ['/bin/zsh', '-l'] }
    const { manager, observers, sessionTitleState } = fixture([item])
    managers.push(manager)
    sessionTitleState.mockResolvedValue({
      paneTitle: 'tasktty',
      currentCommand: 'zsh'
    })
    await manager.initialize()

    observers[0]!.title('editor')
    sessionTitleState.mockResolvedValue({
      paneTitle: 'editor',
      currentCommand: 'vim'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('editor')

    sessionTitleState.mockResolvedValue({
      paneTitle: 'editor',
      currentCommand: 'rg'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('editor')

    sessionTitleState.mockResolvedValue({
      paneTitle: 'editor',
      currentCommand: 'zsh'
    })
    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    expect(manager.get(item.id).title).toBe('tasktty')
  })

  it('does not overwrite observer titles with an older tmux lookup', async () => {
    const item = terminal('one')
    const { manager, observers, sessionTitleState } = fixture([item])
    managers.push(manager)
    let resolveTitle!: (state: {
      paneTitle: string
      currentCommand: string
    }) => void
    sessionTitleState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTitle = resolve
        })
    )

    const initialTrack = manager.trackTerminal(item, worktree)
    await vi.waitFor(() => expect(observers).toHaveLength(1))
    observers[0]!.title('new observer title')
    resolveTitle({
      paneTitle: 'stale polled title',
      currentCommand: 'node'
    })
    await initialTrack

    expect(manager.get(item.id).title).toBe('new observer title')
  })

  it('does not revive runtime when a poll returns after the terminal exits', async () => {
    vi.useFakeTimers()
    const item = terminal('one')
    const { manager, observers, refreshTerminalStatus } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    let resolveStatus!: (terminal: TerminalRecord) => void
    refreshTerminalStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        })
    )

    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)
    await manager.trackTerminal(
      { ...item, status: 'exited', exitCode: 0 },
      worktree
    )
    resolveStatus(item)
    await vi.advanceTimersByTimeAsync(0)

    expect(observers).toHaveLength(1)
    expect(observers[0]!.disposed).toBe(true)
  })

  it('does not revive an observer when an older title lookup finishes after exit', async () => {
    const item = terminal('one')
    const { manager, observers, sessionTitleState } = fixture([item])
    managers.push(manager)
    let resolveTitle!: (state: {
      paneTitle: string
      currentCommand: string
    }) => void
    sessionTitleState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTitle = resolve
        })
    )

    const initialTrack = manager.trackTerminal(item, worktree)
    await vi.waitFor(() => expect(observers).toHaveLength(1))
    await manager.trackTerminal(
      { ...item, status: 'exited', exitCode: 0 },
      worktree
    )
    resolveTitle({
      paneTitle: 'stale running title',
      currentCommand: 'node'
    })
    await initialTrack

    expect(observers).toHaveLength(1)
    expect(observers[0]!.disposed).toBe(true)
    expect(manager.get(item.id)).toEqual({
      terminalId: item.id,
      title: null,
      progress: null,
      progressStartedAt: null,
      progressClearedAt: null,
      bell: null
    })
  })

  it('records progress transitions and daemon-observed bells without duplicating keepalives', async () => {
    const item = terminal('one')
    const { manager, observers, events } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    const published: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'terminal.metadata') {
        published.push(event.data)
      }
    })

    observers[0]!.progress({ state: 'indeterminate', value: null })
    const startedAt = manager.get('one').progressStartedAt
    observers[0]!.progress({ state: 'indeterminate', value: null })
    observers[0]!.bell()
    observers[0]!.bell()
    observers[0]!.progress(null)
    const cleared = manager.get('one')
    observers[0]!.progress(null)

    expect(startedAt).toEqual(expect.any(String))
    expect(cleared).toMatchObject({
      progress: null,
      progressStartedAt: startedAt,
      progressClearedAt: expect.any(String),
      bell: { sequence: 2, at: expect.any(String) }
    })
    expect(published).toHaveLength(4)
  })

  it('expires stale progress while duplicate keepalives renew its lease', async () => {
    vi.useFakeTimers()
    const item = terminal('one')
    const { manager, observers, events } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    const published: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'terminal.metadata') {
        published.push(event.data)
      }
    })

    observers[0]!.progress({ state: 'indeterminate', value: null })
    await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS - 1)
    observers[0]!.progress({ state: 'indeterminate', value: null })
    expect(published).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS - 1)
    expect(manager.get('one').progress).toEqual({
      state: 'indeterminate',
      value: null
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(manager.get('one')).toMatchObject({
      progress: null,
      progressStartedAt: expect.any(String),
      progressClearedAt: expect.any(String)
    })
    expect(published).toHaveLength(2)
  })

  it('expires every active progress state', async () => {
    vi.useFakeTimers()
    const item = terminal('one')
    const { manager, observers } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    const states: TerminalProgress[] = [
      { state: 'normal', value: 25 },
      { state: 'indeterminate', value: null },
      { state: 'error', value: 50 },
      { state: 'paused', value: 75 }
    ]

    for (const progress of states) {
      observers[0]!.progress(progress)
      await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS)
      expect(manager.get('one').progress).toBeNull()
    }
  })

  it('does not let an older deadline clear changed progress', async () => {
    vi.useFakeTimers()
    const item = terminal('one')
    const { manager, observers, events } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    const published: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'terminal.metadata') {
        published.push(event.data)
      }
    })

    observers[0]!.progress({ state: 'normal', value: 25 })
    await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS - 1)
    observers[0]!.progress({ state: 'error', value: 50 })
    await vi.advanceTimersByTimeAsync(1)
    expect(manager.get('one').progress).toEqual({ state: 'error', value: 50 })

    await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS - 1)
    expect(manager.get('one').progress).toBeNull()
    expect(published).toHaveLength(3)
  })

  it('invalidates progress leases on explicit clear and observer exit', async () => {
    vi.useFakeTimers()
    const item = terminal('one')
    const { manager, observers, events } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    const published: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'terminal.metadata') {
        published.push(event.data)
      }
    })

    observers[0]!.progress({ state: 'normal', value: 25 })
    observers[0]!.progress(null)
    await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS)
    expect(manager.get('one').progress).toBeNull()
    expect(published).toHaveLength(2)

    observers[0]!.progress({ state: 'normal', value: 50 })
    observers[0]!.exit()
    observers[0]!.progress({ state: 'normal', value: 75 })
    await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS)
    expect(manager.get('one').progress).toBeNull()
    expect(published).toHaveLength(4)
  })

  it('invalidates old leases when a terminal entry is replaced or removed', async () => {
    vi.useFakeTimers()
    const item = terminal('one')
    const { manager, observers, events } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    const published: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'terminal.metadata') {
        published.push(event.data)
      }
    })
    observers[0]!.progress({ state: 'normal', value: 25 })
    await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS - 1)

    const replacement = {
      ...item,
      tmuxSessionName: 'replacement-session'
    }
    await manager.trackTerminal(replacement, worktree)
    expect(observers[0]!.disposed).toBe(true)
    expect(observers).toHaveLength(2)
    observers[0]!.progress({ state: 'normal', value: 75 })
    observers[1]!.progress({ state: 'paused', value: 50 })
    await vi.advanceTimersByTimeAsync(1)
    expect(manager.get('one').progress).toEqual({
      state: 'paused',
      value: 50
    })

    manager.removeTerminal('one')
    const eventCount = published.length
    await vi.advanceTimersByTimeAsync(TERMINAL_PROGRESS_STALE_MS)
    expect(manager.snapshot()).toEqual([])
    expect(published).toHaveLength(eventCount)
  })

  it('tracks terminals created after startup and disposes them on removal', async () => {
    const { manager, events, observers, terminals } = fixture([])
    managers.push(manager)
    await manager.initialize()
    const created = terminal('new')
    terminals.set(created.id, created)

    events.publish('terminal.created', {
      terminalId: created.id,
      worktreeId: worktree.id
    })
    await vi.waitFor(() =>
      expect(manager.snapshot()).toContainEqual({
        terminalId: created.id,
        title: 'title session-new',
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      })
    )
    expect(observers).toHaveLength(1)

    events.publish('terminal.removed', {
      terminalId: created.id,
      worktreeId: worktree.id
    })
    expect(manager.snapshot()).toEqual([])
    expect(observers[0]!.disposed).toBe(true)
  })
})
