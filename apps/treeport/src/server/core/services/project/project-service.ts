import fs from 'node:fs/promises'
import path from 'node:path'
import { decodeUnknownOrNull, treeContextValuesSchema } from '@treeport/shared'
import type {
  DirectoryBrowseResponse,
  OperationRecord,
  ProjectColor,
  ProjectRecord,
  RecentProjectRecord,
  TreeContextFieldListing,
  TreeContextValues,
  WorktreeRecord
} from '@treeport/shared'
import { and, eq, sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import { loadTreeContextFields } from '../../tree-context'
import {
  ProjectObservationOperations,
  ProjectRegistrationOperations,
  ProjectSnapshotOperations,
  TerminalOperations
} from '../domain-services'
import {
  type ApplicationServices,
  ProjectObservations,
  WorktreeMutations
} from '../infrastructure/application-runtime'
import { MutationLocks } from '../infrastructure/mutation-locks'
import {
  ConfigPort,
  DatabasePort,
  EventBusPort,
  GitPort,
  PackageSystemPort,
  TerminalHostPort
} from '../infrastructure/ports'
import { TerminalState } from '../terminal/terminal-state'
import { ProjectDirectoryService } from './project-directory-service'
import { ProjectFolderIdentities } from './project-folder-identities'
import { ProjectStore } from './project-store'

const now = (): string => new Date().toISOString()

export class ProjectService {
  private readonly directory = new ProjectDirectoryService()

  storedProjects(
    openOnly = false
  ): Effect.Effect<ProjectRecord[], never, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.storedProjects(openOnly)
    )
  }

  storedProject(
    projectId: string
  ): Effect.Effect<ProjectRecord | null, never, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.storedProject(projectId)
    )
  }

  storedWorktree(
    worktreeId: string
  ): Effect.Effect<WorktreeRecord | null, never, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.storedWorktree(worktreeId)
    )
  }

  projectOpenState(
    projectId: string
  ): Effect.Effect<boolean | null, never, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.projectOpenState(projectId)
    )
  }

  storedOperation(
    operationId: string
  ): Effect.Effect<OperationRecord | null, never, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.storedOperation(operationId)
    )
  }

  private invalidateProjectsSnapshot() {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      Effect.sync(() => snapshots.invalidate())
    )
  }

  registerProject(
    inputPath: string,
    requestedName?: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(ProjectRegistrationOperations, (registration) =>
      registration.registerProject(inputPath, requestedName)
    )
  }

  reconcile(): Effect.Effect<void, never, ApplicationServices> {
    return Effect.flatMap(ProjectObservationOperations, (observations) =>
      observations.reconcile()
    )
  }

  listProjects(): Effect.Effect<ProjectRecord[], never, ApplicationServices> {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      snapshots.listProjects()
    )
  }

  listRecentProjects(): Effect.Effect<
    RecentProjectRecord[],
    never,
    ApplicationServices
  > {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      snapshots.listRecentProjects()
    )
  }

  getProjectSnapshot(
    projectId: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      snapshots.getProjectSnapshot(projectId)
    )
  }

  getWorktreeSnapshot(
    worktreeId: string
  ): Effect.Effect<WorktreeRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      snapshots.getWorktreeSnapshot(worktreeId)
    )
  }

  getProject(
    projectId: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) => store.getProject(projectId))
  }

  requireOpenProject(
    projectId: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.requireOpenProject(projectId)
    )
  }

  resolveRegisteredProject(
    identifier: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const direct = yield* projectStore.storedProject(identifier)
      if (direct) {
        return direct
      }

      const canonical = yield* canonicalPath(identifier)
      const match = (yield* projectStore.storedProjects()).find(
        (project) =>
          isPathWithin(canonical, project.rootPath) ||
          project.worktrees.some((worktree) =>
            isPathWithin(canonical, worktree.path)
          )
      )
      if (!match) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_NOT_FOUND',
            `No registered project contains ${identifier}`,
            404
          )
        )
      }

      return match
    })
  }

  updateProjectColor(
    projectId: string,
    color: ProjectColor | null
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const locks = yield* MutationLocks
      const projectStore = yield* ProjectStore
      const worktreeMutations = yield* WorktreeMutations
      yield* projectStore.requireOpenProject(projectId)
      if (
        (yield* locks.isProjectLocked(projectId)) ||
        (yield* worktreeMutations.isBusy(projectId))
      ) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_BUSY',
            'Project is already being modified',
            409
          )
        )
      }

      yield* Effect.promise(() =>
        database.db.run(sql`
          UPDATE projects SET color = ${color}, updated_at = ${now()}
          WHERE id = ${projectId}
        `)
      )
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('project.updated', { projectId })
      })
      return yield* projectStore.getProject(projectId)
    })
  }

  listTreeContextFields(
    projectId: string
  ): Effect.Effect<
    TreeContextFieldListing,
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const config = yield* ConfigPort
      const projectStore = yield* ProjectStore
      const project = yield* projectStore.getProject(projectId)
      return yield* Effect.promise(() =>
        loadTreeContextFields({
          dataDir: config.dataDir,
          projectRoot: project.rootPath
        })
      )
    })
  }

  getWorktree(
    worktreeId: string
  ): Effect.Effect<WorktreeRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.getWorktree(worktreeId)
    )
  }

  getWorktreeContext(
    worktreeId: string
  ): Effect.Effect<
    TreeContextValues,
    DomainError<unknown>,
    ApplicationServices
  > {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const [row] = yield* Effect.promise(() =>
        database.db
          .select({ treeContextJson: worktrees.treeContextJson })
          .from(worktrees)
          .where(eq(worktrees.id, worktreeId))
          .limit(1)
      )
      if (!row) {
        return yield* Effect.fail(
          new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
        )
      }

      const context = decodeUnknownOrNull(
        treeContextValuesSchema,
        JSON.parse(row.treeContextJson)
      )
      if (!context) {
        throw new Error(`Tree ${worktreeId} has invalid stored context`)
      }

      return context
    })
  }

  requestWorkspaceOpen(
    worktreeId: string,
    sourceTerminalId: string
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const events = yield* EventBusPort
      const projectStore = yield* ProjectStore
      const worktree = yield* projectStore.getWorktree(worktreeId)
      yield* projectStore.requireOpenProject(worktree.projectId)
      yield* Effect.sync(() =>
        events.publish('workspace.open_requested', {
          worktreeId,
          sourceTerminalId
        })
      )
    })
  }

  getOperation(
    operationId: string
  ): Effect.Effect<OperationRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.flatMap(ProjectStore, (store) =>
      store.getOperation(operationId)
    )
  }

  resolveProject(
    identifier: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const direct = yield* projectStore.storedProject(identifier)
      if (direct) {
        return yield* projectStore.requireOpenProject(direct.id)
      }

      const canonical = yield* canonicalPath(identifier)
      const match = (yield* projectStore.storedProjects()).find(
        (project) =>
          isPathWithin(canonical, project.rootPath) ||
          project.worktrees.some((worktree) =>
            isPathWithin(canonical, worktree.path)
          )
      )
      if (!match) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_NOT_FOUND',
            `No registered project contains ${identifier}`,
            404
          )
        )
      }

      yield* projectStore.requireOpenProject(match.id)
      return match
    })
  }

  resolveWorktree(
    identifier: string
  ): Effect.Effect<WorktreeRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const direct = yield* projectStore.storedWorktree(identifier)
      if (direct) {
        yield* projectStore.requireOpenProject(direct.projectId)
        return direct
      }

      const canonical = yield* canonicalPath(identifier)
      const matches = (yield* projectStore.storedProjects())
        .flatMap((project) => project.worktrees)
        .filter((worktree) => isPathWithin(canonical, worktree.path))
        .sort((a, b) => b.path.length - a.path.length)
      const match = matches[0]
      if (!match) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_NOT_FOUND',
            `No registered tree contains ${identifier}`,
            404
          )
        )
      }

      yield* projectStore.requireOpenProject(match.projectId)
      return match
    })
  }

  browseDirectory(
    inputPath: string,
    showHidden = false
  ): Effect.Effect<
    DirectoryBrowseResponse,
    DomainError<unknown>,
    ApplicationServices
  > {
    return this.directory.browseDirectory(inputPath, showHidden)
  }

  refreshProject(
    projectId: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const git = yield* GitPort
      const locks = yield* MutationLocks
      const packages = yield* PackageSystemPort
      const observations = yield* ProjectObservationOperations
      const projectStore = yield* ProjectStore
      const terminals = yield* TerminalOperations
      const worktreeMutations = yield* WorktreeMutations
      yield* projectStore.requireOpenProject(projectId)
      if (yield* worktreeMutations.isBusy(projectId)) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_BUSY',
            'Project is already being modified',
            409
          )
        )
      }

      return yield* Effect.acquireUseRelease(
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
            const project = yield* observations.observeAvailableProject(
              yield* projectStore.getProject(projectId)
            )
            yield* terminals.ensureProjectTerminals(projectId)
            if (project.kind === 'repository') {
              const defaultBranch = yield* Effect.promise(() =>
                git.defaultBranch(project.repositoryPath)
              )
              yield* Effect.promise(() =>
                database.db.run(sql`
                  UPDATE projects
                  SET default_branch = ${defaultBranch}, updated_at = ${now()}
                  WHERE id = ${projectId}
                `)
              )
            }

            yield* observations.reconcile()
            const currentProject = yield* projectStore.getProject(projectId)
            yield* packages.registerProject(currentProject)
            yield* invalidateProjectsSnapshot()
            yield* Effect.sync(() => {
              events.publish('project.updated', { projectId })
            })
            return yield* projectStore.getProject(projectId)
          }),
        () => locks.release({ projectId })
      )
    })
  }

  openProject(
    projectId: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const locks = yield* MutationLocks
      const packages = yield* PackageSystemPort
      const projectObservations = yield* ProjectObservations
      const projectSnapshots = yield* ProjectSnapshotOperations
      const projectStore = yield* ProjectStore
      const worktreeMutations = yield* WorktreeMutations
      yield* projectObservations.enqueue(
        projectId,
        Effect.gen(function* () {
          yield* projectStore.getProject(projectId)
          if (yield* worktreeMutations.isBusy(projectId)) {
            return yield* Effect.fail(
              new DomainError(
                'PROJECT_BUSY',
                'Project is already being modified',
                409
              )
            )
          }

          yield* Effect.acquireUseRelease(
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
                const timestamp = now()
                yield* Effect.promise(() =>
                  database.db
                    .update(projects)
                    .set({
                      isOpen: 1,
                      showInRecents: 0,
                      lastOpenedAt: timestamp,
                      updatedAt: timestamp
                    })
                    .where(eq(projects.id, projectId))
                )
                const project = yield* projectStore.getProject(projectId)
                yield* packages.registerProject(project)
                yield* invalidateProjectsSnapshot()
                yield* Effect.sync(() => {
                  events.publish('project.updated', { projectId })
                })
              }),
            () => locks.release({ projectId })
          )
        })
      )
      return yield* projectSnapshots.getProjectSnapshot(projectId)
    })
  }

  closeProject(
    projectId: string
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const locks = yield* MutationLocks
      const projectObservations = yield* ProjectObservations
      const projectStore = yield* ProjectStore
      const worktreeMutations = yield* WorktreeMutations
      yield* projectObservations.enqueue(
        projectId,
        Effect.gen(function* () {
          const project = yield* projectStore.getProject(projectId)
          if ((yield* projectStore.projectOpenState(projectId)) !== true) {
            return
          }

          const lockedWorktreeIds = project.worktrees.map(
            (worktree) => worktree.id
          )
          if (yield* worktreeMutations.isBusy(projectId)) {
            return yield* Effect.fail(
              new DomainError(
                'PROJECT_BUSY',
                'Project is already being modified',
                409
              )
            )
          }

          yield* Effect.acquireUseRelease(
            locks
              .tryAcquire({
                projectId,
                worktreeIds: lockedWorktreeIds
              })
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
                yield* Effect.promise(() =>
                  database.db
                    .update(projects)
                    .set({ isOpen: 0, showInRecents: 1, updatedAt: now() })
                    .where(eq(projects.id, projectId))
                )
                yield* invalidateProjectsSnapshot()
                yield* Effect.sync(() => {
                  events.publish('project.updated', { projectId })
                })
              }),
            () =>
              locks.release({
                projectId,
                worktreeIds: lockedWorktreeIds
              })
          )
        })
      )
    })
  }

  dismissRecentProject(
    projectId: string
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const projectObservations = yield* ProjectObservations
      const projectStore = yield* ProjectStore
      yield* projectObservations.enqueue(
        projectId,
        Effect.gen(function* () {
          yield* projectStore.getProject(projectId)
          if ((yield* projectStore.projectOpenState(projectId)) !== false) {
            return yield* Effect.fail(
              new DomainError(
                'PROJECT_NOT_RECENT',
                'Project is open and cannot be removed from Recent projects',
                409
              )
            )
          }

          yield* Effect.promise(() =>
            database.db
              .update(projects)
              .set({ showInRecents: 0, updatedAt: now() })
              .where(and(eq(projects.id, projectId), eq(projects.isOpen, 0)))
          )
          yield* Effect.sync(() =>
            events.publish('project.updated', { projectId })
          )
        })
      )
    })
  }

  deleteProject(
    projectId: string
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const locks = yield* MutationLocks
      const packages = yield* PackageSystemPort
      const folderIdentities = yield* ProjectFolderIdentities
      const observations = yield* ProjectObservationOperations
      const projectStore = yield* ProjectStore
      const terminalHost = yield* TerminalHostPort
      const terminalState = yield* TerminalState
      const worktreeMutations = yield* WorktreeMutations
      if (yield* worktreeMutations.isBusy(projectId)) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_BUSY',
            'Project is already being modified',
            409
          )
        )
      }

      let project = yield* projectStore.getProject(projectId)
      const lockedWorktrees = project.worktrees.map((worktree) => worktree.id)
      yield* Effect.acquireUseRelease(
        locks
          .tryAcquire({ projectId, worktreeIds: lockedWorktrees })
          .pipe(
            Effect.flatMap((acquired) =>
              acquired
                ? Effect.void
                : Effect.fail(
                    new DomainError(
                      'PROJECT_BUSY',
                      'A project tree is already being modified',
                      409
                    )
                  )
            )
          ),
        () =>
          Effect.gen(function* () {
            project = yield* observations.observeAvailableProject(project, true)
            const additionalWorktrees = project.worktrees
              .map((worktree) => worktree.id)
              .filter((worktreeId) => !lockedWorktrees.includes(worktreeId))
            if (yield* worktreeMutations.isBusy(projectId)) {
              return yield* Effect.fail(
                new DomainError(
                  'PROJECT_BUSY',
                  'A project tree is already being modified',
                  409
                )
              )
            }

            yield* Effect.uninterruptible(
              locks
                .tryAcquire({ worktreeIds: additionalWorktrees })
                .pipe(
                  Effect.flatMap((acquired) =>
                    acquired
                      ? Effect.sync(() =>
                          lockedWorktrees.push(...additionalWorktrees)
                        )
                      : Effect.fail(
                          new DomainError(
                            'PROJECT_BUSY',
                            'A project tree is already being modified',
                            409
                          )
                        )
                  )
                )
            )
            project = yield* projectStore.getProject(projectId)
            const linked = project.worktrees.filter(
              (worktree) => worktree.kind === 'linked'
            )
            if (linked.length) {
              return yield* Effect.fail(
                new DomainError(
                  'PROJECT_HAS_WORKTREES',
                  'Remove linked trees before unregistering the project',
                  409
                )
              )
            }

            const terminalIdsByWorktree = new Map<string, string[]>()
            for (const worktree of project.worktrees) {
              terminalIdsByWorktree.set(
                worktree.id,
                yield* Effect.promise(() =>
                  terminalHost.killWorktree(worktree.id)
                )
              )
            }
            yield* Effect.promise(() =>
              database.db.run(sql`DELETE FROM projects WHERE id=${projectId}`)
            )
            yield* folderIdentities.remove(projectId)
            yield* Effect.sync(() => packages.forgetProject(projectId))
            for (const worktree of project.worktrees) {
              const terminalIds = yield* terminalState.clearWorktree(
                worktree.id,
                terminalIdsByWorktree.get(worktree.id)
              )
              yield* Effect.sync(() => {
                for (const terminalId of terminalIds) {
                  events.publish('terminal.removed', {
                    worktreeId: worktree.id,
                    terminalId
                  })
                }
              })
            }
            yield* invalidateProjectsSnapshot()
            yield* Effect.sync(() => {
              events.publish('project.removed', { projectId })
            })
          }),
        () =>
          locks.release({
            projectId,
            worktreeIds: lockedWorktrees
          })
      )
    })
  }
}

function canonicalPath(identifier: string): Effect.Effect<string> {
  const resolved = path.resolve(identifier)
  return Effect.promise(() => fs.realpath(resolved)).pipe(
    Effect.orElseSucceed(() => resolved)
  )
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}
