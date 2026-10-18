import { decodeUnknownOrNull, webAppInputSchema } from '@treeport/shared'
import type {
  BrowserApp,
  ProjectRecord,
  RecentProjectRecord,
  WebApp,
  WebAppPermission,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import {
  browserApps,
  projects,
  webApps,
  workspaceItemOrders
} from '../../database-schema'
import { DomainError } from '../../domain'
import {
  AppOperations,
  ProjectObservationOperations,
  TerminalOperations
} from '../domain-services'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import { DatabasePort } from '../../database'
import { GitPort } from '../../git'
import { ProjectStore } from './project-store'

export class ProjectSnapshotService {
  private inFlight: Deferred.Deferred<ProjectRecord[], never> | null = null
  private revision = 0
  private readonly dirtyStates = new Map<
    string,
    { path: string; state: WorktreeRecord['dirty'] }
  >()
  private readonly refreshDue = new Map<string, number>()

  invalidate(): void {
    this.revision += 1
    this.inFlight = null
  }

  listProjects(): Effect.Effect<ProjectRecord[], never, ApplicationServices> {
    const collectCurrentProjectsSnapshot =
      this.collectCurrentProjectsSnapshot.bind(this)

    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        const candidate = yield* Deferred.make<ProjectRecord[], never>()
        const active = yield* Effect.sync(() => {
          if (this.inFlight) {
            return this.inFlight
          }

          this.inFlight = candidate
          return candidate
        })
        if (active !== candidate) {
          return yield* restore(Deferred.await(active))
        }

        const result = yield* Effect.exit(
          restore(collectCurrentProjectsSnapshot())
        )
        yield* Deferred.done(candidate, result)
        yield* Effect.sync(() => {
          if (this.inFlight === candidate) {
            this.inFlight = null
          }
        })
        if (Exit.isSuccess(result)) {
          return result.value
        }

        return yield* Effect.failCause(result.cause)
      })
    )
  }

  listRecentProjects(): Effect.Effect<
    RecentProjectRecord[],
    never,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      return yield* database
        .execute('project.snapshot.service.85', (db) =>
          db
            .select({
              id: projects.id,
              name: projects.name,
              kind: projects.kind,
              rootPath: projects.repositoryPath,
              repositoryPath: projects.repositoryPath,
              lastOpenedAt: projects.lastOpenedAt
            })
            .from(projects)
            .where(and(eq(projects.isOpen, 0), eq(projects.showInRecents, 1)))
            .orderBy(desc(projects.lastOpenedAt), asc(projects.id))
        )
        .pipe(Effect.orDie)
    })
  }

  getProjectSnapshot(
    projectId: string,
    freshGitWorktreeId?: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    const collectProjectsSnapshot = this.collectProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      yield* projectStore.requireOpenProject(projectId)
      const project = (yield* collectProjectsSnapshot(projectId))[0]
      if (!project) {
        return yield* Effect.fail(
          new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
        )
      }

      // Context callers need current Git identity, not the bounded background
      // refresh's durable inventory. Overlay the response without reconciling
      // trees or writing cached metadata; ordinary metadata reads stay Git-free.
      if (freshGitWorktreeId && project.kind === 'repository') {
        const worktree = project.worktrees.find(
          (candidate) => candidate.id === freshGitWorktreeId
        )
        if (!worktree) {
          return yield* Effect.fail(
            new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
          )
        }

        const git = yield* GitPort
        const inventory = yield* git
          .listWorktrees(project.repositoryPath)
          .pipe(
            Effect.mapError(
              (error) =>
                new DomainError('PROJECT_UNAVAILABLE', error.message, 503)
            )
          )
        const live = inventory.find(
          (candidate) => candidate.path === worktree.path && !candidate.prunable
        )
        if (!live) {
          return yield* Effect.fail(
            new DomainError(
              'WORKTREE_UNAVAILABLE',
              'Registered tree is missing from the live Git inventory',
              409
            )
          )
        }

        worktree.head = live.head ?? ''
        worktree.branch = live.branch
        worktree.detached = live.detached
      }

      return project
    })
  }

  getWorktreeSnapshot(
    worktreeId: string
  ): Effect.Effect<WorktreeRecord, DomainError<unknown>, ApplicationServices> {
    const collectProjectsSnapshot = this.collectProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const binding = yield* projectStore.getWorktree(worktreeId)
      yield* projectStore.requireOpenProject(binding.projectId)
      const worktree = (yield* collectProjectsSnapshot(binding.projectId))
        .flatMap((project) => project.worktrees)
        .find((candidate) => candidate.id === worktreeId)
      if (!worktree) {
        return yield* Effect.fail(
          new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
        )
      }

      return worktree
    })
  }

  private collectCurrentProjectsSnapshot(): Effect.Effect<
    ProjectRecord[],
    never,
    ApplicationServices
  > {
    const collectProjectsSnapshot = this.collectProjectsSnapshot.bind(this)

    return Effect.gen(this, function* () {
      while (true) {
        const revision = this.revision
        const projects = yield* collectProjectsSnapshot()
        if (revision === this.revision) {
          return projects
        }
      }
    })
  }

  // Run by the daemon, not by HTTP metadata reads. One tree status or
  // project reconciliation per tick bounds subprocess pressure.
  refreshGitState(): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(this, function* () {
      const store = yield* ProjectStore
      const git = yield* GitPort
      const observations = yield* ProjectObservationOperations
      const projects = yield* store.storedProjects(true)
      const tasks = projects.flatMap((project) => [
        ...(project.kind === 'repository'
          ? [{ key: `project:${project.id}`, project, worktree: null }]
          : []),
        ...project.worktrees
          .filter((tree) => project.kind === 'repository' && !tree.prunable)
          .map((worktree) => ({
            key: `tree:${worktree.id}:${worktree.path}`,
            project,
            worktree
          }))
      ])
      const keys = new Set(tasks.map((task) => task.key))
      const treeIds = new Set(
        projects.flatMap((project) => project.worktrees.map((tree) => tree.id))
      )
      for (const id of this.dirtyStates.keys()) {
        if (!treeIds.has(id)) {
          this.dirtyStates.delete(id)
        }
      }
      for (const key of this.refreshDue.keys()) {
        if (!keys.has(key)) {
          this.refreshDue.delete(key)
        }
      }
      const now = Date.now()
      const task = tasks
        .filter((candidate) => (this.refreshDue.get(candidate.key) ?? 0) <= now)
        .sort(
          (a, b) =>
            (this.refreshDue.get(a.key) ?? 0) -
            (this.refreshDue.get(b.key) ?? 0)
        )[0]
      if (!task) {
        return
      }

      // Reserve the slot before awaiting I/O so concurrent refreshes cannot
      // schedule the same expensive operation twice.
      this.refreshDue.set(task.key, now + (task.worktree ? 45_000 : 60_000))
      if (task.worktree) {
        const tree = task.worktree
        const state = yield* git
          .dirtyState(tree.path)
          .pipe(Effect.orElseSucceed(() => null))
        this.dirtyStates.set(tree.id, { path: tree.path, state })
      } else {
        yield* observations.importWorktrees(
          task.project.id,
          task.project.repositoryPath,
          task.project.mainWorktreePath
        )
      }
    })
  }

  private collectProjectsSnapshot(
    projectId?: string
  ): Effect.Effect<ProjectRecord[], never, ApplicationServices> {
    const dirtyStates = this.dirtyStates
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const observations = yield* ProjectObservationOperations
      const apps = yield* AppOperations
      const projectStore = yield* ProjectStore
      const terminalService = yield* TerminalOperations
      const storedProjects = projectId
        ? [yield* projectStore.storedProject(projectId)].filter(
            (project): project is ProjectRecord => project !== null
          )
        : yield* projectStore.storedProjects(true)
      const snapshots = yield* Effect.all(
        storedProjects.map((storedProject) =>
          Effect.gen(function* () {
            let project = storedProject
            const observation = yield* Effect.exit(
              Effect.gen(function* () {
                if (project.kind !== 'repository') {
                  project = yield* observations.observeAvailableProject(project)
                }

                yield* terminalService.ensureProjectTerminals(project.id)
                project =
                  (yield* projectStore.storedProject(project.id)) ?? project
              })
            )
            if (Exit.isFailure(observation)) {
              if (Cause.isInterruptedOnly(observation.cause)) {
                return yield* Effect.interrupt
              }

              const error = Cause.squash(observation.cause)
              project.availability = {
                state: 'unavailable',
                message: error instanceof Error ? error.message : String(error)
              }
            }

            if ((yield* projectStore.projectOpenState(project.id)) !== true) {
              return null
            }

            yield* Effect.all(
              project.worktrees.map((worktree) =>
                Effect.gen(function* () {
                  const cachedDirty = dirtyStates.get(worktree.id)
                  const dirty =
                    project.kind === 'repository' &&
                    project.availability.state === 'available' &&
                    !worktree.prunable &&
                    cachedDirty?.path === worktree.path
                      ? cachedDirty.state
                      : null
                  const terminalInventory = yield* Effect.exit(
                    terminalService.listWorktreeTerminals(worktree)
                  )
                  if (
                    Exit.isFailure(terminalInventory) &&
                    Cause.isInterruptedOnly(terminalInventory.cause)
                  ) {
                    return yield* Effect.interrupt
                  }

                  const terminals = Exit.isSuccess(terminalInventory)
                    ? terminalInventory.value
                    : []
                  if (Exit.isFailure(terminalInventory)) {
                    const error = Cause.squash(terminalInventory.cause)
                    project.availability = {
                      state: 'unavailable',
                      message:
                        error instanceof Error ? error.message : String(error)
                    }
                  }

                  worktree.dirty = dirty
                  worktree.terminals = terminals
                  const [storedBrowserApps, storedWebApps, storedToolOrder] =
                    yield* Effect.all(
                      [
                        database
                          .execute('project.snapshot.service.255', (db) =>
                            db
                              .select()
                              .from(browserApps)
                              .where(eq(browserApps.worktreeId, worktree.id))
                              .orderBy(
                                asc(browserApps.createdAt),
                                asc(browserApps.id)
                              )
                          )
                          .pipe(Effect.orDie),
                        database
                          .execute('project.snapshot.service.265', (db) =>
                            db
                              .select()
                              .from(webApps)
                              .where(eq(webApps.worktreeId, worktree.id))
                              .orderBy(asc(webApps.createdAt), asc(webApps.id))
                          )
                          .pipe(Effect.orDie),
                        database
                          .execute('project.snapshot.service.272', (db) =>
                            db
                              .select()
                              .from(workspaceItemOrders)
                              .where(
                                and(
                                  eq(
                                    workspaceItemOrders.worktreeId,
                                    worktree.id
                                  ),
                                  eq(workspaceItemOrders.surface, 'tool')
                                )
                              )
                              .orderBy(asc(workspaceItemOrders.position))
                          )
                          .pipe(Effect.orDie)
                      ],
                      { concurrency: 'unbounded' }
                    )
                  const definitions =
                    project.availability.state === 'available' &&
                    storedWebApps.length > 0
                      ? yield* Effect.catchAll(
                          apps.listWebAppDefinitions(worktree.id),
                          () => Effect.succeed([])
                        )
                      : []
                  const definitionsById = new Map(
                    definitions.map((definition) => [definition.id, definition])
                  )
                  const workspaceItems = [
                    ...terminals.map((terminal) => ({
                      id: `terminal_${terminal.id}`,
                      kind: 'terminal' as const,
                      worktreeId: worktree.id,
                      terminalId: terminal.id,
                      title: terminal.name,
                      createdAt: terminal.createdAt,
                      updatedAt: terminal.updatedAt
                    })),
                    ...storedBrowserApps.map(mapBrowserApp),
                    ...storedWebApps.map((app) => {
                      const definition = definitionsById.get(app.definitionId)
                      return mapWebApp(
                        app,
                        definition?.permissions ?? [],
                        definition?.permissionsGranted ?? false,
                        definition?.sandbox.enabled ?? true
                      )
                    })
                  ].sort(
                    (left, right) =>
                      left.createdAt.localeCompare(right.createdAt) ||
                      left.id.localeCompare(right.id)
                  )
                  const toolPositionById = new Map(
                    storedToolOrder.map((item) => [item.itemId, item.position])
                  )
                  const orderedTools = workspaceItems
                    .filter((app) => app.kind !== 'terminal')
                    .sort((left, right) => {
                      const leftPosition = toolPositionById.get(left.id)
                      const rightPosition = toolPositionById.get(right.id)

                      if (
                        leftPosition !== undefined ||
                        rightPosition !== undefined
                      ) {
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
                  let toolIndex = 0
                  worktree.workspaceItems = workspaceItems.map((app) =>
                    app.kind === 'terminal' ? app : orderedTools[toolIndex++]!
                  )
                })
              ),
              { concurrency: 'unbounded', discard: true }
            )
            return project
          })
        ),
        { concurrency: 'unbounded' }
      )
      return snapshots.filter(
        (project): project is ProjectRecord => project !== null
      )
    })
  }
}

function mapBrowserApp(row: typeof browserApps.$inferSelect): BrowserApp {
  return {
    id: row.id,
    kind: 'browser',
    worktreeId: row.worktreeId,
    title: row.title,
    url: row.url,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function mapWebApp(
  row: typeof webApps.$inferSelect,
  permissions: WebAppPermission[] = [],
  permissionsGranted = permissions.length === 0,
  sandboxEnabled = true
): WebApp {
  const parsedInput = decodeUnknownOrNull(
    Schema.NullOr(webAppInputSchema),
    JSON.parse(row.inputJson)
  )
  if (parsedInput === null && row.inputJson !== 'null') {
    throw new Error(`Web app ${row.id} has invalid stored launch input`)
  }

  return {
    id: row.id,
    kind: 'web',
    worktreeId: row.worktreeId,
    definitionId: row.definitionId,
    title: row.title,
    launch: { input: parsedInput, cwd: row.launchCwd },
    permissions,
    sandbox: {
      enabled: sandboxEnabled,
      allowSameOrigin:
        !sandboxEnabled ||
        (permissionsGranted && permissions.includes('same-origin'))
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
