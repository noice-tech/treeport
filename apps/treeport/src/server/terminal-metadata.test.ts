import type { TerminalRecord, WorktreeRecord } from '@treeport/shared'
import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'
import { ProductEventBus } from './core/events'
import type { TreeportService } from './core/index'
import type {
  TerminalBellState,
  TerminalBellStateStore
} from './core/terminal-bell-state-store'
import type {
  TerminalAttachmentBackend,
  TerminalHostRuntimeEvent
} from './terminal-host-sessions'
import { TerminalMetadataManager } from './terminal-metadata'
import { testAccess } from './test-access'

type HostRuntimeState = NonNullable<
  Awaited<ReturnType<TerminalAttachmentBackend['runtimeState']>>
>

class HostDouble implements TerminalAttachmentBackend {
  readonly listeners = new Map<
    string,
    Set<(event: TerminalHostRuntimeEvent) => void>
  >()
  titleState = {
    terminalTitle: null,
    currentCommand: 'zsh',
    commandLine: 'zsh'
  }
  state: HostRuntimeState = {
    title: null,
    status: 'running',
    progress: null,
    bell: null
  }

  attach() {
    return Promise.resolve({
      data: '',
      links: [],
      fence: 0,
      cols: 100,
      rows: 30,
      unsubscribe: () => undefined
    })
  }
  subscribeRuntime(
    terminalId: string,
    listener: (event: TerminalHostRuntimeEvent) => void
  ) {
    const listeners =
      this.listeners.get(terminalId) ??
      new Set<(event: TerminalHostRuntimeEvent) => void>()
    listeners.add(listener)
    this.listeners.set(terminalId, listeners)
    return () => listeners.delete(listener)
  }
  terminalTitleState() {
    return Promise.resolve(this.titleState)
  }
  runtimeState() {
    return Promise.resolve(this.state)
  }
  write() {
    return Promise.resolve()
  }
  prepareQueryAuthority() {
    return Promise.resolve({ transitionId: 'transition', fence: 0 })
  }
  activateQueryAuthority() {
    return Promise.resolve()
  }
  useHostQueryAuthority() {
    return Promise.resolve()
  }
  resize() {
    return Promise.resolve()
  }
  dispose() {}

  emit(terminalId: string, event: TerminalHostRuntimeEvent): void {
    for (const listener of this.listeners.get(terminalId) ?? []) {
      listener(event)
    }
  }
}

class BellStoreDouble implements TerminalBellStateStore {
  readonly states = new Map<string, TerminalBellState>()
  readonly upsert = vi.fn(async (state: TerminalBellState) => {
    this.states.set(state.terminalId, state)
  })
  readonly markRead = vi.fn(async (terminalId: string, sequence: number) => {
    const state = this.states.get(terminalId)
    if (state?.sequence === sequence) {
      this.states.set(terminalId, { ...state, unread: false })
    }
  })
  readonly delete = vi.fn(async (terminalId: string) => {
    this.states.delete(terminalId)
  })
  load() {
    return Promise.resolve([...this.states.values()])
  }
}

const terminal: TerminalRecord = {
  id: 'terminal',
  worktreeId: 'worktree',
  name: 'Shell',
  argv: ['/bin/zsh', '-l'],
  shellCommand: null,
  interactiveShell: true,
  status: 'running',
  exitCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

function fixture(states: TerminalBellState[] = []) {
  const events = new ProductEventBus()
  const host = new HostDouble()
  const bells = new BellStoreDouble()
  for (const state of states) {
    bells.states.set(state.terminalId, state)
  }
  const listProjects = vi.fn(() => Effect.succeed([]))
  const getTerminal = vi.fn(() => Effect.succeed(terminal))
  const getWorktree = vi.fn(() =>
    Effect.succeed(
      testAccess<WorktreeRecord>({ id: 'worktree', path: '/repo' })
    )
  )
  // SAFETY: The fixture supplies the service methods used by metadata.
  const service = testAccess<TreeportService>({
    events,
    database: {},
    listProjects,
    getTerminal,
    getWorktree,
    projects: { listProjects, getWorktree },
    terminals: { getTerminal },
    runEffect: vi.fn((effect) =>
      Effect.isEffect(effect)
        ? Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>)
        : effect
    ),
    forkApplicationEffect: vi.fn((effect) => {
      // SAFETY: The metadata fixture provides every service required by the effect.
      Effect.runFork(effect as Effect.Effect<void, never, never>)
    }),
    terminalMetadataMutation: vi.fn((_terminalId, effect) => effect),
    drainTerminalMetadataMutations: vi.fn(() => Effect.void)
  })
  const manager = new TerminalMetadataManager(service, host, bells)
  return { bells, events, host, manager, service }
}

