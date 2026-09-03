import { webPanelInputSchema } from '@treeport/shared'
import type {
  BrowserPanel,
  ProjectRecord,
  RecentProjectRecord,
  WebPanel,
  WebPanelPermission,
  WorktreeRecord
} from '@treeport/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { browserPanels, projects, webPanels } from '../../database-schema'
import { DomainError } from '../../domain'
import {
  PanelOperations,
  ProjectObservationOperations,
  TerminalOperations
} from '../domain-services'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import { DatabasePort, GitPort } from '../infrastructure/ports'
import { ProjectStore } from './project-store'

export class ProjectSnapshotService {
  private inFlight: Deferred.Deferred<ProjectRecord[], never> | null = null
  private revision = 0

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
      return yield* Effect.promise(() =>
        database.db
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
    })
  }

  getProjectSnapshot(
    projectId: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    const listProjects = this.listProjects.bind(this)

    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      yield* projectStore.requireOpenProject(projectId)
      const project = (yield* listProjects()).find(
        (candidate) => candidate.id === projectId
      )
      if (!project) {
        return yield* Effect.fail(
          new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404)
        )
      }

      return project
    })
  }

  getWorktreeSnapshot(
    worktreeId: string
  ): Effect.Effect<WorktreeRecord, DomainError<unknown>, ApplicationServices> {
    const listProjects = this.listProjects.bind(this)

    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const binding = yield* projectStore.getWorktree(worktreeId)
      yield* projectStore.requireOpenProject(binding.projectId)
      const worktree = (yield* listProjects())
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

  private collectProjectsSnapshot(): Effect.Effect<
    ProjectRecord[],
    never,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const git = yield* GitPort
      const observations = yield* ProjectObservationOperations
      const panels = yield* PanelOperations
      const projectStore = yield* ProjectStore
      const terminalService = yield* TerminalOperations
      const storedProjects = yield* projectStore.storedProjects(true)
      const snapshots = yield* Effect.all(
        storedProjects.map((storedProject) =>
          Effect.gen(function* () {
            let project = storedProject
            const observation = yield* Effect.exit(
              Effect.gen(function* () {
                if (project.kind === 'repository') {
                  yield* observations.importWorktrees(
                    project.id,
                    project.repositoryPath,
                    project.mainWorktreePath
                  )
                } else {
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
                  const dirty =
                    project.kind === 'repository' &&
                    project.availability.state === 'available' &&
                    !worktree.prunable
                      ? yield* Effect.tryPromise({
                          try: () => git.dirtyState(worktree.path),
                          catch: (cause) => cause
                        }).pipe(Effect.orElseSucceed(() => null))
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
                  const [storedBrowserPanels, storedWebPanels] =
                    yield* Effect.all(
                      [
                        Effect.promise(() =>
                          database.db
                            .select()
                            .from(browserPanels)
                            .where(eq(browserPanels.worktreeId, worktree.id))
                            .orderBy(
                              asc(browserPanels.createdAt),
                              asc(browserPanels.id)
                            )
                        ),
                        Effect.promise(() =>
                          database.db
                            .select()
                            .from(webPanels)
                            .where(eq(webPanels.worktreeId, worktree.id))
                            .orderBy(
                              asc(webPanels.createdAt),
                              asc(webPanels.id)
                            )
                        )
                      ],
                      { concurrency: 'unbounded' }
                    )
                  const definitions =
                    project.availability.state === 'available' &&
                    storedWebPanels.length > 0
                      ? yield* Effect.catchAll(
                          panels.listWebPanelDefinitions(worktree.id),
                          () => Effect.succeed([])
                        )
                      : []
                  const definitionsById = new Map(
                    definitions.map((definition) => [definition.id, definition])
                  )
                  worktree.panels = [
                    ...terminals.map((terminal) => ({
                      id: `panel_${terminal.id}`,
                      kind: 'terminal' as const,
                      worktreeId: worktree.id,
                      terminalId: terminal.id,
                      title: terminal.name,
                      createdAt: terminal.createdAt,
                      updatedAt: terminal.updatedAt
                    })),
                    ...storedBrowserPanels.map(mapBrowserPanel),
                    ...storedWebPanels.map((panel) => {
                      const definition = definitionsById.get(panel.definitionId)
                      return mapWebPanel(
                        panel,
                        definition?.permissions ?? [],
                        definition?.permissionsGranted ?? false
                      )
                    })
                  ].sort(
                    (left, right) =>
                      left.createdAt.localeCompare(right.createdAt) ||
                      left.id.localeCompare(right.id)
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

function mapBrowserPanel(row: typeof browserPanels.$inferSelect): BrowserPanel {
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

function mapWebPanel(
  row: typeof webPanels.$inferSelect,
  permissions: WebPanelPermission[] = [],
  permissionsGranted = permissions.length === 0
): WebPanel {
  const parsedInput = webPanelInputSchema
    .nullable()
    .safeParse(JSON.parse(row.inputJson))
  if (!parsedInput.success) {
    throw new Error(`Web panel ${row.id} has invalid stored launch input`)
  }

  return {
    id: row.id,
    kind: 'web',
    worktreeId: row.worktreeId,
    definitionId: row.definitionId,
    title: row.title,
    launch: { input: parsedInput.data, cwd: row.launchCwd },
    permissions,
    sandbox: {
      allowSameOrigin: permissionsGranted && permissions.includes('same-origin')
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
