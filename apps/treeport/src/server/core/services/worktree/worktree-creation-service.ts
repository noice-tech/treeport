import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { treeContextValuesSchema } from '@treeport/shared'
import type {
  CreateOperationRequest,
  OperationRecord,
  ProjectRecord,
  TerminalRecord,
  TerminalSize,
  TreeContextValues,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, eq, or, sql } from 'drizzle-orm'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { mapOperation, mapWorktree, serializeOperation } from '../../database'
import { operations, projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import {
  resolveWorktreeSetupTasks,
  runWorktreeSetupTasks,
  type WorktreeSetupTask
} from '../../setup'
import {
  normalizeWorktreeName,
  prepareZedWorktreeWrapper,
  resolveZedWorktreePath
} from '../../zed'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations,
  TerminalOperations
} from '../domain-services'
import {
  ApplicationFibers,
  type ApplicationServices,
  WorktreeMutations
} from '../infrastructure/application-runtime'
import { MutationLocks } from '../infrastructure/mutation-locks'
import {
  CommandPort,
  ConfigPort,
  DatabasePort,
  EventBusPort,
  GitPort
} from '../infrastructure/ports'
import { ProjectStore } from '../project/project-store'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

interface TerminalLaunchOptions {
  setup?: { tasks: WorktreeSetupTask[]; error: string | null }
  initialTitle?: string
  returnToShell?: boolean
  closeOnSuccess?: boolean
  initialSize?: TerminalSize
  cwd?: string
  env?: Record<string, string>
  shellCommand?: string
}

export interface CreateWorktreeResult {
  worktree: WorktreeRecord
  terminal: TerminalRecord | null
  terminalError: string | null
  setupError: string | null
}

export class WorktreeCreationService {
  private observeAvailableProject(project: ProjectRecord, allowClosed = false) {
    return Effect.flatMap(ProjectObservationOperations, (observations) =>
      observations.observeAvailableProject(project, allowClosed)
    )
  }

