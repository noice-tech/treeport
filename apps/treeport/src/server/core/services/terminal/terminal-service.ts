import crypto from 'node:crypto'
import path from 'node:path'
import type {
  TerminalAfterExit,
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { and, asc, eq } from 'drizzle-orm'
import { workspaceItemOrders } from '../../database-schema.ts'
import { DomainError } from '../../domain.ts'
import type { WorktreeSetupTask } from '../../setup.ts'
import type { TerminalSessionBackend } from '../../terminal.ts'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations
} from '../domain-services.ts'
import {
  ApplicationFibers,
  type ApplicationServices,
  ProjectObservations,
  TerminalMutations,
  TreeFileMutations,
  WorktreeMutations
} from '../infrastructure/application-runtime.ts'
import { MutationLocks } from '../infrastructure/mutation-locks.ts'
import {
  ConfigPort,
  EventBusPort,
  TerminalHostPort
} from '../infrastructure/ports.ts'
import { DatabasePort } from '../../database.ts'
import { ProjectStore } from '../project/project-store.ts'
import { currentTraceContext } from '../../../tracing.ts'
import { TerminalState } from './terminal-state.ts'

const now = (): string => new Date().toISOString()

const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

type TerminalEffect<Result> = Effect.Effect<
  Result,
  DomainError<unknown>,
  ApplicationServices
>

export interface TerminalLaunchOptions {
  setup?: { tasks: WorktreeSetupTask[]; error: string | null }
  command?: string
  afterExit?: TerminalAfterExit
  initialSize?: TerminalSize
  cwd?: string
  env?: Record<string, string>
  parentTerminalId?: string
}

export class TerminalService {
  private readonly launchVerifications = new Map<
    string,
    {
      result: Deferred.Deferred<WorktreeRecord, DomainError<unknown>>
      users: number
    }
  >()

