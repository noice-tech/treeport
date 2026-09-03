import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import type { ProjectRecord } from '@treeport/shared'
import type { TreeportDatabase } from '../../database'
import { serializeOperation } from '../../database'
import { projects } from '../../database-schema'
import type { ProductEventBus } from '../../events'
import type { GitAdapter } from '../../git'
import type { TerminalSessionBackend } from '../../terminal'
import type {
  PromiseMutationLocks,
  PromiseMutationQueue
} from '../infrastructure/application-runtime'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

export interface WorktreeReconcilerDependencies {
  readonly database: TreeportDatabase
  readonly git: GitAdapter
  readonly terminalHost: TerminalSessionBackend
  readonly events: ProductEventBus
  readonly locks: PromiseMutationLocks
  readonly worktreeMutations: PromiseMutationQueue
  readonly trackedTerminalIds: (worktreeId: string) => Set<string>
  readonly rememberTerminalIds: (
    worktreeId: string,
    terminalIds: Iterable<string>
  ) => void
  readonly projectOpenState: (projectId: string) => Promise<boolean | null>
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly clearWorktreeTerminalState: (
    worktreeId: string,
    discoveredTerminalIds?: Iterable<string>
  ) => void
  readonly invalidateProjectsSnapshot: () => void
}

export class WorktreeReconciler {
  constructor(private readonly host: WorktreeReconcilerDependencies) {}

  private get deps() {
    return this.host
  }

  private get events() {
    return this.host.events
  }

  private get locks() {
    return this.host.locks
  }

  private get worktreeMutations() {
    return this.host.worktreeMutations
  }

  private projectOpenState(projectId: string) {
    return this.host.projectOpenState(projectId)
  }

  private getProject(projectId: string) {
    return this.host.getProject(projectId)
  }

  private clearWorktreeTerminalState(
    worktreeId: string,
    discoveredTerminalIds: Iterable<string> = []
  ) {
    this.host.clearWorktreeTerminalState(worktreeId, discoveredTerminalIds)
  }

  private invalidateProjectsSnapshot() {
    this.host.invalidateProjectsSnapshot()
  }

