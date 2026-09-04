import crypto from 'node:crypto'
import path from 'node:path'
import type {
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import * as Exit from 'effect/Exit'
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
  EventBusPort,
  TerminalHostPort
} from '../infrastructure/ports'
import { ProjectStore } from '../project/project-store'
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
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
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

      yield* Effect.tryPromise({
        try: () => terminalHost.createTerminal(session),
        catch: (error) =>
          new DomainError(
            'TERMINAL_CREATE_FAILED',
            error instanceof Error ? error.message : String(error),
            500
          )
      })

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

    return Effect.gen(function* () {
      const terminalMutations = yield* TerminalMutations
      return yield* terminalMutations.enqueue(
        worktreeId,
        executeCreateTerminal(worktreeId, name, argv, options)
      )
    })
  }

  executeCreateTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
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
        const verifiedWorktree =
          yield* observations.verifyWorktreeLaunchTarget(worktree)
        return yield* createTerminalSession(
          verifiedWorktree,
          name,
          argv,
          options
        )
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
      const projectId = (yield* projectStore.getWorktree(terminal.worktreeId))
        .projectId
      yield* worktreeMutations.enqueue(
        projectId,
        executeDeleteTerminal(terminalId, terminal.worktreeId)
      )
    })
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

      yield* Effect.promise(() => terminalHost.killTerminal(terminal.id))
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
