import type {
  TerminalActivity,
  TerminalRecord,
  WorktreeRecord
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { describe, expect, it, vi } from 'vitest'
import { ProductEventBus } from './core/events'
import type { TreeportService } from './core/index'
import type {
  TerminalAttentionState,
  TerminalAttentionStateStore
} from './core/terminal-attention-state-store'
import type {
  TerminalAttachmentBackend,
  TerminalHostRuntimeEvent,
  TerminalTitleState
} from './core/terminal'
import { TerminalMetadataManager } from './terminal-metadata'
import { testAccess } from './test-access'

const IDLE: TerminalActivity = {
  state: 'idle',
  kind: null,
  progress: null,
  app: null,
  message: null,
  since: null
}

type HostRuntimeState = {
  title: string | null
  status: 'running' | 'exited'
  activity: TerminalActivity
  attention: {
    sequence: number
    at: string
    reason: 'bell' | 'done' | 'blocked' | 'error'
  } | null
}

class HostDouble implements TerminalAttachmentBackend {
  readonly listeners = new Map<
    string,
    Set<(event: TerminalHostRuntimeEvent) => void>
  >()
  titleState: TerminalTitleState = {
    title: null,
    command: null,
    running: false
  }
  state: HostRuntimeState = {
    title: null,
    status: 'running',
    activity: IDLE,
    attention: null
  }

  attach() {
    return Effect.succeed({
      data: '',
      format: 'ghostty' as const,
      fence: 0,
      cols: 100,
      rows: 30,
      output: Stream.empty
    })
  }
  runtimeEvents(terminalId: string) {
    return Stream.asyncScoped<TerminalHostRuntimeEvent>((emit) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listeners =
            this.listeners.get(terminalId) ??
            new Set<(event: TerminalHostRuntimeEvent) => void>()

          const listener = (event: TerminalHostRuntimeEvent) =>
            emit.single(event)

          listeners.add(listener)
          this.listeners.set(terminalId, listeners)

          return listener
        }),
        (listener) =>
          Effect.sync(() => {
            this.listeners.get(terminalId)?.delete(listener)
          })
      )
    )
  }
  terminalTitleState() {
    return Effect.succeed(this.titleState)
  }
  runtimeState() {
    return Effect.succeed(this.state)
  }
  write() {
    return Effect.void
  }
  prepareQueryAuthority() {
    return Effect.succeed({ transitionId: 'transition', fence: 0 })
  }
  activateQueryAuthority() {
    return Effect.void
  }
  useHostQueryAuthority() {
    return Effect.void
  }
  resize() {
    return Effect.void
  }

  emit(terminalId: string, event: TerminalHostRuntimeEvent): void {
    for (const listener of this.listeners.get(terminalId) ?? []) {
      listener(event)
    }
  }
}

class AttentionStoreDouble implements TerminalAttentionStateStore {
  readonly states = new Map<string, TerminalAttentionState>()
  readonly upsert = vi.fn((state: TerminalAttentionState) =>
    Effect.sync(() => {
      this.states.set(state.terminalId, state)
    })
  )
  readonly markRead = vi.fn((terminalId: string, sequence: number) =>
    Effect.sync(() => {
      const state = this.states.get(terminalId)

      if (state?.sequence === sequence) {
        this.states.set(terminalId, { ...state, unread: false })
      }
    })
  )
  readonly delete = vi.fn((terminalId: string) =>
    Effect.sync(() => {
      this.states.delete(terminalId)
    })
  )
  load() {
    return Effect.sync(() => [...this.states.values()])
  }
}

