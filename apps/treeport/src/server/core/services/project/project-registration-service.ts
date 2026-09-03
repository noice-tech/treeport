import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectRecord } from '@treeport/shared'
import { eq, or, sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { projects, worktrees } from '../../database-schema'
import { DomainError } from '../../domain'
import {
  ProjectSnapshotOperations,
  TerminalOperations,
  WorktreeReconciliation
} from '../domain-services'
import {
  type ApplicationServices,
  ProjectObservations,
  WorktreeMutations
} from '../infrastructure/application-runtime'
import { MutationLocks } from '../infrastructure/mutation-locks'
import {
  DatabasePort,
  EventBusPort,
  GitPort,
  PackageSystemPort
} from '../infrastructure/ports'
import { ProjectFolderIdentities } from './project-folder-identities'
import { ProjectStore } from './project-store'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

function optionalPromise<Result>(
  evaluate: () => Promise<Result>
): Effect.Effect<Result | null> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => cause
  }).pipe(Effect.orElseSucceed(() => null))
}

export class ProjectRegistrationService {
  registerProject(
    inputPath: string,
    requestedName?: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    const registerFolderProject = this.registerFolderProject.bind(this)
    const registerRepositoryProject = this.registerRepositoryProject.bind(this)

    return Effect.gen(function* () {
      const git = yield* GitPort
      const canonicalPath = yield* Effect.tryPromise({
        try: () => fs.realpath(path.resolve(inputPath)),
        catch: (error) =>
          new DomainError(
            'FOLDER_UNREADABLE',
            error instanceof Error ? error.message : 'Folder cannot be read',
            400
          )
      })
      const folderStat = yield* Effect.promise(() =>
        fs.stat(canonicalPath, { bigint: true })
      )
      if (!folderStat.isDirectory()) {
        return yield* Effect.fail(
          new DomainError(
            'FOLDER_NOT_DIRECTORY',
            `Path is not a folder: ${canonicalPath}`,
            400
          )
        )
      }

      const repositoryRoot = yield* Effect.promise(() =>
        git.findProjectRepositoryRoot(canonicalPath)
      )
      return yield* repositoryRoot
        ? registerRepositoryProject(repositoryRoot, requestedName)
        : registerFolderProject(canonicalPath, requestedName)
    })
  }

