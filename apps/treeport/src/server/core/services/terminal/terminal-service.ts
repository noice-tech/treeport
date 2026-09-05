import crypto from 'node:crypto'
import path from 'node:path'
import type {
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import * as Exit from 'effect/Exit'
import { and, asc, eq } from 'drizzle-orm'
import { workspaceItemOrders } from '../../database-schema'
import { DomainError } from '../../domain'
import type { WorktreeSetupTask } from '../../setup'
import type { TerminalSessionBackend } from '../../terminal'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations
} from '../domain-services'
import {
  ApplicationFibers,
  type ApplicationServices,
  ProjectObservations,
  TerminalMutations,
  TreeFileMutations,
  WorktreeMutations
} from '../infrastructure/application-runtime'
import { MutationLocks } from '../infrastructure/mutation-locks'
import {
  ConfigPort,
  DatabasePort,
  EventBusPort,
  TerminalHostPort
} from '../infrastructure/ports'
import { ProjectStore } from '../project/project-store'
import { currentTraceContext } from '../../../tracing'
import { TerminalState } from './terminal-state'

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
  initialTitle?: string
  returnToShell?: boolean
  closeOnSuccess?: boolean
  initialSize?: TerminalSize
  cwd?: string
  env?: Record<string, string>
  shellCommand?: string
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
      let sessions = (yield* Effect.promise(() =>
        terminalHost.listTerminals(worktree.id)
      )).filter((terminal) => terminal.worktreeId === worktree.id)
      if (!(yield* locks.isWorktreeLocked(worktree.id))) {
        for (const terminal of sessions) {
          if (
            sessions.length <= 1 ||
            !terminal.closeOnSuccess ||
            terminal.status !== 'exited' ||
            terminal.exitCode !== 0
          ) {
            continue
          }

          yield* Effect.promise(() => terminalHost.killTerminal(terminal.id))
          sessions = sessions.filter(
            (candidate) => candidate.id !== terminal.id
          )
        }
      }

      const storedOrder = yield* Effect.promise(() =>
        database.db
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
      const positionById = new Map(
        storedOrder.map((item) => [item.itemId, item.position])
      )
      const terminals = sessions
        .map((terminal) => ({
          id: terminal.id,
          worktreeId: terminal.worktreeId,
          name: terminal.name,
          argv: terminal.argv,
          shellCommand: terminal.shellCommand,
          interactiveShell: terminal.interactiveShell,
          status: terminal.status,
          exitCode: terminal.exitCode,
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
      yield* terminalState.updateCloseOnSuccess(
        sessions.map((terminal) => ({
          terminalId: terminal.id,
          closeOnSuccess: terminal.closeOnSuccess
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

      yield* Effect.promise(() =>
        database.db.transaction(async (tx) => {
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

  getTerminalForAttachment(terminalId: string): TerminalEffect<TerminalRecord> {
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

  ensureProjectTerminals(projectId: string): TerminalEffect<void> {
    const ensureWorktreeTerminal = this.ensureWorktreeTerminal.bind(this)

    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const project = yield* projectStore.getProject(projectId)
      if ((yield* projectStore.projectOpenState(projectId)) !== true) {
        return
      }

      yield* Effect.all(
        project.worktrees.map((worktree) =>
          ensureWorktreeTerminal(worktree.id)
        ),
        { concurrency: 'unbounded', discard: true }
      )
    })
  }

  ensureWorktreeTerminal(
    worktreeId: string
  ): TerminalEffect<TerminalRecord | null> {
    const createTerminalSession = this.createTerminalSession.bind(this)
    const listWorktreeTerminals = this.listWorktreeTerminals.bind(this)

    return Effect.gen(function* () {
      const locks = yield* MutationLocks
      const projectStore = yield* ProjectStore
      const terminalMutations = yield* TerminalMutations
      if (yield* terminalMutations.isBusy(worktreeId)) {
        return null
      }

      return yield* terminalMutations.enqueue(
        worktreeId,
        Effect.gen(function* () {
          const worktree = yield* projectStore.storedWorktree(worktreeId)
          if (
            !worktree ||
            (yield* projectStore.projectOpenState(worktree.projectId)) !==
              true ||
            worktree.prunable ||
            !(yield* locks.tryAcquire({ worktreeIds: [worktreeId] }))
          ) {
            return null
          }

          return yield* Effect.gen(function* () {
            const terminals = yield* listWorktreeTerminals(worktree)
            if (terminals.length > 0) {
              return terminals[0]!
            }

            return yield* createTerminalSession(worktree, 'Shell')
          }).pipe(Effect.ensuring(locks.release({ worktreeIds: [worktreeId] })))
        })
      )
    })
  }

  private createTerminalSession(
    worktree: WorktreeRecord,
    name: string,
    argv?: string[],
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
      const shellCommand = options?.shellCommand ?? null
      const interactiveShell = !argv && shellCommand === null
      const commandArgv = argv
        ? [...argv]
        : shellCommand
          ? [config.shell, '-lc', shellCommand]
          : [config.shell, '-l']
      const timestamp = now()
      const session: Parameters<TerminalSessionBackend['createTerminal']>[0] = {
        terminalId,
        worktreeId: worktree.id,
        name,
        createdAt: timestamp,
        cwd: options?.cwd ?? worktree.path,
        argv: commandArgv,
        shellCommand,
        interactiveShell,
        env: {
          PI_IMAGE_PROTOCOL: 'kitty',
          ...(options?.env ?? {}),
          TREEPORT_API_URL: config.apiUrl,
          TREEPORT_MANAGED_API_URL: config.apiUrl,
          TREEPORT_DAEMON_RECORD: path.join(config.runtimeDir, 'daemon.json'),
          TREEPORT_DAEMON_LIFECYCLE: config.daemonLifecycle,
          TREEPORT_PROJECT_ID: worktree.projectId,
          TREEPORT_WORKTREE_ID: worktree.id,
          TREEPORT_TERMINAL_ID: terminalId
        }
      }
      if (options?.initialTitle) {
        session.initialTitle = options.initialTitle
      }

      if (options?.returnToShell && !interactiveShell) {
        session.fallbackArgv = [config.shell, '-l']
      }

      if (options?.closeOnSuccess) {
        session.closeOnSuccess = true
      }

      if (options?.initialSize) {
        session.initialSize = options.initialSize
      }

      if (options?.setup?.tasks.length) {
        session.setupTasks = options.setup.tasks
      }

      if (options?.setup?.error) {
        session.setupError = options.setup.error
      }

      yield* Effect.gen(function* () {
        const trace = yield* currentTraceContext
        yield* Effect.tryPromise({
          try: () => terminalHost.createTerminal(session, trace ?? undefined),
          catch: (error) =>
            new DomainError(
              'TERMINAL_CREATE_FAILED',
              error instanceof Error ? error.message : String(error),
              500
            )
        })
      }).pipe(
        Effect.withSpan('treeport.terminal_host.ipc.create', {
          kind: 'client',
          attributes: {
            'treeport.terminal.id': terminalId,
            'treeport.worktree.id': worktree.id,
            'treeport.terminal.launch_kind': interactiveShell
              ? 'shell'
              : shellCommand
                ? 'shell_command'
                : 'argv'
          }
        })
      )

      const terminal: TerminalRecord = {
        id: terminalId,
        worktreeId: worktree.id,
        name,
        argv: commandArgv,
        shellCommand,
        interactiveShell,
        status: 'running',
        exitCode: null,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      yield* terminalState.recordTerminal(
        terminal,
        options?.closeOnSuccess === true
      )
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
    argv?: string[],
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
              argv,
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
    argv?: string[],
    options?: TerminalLaunchOptions,
    verifiedWorktree?: WorktreeRecord,
    launchVerification?: Deferred.Deferred<WorktreeRecord, DomainError<unknown>>
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

      yield* projectStore.requireOpenProject(worktree.projectId)
      if (worktree.prunable) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_BUSY',
            'Cannot create a terminal while the tree is being modified',
            409
          )
        )
      }

      const acquired = yield* locks.tryAcquire({
        worktreeIds: [worktreeId],
        checkProjectIds: [worktree.projectId]
      })
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
            : yield* observations.verifyWorktreeLaunchTarget(worktree)
        return yield* createTerminalSession(launchWorktree, name, argv, options)
      }).pipe(Effect.ensuring(locks.release({ worktreeIds: [worktreeId] })))
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
      const state = yield* Effect.promise(() =>
        terminalHost.terminalState(terminal.id)
      )
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
        exitCode: state.exitCode
      }
      yield* terminalState.updateTerminal(refreshed)
      if (
        state.status !== terminal.status ||
        state.exitCode !== terminal.exitCode
      ) {
        yield* invalidateProjectsSnapshot()
        yield* Effect.sync(() => {
          events.publish('terminal.updated', {
            worktreeId: worktree.id,
            terminalId
          })
        })
      }

      if (
        state.status === 'exited' &&
        state.exitCode === 0 &&
        (yield* terminalState.closeOnSuccessTerminalIds).has(terminalId)
      ) {
        const deletion = yield* Effect.either(deleteTerminal(terminalId))
        if (Either.isLeft(deletion) && deletion.left.code === 'LAST_TERMINAL') {
          return refreshed
        }

        if (Either.isLeft(deletion)) {
          return yield* Effect.fail(deletion.left)
        }

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
      yield* Effect.promise(() =>
        terminalHost.renameTerminal(terminal.id, name, now())
      )
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
      const projectStore = yield* ProjectStore
      const terminalState = yield* TerminalState
      const worktreeMutations = yield* WorktreeMutations
      const cachedTerminal = yield* terminalState.terminal(terminalId)
      const terminal =
        cachedTerminal ?? (yield* getTerminalFromBindings(terminalId))
      yield* Effect.annotateCurrentSpan({
        'treeport.terminal.id': terminalId,
        'treeport.worktree.id': terminal.worktreeId
      })
      const projectId = (yield* projectStore.getWorktree(terminal.worktreeId))
        .projectId
      yield* worktreeMutations.enqueue(
        projectId,
        executeDeleteTerminal(terminalId, terminal.worktreeId)
      )
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

      const closeOnSuccessTerminalIds =
        yield* terminalState.closeOnSuccessTerminalIds
      if (
        terminals.length <= 1 ||
        terminals.every(
          (candidate) =>
            candidate.id === terminalId ||
            closeOnSuccessTerminalIds.has(candidate.id)
        )
      ) {
        return yield* Effect.fail(
          new DomainError(
            'LAST_TERMINAL',
            'Every open tree must keep at least one terminal',
            409
          )
        )
      }

      yield* Effect.gen(function* () {
        const trace = yield* currentTraceContext
        yield* Effect.promise(() =>
          terminalHost.killTerminal(terminal.id, trace ?? undefined)
        )
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
          const terminalIds = yield* Effect.promise(() =>
            terminalHost.killWorktree(worktree.id)
          )
          terminated += terminalIds.length
          yield* clearWorktreeTerminalState(worktree.id, terminalIds)
        }
      }
      yield* invalidateProjectsSnapshot()
      return terminated
    })
  }
}
