import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  WORKTREE_TITLE_MAX_LENGTH,
  availableTreeName,
  normalizeWorktreeName
} from '@treeport/shared'
import type {
  CreateOperationRequest,
  LauncherTreeTitle,
  OperationRecord,
  ProjectRecord,
  TerminalRecord,
  TerminalAfterExit,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, eq, or, sql } from 'drizzle-orm'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { runCheckedEffect } from '../../command'
import { mapOperation, mapWorktree, serializeOperation } from '../../database'
import { operations, projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import { Setup, type WorktreeSetupTask } from '../../setup'
import { Zed } from '../../zed'
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
import { CommandPort, ConfigPort, EventBusPort } from '../infrastructure/ports'
import { DatabasePort } from '../../database'
import { GitPort } from '../../git'
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
  command?: string
  afterExit?: TerminalAfterExit
  initialSize?: TerminalSize
  cwd?: string
  env?: Record<string, string>
}

interface CreateInitialTerminal {
  name: string
  command?: string
  afterExit?: TerminalAfterExit
  initialSize?: TerminalSize
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
    options?: TerminalLaunchOptions
  ) {
    return Effect.flatMap(TerminalOperations, (terminals) =>
      terminals.executeCreateTerminal(
        worktreeId,
        name,
        options,
        undefined,
        undefined,
        true
      )
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

      const rows = yield* database
        .execute('worktree.creation.service.145', (db) =>
          db
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
        .pipe(Effect.orDie)

      return rows.map(mapOperation)
    })
  }

  beginCreateWorktree(
    projectId: string,
    inputName: string | undefined,
    base: 'default' | 'current',
    initialTerminal?: CreateInitialTerminal,
    sourceWorktreeId?: string,
    treeTitle?: LauncherTreeTitle
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
        try: () =>
          inputName === undefined
            ? availableTreeName(
                project.worktrees.map((worktree) => worktree.name)
              )
            : normalizeWorktreeName(inputName),
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

      if (treeTitle) {
        request.treeTitle = treeTitle
      }

      yield* database
        .execute('worktree.creation.service.239', (db) =>
          db.run(sql`
          INSERT INTO operations(
            id,kind,project_id,worktree_id,status,request_json,result_json,error,
            created_at,updated_at
          ) VALUES(
            ${operationId},'create',${projectId},NULL,'pending',
            ${serializeOperation(request)},NULL,NULL,${timestamp},${timestamp}
          )
        `)
        )
        .pipe(Effect.orDie)
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
            treeTitle
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
    initialTerminal?: CreateInitialTerminal,
    sourceWorktreeId?: string,
    treeTitle?: LauncherTreeTitle
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    const executeCreateWorktree = this.executeCreateWorktree.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      yield* database
        .execute('worktree.creation.service.300', (db) =>
          db.run(sql`
          UPDATE operations SET status='running',updated_at=${now()}
          WHERE id=${operationId} AND status='pending'
        `)
        )
        .pipe(Effect.orDie)

      const creation = executeCreateWorktree(
        projectId,
        inputName,
        base,
        initialTerminal,
        sourceWorktreeId,
        treeTitle
      )

      yield* Effect.matchCauseEffect(creation, {
        onSuccess: (result) =>
          Effect.gen(function* () {
            const timestamp = now()
            yield* database
              .execute('worktree.creation.service.319', (db) =>
                db.run(sql`
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
              .pipe(Effect.orDie)
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
            yield* database
              .execute('worktree.creation.service.343', (db) =>
                db.run(sql`
                UPDATE operations
                SET status='failed',error=${message.slice(0, 4_096)},updated_at=${now()}
                WHERE id=${operationId}
              `)
              )
              .pipe(Effect.orDie)
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

  resumeCreate(
    operationId: string,
    projectId: string,
    request: CreateOperationRequest
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    let initialTerminal: CreateInitialTerminal | undefined

    if (request.initialTerminal) {
      initialTerminal = { name: request.initialTerminal.name }

      if (request.initialTerminal.command !== undefined) {
        initialTerminal.command = request.initialTerminal.command
      }

      if (request.initialTerminal.afterExit !== undefined) {
        initialTerminal.afterExit = request.initialTerminal.afterExit
      }

      if (request.initialTerminal.initialSize !== undefined) {
        initialTerminal.initialSize = request.initialTerminal.initialSize
      }
    }

    return this.executeCreateOperation(
      operationId,
      projectId,
      request.name,
      request.base,
      initialTerminal,
      request.sourceWorktreeId,
      request.treeTitle
    )
  }

  createWorktree(
    projectId: string,
    inputName: string | undefined,
    base: 'default' | 'current',
    initialTerminal?: CreateInitialTerminal,
    sourceWorktreeId?: string,
    treeTitle?: LauncherTreeTitle
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
          inputName ??
            availableTreeName(
              project.worktrees.map((worktree) => worktree.name)
            ),
          base,
          initialTerminal,
          sourceWorktreeId,
          treeTitle
        )
      )
    })
  }

  private executeCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: CreateInitialTerminal,
    sourceWorktreeId?: string,
    treeTitle?: LauncherTreeTitle
  ): Effect.Effect<
    CreateWorktreeResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    const observeAvailableProject = this.observeAvailableProject.bind(this)
    const importWorktrees = this.importWorktrees.bind(this)
    const executeCreateTerminal = this.executeCreateTerminal.bind(this)

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
        const snapshots = yield* ProjectSnapshotOperations
        const setupService = yield* Setup
        const zed = yield* Zed

        const { project, worktree } = yield* Effect.acquireUseRelease(
          locks
            .tryAcquire({ projectId, projectLockKind: 'worktree-creation' })
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
              const project = yield* observeAvailableProject(
                yield* projectStore.getProject(projectId),
                true
              )

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

              const destination = yield* zed
                .resolveWorktreePath(project.mainWorktreePath, name)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new DomainError(
                        'INVALID_WORKTREE_PATH',
                        error.message,
                        400
                      )
                  )
                )

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

                commit = yield* git
                  .resolveCommit(source.path)
                  .pipe(Effect.orDie)
              } else {
                commit = yield* git
                  .resolveDefaultCommit(project.repositoryPath)
                  .pipe(Effect.orDie)
              }

              const preparedWrapper = yield* zed
                .prepareWorktreeWrapper(project.mainWorktreePath, wrapperPath)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new DomainError(
                        'INVALID_WORKTREE_PATH',
                        error.message,
                        400
                      )
                  )
                )

              const wrapperCreated = preparedWrapper.created
              wrapperPath = preparedWrapper.path
              worktreePath = path.join(
                wrapperPath,
                path.basename(project.mainWorktreePath)
              )
              yield* git
                .createDetachedWorktree(
                  project.repositoryPath,
                  worktreePath,
                  commit
                )
                .pipe(Effect.orDie)
                .pipe(
                  Effect.onError(() =>
                    wrapperCreated
                      ? Effect.tryPromise(() => fs.rmdir(wrapperPath))
                          .pipe(Effect.orDie)
                          .pipe(
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
                true,
                true
              )
              yield* database
                .execute('worktree.creation.service.629', (db) =>
                  db.run(sql`
              UPDATE worktrees
              SET managed_wrapper_path=${wrapperCreated ? wrapperPath : null}
              WHERE path=${worktreePath}
            `)
                )
                .pipe(Effect.orDie)

              const [worktreeRow] = yield* database
                .execute('worktree.creation.service.637', (db) =>
                  db
                    .select({
                      worktree: worktrees,
                      mainWorktreePath: projects.mainWorktreePath
                    })
                    .from(worktrees)
                    .innerJoin(projects, eq(worktrees.projectId, projects.id))
                    .where(eq(worktrees.path, worktreePath))
                    .limit(1)
                )
                .pipe(Effect.orDie)

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

              yield* Effect.acquireRelease(
                locks
                  .tryAcquire({ worktreeIds: [worktree.id] })
                  .pipe(
                    Effect.flatMap((acquired) =>
                      acquired
                        ? Effect.void
                        : Effect.fail(
                            new DomainError(
                              'WORKTREE_BUSY',
                              'The new tree is already being modified',
                              409
                            )
                          )
                    )
                  ),
                () => locks.release({ worktreeIds: [worktree.id] })
              )

              if (treeTitle) {
                worktree.pendingTitle = treeTitle.pendingTitle
                yield* Effect.sync(() =>
                  snapshots.setPendingTitle(worktree.id, treeTitle.pendingTitle)
                )
              }

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

        const [titleExecutable, ...titleArgs] = treeTitle?.command ?? []

        if (titleExecutable) {
          yield* Effect.forkDaemon(
            runCheckedEffect(runner, {
              executable: titleExecutable,
              args: titleArgs,
              cwd: worktree.path,
              timeoutMs: 120_000,
              maxStdoutBytes: 64 * 1024
            }).pipe(
              Effect.flatMap((result) => {
                const title = result.stdout
                  .split('\n')
                  .map((line) => line.trim())
                  .find(Boolean)
                  ?.slice(0, WORKTREE_TITLE_MAX_LENGTH)

                if (!title) {
                  return Effect.void
                }

                return database
                  .execute('worktree.creation.service.title', (db) =>
                    db.run(sql`
                    UPDATE worktrees SET title=${title},updated_at=${now()}
                    WHERE id=${worktree.id} AND title IS NULL
                  `)
                  )
                  .pipe(Effect.orDie)
              }),
              Effect.catchAllCause((cause) =>
                Effect.logWarning(
                  `Tree title command failed for ${worktree.id}: ${Cause.pretty(cause)}`
                )
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  snapshots.setPendingTitle(worktree.id, null)
                  events.publish('project.updated', {
                    projectId: worktree.projectId
                  })
                })
              )
            )
          )
        }

        let terminal: TerminalRecord | null = null
        let terminalError: string | null = null
        let setupError: string | null = null

        if (initialTerminal) {
          const launchOptions: TerminalLaunchOptions = {}

          if (initialTerminal.command) {
            launchOptions.command = initialTerminal.command
          }

          if (initialTerminal.afterExit) {
            launchOptions.afterExit = initialTerminal.afterExit
          }

          if (initialTerminal.initialSize) {
            launchOptions.initialSize = initialTerminal.initialSize
          }

          const setupResolution = yield* Effect.forkScoped(
            Effect.exit(
              setupService.resolveSetupTasks({
                shell: config.shell,
                mainWorktreePath: project.mainWorktreePath,
                worktreePath: worktree.path
              })
            )
          )

          const initialTerminalResult = yield* Effect.exit(
            executeCreateTerminal(
              worktree.id,
              initialTerminal.name,
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
              executeCreateTerminal(worktree.id, 'Terminal')
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
                command: 'true',
                afterExit: 'closeOnSuccess'
              }

              if (initialTerminal.initialSize) {
                setupOptions.initialSize = initialTerminal.initialSize
              }

              const setupTerminal = yield* Effect.exit(
                executeCreateTerminal(worktree.id, 'Setup', setupOptions)
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
            setupService
              .resolveSetupTasks({
                shell: config.shell,
                mainWorktreePath: project.mainWorktreePath,
                worktreePath: worktree.path
              })
              .pipe(
                Effect.flatMap((tasks) =>
                  setupService.runTasks({ runner, tasks })
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
            executeCreateTerminal(worktree.id, 'Terminal')
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