  private listProjects() {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      snapshots.listProjects()
    )
  }

  private invalidateProjectsSnapshot() {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      Effect.sync(() => snapshots.invalidate())
    )
  }

  clearWorktreeTerminalState(
    worktreeId: string,
    discoveredTerminalIds: Iterable<string> = []
  ): TerminalEffect<void> {
    return Effect.gen(function* () {
      const events = yield* EventBusPort
      const terminalState = yield* TerminalState

      const terminalIds = yield* terminalState.clearWorktree(
        worktreeId,
        discoveredTerminalIds
      )

      yield* Effect.sync(() => {
        for (const terminalId of terminalIds) {
          events.publish('terminal.removed', { worktreeId, terminalId })
        }
      })
    })
  }

  listWorktreeTerminals(
    worktree: WorktreeRecord
  ): TerminalEffect<TerminalRecord[]> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const locks = yield* MutationLocks
      const terminalHost = yield* TerminalHostPort
      const terminalState = yield* TerminalState

      let sessions = (yield* terminalHost
        .listTerminals(worktree.id)
        .pipe(Effect.orDie)).filter(
        (terminal) => terminal.worktreeId === worktree.id
      )

      if (!(yield* locks.isWorktreeLocked(worktree.id))) {
        for (const terminal of sessions) {
          if (
            terminal.status !== 'exited' ||
            !(
              terminal.afterExit === 'close' ||
              (terminal.afterExit === 'closeOnSuccess' &&
                terminal.exitCode === 0)
            )
          ) {
            continue
          }

          yield* terminalHost.killTerminal(terminal.id).pipe(Effect.orDie)
          sessions = sessions.filter(
            (candidate) => candidate.id !== terminal.id
          )
        }
      }

      const storedOrder = yield* database
        .execute('terminal.service.131', (db) =>
          db
            .select()
            .from(workspaceItemOrders)
            .where(
              and(
                eq(workspaceItemOrders.worktreeId, worktree.id),
                eq(workspaceItemOrders.surface, 'terminal')
              )
            )
            .orderBy(asc(workspaceItemOrders.position))
        )
        .pipe(Effect.orDie)

      const positionById = new Map(
        storedOrder.map((item) => [item.itemId, item.position])
      )

      const terminals = sessions
        .map((terminal) => ({
          id: terminal.id,
          worktreeId: terminal.worktreeId,
          name: terminal.name,
          command: terminal.command,
          status: terminal.status,
          exitCode: terminal.exitCode,
          unavailableReason: terminal.unavailableReason ?? null,
          recoveryPending: terminal.recoveryPending ?? false,
          commandExitCode: terminal.commandExitCode ?? null,
          parentTerminalId: terminal.parentTerminalId ?? null,
          createdAt: terminal.createdAt,
          updatedAt: terminal.updatedAt
        }))
        .sort((left, right) => {
          const leftPosition = positionById.get(left.id)
          const rightPosition = positionById.get(right.id)

          if (leftPosition !== undefined || rightPosition !== undefined) {
            return (
              (leftPosition ?? Number.MAX_SAFE_INTEGER) -
              (rightPosition ?? Number.MAX_SAFE_INTEGER)
            )
          }

          return (
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id)
          )
        })

      yield* terminalState.updateClosePolicies(
        sessions.map((terminal) => ({
          terminalId: terminal.id,
          afterExit: terminal.afterExit
        }))
      )

      if (yield* locks.isWorktreeLocked(worktree.id)) {
        return terminals
      }

      const changes = yield* terminalState.reconcileInventory(
        worktree.id,
        terminals
      )

      yield* Effect.sync(() => {
        for (const terminalId of changes.updatedTerminalIds) {
          events.publish('terminal.updated', {
            worktreeId: worktree.id,
            terminalId
          })
        }

        for (const terminalId of changes.removedTerminalIds) {
          events.publish('terminal.removed', {
            worktreeId: worktree.id,
            terminalId
          })
        }
      })

      return terminals
    })
  }

  reorderTerminals(
    worktreeId: string,
    terminalIds: readonly string[]
  ): TerminalEffect<void> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    const listWorktreeTerminals = this.listWorktreeTerminals.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const projectStore = yield* ProjectStore
      const worktree = yield* projectStore.getWorktree(worktreeId)
      const terminals = yield* listWorktreeTerminals(worktree)
      const currentIds = new Set(terminals.map((terminal) => terminal.id))

      if (
        terminalIds.length !== currentIds.size ||
        terminalIds.some((terminalId) => !currentIds.has(terminalId))
      ) {
        return yield* Effect.fail(
          new DomainError(
            'STALE_WORKSPACE_ORDER',
            'Terminal tabs changed before they could be reordered',
            409
          )
        )
      }

      yield* database
        .execute('terminal.service.235', (db) =>
          db.transaction(async (tx) => {
            await tx
              .delete(workspaceItemOrders)
              .where(
                and(
                  eq(workspaceItemOrders.worktreeId, worktreeId),
                  eq(workspaceItemOrders.surface, 'terminal')
                )
              )
            await tx.insert(workspaceItemOrders).values(
              terminalIds.map((itemId, position) => ({
                worktreeId,
                surface: 'terminal' as const,
                itemId,
                position
              }))
            )
          })
        )
        .pipe(Effect.orDie)
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('worktree.updated', { worktreeId })
      })
    })
  }

  getTerminal(terminalId: string): TerminalEffect<TerminalRecord> {
    const listProjects = this.listProjects.bind(this)

    return Effect.gen(this, function* () {
      const matches = (yield* listProjects())
        .flatMap((project) => project.worktrees)
        .flatMap((worktree) => worktree.terminals)
        .filter((terminal) => terminal.id === terminalId)

      if (matches.length > 1) {
        return yield* Effect.fail(
          new DomainError(
            'TERMINAL_ID_CONFLICT',
            'Terminal ID is present in more than one terminal host',
            500
          )
        )
      }

      if (matches[0]) {
        return matches[0]
      }

      return yield* Effect.fail(
        new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
      )
    })
  }

  getKnownTerminal(terminalId: string): TerminalEffect<TerminalRecord> {
    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const terminalState = yield* TerminalState
      const terminal = yield* terminalState.terminal(terminalId)

      if (!terminal) {
        return yield* Effect.fail(
          new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
        )
      }

      const worktree = yield* projectStore.getWorktree(terminal.worktreeId)
      yield* projectStore.requireOpenProject(worktree.projectId)

      return terminal
    })
  }

  getTerminalFromBindings(terminalId: string): TerminalEffect<TerminalRecord> {
    const listWorktreeTerminals = this.listWorktreeTerminals.bind(this)

    return Effect.gen(this, function* () {
      const projectStore = yield* ProjectStore
      const terminalState = yield* TerminalState
      const known = yield* terminalState.terminal(terminalId)

      if (known) {
        const worktree = yield* projectStore.storedWorktree(known.worktreeId)

        if (worktree) {
          yield* projectStore.requireOpenProject(worktree.projectId)

          const terminal = (yield* listWorktreeTerminals(worktree)).find(
            (candidate) => candidate.id === terminalId
          )

          if (terminal) {
            return terminal
          }
        }
      }

      const projects = yield* projectStore.storedProjects(true)

      const inventories = yield* Effect.all(
        projects
          .flatMap((project) => project.worktrees)
          .map((worktree) => Effect.exit(listWorktreeTerminals(worktree))),
        { concurrency: 'unbounded' }
      )

      const matches = inventories
        .filter(Exit.isSuccess)
        .flatMap((inventory) => inventory.value)
        .filter((terminal) => terminal.id === terminalId)

      if (matches.length > 1) {
        return yield* Effect.fail(
          new DomainError(
            'TERMINAL_ID_CONFLICT',
            'Terminal ID is present in more than one terminal host',
            500
          )
        )
      }

      if (matches[0]) {
        return matches[0]
      }

      const failure = inventories.find(Exit.isFailure)

      if (failure) {
        return yield* Effect.failCause(failure.cause)
      }

      return yield* Effect.fail(
        new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
      )
    })
  }

  private createTerminalSession(
    worktree: WorktreeRecord,
    name: string,
    options?: TerminalLaunchOptions
  ): TerminalEffect<TerminalRecord> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const config = yield* ConfigPort
      const events = yield* EventBusPort
      const terminalHost = yield* TerminalHostPort
      const terminalState = yield* TerminalState
      const terminalId = id('term')
      yield* Effect.annotateCurrentSpan({
        'treeport.terminal.id': terminalId,
        'treeport.worktree.id': worktree.id
      })

      const command = options?.command ?? null
      const afterExit = options?.afterExit ?? 'shell'
      const timestamp = now()

      const session: Parameters<TerminalSessionBackend['createTerminal']>[0] = {
        terminalId,
        worktreeId: worktree.id,
        name,
        createdAt: timestamp,
        cwd: options?.cwd ?? worktree.path,
        shell: config.shell,
        command,
        afterExit,
        env: {
          PI_IMAGE_PROTOCOL: 'kitty',
          // EXTERNAL: Pi only emits OSC 8 links for terminals it recognizes.
          PI_HYPERLINKS: '1',
          PI_CLIPBOARD_OSC52: '1',
          ...(options?.env ?? {}),
          TREEPORT_API_URL: config.apiUrl,
          TREEPORT_MANAGED_API_URL: config.apiUrl,
          TREEPORT_DAEMON_RECORD: path.join(config.runtimeDir, 'daemon.json'),
          TREEPORT_DATA_DIR: config.dataDir,
          TREEPORT_RUNTIME_DIR: config.runtimeDir,
          TREEPORT_PROJECT_ID: worktree.projectId,
          TREEPORT_WORKTREE_ID: worktree.id,
          TREEPORT_TERMINAL_ID: terminalId
        }
      }

      if (options?.initialSize) {
        session.initialSize = options.initialSize
      }

      if (options?.parentTerminalId) {
        session.parentTerminalId = options.parentTerminalId
      }

      if (options?.setup?.tasks.length) {
        session.setupTasks = options.setup.tasks
      }

      if (options?.setup?.error) {
        session.setupError = options.setup.error
      }

      yield* Effect.gen(function* () {
        const trace = yield* currentTraceContext
        yield* terminalHost
          .createTerminal(session, trace ?? undefined)
          .pipe(
            Effect.mapError(
              (error) =>
                new DomainError(
                  'TERMINAL_CREATE_FAILED',
                  error instanceof Error ? error.message : String(error),
                  500
                )
            )
          )
      }).pipe(
        Effect.withSpan('treeport.terminal_host.ipc.create', {
          kind: 'client',
          attributes: {
            'treeport.terminal.id': terminalId,
            'treeport.worktree.id': worktree.id,
            'treeport.terminal.after_exit': afterExit
          }
        })
      )

      const terminal: TerminalRecord = {
        id: terminalId,
        worktreeId: worktree.id,
        name,
        command,
        status: 'running',
        exitCode: null,
        commandExitCode: null,
        parentTerminalId: options?.parentTerminalId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp
      }

      yield* terminalState.recordTerminal(terminal, afterExit)
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('terminal.created', {
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          terminalId,
          terminal
        })
      })

      return terminal
    })
  }

  createTerminal(
    worktreeId: string,
    name: string,
    options?: TerminalLaunchOptions
  ): TerminalEffect<TerminalRecord> {
    const executeCreateTerminal = this.executeCreateTerminal.bind(this)

    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        const applicationFibers = yield* ApplicationFibers
        const observations = yield* ProjectObservationOperations
        const projectStore = yield* ProjectStore
        const terminalMutations = yield* TerminalMutations

        const candidate = {
          result: yield* Deferred.make<WorktreeRecord, DomainError<unknown>>(),
          users: 1
        }

        const verification = yield* Effect.sync(() => {
          const active = this.launchVerifications.get(worktreeId)

          if (active) {
            active.users += 1

            return active
          }

          this.launchVerifications.set(worktreeId, candidate)

          return candidate
        })

        if (verification === candidate) {
          yield* applicationFibers.fork(
            Effect.gen(function* () {
              const result = yield* Effect.exit(
                Effect.gen(function* () {
                  const worktree =
                    yield* projectStore.storedWorktree(worktreeId)

                  if (!worktree) {
                    return yield* Effect.fail(
                      new DomainError(
                        'WORKTREE_NOT_FOUND',
                        'Tree not found',
                        404
                      )
                    )
                  }

                  return yield* observations.verifyWorktreeLaunchTarget(
                    worktree
                  )
                })
              )

              yield* Deferred.done(candidate.result, result)
            })
          )
        }

        return yield* restore(
          terminalMutations.enqueue(
            worktreeId,
            executeCreateTerminal(
              worktreeId,
              name,
              options,
              undefined,
              verification.result
            )
          )
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              verification.users -= 1

              if (
                verification.users === 0 &&
                this.launchVerifications.get(worktreeId) === verification
              ) {
                this.launchVerifications.delete(worktreeId)
              }
            })
          )
        )
      })
    ).pipe(
      Effect.withSpan('treeport.terminal.create', {
        attributes: { 'treeport.worktree.id': worktreeId }
      })
    )
  }

  executeCreateTerminal(
    worktreeId: string,
    name: string,
    options?: TerminalLaunchOptions,
    verifiedWorktree?: WorktreeRecord,
    launchVerification?: Deferred.Deferred<
      WorktreeRecord,
      DomainError<unknown>
    >,
    reservedByCreation = false
  ): TerminalEffect<TerminalRecord> {
    const createTerminalSession = this.createTerminalSession.bind(this)

    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const locks = yield* MutationLocks
      const observations = yield* ProjectObservationOperations
      const projectStore = yield* ProjectStore
      const worktree = yield* projectStore.storedWorktree(worktreeId)

      if (!worktree) {
        return yield* Effect.fail(
          new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
        )
      }

      if (!reservedByCreation) {
        yield* projectStore.requireOpenProject(worktree.projectId)
      }

      if (worktree.prunable) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_BUSY',
            'Cannot create a terminal while the tree is being modified',
            409
          )
        )
      }

      const acquired =
        reservedByCreation ||
        (yield* locks.tryAcquire({
          worktreeIds: [worktreeId],
          checkProjectIds: [worktree.projectId],
          allowWorktreeCreation: true
        }))

      if (!acquired) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_BUSY',
            'Cannot create a terminal while the tree is being modified',
            409
          )
        )
      }

      return yield* Effect.gen(function* () {
        const preverifiedWorktree = launchVerification
          ? yield* Deferred.await(launchVerification)
          : verifiedWorktree

        const launchWorktree =
          preverifiedWorktree &&
          preverifiedWorktree.projectId === worktree.projectId &&
          preverifiedWorktree.path === worktree.path &&
          preverifiedWorktree.kind === worktree.kind
            ? worktree
            : yield* observations.verifyWorktreeLaunchTarget(
                worktree,
                reservedByCreation
              )

        return yield* createTerminalSession(launchWorktree, name, options)
      }).pipe(
        Effect.ensuring(
          reservedByCreation
            ? Effect.void
            : locks.release({ worktreeIds: [worktreeId] })
        )
      )
    }).pipe(Effect.onError(() => invalidateProjectsSnapshot()))
  }

  refreshTerminalStatus(
    terminalId: string,
    observeGit = true
  ): TerminalEffect<TerminalRecord> {
    const deleteTerminal = this.deleteTerminal.bind(this)
    const getTerminal = this.getTerminal.bind(this)
    const getTerminalFromBindings = this.getTerminalFromBindings.bind(this)

    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const events = yield* EventBusPort
      const projectStore = yield* ProjectStore
      const terminalHost = yield* TerminalHostPort
      const terminalState = yield* TerminalState
      const cachedTerminal = yield* terminalState.terminal(terminalId)

      const terminal = observeGit
        ? yield* getTerminal(terminalId)
        : (cachedTerminal ?? (yield* getTerminalFromBindings(terminalId)))

      const worktree = yield* projectStore.getWorktree(terminal.worktreeId)

      const state = yield* terminalHost
        .terminalState(terminal.id)
        .pipe(Effect.orDie)

      yield* projectStore.requireOpenProject(worktree.projectId)

      if (!(yield* terminalState.hasTerminal(terminalId))) {
        return yield* Effect.fail(
          new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
        )
      }

      if (state.status === 'missing') {
        yield* terminalState.removeTerminal(terminalId, worktree.id)
        yield* invalidateProjectsSnapshot()
        yield* Effect.sync(() => {
          events.publish('terminal.removed', {
            worktreeId: worktree.id,
            terminalId
          })
        })

        return yield* Effect.fail(
          new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
        )
      }

      const refreshed = {
        ...terminal,
        status: state.status,
        exitCode: state.exitCode,
        unavailableReason: state.unavailableReason ?? null,
        recoveryPending: state.recoveryPending ?? false,
        commandExitCode: state.commandExitCode ?? null
      }

      yield* terminalState.updateTerminal(refreshed)

      if (
        state.status !== terminal.status ||
        state.exitCode !== terminal.exitCode ||
        state.unavailableReason !== terminal.unavailableReason ||
        (state.commandExitCode ?? null) !== (terminal.commandExitCode ?? null)
      ) {
        yield* invalidateProjectsSnapshot()
        yield* Effect.sync(() => {
          events.publish('terminal.updated', {
            worktreeId: worktree.id,
            terminalId
          })
        })
      }

      const closePolicy = (yield* terminalState.terminalClosePolicies).get(
        terminalId
      )

      if (
        state.status === 'exited' &&
        (closePolicy === 'close' ||
          (closePolicy === 'closeOnSuccess' && state.exitCode === 0))
      ) {
        yield* deleteTerminal(terminalId)

        return yield* Effect.fail(
          new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
        )
      }

      return refreshed
    })
  }

  renameTerminal(
    terminalId: string,
    name: string
  ): TerminalEffect<TerminalRecord> {
    const executeRenameTerminal = this.executeRenameTerminal.bind(this)
    const getTerminal = this.getTerminal.bind(this)

    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const worktreeMutations = yield* WorktreeMutations
      const terminal = yield* getTerminal(terminalId)

      const projectId = (yield* projectStore.getWorktree(terminal.worktreeId))
        .projectId

      return yield* worktreeMutations.enqueue(
        projectId,
        executeRenameTerminal(terminalId, name)
      )
    })
  }

  private executeRenameTerminal(
    terminalId: string,
    name: string
  ): TerminalEffect<TerminalRecord> {
    const getTerminal = this.getTerminal.bind(this)

    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const events = yield* EventBusPort
      const projectStore = yield* ProjectStore
      const terminalHost = yield* TerminalHostPort
      const terminal = yield* getTerminal(terminalId)
      const worktree = yield* projectStore.getWorktree(terminal.worktreeId)
      yield* projectStore.requireOpenProject(worktree.projectId)
      yield* terminalHost
        .renameTerminal(terminal.id, name, now())
        .pipe(Effect.orDie)
      const renamed = yield* getTerminal(terminalId)
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('terminal.updated', {
          worktreeId: terminal.worktreeId,
          terminalId
        })
      })

      return renamed
    })
  }

  deleteTerminal(terminalId: string): TerminalEffect<void> {
    const executeDeleteTerminal = this.executeDeleteTerminal.bind(this)
    const getTerminalFromBindings = this.getTerminalFromBindings.bind(this)

    return Effect.gen(function* () {
      const applicationFibers = yield* ApplicationFibers
      const terminalState = yield* TerminalState
      const cachedTerminal = yield* terminalState.terminal(terminalId)

      const terminal =
        cachedTerminal ?? (yield* getTerminalFromBindings(terminalId))

      yield* Effect.annotateCurrentSpan({
        'treeport.terminal.id': terminalId,
        'treeport.worktree.id': terminal.worktreeId
      })
      const result = yield* Deferred.make<void, DomainError<unknown>>()
      yield* applicationFibers.fork(
        executeDeleteTerminal(terminalId, terminal.worktreeId).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(result, exit))
        )
      )
      yield* Deferred.await(result)
    }).pipe(
      Effect.withSpan('treeport.terminal.remove', {
        attributes: { 'treeport.terminal.id': terminalId }
      })
    )
  }

  private executeDeleteTerminal(
    terminalId: string,
    worktreeId: string
  ): TerminalEffect<void> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    const listWorktreeTerminals = this.listWorktreeTerminals.bind(this)

    return Effect.gen(function* () {
      const events = yield* EventBusPort
      const locks = yield* MutationLocks
      const projectStore = yield* ProjectStore
      const terminalHost = yield* TerminalHostPort
      const terminalState = yield* TerminalState
      const worktree = yield* projectStore.storedWorktree(worktreeId)

      if (!worktree) {
        return yield* Effect.fail(
          new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
        )
      }

      yield* projectStore.requireOpenProject(worktree.projectId)
      const terminals = yield* listWorktreeTerminals(worktree)

      const terminal = terminals.find(
        (candidate) => candidate.id === terminalId
      )

      if (!terminal) {
        return yield* Effect.fail(
          new DomainError('TERMINAL_NOT_FOUND', 'Terminal not found', 404)
        )
      }

      const allowed = yield* locks.tryAcquire({
        checkWorktreeIds: [worktree.id],
        checkProjectIds: [worktree.projectId],
        allowWorktreeCreation: true
      })

      if (!allowed) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_BUSY',
            'Cannot delete a terminal while its tree or project is being removed',
            409
          )
        )
      }

      yield* Effect.acquireUseRelease(
        terminalState.reserveRemoval(terminalId, worktree.id),
        () =>
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const trace = yield* currentTraceContext
              yield* terminalHost
                .killTerminal(terminal.id, trace ?? undefined)
                .pipe(Effect.orDie)
            }).pipe(
              Effect.withSpan('treeport.terminal_host.ipc.remove', {
                kind: 'client',
                attributes: {
                  'treeport.terminal.id': terminal.id,
                  'treeport.worktree.id': worktree.id
                }
              })
            )
            yield* terminalState.removeTerminal(terminalId, worktree.id)
            yield* invalidateProjectsSnapshot()
            yield* Effect.sync(() => {
              events.publish('terminal.removed', {
                worktreeId: worktree.id,
                terminalId
              })
            })
          }),
        (_, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : terminalState.releaseRemoval(terminalId)
      )
    })
  }

  terminateAllTerminals(): TerminalEffect<number> {
    const clearWorktreeTerminalState =
      this.clearWorktreeTerminalState.bind(this)

    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    const listProjects = this.listProjects.bind(this)

    return Effect.gen(function* () {
      const applicationFibers = yield* ApplicationFibers
      const projectObservations = yield* ProjectObservations
      const terminalHost = yield* TerminalHostPort
      const terminalMutations = yield* TerminalMutations
      const treeFileMutations = yield* TreeFileMutations
      const worktreeMutations = yield* WorktreeMutations
      yield* Effect.all(
        [
          worktreeMutations.drain,
          terminalMutations.drain,
          treeFileMutations.drain,
          projectObservations.drain
        ],
        { concurrency: 'unbounded', discard: true }
      )
      yield* applicationFibers.awaitEmpty

      let terminated = 0

      for (const project of yield* listProjects()) {
        for (const worktree of project.worktrees) {
          const terminalIds = yield* terminalHost
            .killWorktree(worktree.id)
            .pipe(Effect.orDie)

          terminated += terminalIds.length
          yield* clearWorktreeTerminalState(worktree.id, terminalIds)
        }
      }

      yield* invalidateProjectsSnapshot()

      return terminated
    })
  }
}
