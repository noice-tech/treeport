import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  OperationRecord,
  PrInfo,
  ProjectRecord,
  RemovalCheckoutIdentity,
  RemovePreview,
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import { eq, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { CommandRunner } from '../../command'
import type { TreeportDatabase } from '../../database'
import { serializeOperation } from '../../database'
import { projects } from '../../database-schema'
import { DomainError } from '../../domain'
import type { ProductEventBus } from '../../events'
import type { GhAdapter } from '../../gh'
import type { GitAdapter } from '../../git'
import type { WorktreeSetupTask } from '../../setup'
import type { TerminalSessionBackend } from '../../terminal'
import type {
  PromiseMutationLocks,
  PromiseMutationQueue
} from '../infrastructure/application-runtime'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

interface CheckoutCleanupResult {
  removed: boolean
  error: string | null
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

export interface WorktreeServiceDependencies {
  readonly config: AppConfig
  readonly database: TreeportDatabase
  readonly runner: CommandRunner
  readonly git: GitAdapter
  readonly terminalHost: TerminalSessionBackend
  readonly gh: GhAdapter
  readonly events: ProductEventBus
  readonly locks: PromiseMutationLocks
  readonly worktreeMutations: PromiseMutationQueue
  readonly terminalMutations: PromiseMutationQueue
  readonly requireOpenProject: (projectId: string) => Promise<ProjectRecord>
  readonly observeAvailableProject: (
    project: ProjectRecord,
    allowClosed?: boolean
  ) => Promise<ProjectRecord>
  readonly importWorktrees: (
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock?: boolean,
    allowClosed?: boolean
  ) => Promise<void>
  readonly getProject: (projectId: string) => Promise<ProjectRecord>
  readonly getWorktree: (worktreeId: string) => Promise<WorktreeRecord>
  readonly getOperation: (operationId: string) => Promise<OperationRecord>
  readonly storedProject: (projectId: string) => Promise<ProjectRecord | null>
  readonly storedWorktree: (
    worktreeId: string
  ) => Promise<WorktreeRecord | null>
  readonly storedOperation: (
    operationId: string
  ) => Promise<OperationRecord | null>
  readonly requireAvailableWorktree: (
    worktreeId: string,
    allowPrunable?: boolean
  ) => Promise<WorktreeRecord>
  readonly listWorktreeTerminals: (
    worktree: WorktreeRecord
  ) => Promise<TerminalRecord[]>
  readonly createTerminal: (
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ) => Promise<TerminalRecord>
  readonly ensureWorktreeTerminal: (
    worktreeId: string
  ) => Promise<TerminalRecord | null>
  readonly clearWorktreeTerminalState: (
    worktreeId: string,
    discoveredTerminalIds?: Iterable<string>
  ) => void
  readonly invalidateProjectsSnapshot: () => void
}

export class WorktreeRemovalService {
  private readonly removeConfirmationKey = crypto.randomBytes(32)

  constructor(private readonly host: WorktreeServiceDependencies) {}

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

  private get terminalMutations() {
    return this.host.terminalMutations
  }

  private requireOpenProject(projectId: string) {
    return this.host.requireOpenProject(projectId)
  }

  private observeAvailableProject(project: ProjectRecord, allowClosed = false) {
    return this.host.observeAvailableProject(project, allowClosed)
  }

  private importWorktrees(
    projectId: string,
    repositoryPath: string,
    mainPath: string,
    allowProjectLock = false,
    allowClosed = false
  ) {
    return this.host.importWorktrees(
      projectId,
      repositoryPath,
      mainPath,
      allowProjectLock,
      allowClosed
    )
  }

  private getProject(projectId: string) {
    return this.host.getProject(projectId)
  }

  private getWorktree(worktreeId: string) {
    return this.host.getWorktree(worktreeId)
  }

  private getOperation(operationId: string) {
    return this.host.getOperation(operationId)
  }

  private storedProject(projectId: string) {
    return this.host.storedProject(projectId)
  }

  private storedWorktree(worktreeId: string) {
    return this.host.storedWorktree(worktreeId)
  }

  private storedOperation(operationId: string) {
    return this.host.storedOperation(operationId)
  }

  private requireAvailableWorktree(worktreeId: string, allowPrunable = false) {
    return this.host.requireAvailableWorktree(worktreeId, allowPrunable)
  }

  private listWorktreeTerminals(worktree: WorktreeRecord) {
    return this.host.listWorktreeTerminals(worktree)
  }

  private executeCreateTerminal(
    worktreeId: string,
    name: string,
    argv?: string[],
    options?: TerminalLaunchOptions
  ) {
    return this.host.createTerminal(worktreeId, name, argv, options)
  }

  private ensureWorktreeTerminal(worktreeId: string) {
    return this.host.ensureWorktreeTerminal(worktreeId)
  }

  private clearWorktreeTerminalState(
    worktreeId: string,
    discoveredTerminalIds: Iterable<string> = []
  ) {
    return this.host.clearWorktreeTerminalState(
      worktreeId,
      discoveredTerminalIds
    )
  }

  private invalidateProjectsSnapshot() {
    this.host.invalidateProjectsSnapshot()
  }

  private async checkoutStat(checkoutPath: string) {
    return fs.lstat(checkoutPath, { bigint: true }).catch((error) => {
      // SAFETY: The surrounding boundary contract establishes this asserted value.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }

      throw error
    })
  }

  private async authorizedCheckoutError(
    checkoutPath: string,
    identity: RemovalCheckoutIdentity | null,
    acceptedPath = checkoutPath
  ): Promise<string | null> {
    const checkout = await this.checkoutStat(checkoutPath)
    if (!checkout) {
      return null
    }

    if (!identity || identity.path !== acceptedPath) {
      return 'The residual checkout has no matching filesystem identity'
    }

    if (
      !checkout.isDirectory() ||
      checkout.dev.toString() !== identity.device ||
      checkout.ino.toString() !== identity.inode
    ) {
      return 'The residual checkout path now refers to a different filesystem object'
    }

    const markerPath = path.join(checkoutPath, '.git')
    const markerStat = await this.checkoutStat(markerPath)
    const marker = markerStat?.isFile()
      ? await fs.readFile(markerPath, 'utf8').catch(() => null)
      : null
    if (
      marker !== identity.gitMarker ||
      !gitMarkerMatchesKey(acceptedPath, marker ?? '', identity.gitWorktreeKey)
    ) {
      return 'The residual checkout Git marker no longer proves that Treeport owns this removal'
    }

    return null
  }

  private async removeAuthorizedCheckout(
    checkoutPath: string,
    identity: RemovalCheckoutIdentity | null
  ): Promise<CheckoutCleanupResult> {
    if (
      !identity ||
      identity.path !== checkoutPath ||
      path.dirname(identity.quarantinePath) !== path.dirname(checkoutPath) ||
      identity.quarantinePath === checkoutPath
    ) {
      return {
        removed: false,
        error: 'The persisted residual-checkout quarantine is invalid'
      }
    }

    const quarantinePath = identity.quarantinePath
    if (await this.checkoutStat(quarantinePath)) {
      const quarantineError = await this.authorizedCheckoutError(
        quarantinePath,
        identity,
        checkoutPath
      )
      if (quarantineError) {
        return {
          removed: false,
          error: `${quarantineError}; the unverified directory was preserved at ${quarantinePath}`
        }
      }
    } else {
      const authorizationError = await this.authorizedCheckoutError(
        checkoutPath,
        identity
      )
      if (authorizationError) {
        return { removed: false, error: authorizationError }
      }

      if (!(await this.checkoutStat(checkoutPath))) {
        return { removed: false, error: null }
      }

      const renameError = await fs.rename(checkoutPath, quarantinePath).then(
        () => null,
        (error) => error
      )
      if (renameError) {
        if (
          // SAFETY: The surrounding boundary contract establishes this asserted value.
          (renameError as NodeJS.ErrnoException).code === 'ENOENT' &&
          !(await this.checkoutStat(checkoutPath)) &&
          !(await this.checkoutStat(quarantinePath))
        ) {
          return { removed: false, error: null }
        }

        throw renameError
      }

      const quarantineError = await this.authorizedCheckoutError(
        quarantinePath,
        identity,
        checkoutPath
      )
      if (quarantineError) {
        if (!(await this.checkoutStat(checkoutPath))) {
          const restoreError = await fs
            .rename(quarantinePath, checkoutPath)
            .then(
              () => null,
              (error) => error
            )
          if (!restoreError) {
            return { removed: false, error: quarantineError }
          }
        }

        return {
          removed: false,
          error: `${quarantineError}; the unverified directory was preserved at ${quarantinePath}`
        }
      }
    }

    const removalError = await fs
      .rm(quarantinePath, { recursive: true, force: true })
      .then(
        () => null,
        (error) => error
      )
    if (removalError || (await this.checkoutStat(quarantinePath))) {
      if (!(await this.checkoutStat(checkoutPath))) {
        const restoreError = await fs.rename(quarantinePath, checkoutPath).then(
          () => null,
          (error) => error
        )
        if (!restoreError) {
          return {
            removed: false,
            error: `Automatic residual-checkout cleanup failed: ${
              removalError instanceof Error
                ? removalError.message
                : 'the quarantined checkout root still exists'
            }`
          }
        }
      }

      return {
        removed: false,
        error: `Automatic residual-checkout cleanup failed; the checkout was preserved at ${quarantinePath}`
      }
    }

    if (await this.checkoutStat(checkoutPath)) {
      return {
        removed: false,
        error:
          'The residual checkout path was recreated during automatic cleanup'
      }
    }

    return { removed: true, error: null }
  }

  async refreshPr(worktreeId: string, force = false): Promise<PrInfo> {
    const worktree = await this.requireAvailableWorktree(worktreeId)
    if (worktree.kind === 'main' || !worktree.branch) {
      return worktree.pr
    }

    const age = worktree.pr.refreshedAt
      ? Date.now() - Date.parse(worktree.pr.refreshedAt)
      : Number.POSITIVE_INFINITY
    if (!force && age < 60_000) {
      return worktree.pr
    }

    await this.requireOpenProject(worktree.projectId)
    const pr = await this.deps.gh.pullRequest(worktree.path, worktree.branch)
    const current = await this.storedWorktree(worktreeId)

    if (!current) {
      throw new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
    }

    if (await this.locks.isWorktreeLocked(worktreeId)) {
      throw new DomainError(
        'WORKTREE_UNAVAILABLE',
        'Cannot refresh a pull request while the tree is being removed',
        409
      )
    }

    await this.deps.database.db.run(sql`
      UPDATE worktrees
      SET pr_state=${pr.state},pr_number=${pr.number},pr_url=${pr.url},
          pr_base_branch=${pr.baseBranch},pr_head_branch=${pr.headBranch},
          pr_merged_at=${pr.mergedAt},pr_refreshed_at=${pr.refreshedAt},
          updated_at=${now()}
      WHERE id=${worktreeId}
    `)
    this.invalidateProjectsSnapshot()
    this.events.publish('worktree.updated', { worktreeId })
    return pr
  }

  private async prepareRemovePreview(worktreeId: string): Promise<{
    preview: RemovePreview
    statusFingerprint: string
    prunable: boolean
  }> {
    const worktree = await this.requireAvailableWorktree(worktreeId, true)
    worktree.terminals = await this.listWorktreeTerminals(worktree)
    const project = await this.getProject(worktree.projectId)
    if (project.kind === 'folder') {
      throw new DomainError(
        'FOLDER_WORKSPACE_NOT_REMOVABLE',
        'Remove the folder project instead of its folder workspace',
        409
      )
    }

    const live = (
      await this.deps.git.listWorktrees(project.repositoryPath)
    ).find((item) => item.path === worktree.path)
    if (!live) {
      throw new DomainError(
        'WORKTREE_NOT_FOUND',
        'Git no longer reports this worktree',
        404
      )
    }

    const head = live.head ?? worktree.head
    const status = live.prunable
      ? {
          dirty: {
            dirty: false,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicts: 0,
            total: 0
          },
          fingerprint: `prunable:${live.head ?? ''}:${live.branch ?? ''}`
        }
      : await this.deps.git.dirtyStatus(worktree.path)
    const dirty = status.dirty
    const reachable =
      live.detached && head
        ? await this.deps.git.isCommitReachable(
            live.prunable ? project.repositoryPath : worktree.path,
            head
          )
        : null
    const reasons: string[] = []
    const warnings: string[] = []
    if (worktree.kind === 'main') {
      reasons.push('The main checkout cannot be removed')
    }

    if (live.locked) {
      reasons.push(
        live.lockReason
          ? `The tree is locked: ${live.lockReason}`
          : 'The tree is locked'
      )
    }

    if (dirty.staged) {
      warnings.push(`${dirty.staged} staged change(s) will be lost`)
    }

    if (dirty.unstaged) {
      warnings.push(`${dirty.unstaged} unstaged change(s) will be lost`)
    }

    if (dirty.untracked) {
      warnings.push(`${dirty.untracked} untracked file(s) will be lost`)
    }

    if (dirty.conflicts) {
      warnings.push(`${dirty.conflicts} conflicted file(s) will be lost`)
    }

    if (live.detached && reachable === false) {
      warnings.push('Detached commits may become unreachable after removal')
    }

    if (live.detached && reachable === null) {
      warnings.push('Detached commit reachability could not be verified')
    }

    const previewWithoutToken = {
      worktreeId,
      name: worktree.name,
      path: worktree.path,
      head,
      branch: live.branch,
      detached: live.detached,
      locked: live.locked,
      lockReason: live.lockReason,
      dirty,
      detachedHeadReachable: reachable,
      forceRequired: dirty.dirty,
      eligible: reasons.length === 0,
      reasons,
      warnings,
      terminals: worktree.terminals.map(({ id: terminalId, name, status }) => ({
        id: terminalId,
        name,
        status
      }))
    } satisfies Omit<RemovePreview, 'confirmationToken'>
    return {
      preview: {
        ...previewWithoutToken,
        confirmationToken: removeConfirmationToken(
          this.removeConfirmationKey,
          previewWithoutToken,
          status.fingerprint
        )
      },
      statusFingerprint: status.fingerprint,
      prunable: live.prunable
    }
  }

  async removePreview(worktreeId: string): Promise<RemovePreview> {
    return (await this.prepareRemovePreview(worktreeId)).preview
  }

  async beginRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Promise<OperationRecord> {
    const worktree = await this.getWorktree(worktreeId)
    await this.requireOpenProject(worktree.projectId)
    const [activeRemoval] = await this.deps.database.db.all<{ id: string }>(sql`
      SELECT id FROM operations
      WHERE worktree_id=${worktreeId} AND kind='remove'
        AND status IN ('pending','running')
      LIMIT 1
    `)
    if (activeRemoval) {
      throw new DomainError(
        'REMOVE_IN_PROGRESS',
        'The tree is already being removed',
        409
      )
    }

    if (await this.terminalMutations.isBusy(worktreeId)) {
      return this.terminalMutations.enqueue(worktreeId, async () => {
        if (await this.worktreeMutations.isBusy(worktree.projectId)) {
          return this.worktreeMutations.enqueue(worktree.projectId, () =>
            this.acceptRemove(worktreeId, request)
          )
        }

        return this.acceptRemove(worktreeId, request)
      })
    }

    if (await this.worktreeMutations.isBusy(worktree.projectId)) {
      return this.worktreeMutations.enqueue(worktree.projectId, () =>
        this.acceptRemove(worktreeId, request)
      )
    }

    if (
      (await this.locks.isProjectLocked(worktree.projectId)) ||
      (await this.locks.isWorktreeLocked(worktreeId))
    ) {
      throw new DomainError(
        'REMOVE_IN_PROGRESS',
        'The tree or project is already being modified',
        409
      )
    }

    return this.acceptRemove(worktreeId, request)
  }

  private async acceptRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Promise<OperationRecord> {
    const worktree = await this.getWorktree(worktreeId)
    await this.requireOpenProject(worktree.projectId)
    if (
      !(await this.locks.tryAcquire({
        worktreeIds: [worktreeId],
        checkProjectIds: [worktree.projectId]
      }))
    ) {
      throw new DomainError(
        'REMOVE_IN_PROGRESS',
        'The tree or project is already being modified',
        409
      )
    }

    let operationStarted = false
    try {
      const { preview, prunable } = await this.prepareRemovePreview(worktreeId)
      if (!preview.eligible) {
        throw new DomainError(
          'REMOVE_REFUSED',
          'The tree cannot be removed',
          409,
          preview
        )
      }

      if (request.confirmationToken !== preview.confirmationToken) {
        throw new DomainError(
          'REMOVE_PREVIEW_STALE',
          'The tree changed after the removal preview; review it again',
          409,
          preview
        )
      }

      if (preview.warnings.length > 0 && !request.confirmDestructive) {
        throw new DomainError(
          'REMOVE_CONFIRMATION_REQUIRED',
          'Confirm the destructive removal after reviewing its warnings',
          409,
          preview
        )
      }

      const checkout = await this.checkoutStat(preview.path)
      const [checkoutBinding] = await this.deps.database.db.all<{
        git_worktree_key: string | null
        managed_wrapper_path: string | null
      }>(sql`
        SELECT git_worktree_key,managed_wrapper_path
        FROM worktrees WHERE id=${worktreeId}
      `)
      const [projectMetadata] = await this.deps.database.db
        .select({ identity: projects.repositoryIdentity })
        .from(projects)
        .where(eq(projects.id, worktree.projectId))
        .limit(1)
      const repositoryIdentity = await this.deps.git.repositoryIdentity(
        prunable
          ? (await this.getProject(worktree.projectId)).repositoryPath
          : preview.path
      )
      if (
        !projectMetadata?.identity ||
        repositoryIdentity !== projectMetadata.identity
      ) {
        throw new DomainError(
          'REMOVE_PREVIEW_STALE',
          'The repository identity changed after the removal preview; review it again',
          409,
          preview
        )
      }

      const operationId = id('op')
      let checkoutIdentity: RemovalCheckoutIdentity | null = null
      if (prunable) {
        if (!checkoutBinding?.git_worktree_key) {
          throw new DomainError(
            'REMOVE_PREVIEW_STALE',
            'The prunable tree changed after the removal preview; review it again',
            409,
            preview
          )
        }
      } else {
        const markerPath = path.join(preview.path, '.git')
        const markerStat = await this.checkoutStat(markerPath)
        const gitMarker = markerStat?.isFile()
          ? await fs.readFile(markerPath, 'utf8').catch(() => null)
          : null
        if (
          !checkout?.isDirectory() ||
          !checkoutBinding?.git_worktree_key ||
          gitMarker === null ||
          !gitMarkerMatchesKey(
            preview.path,
            gitMarker,
            checkoutBinding.git_worktree_key
          )
        ) {
          throw new DomainError(
            'REMOVE_PREVIEW_STALE',
            'The tree checkout changed after the removal preview; review it again',
            409,
            preview
          )
        }

        checkoutIdentity = {
          path: preview.path,
          device: checkout.dev.toString(),
          inode: checkout.ino.toString(),
          gitWorktreeKey: checkoutBinding.git_worktree_key,
          gitMarker,
          repositoryIdentity,
          managedWrapperPath: checkoutBinding.managed_wrapper_path,
          quarantinePath: path.join(
            path.dirname(preview.path),
            `.${path.basename(preview.path)}.treeport-removing-${operationId}`
          )
        }
      }

      const timestamp = now()
      await this.deps.database.db.transaction(async (tx) => {
        await tx.run(sql`
          INSERT INTO operations(
            id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at
          ) VALUES(
            ${operationId},'remove',${
              worktree.projectId
            },${worktreeId},'pending',
            ${serializeOperation({
              ...request,
              preview,
              checkoutIdentity,
              prunable,
              gitWorktreeKey: checkoutBinding.git_worktree_key,
              repositoryIdentity,
              phase: 'accepted',
              managedWrapperPath: checkoutBinding.managed_wrapper_path
            })},
            NULL,NULL,${timestamp},${timestamp}
          )
        `)
      })
      this.invalidateProjectsSnapshot()
      operationStarted = true
      void this.worktreeMutations
        .enqueue(worktree.projectId, () =>
          this.executeRemove(operationId, worktreeId, preview.forceRequired)
        )
        .catch(async () => {
          await this.locks.release({ worktreeIds: [worktreeId] })
        })
      this.events.publish('remove.started', {
        operationId,
        worktreeId,
        kind: 'remove'
      })
      return await this.getOperation(operationId)
    } finally {
      if (!operationStarted) {
        await this.locks.release({ worktreeIds: [worktreeId] })
      }
    }
  }

  private async executeRemove(
    operationId: string,
    lockedWorktreeId: string,
    force: boolean
  ): Promise<void> {
    const operation = await this.storedOperation(operationId)
    if (
      operation?.kind !== 'remove' ||
      !operation.projectId ||
      !operation.request.preview
    ) {
      await this.locks.release({ worktreeIds: [lockedWorktreeId] })
      return
    }

    const request = operation.request
    const preview = request.preview!
    const project = await this.storedProject(operation.projectId)
    if (!project) {
      await this.locks.release({ worktreeIds: [lockedWorktreeId] })
      return
    }

    const persistPhase = async (
      phase: NonNullable<typeof request.phase>
    ): Promise<void> => {
      request.phase = phase
      await this.deps.database.db.run(sql`
        UPDATE operations
        SET request_json=${serializeOperation(request)},updated_at=${now()}
        WHERE id=${operationId}
      `)
    }

    await this.deps.database.db.run(sql`
      UPDATE operations SET status='running',error=NULL,updated_at=${now()}
      WHERE id=${operationId}
    `)
    let gitRemoved =
      request.phase === 'git_removed' || request.phase === 'cleanup_pending'
    let retiredNow = false
    try {
      const liveWorktrees = await this.deps.git.listWorktrees(
        project.repositoryPath
      )
      const acceptedKey = request.gitWorktreeKey
      const liveAccepted = liveWorktrees.find(
        (item) =>
          item.path === preview.path &&
          (request.prunable
            ? item.prunable
            : acceptedKey !== null && item.gitWorktreeKey === acceptedKey)
      )
      const liveRepositoryIdentity = await this.deps.git.repositoryIdentity(
        project.repositoryPath
      )

      if (liveAccepted) {
        if (
          !request.repositoryIdentity ||
          liveRepositoryIdentity !== request.repositoryIdentity
        ) {
          throw new Error(
            'Removal revalidation failed before destructive effects: the repository identity changed after removal was accepted'
          )
        }

        if (request.prunable) {
          if (!liveAccepted.prunable) {
            throw new Error(
              'Removal revalidation failed before destructive effects: the accepted tree is no longer prunable'
            )
          }
        } else {
          const authorizationError = await this.authorizedCheckoutError(
            preview.path,
            request.checkoutIdentity
          )
          if (authorizationError) {
            throw new Error(
              `Removal revalidation failed before destructive effects: ${authorizationError}`
            )
          }
        }

        await this.deps.terminalHost.killWorktree(lockedWorktreeId)

        await persistPhase('terminals_stopped')

        if (request.prunable) {
          await this.deps.git.pruneWorktrees(project.repositoryPath)
        } else {
          await this.deps.git.removeWorktree(
            project.repositoryPath,
            preview.path,
            force
          )
        }

        const stillReported = (
          await this.deps.git.listWorktrees(project.repositoryPath)
        ).some(
          (item) =>
            item.path === preview.path &&
            (request.prunable
              ? item.prunable
              : item.gitWorktreeKey === acceptedKey)
        )
        if (stillReported) {
          throw new Error(
            'Git still reports the accepted worktree after removal'
          )
        }
      }

      gitRemoved = true
      await persistPhase('git_removed')

      const [storedBinding] = await this.deps.database.db.all<{
        id: string
        git_worktree_key: string | null
      }>(sql`
        SELECT id,git_worktree_key FROM worktrees WHERE id=${preview.worktreeId}
      `)
      if (
        storedBinding &&
        (!acceptedKey || storedBinding.git_worktree_key === acceptedKey)
      ) {
        const deletion = await this.deps.database.db.run(sql`
          DELETE FROM worktrees WHERE id=${preview.worktreeId}
        `)
        retiredNow = deletion.rowsAffected > 0
        if (retiredNow) {
          this.clearWorktreeTerminalState(preview.worktreeId)
          this.invalidateProjectsSnapshot()
          this.events.publish('worktree.removed', {
            projectId: project.id,
            worktreeId: preview.worktreeId
          })
        }
      }

      await persistPhase('cleanup_pending')
      let cleanupWarning: string | null = null
      let residualPath: string | null = null
      const currentRepositoryIdentity = await this.deps.git
        .repositoryIdentity(project.repositoryPath)
        .catch(() => null)
      if (
        request.repositoryIdentity &&
        currentRepositoryIdentity !== request.repositoryIdentity
      ) {
        cleanupWarning =
          'The repository identity changed after removal was accepted; residual files were preserved'
        residualPath = preview.path
      } else if (request.checkoutIdentity) {
        let cleanup: CheckoutCleanupResult = {
          removed: false,
          error: null
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          cleanup = await this.removeAuthorizedCheckout(
            preview.path,
            request.checkoutIdentity
          ).catch((error) => ({
            removed: false,
            error: `Automatic residual-checkout cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          }))
          if (!cleanup.error || !cleanup.error.startsWith('Automatic ')) {
            break
          }

          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        if (cleanup.error) {
          cleanupWarning = cleanup.error.slice(0, 4_096)
          residualPath = (await this.checkoutStat(
            request.checkoutIdentity.quarantinePath
          ))
            ? request.checkoutIdentity.quarantinePath
            : preview.path
        }
      } else if (request.prunable) {
        const worktreeAtPath = (
          await this.deps.git.listWorktrees(project.repositoryPath)
        ).some((item) => item.path === preview.path)
        if (!worktreeAtPath) {
          await fs.rmdir(preview.path).catch(() => undefined)
        }
      } else if (await this.checkoutStat(preview.path)) {
        cleanupWarning =
          'The residual checkout has no matching filesystem identity and was preserved'
        residualPath = preview.path
      }

      if (request.managedWrapperPath) {
        await fs.rmdir(request.managedWrapperPath).catch(() => undefined)
      }

      const timestamp = now()
      await this.deps.database.db.run(sql`
        UPDATE operations
        SET status='completed',
            result_json=${serializeOperation({
              removed: true,
              worktreeId: preview.worktreeId,
              name: preview.name,
              branchPreserved: preview.branch,
              path: preview.path,
              recovered: operation.status === 'running' || !retiredNow,
              cleanup: {
                status: cleanupWarning ? 'preserved' : 'completed',
                residualPath,
                warning: cleanupWarning
              }
            })},
            error=NULL,
            updated_at=${timestamp}
        WHERE id=${operationId}
      `)
      this.events.publish('remove.completed', {
        operationId,
        worktreeId: preview.worktreeId
      })
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error)
      if (gitRemoved) {
        const warning = base.slice(0, 4_096)
        await this.deps.database.db.run(sql`
          UPDATE operations
          SET status='completed',
              result_json=${serializeOperation({
                removed: true,
                worktreeId: preview.worktreeId,
                name: preview.name,
                branchPreserved: preview.branch,
                path: preview.path,
                recovered: true,
                cleanup: {
                  status: 'preserved',
                  residualPath: preview.path,
                  warning
                }
              })},
              error=NULL,
              updated_at=${now()}
          WHERE id=${operationId}
        `)
        this.events.publish('remove.completed', {
          operationId,
          worktreeId: preview.worktreeId
        })
      } else {
        const message = (
          request.phase === 'terminals_stopped'
            ? `Terminals were stopped, but Git removal failed: ${base}`
            : base
        ).slice(0, 4_096)
        await this.deps.database.db.run(sql`
          UPDATE operations
          SET status='failed',result_json=NULL,error=${message},updated_at=${now()}
          WHERE id=${operationId}
        `)
        this.events.publish('remove.failed', {
          operationId,
          worktreeId: preview.worktreeId,
          error: message
        })
      }
    } finally {
      await this.locks.release({ worktreeIds: [lockedWorktreeId] })
    }
  }

  resumeRemove(
    operationId: string,
    worktreeId: string,
    force: boolean
  ): Promise<void> {
    return this.executeRemove(operationId, worktreeId, force)
  }
}

function gitMarkerTarget(checkoutPath: string, marker: string): string | null {
  const match = /^gitdir: (.+)$/u.exec(marker.trim())
  return match ? path.resolve(checkoutPath, match[1]!) : null
}

function gitMarkerMatchesKey(
  checkoutPath: string,
  marker: string,
  gitWorktreeKey: string
): boolean {
  const target = gitMarkerTarget(checkoutPath, marker)
  if (!target) {
    return false
  }

  if (path.isAbsolute(gitWorktreeKey)) {
    return target === path.resolve(gitWorktreeKey)
  }

  const normalizedKey = path.normalize(gitWorktreeKey)
  return target.endsWith(`${path.sep}${normalizedKey}`)
}

function removeConfirmationToken(
  key: Buffer,
  preview: Omit<RemovePreview, 'confirmationToken'>,
  statusFingerprint: string
): string {
  return crypto
    .createHmac('sha256', key)
    .update(
      JSON.stringify({
        worktreeId: preview.worktreeId,
        path: preview.path,
        head: preview.head,
        branch: preview.branch,
        detached: preview.detached,
        detachedHeadReachable: preview.detachedHeadReachable,
        locked: preview.locked,
        lockReason: preview.lockReason,
        dirty: preview.dirty,
        forceRequired: preview.forceRequired,
        eligible: preview.eligible,
        reasons: preview.reasons,
        warnings: preview.warnings,
        statusFingerprint,
        terminalIds: preview.terminals.map((terminal) => terminal.id).sort()
      })
    )
    .digest('hex')
}