  private registerRepositoryProject(
    inputPath: string,
    requestedName?: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const git = yield* GitPort
      const locks = yield* MutationLocks
      const packages = yield* PackageSystemPort
      const projectObservations = yield* ProjectObservations
      const projectSnapshots = yield* ProjectSnapshotOperations
      const projectStore = yield* ProjectStore
      const terminals = yield* TerminalOperations
      const reconciler = yield* WorktreeReconciliation
      const worktreeMutations = yield* WorktreeMutations
      const ensureProjectTerminals =
        terminals.ensureProjectTerminals.bind(terminals)
      const getProjectSnapshot =
        projectSnapshots.getProjectSnapshot.bind(projectSnapshots)
      const invalidateProjectsSnapshot =
        projectSnapshots.invalidate.bind(projectSnapshots)
      const reconcileProjectWorktrees =
        reconciler.reconcileProjectWorktrees.bind(reconciler)

      const checkout = yield* Effect.tryPromise({
        try: () => git.canonicalizeRepositoryPath(inputPath),
        catch: (error) =>
          new DomainError(
            'NOT_A_GIT_REPOSITORY',
            error instanceof Error ? error.message : 'Not a Git repository',
            400
          )
      })
      const mainPath = yield* Effect.promise(() =>
        git.resolveMainCheckout(checkout)
      )
      const repositoryPath = yield* Effect.promise(() => fs.realpath(mainPath))
      const repositoryStat = yield* Effect.promise(() =>
        fs.stat(repositoryPath, { bigint: true })
      )
      const repositoryDevice = repositoryStat.dev.toString()
      const repositoryInode = repositoryStat.ino.toString()
      const repositoryIdentity = yield* Effect.promise(() =>
        git.ensureRepositoryIdentity(repositoryPath)
      )
      const [pathMatches, identityMatches] = yield* Effect.all(
        [
          Effect.promise(() =>
            database.db
              .select({ id: projects.id })
              .from(projects)
              .where(
                or(
                  eq(projects.repositoryPath, repositoryPath),
                  eq(projects.mainWorktreePath, repositoryPath)
                )
              )
              .limit(1)
          ),
          Effect.promise(() =>
            database.db
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.repositoryIdentity, repositoryIdentity))
              .limit(1)
          )
        ],
        { concurrency: 'unbounded' }
      )
      const [pathMatch, identityMatch] = yield* Effect.all(
        [
          pathMatches[0]
            ? projectStore.storedProject(pathMatches[0].id)
            : Effect.succeed(null),
          identityMatches[0]
            ? projectStore.storedProject(identityMatches[0].id)
            : Effect.succeed(null)
        ],
        { concurrency: 'unbounded' }
      )
      const pathMetadataRows = pathMatch
        ? yield* Effect.promise(() =>
            database.db
              .select({
                identity: projects.repositoryIdentity,
                device: projects.repositoryDevice,
                inode: projects.repositoryInode,
                nameIsCustom: projects.nameIsCustom
              })
              .from(projects)
              .where(eq(projects.id, pathMatch.id))
              .limit(1)
          )
        : []
      const pathMetadataRow = pathMetadataRows[0]
      const pathMetadata = pathMetadataRow
        ? {
            ...pathMetadataRow,
            nameIsCustom: Boolean(pathMetadataRow.nameIsCustom)
          }
        : null
      if (pathMatch && !pathMetadata) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_PATH_CONFLICT',
            'The registered project is missing its repository identity metadata',
            409
          )
        )
      }

      if (
        pathMatch &&
        ((pathMetadata?.identity !== null &&
          pathMetadata?.identity !== repositoryIdentity) ||
          (pathMetadata?.identity === null &&
            pathMetadata.inode !== repositoryInode))
      ) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_PATH_CONFLICT',
            'The registered path now contains a different repository',
            409
          )
        )
      }

      if (pathMatch && identityMatch && pathMatch.id !== identityMatch.id) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_PATH_CONFLICT',
            'The repository identity and registered path belong to different projects',
            409
          )
        )
      }

      if (
        identityMatch &&
        identityMatch.repositoryPath !== repositoryPath &&
        (yield* optionalPromise(() =>
          fs.realpath(identityMatch.repositoryPath)
        )) &&
        (yield* optionalPromise(() =>
          git.repositoryIdentity(identityMatch.repositoryPath)
        )) === repositoryIdentity
      ) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_PATH_CONFLICT',
            'The same local repository identity exists at multiple paths; Treeport cannot choose between a move and a copy',
            409
          )
        )
      }

      const existing = identityMatch ?? pathMatch
      const projectId = existing?.id ?? id('proj')
      const updateRegistration: Effect.Effect<
        void,
        DomainError<unknown>,
        ApplicationServices
      > = Effect.gen(function* () {
        if (existing && existing.repositoryPath !== repositoryPath) {
          yield* Effect.promise(() => git.repairWorktrees(repositoryPath))
          const discovered = yield* Effect.promise(() =>
            git.listWorktrees(repositoryPath)
          )
          if (
            !discovered.some(
              (worktree) =>
                !worktree.bare &&
                !worktree.prunable &&
                worktree.path === repositoryPath &&
                worktree.gitWorktreeKey === 'main'
            )
          ) {
            return yield* Effect.fail(
              new DomainError(
                'NOT_A_GIT_REPOSITORY',
                'Git worktree inventory did not report the recovered main checkout',
                400
              )
            )
          }
        }

        const timestamp = now()
        const defaultBranch = yield* Effect.promise(() =>
          git.defaultBranch(repositoryPath)
        )
        const requested = requestedName?.trim() || null
        const existingMetadataRows = existing
          ? yield* Effect.promise(() =>
              database.db
                .select({
                  identity: projects.repositoryIdentity,
                  device: projects.repositoryDevice,
                  inode: projects.repositoryInode,
                  nameIsCustom: projects.nameIsCustom
                })
                .from(projects)
                .where(eq(projects.id, existing.id))
                .limit(1)
            )
          : []
        const existingMetadataRow = existingMetadataRows[0]
        const existingMetadata = existingMetadataRow
          ? {
              ...existingMetadataRow,
              nameIsCustom: Boolean(existingMetadataRow.nameIsCustom)
            }
          : null
        if (existing && !existingMetadata) {
          return yield* Effect.fail(
            new DomainError(
              'PROJECT_PATH_CONFLICT',
              'The registered project is missing its filesystem identity',
              409
            )
          )
        }

        const nameIsCustom = requested
          ? true
          : (existingMetadata?.nameIsCustom ?? false)
        const automaticExistingName = Boolean(
          existing &&
          !nameIsCustom &&
          existing.name === path.basename(existing.repositoryPath)
        )
        const name =
          requested ||
          (automaticExistingName
            ? path.basename(repositoryPath)
            : existing?.name) ||
          path.basename(repositoryPath)
        const [verifiedIdentity, verifiedStat] = yield* Effect.all(
          [
            Effect.promise(() => git.repositoryIdentity(repositoryPath)),
            Effect.promise(() => fs.stat(repositoryPath, { bigint: true }))
          ],
          { concurrency: 'unbounded' }
        )
        if (
          verifiedIdentity !== repositoryIdentity ||
          verifiedStat.dev.toString() !== repositoryDevice ||
          verifiedStat.ino.toString() !== repositoryInode
        ) {
          return yield* Effect.fail(
            new DomainError(
              'PROJECT_PATH_CONFLICT',
              'The repository changed during registration',
              409
            )
          )
        }

        yield* Effect.promise(() =>
          database.db.run(sql`
            INSERT INTO projects(
              id,name,project_kind,repository_path,main_worktree_path,default_branch,
              repository_identity,repository_device,repository_inode,name_is_custom,
              is_open,show_in_recents,last_opened_at,created_at,updated_at
            ) VALUES(
              ${projectId},${name},'repository',${repositoryPath},${mainPath},${defaultBranch},
              ${repositoryIdentity},${repositoryDevice},${repositoryInode},
              ${nameIsCustom ? 1 : 0},1,0,${timestamp},
              ${existing?.createdAt ?? timestamp},${timestamp}
            )
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,
              project_kind=excluded.project_kind,
              repository_path=excluded.repository_path,
              main_worktree_path=excluded.main_worktree_path,
              default_branch=excluded.default_branch,
              repository_identity=excluded.repository_identity,
              repository_device=excluded.repository_device,
              repository_inode=excluded.repository_inode,
              name_is_custom=excluded.name_is_custom,
              updated_at=excluded.updated_at
          `)
        )
        yield* reconcileProjectWorktrees(
          projectId,
          repositoryPath,
          mainPath,
          Boolean(existing),
          true
        )
      })

      if (existing) {
        yield* projectObservations.enqueue(
          projectId,
          Effect.gen(function* () {
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
                  yield* updateRegistration
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
                  yield* ensureProjectTerminals(projectId).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                  yield* Effect.sync(() => {
                    invalidateProjectsSnapshot()
                    events.publish('project.updated', { projectId })
                  })
                }),
              () => locks.release({ projectId })
            )
          })
        )
        return yield* getProjectSnapshot(projectId)
      }

      yield* updateRegistration
      const project = yield* projectStore.getProject(projectId)
      yield* packages.registerProject(project)
      yield* ensureProjectTerminals(projectId).pipe(
        Effect.catchAll(() => Effect.void)
      )
      yield* Effect.sync(() => {
        invalidateProjectsSnapshot()
        events.publish('project.created', { projectId })
      })
      return yield* getProjectSnapshot(projectId)
    })
  }

  private registerFolderProject(
    folderPath: string,
    requestedName?: string
  ): Effect.Effect<ProjectRecord, DomainError<unknown>, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const locks = yield* MutationLocks
      const packages = yield* PackageSystemPort
      const folderIdentities = yield* ProjectFolderIdentities
      const projectObservations = yield* ProjectObservations
      const projectSnapshots = yield* ProjectSnapshotOperations
      const projectStore = yield* ProjectStore
      const terminals = yield* TerminalOperations
      const worktreeMutations = yield* WorktreeMutations
      const ensureProjectTerminals =
        terminals.ensureProjectTerminals.bind(terminals)
      const getProjectSnapshot =
        projectSnapshots.getProjectSnapshot.bind(projectSnapshots)
      const invalidateProjectsSnapshot =
        projectSnapshots.invalidate.bind(projectSnapshots)
      const folderStat = yield* Effect.promise(() =>
        fs.stat(folderPath, { bigint: true })
      )
      const device = folderStat.dev.toString()
      const inode = folderStat.ino.toString()
      const pathMatches = yield* Effect.promise(() =>
        database.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.repositoryPath, folderPath))
          .limit(1)
      )
      const folderIdentitySnapshot = yield* folderIdentities.snapshot
      const identityMatchId = [...folderIdentitySnapshot].find(
        ([, identity]) => identity.device === device && identity.inode === inode
      )?.[0]
      const [pathMatch, identityMatch] = yield* Effect.all(
        [
          pathMatches[0]
            ? projectStore.storedProject(pathMatches[0].id)
            : Effect.succeed(null),
          identityMatchId
            ? projectStore.storedProject(identityMatchId)
            : Effect.succeed(null)
        ],
        { concurrency: 'unbounded' }
      )
      if (pathMatch?.kind === 'repository') {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_PATH_CONFLICT',
            'The selected folder is registered as a Git repository, but Git no longer recognizes it',
            409
          )
        )
      }

      const observedPathIdentity = pathMatch
        ? yield* folderIdentities.get(pathMatch.id)
        : null
      if (
        observedPathIdentity &&
        (observedPathIdentity.device !== device ||
          observedPathIdentity.inode !== inode)
      ) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_PATH_CONFLICT',
            'The registered folder path now refers to a different folder',
            409
          )
        )
      }

      if (pathMatch && identityMatch && pathMatch.id !== identityMatch.id) {
        return yield* Effect.fail(
          new DomainError(
            'PROJECT_PATH_CONFLICT',
            'The folder identity and registered path belong to different projects',
            409
          )
        )
      }

      const existing = identityMatch ?? pathMatch
      const projectId = existing?.id ?? id('proj')
      const updateRegistration: Effect.Effect<
        void,
        DomainError<unknown>,
        ApplicationServices
      > = Effect.gen(function* () {
        const timestamp = now()
        const metadataRows = existing
          ? yield* Effect.promise(() =>
              database.db
                .select({ nameIsCustom: projects.nameIsCustom })
                .from(projects)
                .where(eq(projects.id, existing.id))
                .limit(1)
            )
          : []
        const requested = requestedName?.trim() || null
        const nameIsCustom = requested
          ? true
          : Boolean(metadataRows[0]?.nameIsCustom)
        const name =
          requested ||
          (existing &&
          !nameIsCustom &&
          existing.name === path.basename(existing.rootPath)
            ? path.basename(folderPath)
            : existing?.name) ||
          path.basename(folderPath)
        const [verifiedPath, verifiedStat] = yield* Effect.all(
          [
            Effect.promise(() => fs.realpath(folderPath)),
            Effect.promise(() => fs.stat(folderPath, { bigint: true }))
          ],
          { concurrency: 'unbounded' }
        )
        if (
          verifiedPath !== folderPath ||
          !verifiedStat.isDirectory() ||
          verifiedStat.dev.toString() !== device ||
          verifiedStat.ino.toString() !== inode
        ) {
          return yield* Effect.fail(
            new DomainError(
              'PROJECT_PATH_CONFLICT',
              'The folder changed during registration',
              409
            )
          )
        }

        const existingWorktreeRows = existing
          ? yield* Effect.promise(() =>
              database.db
                .select()
                .from(worktrees)
                .where(eq(worktrees.projectId, projectId))
            )
          : []
        if (
          existingWorktreeRows.length > 1 ||
          existingWorktreeRows.some((worktree) => worktree.kind !== 'folder')
        ) {
          return yield* Effect.fail(
            new DomainError(
              'PROJECT_PATH_CONFLICT',
              'The folder registration contains incompatible Git worktrees',
              409
            )
          )
        }

        const existingWorktree = existingWorktreeRows[0]
        const worktreeId = existingWorktree?.id ?? id('wt')
        yield* Effect.promise(() =>
          database.db.transaction(async (tx) => {
            await tx.run(sql`
              INSERT INTO projects(
                id,name,project_kind,repository_path,main_worktree_path,default_branch,
                repository_identity,repository_device,repository_inode,name_is_custom,
                is_open,show_in_recents,last_opened_at,created_at,updated_at
              ) VALUES(
                ${projectId},${name},'folder',${folderPath},${folderPath},'',
                NULL,${device},${inode},${nameIsCustom ? 1 : 0},1,0,${timestamp},
                ${existing?.createdAt ?? timestamp},${timestamp}
              )
              ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                project_kind='folder',
                repository_path=excluded.repository_path,
                main_worktree_path=excluded.main_worktree_path,
                default_branch='',
                repository_identity=NULL,
                repository_device=excluded.repository_device,
                repository_inode=excluded.repository_inode,
                name_is_custom=excluded.name_is_custom,
                is_open=1,
                show_in_recents=0,
                last_opened_at=excluded.last_opened_at,
                updated_at=excluded.updated_at
            `)
            if (existingWorktree) {
              await tx.run(sql`
                UPDATE worktrees
                SET path=${folderPath},git_worktree_key=NULL,head='',branch=NULL,
                    detached=0,locked=0,lock_reason=NULL,prunable=0,kind='folder',
                    managed_wrapper_path=NULL,pr_state='unknown',pr_number=NULL,
                    pr_url=NULL,pr_base_branch=NULL,pr_head_branch=NULL,
                    pr_merged_at=NULL,pr_refreshed_at=NULL,updated_at=${timestamp}
                WHERE id=${worktreeId}
              `)
            } else {
              await tx.run(sql`
                INSERT INTO worktrees(
                  id,project_id,path,git_worktree_key,head,branch,detached,locked,
                  lock_reason,prunable,kind,created_at,updated_at
                ) VALUES(
                  ${worktreeId},${projectId},${folderPath},NULL,'',NULL,0,0,NULL,0,
                  'folder',${timestamp},${timestamp}
                )
              `)
            }
          })
        )
      })

      const register: Effect.Effect<
        void,
        DomainError<unknown>,
        ApplicationServices
      > = Effect.gen(function* () {
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
          () => updateRegistration,
          () => locks.release({ projectId })
        )
      })

      if (existing) {
        yield* projectObservations.enqueue(projectId, register)
      } else {
        yield* register
      }

      yield* folderIdentities.set(projectId, { device, inode })
      const project = yield* projectStore.getProject(projectId)
      yield* packages.registerProject(project)
      yield* ensureProjectTerminals(projectId).pipe(
        Effect.catchAll(() => Effect.void)
      )
      yield* Effect.sync(() => {
        invalidateProjectsSnapshot()
        events.publish(existing ? 'project.updated' : 'project.created', {
          projectId
        })
      })
      return yield* getProjectSnapshot(projectId)
    })
  }
}
