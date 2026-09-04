import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectRecord, WorktreeRecord } from '@treeport/shared'
import { eq } from 'drizzle-orm'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import { projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import { TerminalOperations, WorktreeReconciliation } from '../domain-services'
import {
  type ApplicationServices,
  ProjectObservations,
  WorktreeMutations
} from '../infrastructure/application-runtime'
import { DatabasePort, GitPort } from '../infrastructure/ports'
import { ProjectFolderIdentities } from './project-folder-identities'
import { ProjectStore } from './project-store'

/** Validates registered paths and reconciles their durable worktree inventory. */
export class ProjectObservationService {
  observeAvailableProject(
    project: ProjectRecord,
    allowClosed = false
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    const importWorktrees = this.importWorktrees.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const folderIdentities = yield* ProjectFolderIdentities
      const projectObservations = yield* ProjectObservations
      const projectStore = yield* ProjectStore
      const worktreeMutations = yield* WorktreeMutations
      const observation =
        project.kind === 'repository'
          ? importWorktrees(
              project.id,
              project.repositoryPath,
              project.mainWorktreePath,
              true,
              allowClosed
            )
          : projectObservations.enqueue(
              project.id,
              Effect.gen(function* () {
                if (
                  (!allowClosed &&
                    (yield* projectStore.projectOpenState(project.id)) !==
                      true) ||
                  (yield* worktreeMutations.isBusy(project.id))
                ) {
                  return
                }

                const [metadata] = yield* Effect.promise(() =>
                  database.db
                    .select({
                      device: projects.repositoryDevice,
                      inode: projects.repositoryInode
                    })
                    .from(projects)
                    .where(eq(projects.id, project.id))
                    .limit(1)
                )
                const [canonicalPath, folderStat] = yield* Effect.all(
                  [
                    Effect.promise(() => fs.realpath(project.rootPath)),
                    Effect.promise(() =>
                      fs.stat(project.rootPath, { bigint: true })
                    )
                  ],
                  { concurrency: 'unbounded' }
                )
                if (
                  !metadata ||
                  canonicalPath !== project.rootPath ||
                  !folderStat.isDirectory()
                ) {
                  throw new Error(
                    'The registered folder path is not an available directory'
                  )
                }

                const device = folderStat.dev.toString()
                const inode = folderStat.ino.toString()
                const observedIdentity = yield* folderIdentities.get(project.id)
                if (
                  observedIdentity &&
                  (observedIdentity.device !== device ||
                    observedIdentity.inode !== inode)
                ) {
                  throw new Error(
                    'The registered folder path changed during this daemon session'
                  )
                }

                const folderWorktrees = project.worktrees.filter(
                  (worktree) =>
                    worktree.kind === 'folder' &&
                    worktree.path === project.rootPath
                )
                if (
                  folderWorktrees.length !== 1 ||
                  project.worktrees.length !== 1
                ) {
                  throw new Error(
                    'The registered folder does not have one folder workspace'
                  )
                }

                if (metadata.device !== device || metadata.inode !== inode) {
                  yield* Effect.promise(() =>
                    database.db
                      .update(projects)
                      .set({
                        repositoryDevice: device,
                        repositoryInode: inode
                      })
                      .where(eq(projects.id, project.id))
                  )
                }

                yield* folderIdentities.set(project.id, { device, inode })
              })
            )

      yield* Effect.catchAllCause(observation, (cause) => {
        if (Cause.isInterruptedOnly(cause)) {
          return Effect.failCause(cause)
        }

        const error = Cause.squash(cause)
        return Effect.fail(
          new DomainError(
            'PROJECT_UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
            503
          )
        )
      })
      return yield* projectStore.getProject(project.id)
    })
  }

  verifyWorktreeLaunchTarget(
    binding: WorktreeRecord
  ): Effect.Effect<WorktreeRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const git = yield* GitPort
      const [metadata] = yield* Effect.promise(() =>
        database.db
          .select({
            projectKind: projects.kind,
            repositoryPath: projects.repositoryPath,
            isOpen: projects.isOpen,
            device: projects.repositoryDevice,
            inode: projects.repositoryInode,
            gitWorktreeKey: worktrees.gitWorktreeKey
          })
          .from(worktrees)
          .innerJoin(projects, eq(worktrees.projectId, projects.id))
          .where(eq(worktrees.id, binding.id))
          .limit(1)
      )
      if (!metadata) {
        return yield* Effect.fail(
          new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
        )
      }

      if (!metadata.isOpen) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_CLOSED',
            'Project is closed; open it before modifying it',
            409
          )
        )
      }

      return yield* Effect.tryPromise({
        try: async () => {
          const [
            canonicalWorktree,
            worktreeStat,
            canonicalRepository,
            repositoryStat
          ] = await Promise.all([
            fs.realpath(binding.path),
            fs.stat(binding.path, { bigint: true }),
            fs.realpath(metadata.repositoryPath),
            fs.stat(metadata.repositoryPath, { bigint: true })
          ])
          if (
            canonicalWorktree !== binding.path ||
            !worktreeStat.isDirectory() ||
            canonicalRepository !== metadata.repositoryPath ||
            !repositoryStat.isDirectory() ||
            repositoryStat.dev.toString() !== metadata.device ||
            repositoryStat.ino.toString() !== metadata.inode
          ) {
            throw new Error('The registered tree path changed')
          }

          if (metadata.projectKind === 'folder') {
            if (
              binding.kind !== 'folder' ||
              binding.path !== metadata.repositoryPath ||
              metadata.gitWorktreeKey !== null
            ) {
              throw new Error('The registered folder tree identity changed')
            }

            return binding
          }

          if (!metadata.gitWorktreeKey) {
            throw new Error('The Git worktree key is missing')
          }

          const identity = await git.worktreeLaunchIdentity(binding.path)
          const expectedCommonPath = path.join(metadata.repositoryPath, '.git')
          const expectedCommonDirectory = await fs
            .realpath(expectedCommonPath)
            .catch(() => path.resolve(expectedCommonPath))
          const relativeGitDirectory = path.relative(
            identity.commonDirectory,
            identity.gitDirectory
          )
          const observedKey =
            relativeGitDirectory === ''
              ? 'main'
              : relativeGitDirectory.split(path.sep).length === 2 &&
                  relativeGitDirectory.startsWith(`worktrees${path.sep}`)
                ? relativeGitDirectory.split(path.sep).join('/')
                : null
          if (identity.topLevel !== binding.path) {
            throw new Error('Git reports a different worktree path')
          }

          if (identity.commonDirectory !== expectedCommonDirectory) {
            throw new Error(
              `Git reports a different repository (${identity.commonDirectory} instead of ${expectedCommonDirectory})`
            )
          }

          if (observedKey !== metadata.gitWorktreeKey) {
            throw new Error('Git reports a different worktree key')
          }

          if ((binding.kind === 'main') !== (observedKey === 'main')) {
            throw new Error('Git reports a different worktree kind')
          }

          return binding
        },
        catch: (error) =>
          new DomainError(
            'WORKTREE_UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
            409
          )
      })
    })
  }

  requireAvailableWorktree(
    worktreeId: string,
    allowPrunable = false
  ): Effect.Effect<WorktreeRecord, DomainError<unknown>, ApplicationServices> {
    const observeAvailableProject = this.observeAvailableProject.bind(this)

    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const binding = yield* projectStore.storedWorktree(worktreeId)
      if (!binding) {
        return yield* Effect.fail(
          new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
        )
      }

      const project = yield* observeAvailableProject(
        yield* projectStore.requireOpenProject(binding.projectId)
      )
      const worktree = project.worktrees.find(
        (candidate) => candidate.id === worktreeId
      )
      if (!worktree) {
        return yield* Effect.fail(
          new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
        )
      }

      if (worktree.prunable && !allowPrunable) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_UNAVAILABLE',
            'Git reports this worktree as prunable',
            409
          )
        )
      }

      return worktree
    })
  }

  importWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock = false,
    allowClosed = false
  ): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(function* () {
      const projectObservations = yield* ProjectObservations
      const reconciler = yield* WorktreeReconciliation
      yield* projectObservations.enqueue(
        projectId,
        reconciler.reconcileProjectWorktrees(
          projectId,
          repositoryPath,
          mainPath,
          allowProjectLock,
          allowClosed
        )
      )
    })
  }

  reconcile(): Effect.Effect<void, never, ApplicationServices> {
    const observeAvailableProject = this.observeAvailableProject.bind(this)

    return Effect.gen(function* () {
      const projectStore = yield* ProjectStore
      const terminals = yield* TerminalOperations
      const availableProjects = new Set<string>()
      for (const project of yield* projectStore.storedProjects(true)) {
        const observation = yield* Effect.either(
          observeAvailableProject(project)
        )
        if (observation._tag === 'Right') {
          availableProjects.add(project.id)
        }
      }

      for (const project of yield* projectStore.storedProjects(true)) {
        if (!availableProjects.has(project.id)) {
          continue
        }

        yield* terminals
          .ensureProjectTerminals(project.id)
          .pipe(Effect.catchAll(() => Effect.void))
      }
    })
  }
}