const terminal: TerminalRecord = {
  id: 'terminal',
  worktreeId: 'worktree',
  name: 'Shell',
  command: null,
  status: 'running',
  exitCode: null,
  parentTerminalId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

function fixture(states: TerminalAttentionState[] = []) {
  const events = new ProductEventBus()
  const host = new HostDouble()
  const attention = new AttentionStoreDouble()

  for (const state of states) {
    attention.states.set(state.terminalId, state)
  }

  const listProjects = vi.fn(() => Effect.succeed([]))
  const getTerminal = vi.fn(() => Effect.succeed(terminal))

  const refreshTerminalStatus = vi.fn(() =>
    Effect.succeed({ ...terminal, status: 'exited' as const, exitCode: 7 })
  )

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
    terminals: { getTerminal, refreshTerminalStatus },
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

  const manager = new TerminalMetadataManager(service, host, attention)

  return { attention, events, host, manager, refreshTerminalStatus, service }
}

describe('TerminalMetadataManager', () => {
  it('projects host title, command, activity, attention, and exit events', async () => {
    const { attention, events, host, manager, refreshTerminalStatus, service } =
      fixture()

    const published: string[] = []
    events.subscribe((event) => {
      if (event.type === 'terminal.metadata') {
        published.push(
          `${event.data.title}:${event.data.program}:${event.data.activity.progress ?? 'none'}`
        )
      }
    })
    await service.runEffect(manager.initialize())
    await service.runEffect(
      manager.trackTerminal(
        { ...terminal, command: 'pnpm test' },
        testAccess({ id: 'worktree' })
      )
    )

    host.emit('terminal', {
      titleState: {
        title: 'pi --mode rpc',
        command: 'pi --mode rpc',
        running: true
      }
    })
    host.emit('terminal', {
      activity: { ...IDLE, state: 'working', progress: 42 }
    })
    host.emit('terminal', {
      attention: { sequence: 1, at: '2026-01-01T00:01:00.000Z', reason: 'bell' }
    })
    await vi.waitFor(() =>
      expect(manager.get('terminal').attention?.sequence).toBe(1)
    )
    await service.runEffect(manager.drain())

    expect(manager.get('terminal')).toMatchObject({
      title: 'pi --mode rpc',
      program: 'pi',
      hasForegroundProcess: true,
      activity: { state: 'working', progress: 42 },
      attention: { sequence: 1, unread: true, reason: 'bell' }
    })
    expect(attention.upsert).toHaveBeenCalledOnce()
    expect(published).toContain('pi --mode rpc:pi:42')

    host.emit('terminal', { commandExitCode: 7 })
    await vi.waitFor(() =>
      expect(refreshTerminalStatus).toHaveBeenCalledExactlyOnceWith(
        'terminal',
        false
      )
    )
    expect(host.listeners.get('terminal')?.size).toBe(1)
    expect(manager.get('terminal').activity).toMatchObject({
      state: 'working',
      progress: 42
    })
    refreshTerminalStatus.mockClear()

    host.titleState = { title: '~/repo', command: null, running: false }
    host.emit('terminal', { titleState: host.titleState })
    await vi.waitFor(() =>
      expect(manager.get('terminal').hasForegroundProcess).toBe(false)
    )
    await service.runEffect(
      manager.trackTerminal(
        {
          ...terminal,
          command: 'pnpm test',
          commandExitCode: 7
        },
        testAccess({ id: 'worktree' })
      )
    )
    expect(manager.get('terminal').hasForegroundProcess).toBe(false)
    const restored = new TerminalMetadataManager(service, host, attention)
    await service.runEffect(
      restored.trackTerminal(
        {
          ...terminal,
          command: 'pnpm test',
          commandExitCode: 7
        },
        testAccess({ id: 'worktree' })
      )
    )
    expect(restored.get('terminal').hasForegroundProcess).toBe(false)
    restored.dispose()

    host.emit('terminal', {
      titleState: {
        title: 'pi --mode rpc',
        command: 'pi --mode rpc',
        running: true
      }
    })
    await vi.waitFor(() =>
      expect(manager.get('terminal').hasForegroundProcess).toBe(true)
    )

    host.emit('terminal', { exitCode: 7 })
    await vi.waitFor(() => {
      expect(manager.get('terminal').hasForegroundProcess).toBe(false)
      expect(refreshTerminalStatus).toHaveBeenCalledExactlyOnceWith(
        'terminal',
        false
      )
    })
    expect(manager.get('terminal')).toMatchObject({
      hasForegroundProcess: false,
      activity: { state: 'idle', progress: null }
    })
    manager.dispose()
  })

  it('restores activity and exactly one detached attention event from host state', async () => {
    const existing: TerminalAttentionState = {
      terminalId: 'terminal',
      worktreeId: 'worktree',
      sequence: 3,
      occurredAt: '2026-01-01T00:00:00.000Z',
      reason: 'bell',
      unread: true
    }

    const { attention, host, manager, service } = fixture([existing])
    host.state.activity = { ...IDLE, state: 'working', progress: 71 }
    host.state.attention = {
      sequence: 4,
      at: '2026-01-01T00:01:00.000Z',
      reason: 'bell'
    }
    await service.runEffect(manager.initialize())
    await service.runEffect(
      manager.trackTerminal(terminal, testAccess({ id: 'worktree' }))
    )
    await service.runEffect(manager.drain())

    expect(manager.get('terminal')).toMatchObject({
      activity: { state: 'working', progress: 71 },
      attention: { sequence: 4, unread: true }
    })
    expect(attention.upsert).toHaveBeenCalledTimes(1)

    host.emit('terminal', {
      attention: { sequence: 4, at: '2026-01-01T00:01:00.000Z', reason: 'bell' }
    })
    await service.runEffect(manager.drain())
    expect(attention.upsert).toHaveBeenCalledTimes(1)

    await service.runEffect(manager.acknowledgeAttention('terminal', 4))
    expect(attention.markRead).toHaveBeenCalledWith('terminal', 4)
    expect(manager.get('terminal').attention).toMatchObject({
      sequence: 4,
      unread: false
    })
    manager.dispose()
  })

  it('removes runtime subscriptions and persisted attention state with a terminal', async () => {
    const { attention, host, manager, service } = fixture()
    await service.runEffect(manager.initialize())
    await service.runEffect(
      manager.trackTerminal(terminal, testAccess({ id: 'worktree' }))
    )
    host.emit('terminal', {
      attention: { sequence: 1, at: '2026-01-01T00:01:00.000Z', reason: 'bell' }
    })
    await service.runEffect(manager.drain())

    manager.removeTerminal('terminal')
    await service.runEffect(manager.drain())
    expect(host.listeners.get('terminal')?.size ?? 0).toBe(0)
    expect(attention.delete).toHaveBeenCalledWith('terminal')
    expect(manager.get('terminal').attention).toBeNull()
    manager.dispose()
  })
})