  async reconcileProjectWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock: boolean,
    allowClosed = false
  ): Promise<void> {
    if (
      (!allowProjectLock &&
        ((await this.locks.isProjectLocked(projectId)) ||
          (await this.worktreeMutations.isBusy(projectId)))) ||
      (!allowClosed && (await this.projectOpenState(projectId)) !== true)
    ) {
      return
    }

    const storedProject = await this.getProject(projectId)
    const [storedIdentity] = await this.deps.database.db
      .select({
        identity: projects.repositoryIdentity,
        device: projects.repositoryDevice,
        inode: projects.repositoryInode,
        nameIsCustom: projects.nameIsCustom
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    if (!storedIdentity) {
      throw new Error('Registered project is missing its repository metadata')
    }

    let repositoryIdentity = storedIdentity.identity
    let canonicalRepository = await fs
      .realpath(repositoryPath)
      .catch(() => null)
    let canonicalStat = canonicalRepository
      ? await fs.stat(canonicalRepository, { bigint: true }).catch(() => null)
      : null
    let markerAtStoredPath = canonicalRepository
      ? await this.deps.git.repositoryIdentity(canonicalRepository)
      : null

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

      const canonical =
        await this.deps.git.canonicalizeRepositoryPath(canonicalRepository)
      const resolvedMain = await this.deps.git.resolveMainCheckout(canonical)
      const enrollmentInventory = await this.deps.git.listWorktrees(canonical)
      const verifiedStat = await fs.stat(canonicalRepository, { bigint: true })
      if (
        canonical !== canonicalRepository ||
        resolvedMain !== canonicalRepository ||
        !enrollmentInventory.some(
          (item) =>
            !item.bare &&
            !item.prunable &&
            item.path === canonicalRepository &&
            item.gitWorktreeKey !== null
        ) ||
        verifiedStat.dev !== canonicalStat.dev ||
        verifiedStat.ino !== canonicalStat.ino
      ) {
        throw new Error(
          'Legacy repository changed while its durable identity was enrolled'
        )
      }

      repositoryIdentity =
        markerAtStoredPath ??
        (await this.deps.git.ensureRepositoryIdentity(canonicalRepository))
      const [identityOwner] = await this.deps.database.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.repositoryIdentity, repositoryIdentity))
        .limit(1)
      if (identityOwner && identityOwner.id !== projectId) {
        throw new Error(
          'The local Treeport repository identity belongs to another registered project'
        )
      }

      markerAtStoredPath =
        await this.deps.git.repositoryIdentity(canonicalRepository)
      const enrolledStat = await fs.stat(canonicalRepository, { bigint: true })
      if (
        markerAtStoredPath !== repositoryIdentity ||
        enrolledStat.dev !== canonicalStat.dev ||
        enrolledStat.ino !== canonicalStat.ino
      ) {
        throw new Error(
          'Repository identity changed while legacy enrollment completed'
        )
      }
    } else if (markerAtStoredPath !== repositoryIdentity) {
      const candidates = new Set<string>()
      const parent = path.dirname(repositoryPath)
      const entries = await fs
        .readdir(parent, { withFileTypes: true })
        .catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue
        }

        const candidate = await fs
          .realpath(path.join(parent, entry.name))
          .catch(() => null)
        if (!candidate || candidates.has(candidate)) {
          continue
        }

        const candidateMarker = await this.deps.git
          .repositoryIdentity(candidate)
          .catch(() => null)
        if (candidateMarker === repositoryIdentity) {
          const candidateTopLevel = await this.deps.git
            .canonicalizeRepositoryPath(candidate)
            .catch(() => null)
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

      canonicalRepository = [...candidates][0]!
      canonicalStat = await fs.stat(canonicalRepository, { bigint: true })
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
    const canonical =
      await this.deps.git.canonicalizeRepositoryPath(repositoryPath)
    if (canonical !== repositoryPath) {
      throw new Error('Repository is not the Git top-level main checkout')
    }

    if (repositoryRenamed) {
      if (
        (await this.deps.git.repositoryIdentity(repositoryPath)) !==
        repositoryIdentity
      ) {
        throw new Error('Repository rename candidate changed during recovery')
      }

      await this.deps.git.repairWorktrees(repositoryPath)
    }

    const discovered = (
      await this.deps.git.listWorktrees(repositoryPath)
    ).filter((item) => !item.bare)
    if (
      (!allowProjectLock &&
        ((await this.locks.isProjectLocked(projectId)) ||
          (await this.worktreeMutations.isBusy(projectId)))) ||
      (!allowClosed && (await this.projectOpenState(projectId)) !== true)
    ) {
      return
    }

    const observedMain = discovered.filter(
      (item) =>
        !item.prunable && item.path === mainPath && item.gitWorktreeKey !== null
    )
    if (observedMain.length !== 1) {
      throw new Error(
        'Git worktree inventory is incomplete: the registered main checkout was not reported'
      )
    }

    const [repositoryStat, verifiedIdentity] = await Promise.all([
      fs.stat(repositoryPath, { bigint: true }),
      this.deps.git.repositoryIdentity(repositoryPath)
    ])
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
    const known = await this.deps.database.db.all<{
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
        (worktree) => worktree.kind === 'linked' && !matchedIds.has(worktree.id)
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
      const terminalIds = this.host.trackedTerminalIds(worktree.id)
      const sessions = await this.deps.terminalHost.listTerminals(worktree.id)
      for (const terminal of sessions) {
        if (terminal.worktreeId === worktree.id) {
          terminalIds.add(terminal.id)
        }
      }
      await this.deps.terminalHost.killWorktree(worktree.id)

      const [acceptedRemoval] = await this.deps.database.db.all<{
        id: string
      }>(sql`
        SELECT id FROM operations
        WHERE worktree_id=${worktree.id} AND kind='remove'
          AND status IN ('pending','running')
        ORDER BY created_at DESC,id DESC LIMIT 1
      `)
      const retiredAt = now()
      await this.deps.database.db.transaction(async (tx) => {
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
      this.host.rememberTerminalIds(worktree.id, terminalIds)
      this.clearWorktreeTerminalState(worktree.id)
      this.invalidateProjectsSnapshot()

      if (!acceptedRemoval && worktree.managed_wrapper_path) {
        await fs.rmdir(worktree.managed_wrapper_path).catch(() => undefined)
      }

      this.events.publish('worktree.removed', {
        projectId,
        worktreeId: worktree.id
      })
    }

    await this.deps.database.db.transaction(async (tx) => {
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
                detached=${item.detached ? 1 : 0},locked=${item.locked ? 1 : 0},
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
            ${item.locked ? 1 : 0},${item.lockReason},${item.prunable ? 1 : 0},
            ${kind},${timestamp},${timestamp}
          )
        `)
      }
    })

    if (projectIdentityChanged || changed.length > 0) {
      this.invalidateProjectsSnapshot()
    }

    if (repositoryRenamed) {
      this.events.publish('project.updated', { projectId })
    }

    for (const { existing } of changed) {
      if (existing) {
        this.events.publish('worktree.updated', { worktreeId: existing.id })
      }
    }
  }
}