describe('TerminalMetadataManager', () => {
  it('projects host title, command, progress, BEL, and exit events', async () => {
    const { bells, events, host, manager, service } = fixture()
    const published: string[] = []
    events.subscribe((event) => {
      if (event.type === 'terminal.metadata') {
        published.push(
          `${event.data.title}:${event.data.program}:${event.data.progress?.value ?? 'none'}`
        )
      }
    })
    await service.runEffect(manager.initialize())
    await service.runEffect(
      manager.trackTerminal(terminal, testAccess({ id: 'worktree' }))
    )

    host.emit('terminal', {
      titleState: {
        terminalTitle: null,
        currentCommand: 'pi',
        commandLine: 'pi --mode rpc'
      }
    })
    host.emit('terminal', {
      progress: { state: 'normal', value: 42 }
    })
    host.emit('terminal', {
      bell: { sequence: 1, at: '2026-01-01T00:01:00.000Z' }
    })
    await service.runEffect(manager.drain())

    expect(manager.get('terminal')).toMatchObject({
      title: 'pi --mode rpc',
      program: 'pi',
      hasForegroundProcess: true,
      progress: { state: 'normal', value: 42 },
      bell: { sequence: 1, unread: true }
    })
    expect(bells.upsert).toHaveBeenCalledOnce()
    expect(published).toContain('pi --mode rpc:pi:42')

    host.emit('terminal', { exitCode: 7 })
    expect(manager.get('terminal')).toMatchObject({
      hasForegroundProcess: false,
      progress: null
    })
    manager.dispose()
  })

  it('restores progress and exactly one detached BEL from host state', async () => {
    const existing: TerminalBellState = {
      terminalId: 'terminal',
      worktreeId: 'worktree',
      sequence: 3,
      occurredAt: '2026-01-01T00:00:00.000Z',
      unread: true
    }
    const { bells, host, manager, service } = fixture([existing])
    host.state.progress = { state: 'normal', value: 71 }
    host.state.bell = {
      sequence: 4,
      at: '2026-01-01T00:01:00.000Z'
    }
    await service.runEffect(manager.initialize())
    await service.runEffect(
      manager.trackTerminal(terminal, testAccess({ id: 'worktree' }))
    )
    await service.runEffect(manager.drain())

    expect(manager.get('terminal')).toMatchObject({
      progress: { state: 'normal', value: 71 },
      bell: { sequence: 4, unread: true }
    })
    expect(bells.upsert).toHaveBeenCalledTimes(1)

    host.emit('terminal', {
      bell: { sequence: 4, at: '2026-01-01T00:01:00.000Z' }
    })
    await service.runEffect(manager.drain())
    expect(bells.upsert).toHaveBeenCalledTimes(1)

    await service.runEffect(manager.acknowledgeBell('terminal', 4))
    expect(bells.markRead).toHaveBeenCalledWith('terminal', 4)
    expect(manager.get('terminal').bell).toMatchObject({
      sequence: 4,
      unread: false
    })
    manager.dispose()
  })

  it('removes runtime subscriptions and persisted BEL state with a terminal', async () => {
    const { bells, host, manager, service } = fixture()
    await service.runEffect(manager.initialize())
    await service.runEffect(
      manager.trackTerminal(terminal, testAccess({ id: 'worktree' }))
    )
    host.emit('terminal', {
      bell: { sequence: 1, at: '2026-01-01T00:01:00.000Z' }
    })
    await service.runEffect(manager.drain())

    manager.removeTerminal('terminal')
    await service.runEffect(manager.drain())
    expect(host.listeners.get('terminal')?.size ?? 0).toBe(0)
    expect(bells.delete).toHaveBeenCalledWith('terminal')
    expect(manager.get('terminal').bell).toBeNull()
    manager.dispose()
  })
})
