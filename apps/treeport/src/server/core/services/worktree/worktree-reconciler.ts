import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { serializeOperation } from '../../database'
import { projects } from '../../database-schema'
import { ProjectSnapshotOperations } from '../domain-services'
import {
  type ApplicationServices,
  WorktreeMutations
} from '../infrastructure/application-runtime'
import { MutationLocks } from '../infrastructure/mutation-locks'
import {
  DatabasePort,
  EventBusPort,
  GitPort,
  TerminalHostPort
} from '../infrastructure/ports'
import { ProjectStore } from '../project/project-store'
import { TerminalState } from '../terminal/terminal-state'

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

export class WorktreeReconciler {
  reconcileProjectWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock: boolean,
    allowClosed = false
  ): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const git = yield* GitPort
      const locks = yield* MutationLocks
      const projectSnapshots = yield* ProjectSnapshotOperations
      const projectStore = yield* ProjectStore
      const terminalHost = yield* TerminalHostPort
      const terminalState = yield* TerminalState
      const worktreeMutations = yield* WorktreeMutations

      if (
        (!allowProjectLock &&
          ((yield* locks.isProjectLocked(projectId)) ||
            (yield* worktreeMutations.isBusy(projectId)))) ||
        (!allowClosed &&
          (yield* projectStore.projectOpenState(projectId)) !== true)
      ) {
        return
      }

      const storedProject = yield* projectStore.storedProject(projectId)
      if (!storedProject) {
        throw new Error('Registered project is missing')
      }

      const [storedIdentity] = yield* Effect.promise(() =>
        database.db
          .select({
            identity: projects.repositoryIdentity,
            device: projects.repositoryDevice,
            inode: projects.repositoryInode,
            nameIsCustom: projects.nameIsCustom
          })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
      )
      if (!storedIdentity) {
        throw new Error('Registered project is missing its repository metadata')
      }

      let repositoryIdentity = storedIdentity.identity
      let canonicalRepository = yield* optionalPromise(() =>
        fs.realpath(repositoryPath)
      )
      let canonicalStat = null
      let markerAtStoredPath = null
      if (canonicalRepository) {
        const repository = canonicalRepository
        canonicalStat = yield* optionalPromise(() =>
          fs.stat(repository, { bigint: true })
        )
        markerAtStoredPath = yield* Effect.promise(() =>
          git.repositoryIdentity(repository)
        )
      }

      if (repositoryIdentity === null) {
        if (
          !canonicalRepository ||
          canonicalRepository !== storedProject.repositoryPath ||
          !canonicalStat?.isDirectory() ||
          (markerAtStoredPath === null &&
            canonicalStat.ino.toString() !== storedIdentity.inode)
        ) {
          throw new Error(
            'Legacy repository identity could not be enrolled; explicitly re-link the repository'
          )
        }

        const legacyRepository = canonicalRepository
        const legacyStat = canonicalStat
        const canonical = yield* Effect.promise(() =>
          git.canonicalizeRepositoryPath(legacyRepository)
        )
        const resolvedMain = yield* Effect.promise(() =>
          git.resolveMainCheckout(canonical)
        )
        const enrollmentInventory = yield* Effect.promise(() =>
          git.listWorktrees(canonical)
        )
        const verifiedStat = yield* Effect.promise(() =>
          fs.stat(legacyRepository, { bigint: true })
        )
        if (
          canonical !== legacyRepository ||
          resolvedMain !== legacyRepository ||
          !enrollmentInventory.some(
            (item) =>
              !item.bare &&
              !item.prunable &&
              item.path === legacyRepository &&
              item.gitWorktreeKey !== null
          ) ||
          verifiedStat.dev !== legacyStat.dev ||
          verifiedStat.ino !== legacyStat.ino
        ) {
          throw new Error(
            'Legacy repository changed while its durable identity was enrolled'
          )
        }

        repositoryIdentity =
          markerAtStoredPath ??
          (yield* Effect.promise(() =>
            git.ensureRepositoryIdentity(legacyRepository)
          ))
        const enrolledIdentity = repositoryIdentity
        const [identityOwner] = yield* Effect.promise(() =>
          database.db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.repositoryIdentity, enrolledIdentity))
            .limit(1)
        )
        if (identityOwner && identityOwner.id !== projectId) {
          throw new Error(
            'The local Treeport repository identity belongs to another registered project'
          )
        }

        markerAtStoredPath = yield* Effect.promise(() =>
          git.repositoryIdentity(legacyRepository)
        )
        const enrolledStat = yield* Effect.promise(() =>
          fs.stat(legacyRepository, { bigint: true })
        )
        if (
          markerAtStoredPath !== repositoryIdentity ||
          enrolledStat.dev !== legacyStat.dev ||
          enrolledStat.ino !== legacyStat.ino
        ) {
          throw new Error(
            'Repository identity changed while legacy enrollment completed'
          )
        }
      } else if (markerAtStoredPath !== repositoryIdentity) {
        const candidates = new Set<string>()
        const parent = path.dirname(repositoryPath)
        const entries =
          (yield* optionalPromise(() =>
            fs.readdir(parent, { withFileTypes: true })
          )) ?? []
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) {
            continue
          }

          const candidate = yield* optionalPromise(() =>
            fs.realpath(path.join(parent, entry.name))
          )
          if (!candidate || candidates.has(candidate)) {
            continue
          }

          const candidateMarker = yield* optionalPromise(() =>
            git.repositoryIdentity(candidate)
          )
          if (candidateMarker === repositoryIdentity) {
            const candidateTopLevel = yield* optionalPromise(() =>
              git.canonicalizeRepositoryPath(candidate)
            )
            if (candidateTopLevel === candidate) {
              candidates.add(candidate)
            }
          }
        }

        if (candidates.size !== 1) {
          throw new Error(
            candidates.size > 1
              ? 'Moved-repository recovery is ambiguous because the local identity exists at multiple paths'
              : markerAtStoredPath === null
                ? 'The registered repository marker is missing and no moved repository could be identified'
                : 'The registered path now contains a different repository'
          )
        }

        const [candidate] = candidates
        if (!candidate) {
          throw new Error('Moved-repository recovery candidate is missing')
        }

        canonicalRepository = candidate
        canonicalStat = yield* Effect.promise(() =>
          fs.stat(candidate, { bigint: true })
        )
      }

      if (
        !repositoryIdentity ||
        !canonicalRepository ||
        !canonicalStat?.isDirectory()
      ) {
        throw new Error('Registered main checkout is unavailable')
      }

      repositoryPath = canonicalRepository
      mainPath = canonicalRepository
      const repositoryRenamed = repositoryPath !== storedProject.repositoryPath
      const canonical = yield* Effect.promise(() =>
        git.canonicalizeRepositoryPath(repositoryPath)
      )
      if (canonical !== repositoryPath) {
        throw new Error('Repository is not the Git top-level main checkout')
      }

      if (repositoryRenamed) {
        if (
          (yield* Effect.promise(() =>
            git.repositoryIdentity(repositoryPath)
          )) !== repositoryIdentity
        ) {
          throw new Error('Repository rename candidate changed during recovery')
        }

        yield* Effect.promise(() => git.repairWorktrees(repositoryPath))
      }

      const discovered = (yield* Effect.promise(() =>
        git.listWorktrees(repositoryPath)
      )).filter((item) => !item.bare)
      if (
        (!allowProjectLock &&
          ((yield* locks.isProjectLocked(projectId)) ||
            (yield* worktreeMutations.isBusy(projectId)))) ||
        (!allowClosed &&
          (yield* projectStore.projectOpenState(projectId)) !== true)
      ) {
        return
      }

      const observedMain = discovered.filter(
        (item) =>
          !item.prunable &&
          item.path === mainPath &&
          item.gitWorktreeKey !== null
      )
      if (observedMain.length !== 1) {
        throw new Error(
          'Git worktree inventory is incomplete: the registered main checkout was not reported'
        )
      }

      const [repositoryStat, verifiedIdentity] = yield* Effect.all(
        [
          Effect.promise(() => fs.stat(repositoryPath, { bigint: true })),
          Effect.promise(() => git.repositoryIdentity(repositoryPath))
        ],
        { concurrency: 'unbounded' }
      )
      const repositoryDevice = repositoryStat.dev.toString()
      const repositoryInode = repositoryStat.ino.toString()
      if (
        canonicalStat.dev !== repositoryStat.dev ||
        canonicalStat.ino !== repositoryStat.ino ||
        verifiedIdentity !== repositoryIdentity
      ) {
        throw new Error('Registered main checkout changed during observation')
      }

      const projectIdentityChanged =
        storedIdentity.identity === null ||
        repositoryRenamed ||
        storedIdentity.device !== repositoryDevice ||
        storedIdentity.inode !== repositoryInode
      const timestamp = now()
      const known = yield* Effect.promise(() =>
        database.db.all<{
          id: string
          path: string
          git_worktree_key: string | null
          kind: 'main' | 'linked'
          managed_wrapper_path: string | null
          created_at: string
          head: string
          branch: string | null
          detached: number
          locked: number
          lock_reason: string | null
          prunable: number
        }>(sql`
          SELECT id,path,git_worktree_key,kind,
                 managed_wrapper_path,created_at,head,branch,detached,locked,lock_reason,prunable
          FROM worktrees WHERE project_id=${projectId}
        `)
      )
      const keyed = new Map(
        known.flatMap((worktree) =>
          worktree.git_worktree_key
            ? [[worktree.git_worktree_key, worktree] as const]
            : []
        )
      )
      const matched = discovered.map((item) => ({
        item,
        existing:
          (item.gitWorktreeKey ? keyed.get(item.gitWorktreeKey) : undefined) ??
          (item.gitWorktreeKey === 'main'
            ? known.find((worktree) => worktree.kind === 'main')
            : undefined) ??
          known.find(
            (worktree) =>
              worktree.path === item.path &&
              (!worktree.git_worktree_key || !item.gitWorktreeKey)
          )
      }))
      const matchedIds = new Set(
        matched.flatMap(({ existing }) => (existing ? [existing.id] : []))
      )
      const retired = known
        .filter(
          (worktree) =>
            worktree.kind === 'linked' && !matchedIds.has(worktree.id)
        )
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
      const changed = matched.filter(({ item, existing }) => {
        if (!existing) {
          return true
        }

        const kind = item.path === mainPath ? 'main' : 'linked'
        return (
          existing.path !== item.path ||
          existing.git_worktree_key !==
            (item.gitWorktreeKey ?? existing.git_worktree_key) ||
          existing.head !== (item.head ?? '') ||
          existing.branch !== item.branch ||
          Boolean(existing.detached) !== item.detached ||
          Boolean(existing.locked) !== item.locked ||
          existing.lock_reason !== item.lockReason ||
          Boolean(existing.prunable) !== item.prunable ||
          existing.kind !== kind
        )
      })
      const changedExistingIds = new Set(
        changed.flatMap(({ existing }) => (existing ? [existing.id] : []))
      )
      for (const worktree of retired) {
        const terminalIds = yield* terminalState.trackedTerminalIds(worktree.id)
        const sessions = yield* Effect.promise(() =>
          terminalHost.listTerminals(worktree.id)
        )
        for (const terminal of sessions) {
          if (terminal.worktreeId === worktree.id) {
            terminalIds.add(terminal.id)
          }
        }
        yield* Effect.promise(() => terminalHost.killWorktree(worktree.id))

        const [acceptedRemoval] = yield* Effect.promise(() =>
          database.db.all<{ id: string }>(sql`
            SELECT id FROM operations
            WHERE worktree_id=${worktree.id} AND kind='remove'
              AND status IN ('pending','running')
            ORDER BY created_at DESC,id DESC LIMIT 1
          `)
        )
        const retiredAt = now()
        yield* Effect.promise(() =>
          database.db.transaction(async (tx) => {
            if (!acceptedRemoval) {
              await tx.run(sql`
                INSERT INTO operations(
                  id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at
                ) VALUES(
                  ${id('op')},'external_remove',${projectId},${
                    worktree.id
                  },'completed',
                  ${serializeOperation({ source: 'git' })},
                  ${serializeOperation({
                    removed: true,
                    external: true,
                    worktreeId: worktree.id,
                    path: worktree.path,
                    head: worktree.head,
                    branch: worktree.branch,
                    cleanup: {
                      status: 'skipped',
                      skippedReason: 'Git removed the tree outside Treeport'
                    }
                  })},NULL,${retiredAt},${retiredAt}
                )
              `)
            }

            await tx.run(sql`DELETE FROM worktrees WHERE id=${worktree.id}`)
          })
        )
        const removedTerminalIds = yield* terminalState.clearWorktree(
          worktree.id,
          terminalIds
        )
        yield* Effect.sync(() => {
          for (const terminalId of removedTerminalIds) {
            events.publish('terminal.removed', {
              worktreeId: worktree.id,
              terminalId
            })
          }
          projectSnapshots.invalidate()
        })

        const managedWrapperPath = worktree.managed_wrapper_path
        if (!acceptedRemoval && managedWrapperPath) {
          yield* Effect.ignore(
            Effect.tryPromise({
              try: () => fs.rmdir(managedWrapperPath),
              catch: (cause) => cause
            })
          )
        }

        yield* Effect.sync(() =>
          events.publish('worktree.removed', {
            projectId,
            worktreeId: worktree.id
          })
        )
      }

      yield* Effect.promise(() =>
        database.db.transaction(async (tx) => {
          if (projectIdentityChanged) {
            const projectName =
              repositoryRenamed &&
              !storedIdentity.nameIsCustom &&
              storedProject.name === path.basename(storedProject.repositoryPath)
                ? path.basename(repositoryPath)
                : storedProject.name
            await tx.run(sql`
              UPDATE projects
              SET name=${projectName},repository_path=${repositoryPath},
                  main_worktree_path=${mainPath},
                  repository_identity=${repositoryIdentity},
                  repository_device=${repositoryDevice},
                  repository_inode=${repositoryInode},updated_at=${timestamp}
              WHERE id=${projectId}
            `)
          }

          for (const { item, existing } of matched) {
            const kind = item.path === mainPath ? 'main' : 'linked'
            if (existing) {
              if (!changedExistingIds.has(existing.id)) {
                continue
              }

              await tx.run(sql`
                UPDATE worktrees
                SET path=${item.path},
                    git_worktree_key=${
                      item.gitWorktreeKey ?? existing.git_worktree_key
                    },
                    head=${item.head ?? ''},branch=${item.branch},
                    detached=${item.detached ? 1 : 0},locked=${
                      item.locked ? 1 : 0
                    },
                    lock_reason=${item.lockReason},prunable=${
                      item.prunable ? 1 : 0
                    },
                    kind=${kind},
                    updated_at=${timestamp}
                WHERE id=${existing.id}
              `)
              continue
            }

            await tx.run(sql`
              INSERT INTO worktrees(
                id,project_id,path,git_worktree_key,head,branch,detached,locked,lock_reason,
                prunable,kind,created_at,updated_at
              ) VALUES(
                ${id('wt')},${projectId},${item.path},${item.gitWorktreeKey},
                ${item.head ?? ''},${item.branch},${item.detached ? 1 : 0},
                ${item.locked ? 1 : 0},${item.lockReason},${
                  item.prunable ? 1 : 0
                },
                ${kind},${timestamp},${timestamp}
              )
            `)
          }
        })
      )

      if (projectIdentityChanged || changed.length > 0) {
        yield* Effect.sync(() => projectSnapshots.invalidate())
      }

      if (repositoryRenamed) {
        yield* Effect.sync(() =>
          events.publish('project.updated', { projectId })
        )
      }

      for (const { existing } of changed) {
        if (existing) {
          yield* Effect.sync(() =>
            events.publish('worktree.updated', { worktreeId: existing.id })
          )
        }
      }
    })
  }
}
