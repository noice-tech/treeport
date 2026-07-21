import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalRecord, WorktreeRecord } from '@tasktty/shared'
import {
  ProductEventBus,
  type TaskTTYService,
  type TmuxAdapter
} from '@tasktty/core'
import {
  TerminalMetadataManager,
  TERMINAL_METADATA_POLL_MS
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
  const sessionTitle = vi.fn(
    async (_socket: string, sessionName: string) => `title ${sessionName}`
  )
  const tmux = {
    configPath: '/runtime/tmux.conf',
    sessionTitle
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
    sessionTitle,
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
      { terminalId: 'one', title: 'title session-one', progress: null },
      { terminalId: 'two', title: 'title session-two', progress: null }
    ])

    observers[1]!.title('pi · /repo')
    observers[1]!.progress({ state: 'indeterminate', value: null })
    expect(manager.get('two')).toEqual({
      terminalId: 'two',
      title: 'pi · /repo',
      progress: { state: 'indeterminate', value: null }
    })
    expect(published).toContainEqual({
      terminalId: 'two',
      title: 'pi · /repo',
      progress: { state: 'indeterminate', value: null }
    })
  })

  it('polls unviewed terminals for title/status changes and stops exited observers', async () => {
    vi.useFakeTimers()
    const item = terminal('one')
    const {
      manager,
      observers,
      refreshTerminalStatus,
      sessionTitle,
      terminals
    } = fixture([item])
    managers.push(manager)
    await manager.initialize()
    observers[0]!.progress({ state: 'normal', value: 40 })
    terminals.set('one', { ...item, status: 'exited', exitCode: 0 })
    sessionTitle.mockResolvedValue('finished')

    await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_POLL_MS)

    expect(refreshTerminalStatus).toHaveBeenCalledWith('one')
    expect(manager.get('one')).toEqual({
      terminalId: 'one',
      title: 'finished',
      progress: null
    })
    expect(observers[0]!.disposed).toBe(true)
  })

  it('does not overwrite observer titles with an older tmux lookup', async () => {
    const item = terminal('one')
    const { manager, observers, sessionTitle } = fixture([item])
    managers.push(manager)
    let resolveTitle!: (title: string) => void
    sessionTitle.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveTitle = resolve
        })
    )

    const initialTrack = manager.trackTerminal(item, worktree)
    await vi.waitFor(() => expect(observers).toHaveLength(1))
    observers[0]!.title('new observer title')
    resolveTitle('stale polled title')
    await initialTrack

    expect(manager.get(item.id).title).toBe('new observer title')
  })

  it('does not revive an observer when an older title lookup finishes after exit', async () => {
    const item = terminal('one')
    const { manager, observers, sessionTitle } = fixture([item])
    managers.push(manager)
    let resolveTitle!: (title: string) => void
    sessionTitle.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveTitle = resolve
        })
    )

    const initialTrack = manager.trackTerminal(item, worktree)
    await vi.waitFor(() => expect(observers).toHaveLength(1))
    await manager.trackTerminal(
      { ...item, status: 'exited', exitCode: 0 },
      worktree
    )
    resolveTitle('stale running title')
    await initialTrack

    expect(observers).toHaveLength(1)
    expect(observers[0]!.disposed).toBe(true)
    expect(manager.get(item.id)).toEqual({
      terminalId: item.id,
      title: null,
      progress: null
    })
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
        progress: null
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