  private importWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock = false,
    allowClosed = false
  ) {
    return Effect.flatMap(ProjectObservationOperations, (observations) =>
      observations.importWorktrees(
        projectId,
        repositoryPath,
        mainPath,
        allowProjectLock,
        allowClosed
      )
    )
  }

  private executeCreateTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ) {
    return Effect.flatMap(TerminalOperations, (terminals) =>
      terminals.executeCreateTerminal(worktreeId, name, argv, options)
    )
  }

  private ensureWorktreeTerminal(worktreeId: string) {
    return Effect.flatMap(TerminalOperations, (terminals) =>
      terminals.ensureWorktreeTerminal(worktreeId)
    )
  }

  private invalidateProjectsSnapshot() {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      Effect.sync(() => snapshots.invalidate())
    )
  }

  listActiveOperations(
    filters: {
      projectId?: string
      kind?: OperationRecord['kind']
    } = {}
  ): Effect.Effect<
    OperationRecord[],
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const projectStore = yield* ProjectStore
      const filteredProjectId = filters.projectId
      if (filteredProjectId) {
        yield* projectStore.requireOpenProject(filteredProjectId)
      }

      const rows = yield* Effect.promise(() =>
        database.db
          .select()
          .from(operations)
          .where(
            and(
              or(
                eq(operations.status, 'pending'),
                eq(operations.status, 'running')
              ),
              ...(filters.projectId
                ? [eq(operations.projectId, filters.projectId)]
                : []),
              ...(filters.kind ? [eq(operations.kind, filters.kind)] : [])
            )
          )
          .orderBy(asc(operations.createdAt), asc(operations.id))
      )
      return rows.map(mapOperation)
    })
  }

  beginCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Effect.Effect<OperationRecord, DomainError<unknown>, ApplicationServices> {
    const executeCreateOperation = this.executeCreateOperation.bind(this)

    return Effect.gen(function* () {
      const applicationFibers = yield* ApplicationFibers
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const locks = yield* MutationLocks
      const projectStore = yield* ProjectStore
      const worktreeMutations = yield* WorktreeMutations

      const project = yield* projectStore.requireOpenProject(projectId)
      if (project.kind === 'folder') {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_HAS_NO_GIT_REPOSITORY',
            'Linked worktrees require a Git repository project',
            409
          )
        )
      }

      const name = yield* Effect.try({
        try: () => normalizeWorktreeName(inputName),
        catch: (error) =>
          new DomainError(
            'INVALID_WORKTREE_NAME',
            error instanceof Error ? error.message : String(error),
            400
          )
      })
      if (
        (yield* locks.isProjectLocked(projectId)) &&
        !(yield* worktreeMutations.isBusy(projectId))
      ) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_BUSY',
            'Project is already being modified',
            409
          )
        )
      }

      const operationId = id('op')
      const timestamp = now()
      const request: CreateOperationRequest = { name, base }
      if (initialTerminal) {
        request.initialTerminal = initialTerminal
      }

      if (sourceWorktreeId) {
        request.sourceWorktreeId = sourceWorktreeId
      }

      if (treeContext && Object.keys(treeContext).length > 0) {
        request.context = treeContext
      }

      yield* Effect.promise(() =>
        database.db.run(sql`
          INSERT INTO operations(
            id,kind,project_id,worktree_id,status,request_json,result_json,error,
            created_at,updated_at
          ) VALUES(
            ${operationId},'create',${projectId},NULL,'pending',
            ${serializeOperation(request)},NULL,NULL,${timestamp},${timestamp}
          )
        `)
      )
      const operation = yield* projectStore.getOperation(operationId)
      yield* Effect.sync(() =>
        events.publish('create.started', { projectId, operationId })
      )

      const backgroundCreate = worktreeMutations
        .enqueue(
          projectId,
          executeCreateOperation(
            operationId,
            projectId,
            name,
            base,
            initialTerminal,
            sourceWorktreeId,
            treeContext
          )
        )
        .pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError(
              `Background tree creation failed for ${operationId}: ${Cause.pretty(cause)}`
            )
          )
        )
      yield* applicationFibers.fork(backgroundCreate)
      return operation
    })
  }

  private executeCreateOperation(
    operationId: string,
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    const executeCreateWorktree = this.executeCreateWorktree.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      yield* Effect.promise(() =>
        database.db.run(sql`
          UPDATE operations SET status='running',updated_at=${now()}
          WHERE id=${operationId} AND status='pending'
        `)
      )

      const creation = executeCreateWorktree(
        projectId,
        inputName,
        base,
        initialTerminal,
        sourceWorktreeId,
        treeContext
      )
      yield* Effect.matchCauseEffect(creation, {
        onSuccess: (result) =>
          Effect.gen(function* () {
            const timestamp = now()
            yield* Effect.promise(() =>
              database.db.run(sql`
                UPDATE operations
                SET status='completed',worktree_id=${result.worktree.id},
                    result_json=${serializeOperation({
                      worktreeId: result.worktree.id,
                      terminalId: result.terminal?.id ?? null,
                      terminalError: result.terminalError,
                      setupError: result.setupError
                    })},error=NULL,updated_at=${timestamp}
                WHERE id=${operationId}
              `)
            )
            yield* Effect.sync(() =>
              events.publish('create.completed', {
                projectId,
                operationId,
                worktreeId: result.worktree.id
              })
            )
          }),
        onFailure: (cause) =>
          Effect.gen(function* () {
            const message = causeMessage(cause)
            yield* Effect.promise(() =>
              database.db.run(sql`
                UPDATE operations
                SET status='failed',error=${message.slice(0, 4_096)},updated_at=${now()}
                WHERE id=${operationId}
              `)
            )
            yield* Effect.sync(() =>
              events.publish('create.failed', { projectId, operationId })
            )
            if (!Cause.isFailure(cause)) {
              return yield* Effect.failCause(cause)
            }
          })
      })
    })
  }

  createWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Effect.Effect<
    CreateWorktreeResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const executeCreateWorktree = this.executeCreateWorktree.bind(this)

    return Effect.gen(function* () {
      const locks = yield* MutationLocks
      const projectStore = yield* ProjectStore
      const worktreeMutations = yield* WorktreeMutations
      const project = yield* projectStore.requireOpenProject(projectId)
      if (project.kind === 'folder') {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_HAS_NO_GIT_REPOSITORY',
            'Linked worktrees require a Git repository project',
            409
          )
        )
      }

      if (
        (yield* locks.isProjectLocked(projectId)) &&
        !(yield* worktreeMutations.isBusy(projectId))
      ) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_BUSY',
            'Project is already being modified',
            409
          )
        )
      }

      return yield* worktreeMutations.enqueue(
        projectId,
        executeCreateWorktree(
          projectId,
          inputName,
          base,
          initialTerminal,
          sourceWorktreeId,
          treeContext
        )
      )
    })
  }

  private executeCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Effect.Effect<
    CreateWorktreeResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const observeAvailableProject = this.observeAvailableProject.bind(this)
    const importWorktrees = this.importWorktrees.bind(this)
    const executeCreateTerminal = this.executeCreateTerminal.bind(this)
    const ensureWorktreeTerminal = this.ensureWorktreeTerminal.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ConfigPort
        const database = yield* DatabasePort
        const events = yield* EventBusPort
        const git = yield* GitPort
        const locks = yield* MutationLocks
        const projectStore = yield* ProjectStore
        const runner = yield* CommandPort
        const contextValues = yield* Effect.sync(() =>
          treeContextValuesSchema.parse(treeContext ?? {})
        )
        yield* projectStore.requireOpenProject(projectId)

        const { project, worktree } = yield* Effect.acquireUseRelease(
          locks
            .tryAcquire({ projectId })
            .pipe(
              Effect.flatMap((acquired) =>
                acquired
                  ? Effect.void
                  : Effect.fail(
                      new DomainError(
                        'PROJECT_BUSY',
                        'Project is already being modified',
                        409
                      )
                    )
              )
            ),
          () =>
            Effect.gen(function* () {
              const openProject =
                yield* projectStore.requireOpenProject(projectId)
              const project = yield* observeAvailableProject(openProject)
              if (project.kind === 'folder') {
                return yield* Effect.fail(
                  new DomainError(
                    'PROJECT_HAS_NO_GIT_REPOSITORY',
                    'Linked worktrees require a Git repository project',
                    409
                  )
                )
              }

              const name = yield* Effect.try({
                try: () => normalizeWorktreeName(inputName),
                catch: (error) =>
                  new DomainError(
                    'INVALID_WORKTREE_NAME',
                    error instanceof Error ? error.message : String(error),
                    400
                  )
              })
              if (
                project.worktrees.some(
                  (candidate) =>
                    candidate.name.localeCompare(name, undefined, {
                      sensitivity: 'accent'
                    }) === 0
                )
              ) {
                return yield* Effect.fail(
                  new DomainError(
                    'WORKTREE_EXISTS',
                    `A tree named ${name} already exists`,
                    409
                  )
                )
              }

              const destination = yield* Effect.tryPromise({
                try: () =>
                  resolveZedWorktreePath(project.mainWorktreePath, name),
                catch: (error) =>
                  new DomainError(
                    'INVALID_WORKTREE_PATH',
                    error instanceof Error ? error.message : String(error),
                    400
                  )
              })
              let worktreePath = destination.path
              let wrapperPath = destination.wrapperPath
              const pathExists = yield* Effect.tryPromise({
                try: () => fs.access(worktreePath).then(() => true),
                catch: (cause) => cause
              }).pipe(Effect.orElseSucceed(() => false))
              if (pathExists) {
                return yield* Effect.fail(
                  new DomainError(
                    'WORKTREE_PATH_EXISTS',
                    `Destination already exists: ${worktreePath}`,
                    409
                  )
                )
              }

              let commit: string
              if (base === 'current') {
                if (!sourceWorktreeId) {
                  return yield* Effect.fail(
                    new DomainError(
                      'INVALID_SOURCE_WORKTREE',
                      'A source tree is required when starting from current',
                      400
                    )
                  )
                }

                const source = yield* projectStore.getWorktree(sourceWorktreeId)
                if (source.projectId !== projectId || source.prunable) {
                  return yield* Effect.fail(
                    new DomainError(
                      'INVALID_SOURCE_WORKTREE',
                      'The source tree must be active and belong to the project',
                      400
                    )
                  )
                }

                commit = yield* Effect.promise(() =>
                  git.resolveCommit(source.path)
                )
              } else {
                commit = yield* Effect.promise(() =>
                  git.resolveDefaultCommit(project.repositoryPath)
                )
              }

              const preparedWrapper = yield* Effect.tryPromise({
                try: () =>
                  prepareZedWorktreeWrapper(
                    project.mainWorktreePath,
                    wrapperPath
                  ),
                catch: (error) =>
                  new DomainError(
                    'INVALID_WORKTREE_PATH',
                    error instanceof Error ? error.message : String(error),
                    400
                  )
              })
              const wrapperCreated = preparedWrapper.created
              wrapperPath = preparedWrapper.path
              worktreePath = path.join(
                wrapperPath,
                path.basename(project.mainWorktreePath)
              )
              yield* Effect.promise(() =>
                git.createDetachedWorktree(
                  project.repositoryPath,
                  worktreePath,
                  commit
                )
              ).pipe(
                Effect.onError(() =>
                  wrapperCreated
                    ? Effect.promise(() => fs.rmdir(wrapperPath)).pipe(
                        Effect.catchAllCause((cause) =>
                          Effect.logWarning(
                            `Failed to remove worktree wrapper ${wrapperPath} after creation failed: ${Cause.pretty(cause)}`
                          )
                        )
                      )
                    : Effect.void
                )
              )
              yield* importWorktrees(
                project.id,
                project.repositoryPath,
                project.mainWorktreePath,
                true
              )
              yield* Effect.promise(() =>
                database.db.run(sql`
              UPDATE worktrees
              SET managed_wrapper_path=${wrapperCreated ? wrapperPath : null},
                  tree_context_json=${JSON.stringify(contextValues)}
              WHERE path=${worktreePath}
            `)
              )
              const [worktreeRow] = yield* Effect.promise(() =>
                database.db
                  .select({
                    worktree: worktrees,
                    mainWorktreePath: projects.mainWorktreePath
                  })
                  .from(worktrees)
                  .innerJoin(projects, eq(worktrees.projectId, projects.id))
                  .where(eq(worktrees.path, worktreePath))
                  .limit(1)
              )
              if (!worktreeRow) {
                return yield* Effect.fail(
                  new DomainError(
                    'WORKTREE_DISCOVERY_FAILED',
                    'Git created the worktree but it could not be discovered',
                    500
                  )
                )
              }

              const worktree = mapWorktree(
                worktreeRow.worktree,
                worktreeRow.mainWorktreePath
              )
              yield* Effect.sync(() =>
                events.publish('worktree.created', {
                  projectId,
                  worktreeId: worktree.id
                })
              )
              return { project, worktree }
            }),
          () => locks.release({ projectId })
        )

        let terminal: TerminalRecord | null = null
        let terminalError: string | null = null
        let setupError: string | null = null
        if (initialTerminal) {
          const launchOptions: TerminalLaunchOptions = {}
          if (initialTerminal.initialTitle) {
            launchOptions.initialTitle = initialTerminal.initialTitle
          }

          if (initialTerminal.returnToShell) {
            launchOptions.returnToShell = true
          }

          if (initialTerminal.initialSize) {
            launchOptions.initialSize = initialTerminal.initialSize
          }

          const setupResolution = yield* Effect.forkScoped(
            Effect.exit(
              Effect.promise(() =>
                resolveWorktreeSetupTasks({
                  shell: config.shell,
                  mainWorktreePath: project.mainWorktreePath,
                  worktreePath: worktree.path
                })
              )
            )
          )
          const initialTerminalResult = yield* Effect.exit(
            executeCreateTerminal(
              worktree.id,
              initialTerminal.name,
              initialTerminal.argv,
              launchOptions
            )
          )
          if (
            Exit.isFailure(initialTerminalResult) &&
            Cause.isInterruptedOnly(initialTerminalResult.cause)
          ) {
            return yield* Effect.interrupt
          }

          if (Exit.isSuccess(initialTerminalResult)) {
            terminal = initialTerminalResult.value
          } else {
            terminalError = causeMessage(initialTerminalResult.cause)
          }

          if (!terminal) {
            const fallback = yield* Effect.exit(
              ensureWorktreeTerminal(worktree.id)
            )
            if (
              Exit.isFailure(fallback) &&
              Cause.isInterruptedOnly(fallback.cause)
            ) {
              return yield* Effect.interrupt
            }

            if (Exit.isSuccess(fallback)) {
              terminal = fallback.value
            } else {
              terminalError ??= causeMessage(fallback.cause)
            }
          }

          const setupResult = yield* Fiber.join(setupResolution)
          if (
            Exit.isFailure(setupResult) &&
            Cause.isInterruptedOnly(setupResult.cause)
          ) {
            return yield* Effect.interrupt
          }

          const setup: {
            tasks: WorktreeSetupTask[]
            error: string | null
          } = Exit.isSuccess(setupResult)
            ? { tasks: setupResult.value, error: null }
            : {
                tasks: [],
                error: `Tree setup: ${causeMessage(setupResult.cause)}`.slice(
                  0,
                  4_096
                )
              }
          setupError = setup.error
          if (setup.tasks.length > 0 || setupError) {
            if (!terminal) {
              setupError ??=
                'Tree setup: no persistent terminal could be started'
            } else {
              const setupOptions: TerminalLaunchOptions = {
                setup: { tasks: setup.tasks, error: setupError },
                closeOnSuccess: true
              }
              if (initialTerminal.initialSize) {
                setupOptions.initialSize = initialTerminal.initialSize
              }

              const setupTerminal = yield* Effect.exit(
                executeCreateTerminal(
                  worktree.id,
                  'Setup',
                  ['true'],
                  setupOptions
                )
              )
              if (
                Exit.isFailure(setupTerminal) &&
                Cause.isInterruptedOnly(setupTerminal.cause)
              ) {
                return yield* Effect.interrupt
              }

              if (Exit.isFailure(setupTerminal)) {
                const error = Cause.squash(setupTerminal.cause)
                const setupTerminalError = `Tree setup terminal${
                  error instanceof DomainError ? ` [${error.code}]` : ''
                }: ${
                  error instanceof Error ? error.message : String(error)
                }`.slice(0, 2_048)
                setupError = setupError
                  ? `${setupError.slice(0, 2_047)}\n${setupTerminalError}`
                  : setupTerminalError
              }
            }
          }
        } else {
          const setupResultsExit = yield* Effect.exit(
            Effect.promise(() =>
              resolveWorktreeSetupTasks({
                shell: config.shell,
                mainWorktreePath: project.mainWorktreePath,
                worktreePath: worktree.path
              })
            ).pipe(
              Effect.flatMap((tasks) =>
                Effect.promise(() => runWorktreeSetupTasks({ runner, tasks }))
              )
            )
          )
          if (
            Exit.isFailure(setupResultsExit) &&
            Cause.isInterruptedOnly(setupResultsExit.cause)
          ) {
            return yield* Effect.interrupt
          }

          const setupResults = Exit.isSuccess(setupResultsExit)
            ? setupResultsExit.value
            : [
                {
                  label: 'Tree setup',
                  error: causeMessage(setupResultsExit.cause)
                }
              ]
          const setupFailure = setupResults.find((result) => result.error)
          setupError = setupFailure
            ? `${setupFailure.label}: ${setupFailure.error}`.slice(0, 4_096)
            : null
        }

        if (!terminal) {
          const fallback = yield* Effect.exit(
            ensureWorktreeTerminal(worktree.id)
          )
          if (
            Exit.isFailure(fallback) &&
            Cause.isInterruptedOnly(fallback.cause)
          ) {
            return yield* Effect.interrupt
          }

          if (Exit.isSuccess(fallback)) {
            terminal = fallback.value
          } else {
            terminalError ??= causeMessage(fallback.cause)
          }
        }

        yield* invalidateProjectsSnapshot()
        return {
          worktree: yield* projectStore.getWorktree(worktree.id),
          terminal,
          terminalError,
          setupError
        }
      })
    )
  }
}
