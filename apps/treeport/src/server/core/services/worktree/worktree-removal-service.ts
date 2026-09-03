import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  OperationRecord,
  PrInfo,
  RemovalCheckoutIdentity,
  RemovePreview,
  WorktreeRecord
} from '@treeport/shared'
import { eq, sql } from 'drizzle-orm'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import { serializeOperation } from '../../database'
import { projects } from '../../database-schema'
import { DomainError } from '../../domain'
import {
  resolveWorktreeCleanupTasks,
  type WorktreeSetupTask
} from '../../setup'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations,
  TerminalOperations
} from '../domain-services'
import {
  ApplicationFibers,
  type ApplicationServices,
  TerminalMutations,
  WorktreeMutations
} from '../infrastructure/application-runtime'
import { MutationLocks } from '../infrastructure/mutation-locks'
import {
  CommandPort,
  DatabasePort,
  EventBusPort,
  GitHubPort,
  GitPort,
  TerminalHostPort
} from '../infrastructure/ports'
import { ProjectStore } from '../project/project-store'
import { TerminalState } from '../terminal/terminal-state'

const now = (): string => new Date().toISOString()
const id = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
const CLEANUP_OUTPUT_MAX_LENGTH = 16 * 1024
const CLEANUP_OUTPUT_TRUNCATION_MARKER = '[Earlier output was truncated]\n'

class RemovalExecutionError {
  readonly _tag = 'RemovalExecutionError'

  constructor(readonly cause: unknown) {}
}

function removalPromise<Result>(
  evaluate: () => Promise<Result>
): Effect.Effect<Result, RemovalExecutionError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new RemovalExecutionError(cause)
  })
}

function removalEffect<Result>(
  effect: Effect.Effect<Result>
): Effect.Effect<Result, RemovalExecutionError> {
  return Effect.catchAllCause(effect, (cause) =>
    Cause.isInterruptedOnly(cause)
      ? Effect.failCause(cause)
      : Effect.fail(new RemovalExecutionError(Cause.squash(cause)))
  )
}

function removalFailure(message: string): RemovalExecutionError {
  return new RemovalExecutionError(new Error(message))
}

function removalErrorMessage(error: RemovalExecutionError): string {
  return error.cause instanceof Error
    ? error.cause.message
    : String(error.cause)
}

interface CheckoutCleanupResult {
  removed: boolean
  error: string | null
}

interface RemovePreviewPreparation {
  readonly preview: RemovePreview
  readonly statusFingerprint: string
  readonly prunable: boolean
  readonly cleanupTasks: WorktreeSetupTask[]
  readonly cleanupDefinitionHash: string | null
}

export class WorktreeRemovalService {
  private readonly removeConfirmationKey = crypto.randomBytes(32)

  private requireAvailableWorktree(worktreeId: string, allowPrunable = false) {
    return Effect.flatMap(ProjectObservationOperations, (observations) =>
      observations.requireAvailableWorktree(worktreeId, allowPrunable)
    )
  }

  private listWorktreeTerminals(worktree: WorktreeRecord) {
    return Effect.flatMap(TerminalOperations, (terminals) =>
      terminals.listWorktreeTerminals(worktree)
    )
  }

  private invalidateProjectsSnapshot() {
    return Effect.flatMap(ProjectSnapshotOperations, (snapshots) =>
      Effect.sync(() => snapshots.invalidate())
    )
  }

  private checkoutStat(checkoutPath: string) {
    return Effect.tryPromise({
      try: () => fs.lstat(checkoutPath, { bigint: true }),
      catch: (error) => error
    }).pipe(
      Effect.catchAll((error) => {
        // SAFETY: Node filesystem failures can carry the standard errno code.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return Effect.succeed(null)
        }

        return Effect.die(error)
      })
    )
  }

  private authorizedCheckoutError(
    checkoutPath: string,
    identity: RemovalCheckoutIdentity | null,
    acceptedPath = checkoutPath
  ): Effect.Effect<string | null> {
    const checkoutStat = this.checkoutStat.bind(this)

    return Effect.gen(function* () {
      const checkout = yield* checkoutStat(checkoutPath)
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
      const markerStat = yield* checkoutStat(markerPath)
      let marker: string | null = null
      if (markerStat?.isFile()) {
        marker = yield* Effect.tryPromise({
          try: () => fs.readFile(markerPath, 'utf8'),
          catch: (cause) => cause
        }).pipe(Effect.orElseSucceed(() => null))
      }

      if (
        marker !== identity.gitMarker ||
        !gitMarkerMatchesKey(
          acceptedPath,
          marker ?? '',
          identity.gitWorktreeKey
        )
      ) {
        return 'The residual checkout Git marker no longer proves that Treeport owns this removal'
      }

      return null
    })
  }

  private removeAuthorizedCheckout(
    checkoutPath: string,
    identity: RemovalCheckoutIdentity | null
  ): Effect.Effect<CheckoutCleanupResult> {
    const authorizedCheckoutError = this.authorizedCheckoutError.bind(this)
    const checkoutStat = this.checkoutStat.bind(this)

    return Effect.gen(function* () {
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
      if (yield* checkoutStat(quarantinePath)) {
        const quarantineError = yield* authorizedCheckoutError(
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
        const authorizationError = yield* authorizedCheckoutError(
          checkoutPath,
          identity
        )
        if (authorizationError) {
          return { removed: false, error: authorizationError }
        }

        if (!(yield* checkoutStat(checkoutPath))) {
          return { removed: false, error: null }
        }

        const rename = yield* Effect.either(
          Effect.tryPromise({
            try: () => fs.rename(checkoutPath, quarantinePath),
            catch: (cause) => cause
          })
        )
        if (Either.isLeft(rename)) {
          const renameError = rename.left
          if (
            // SAFETY: Node filesystem failures can carry the standard errno code.
            (renameError as NodeJS.ErrnoException).code === 'ENOENT' &&
            !(yield* checkoutStat(checkoutPath)) &&
            !(yield* checkoutStat(quarantinePath))
          ) {
            return { removed: false, error: null }
          }

          return yield* Effect.die(renameError)
        }

        const quarantineError = yield* authorizedCheckoutError(
          quarantinePath,
          identity,
          checkoutPath
        )
        if (quarantineError) {
          if (!(yield* checkoutStat(checkoutPath))) {
            const restore = yield* Effect.either(
              Effect.tryPromise({
                try: () => fs.rename(quarantinePath, checkoutPath),
                catch: (cause) => cause
              })
            )
            if (Either.isRight(restore)) {
              return { removed: false, error: quarantineError }
            }
          }

          return {
            removed: false,
            error: `${quarantineError}; the unverified directory was preserved at ${quarantinePath}`
          }
        }
      }

      const removal = yield* Effect.either(
        Effect.tryPromise({
          try: () => fs.rm(quarantinePath, { recursive: true, force: true }),
          catch: (cause) => cause
        })
      )
      const removalError = Either.isLeft(removal) ? removal.left : null
      if (removalError || (yield* checkoutStat(quarantinePath))) {
        if (!(yield* checkoutStat(checkoutPath))) {
          const restore = yield* Effect.either(
            Effect.tryPromise({
              try: () => fs.rename(quarantinePath, checkoutPath),
              catch: (cause) => cause
            })
          )
          if (Either.isRight(restore)) {
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

      if (yield* checkoutStat(checkoutPath)) {
        return {
          removed: false,
          error:
            'The residual checkout path was recreated during automatic cleanup'
        }
      }

      return { removed: true, error: null }
    })
  }

  refreshPr(
    worktreeId: string,
    force = false
  ): Effect.Effect<PrInfo, DomainError<unknown>, ApplicationServices> {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const gh = yield* GitHubPort
      const locks = yield* MutationLocks
      const projectStore = yield* ProjectStore
      const worktree = yield* requireAvailableWorktree(worktreeId)
      const branch = worktree.branch
      if (worktree.kind === 'main' || !branch) {
        return worktree.pr
      }

      const age = worktree.pr.refreshedAt
        ? Date.now() - Date.parse(worktree.pr.refreshedAt)
        : Number.POSITIVE_INFINITY
      if (!force && age < 60_000) {
        return worktree.pr
      }

      yield* projectStore.requireOpenProject(worktree.projectId)
      const pr = yield* Effect.promise(() =>
        gh.pullRequest(worktree.path, branch)
      )
      const current = yield* projectStore.storedWorktree(worktreeId)
      if (!current) {
        return yield* Effect.fail(
          new DomainError('WORKTREE_NOT_FOUND', 'Tree not found', 404)
        )
      }

      if (yield* locks.isWorktreeLocked(worktreeId)) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_UNAVAILABLE',
            'Cannot refresh a pull request while the tree is being removed',
            409
          )
        )
      }

      yield* Effect.promise(() =>
        database.db.run(sql`
          UPDATE worktrees
          SET pr_state=${pr.state},pr_number=${pr.number},pr_url=${pr.url},
              pr_base_branch=${pr.baseBranch},pr_head_branch=${pr.headBranch},
              pr_merged_at=${pr.mergedAt},pr_refreshed_at=${pr.refreshedAt},
              updated_at=${now()}
          WHERE id=${worktreeId}
        `)
      )
      yield* invalidateProjectsSnapshot()
      yield* Effect.sync(() => {
        events.publish('worktree.updated', { worktreeId })
      })
      return pr
    })
  }

  private prepareRemovePreview(
    worktreeId: string
  ): Effect.Effect<
    RemovePreviewPreparation,
    DomainError<unknown>,
    ApplicationServices
  > {
    const requireAvailableWorktree = this.requireAvailableWorktree.bind(this)
    const listWorktreeTerminals = this.listWorktreeTerminals.bind(this)
    const removeConfirmationKey = this.removeConfirmationKey

    return Effect.gen(function* () {
      const git = yield* GitPort
      const projectStore = yield* ProjectStore
      const worktree = yield* requireAvailableWorktree(worktreeId, true)
      worktree.terminals = yield* listWorktreeTerminals(worktree)
      const project = yield* projectStore.getProject(worktree.projectId)
      if (project.kind === 'folder') {
        return yield* Effect.fail(
          new DomainError(
            'FOLDER_WORKSPACE_NOT_REMOVABLE',
            'Remove the folder project instead of its folder workspace',
            409
          )
        )
      }

      const live = (yield* Effect.promise(() =>
        git.listWorktrees(project.repositoryPath)
      )).find((item) => item.path === worktree.path)
      if (!live) {
        return yield* Effect.fail(
          new DomainError(
            'WORKTREE_NOT_FOUND',
            'Git no longer reports this worktree',
            404
          )
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
        : yield* Effect.promise(() => git.dirtyStatus(worktree.path))
      const dirty = status.dirty
      const reachable =
        live.detached && head
          ? yield* Effect.promise(() =>
              git.isCommitReachable(
                live.prunable ? project.repositoryPath : worktree.path,
                head
              )
            )
          : null
      const reasons: string[] = []
      const warnings: string[] = []
      let cleanupTasks: WorktreeSetupTask[] = []
      let cleanupDefinitionHash: string | null = null
      let cleanupUnavailableReason: string | null = null
      const cleanup = yield* Effect.either(
        Effect.tryPromise({
          try: () =>
            resolveWorktreeCleanupTasks({
              mainWorktreePath: project.mainWorktreePath,
              worktreePath: worktree.path
            }),
          catch: (cause) => cause
        })
      )
      if (Either.isRight(cleanup)) {
        cleanupTasks = cleanup.right.tasks
        cleanupDefinitionHash = cleanup.right.definitionHash
      } else {
        const error = cleanup.left
        cleanupUnavailableReason =
          error instanceof Error ? error.message : String(error)
        reasons.push(
          `Project cleanup is unavailable: ${cleanupUnavailableReason}`
        )
      }

      if (live.prunable && cleanupTasks.length > 0) {
        cleanupUnavailableReason =
          'Treeport cannot safely run project cleanup for this prunable tree'
        reasons.push(cleanupUnavailableReason)
      }

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
        cleanup: {
          commands: cleanupTasks.map((task) => task.label),
          available: cleanupUnavailableReason === null,
          unavailableReason: cleanupUnavailableReason
        },
        terminals: worktree.terminals.map(
          ({ id: terminalId, name, status }) => ({
            id: terminalId,
            name,
            status
          })
        )
      } satisfies Omit<RemovePreview, 'confirmationToken'>
      return {
        preview: {
          ...previewWithoutToken,
          confirmationToken: removeConfirmationToken(
            removeConfirmationKey,
            previewWithoutToken,
            status.fingerprint
          )
        },
        statusFingerprint: status.fingerprint,
        prunable: live.prunable,
        cleanupTasks,
        cleanupDefinitionHash
      }
    })
  }

  removePreview(
    worktreeId: string
  ): Effect.Effect<RemovePreview, DomainError<unknown>, ApplicationServices> {
    return this.prepareRemovePreview(worktreeId).pipe(
      Effect.map(({ preview }) => preview)
    )
  }

  beginRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Effect.Effect<OperationRecord, DomainError<unknown>, ApplicationServices> {
    const acceptRemove = this.acceptRemove.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const locks = yield* MutationLocks
      const projectStore = yield* ProjectStore
      const terminalMutations = yield* TerminalMutations
      const worktreeMutations = yield* WorktreeMutations
      const worktree = yield* projectStore.getWorktree(worktreeId)
      yield* projectStore.requireOpenProject(worktree.projectId)
      const [activeRemoval] = yield* Effect.promise(() =>
        database.db.all<{ id: string }>(sql`
          SELECT id FROM operations
          WHERE worktree_id=${worktreeId} AND kind='remove'
            AND status IN ('pending','running')
          LIMIT 1
        `)
      )
      if (activeRemoval) {
        return yield* Effect.fail(
          new DomainError(
            'REMOVE_IN_PROGRESS',
            'The tree is already being removed',
            409
          )
        )
      }

      if (yield* terminalMutations.isBusy(worktreeId)) {
        return yield* terminalMutations.enqueue(
          worktreeId,
          Effect.gen(function* () {
            if (yield* worktreeMutations.isBusy(worktree.projectId)) {
              return yield* worktreeMutations.enqueue(
                worktree.projectId,
                acceptRemove(worktreeId, request)
              )
            }

            return yield* acceptRemove(worktreeId, request)
          })
        )
      }

      if (yield* worktreeMutations.isBusy(worktree.projectId)) {
        return yield* worktreeMutations.enqueue(
          worktree.projectId,
          acceptRemove(worktreeId, request)
        )
      }

      if (
        (yield* locks.isProjectLocked(worktree.projectId)) ||
        (yield* locks.isWorktreeLocked(worktreeId))
      ) {
        return yield* Effect.fail(
          new DomainError(
            'REMOVE_IN_PROGRESS',
            'The tree or project is already being modified',
            409
          )
        )
      }

      return yield* acceptRemove(worktreeId, request)
    })
  }

  private acceptRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Effect.Effect<OperationRecord, DomainError<unknown>, ApplicationServices> {
    const prepareRemovePreview = this.prepareRemovePreview.bind(this)
    const checkoutStat = this.checkoutStat.bind(this)
    const executeRemove = this.executeRemove.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const applicationFibers = yield* ApplicationFibers
        const database = yield* DatabasePort
        const events = yield* EventBusPort
        const git = yield* GitPort
        const locks = yield* MutationLocks
        const projectStore = yield* ProjectStore
        const worktreeMutations = yield* WorktreeMutations
        const worktree = yield* projectStore.getWorktree(worktreeId)
        yield* projectStore.requireOpenProject(worktree.projectId)
        const acquired = yield* locks.tryAcquire({
          worktreeIds: [worktreeId],
          checkProjectIds: [worktree.projectId]
        })
        if (!acquired) {
          return yield* Effect.fail(
            new DomainError(
              'REMOVE_IN_PROGRESS',
              'The tree or project is already being modified',
              409
            )
          )
        }

        const accepted = yield* restore(
          Effect.gen(function* () {
            const { preview, prunable, cleanupTasks, cleanupDefinitionHash } =
              yield* prepareRemovePreview(worktreeId)
            if (!preview.eligible) {
              return yield* Effect.fail(
                new DomainError(
                  'REMOVE_REFUSED',
                  'The tree cannot be removed',
                  409,
                  preview
                )
              )
            }

            if (request.confirmationToken !== preview.confirmationToken) {
              return yield* Effect.fail(
                new DomainError(
                  'REMOVE_PREVIEW_STALE',
                  'The tree changed after the removal preview; review it again',
                  409,
                  preview
                )
              )
            }

            if (preview.warnings.length > 0 && !request.confirmDestructive) {
              return yield* Effect.fail(
                new DomainError(
                  'REMOVE_CONFIRMATION_REQUIRED',
                  'Confirm the destructive removal after reviewing its warnings',
                  409,
                  preview
                )
              )
            }

            const checkout = yield* checkoutStat(preview.path)
            const [checkoutBinding] = yield* Effect.promise(() =>
              database.db.all<{
                git_worktree_key: string | null
                managed_wrapper_path: string | null
              }>(sql`
                SELECT git_worktree_key,managed_wrapper_path
                FROM worktrees WHERE id=${worktreeId}
              `)
            )
            const [projectMetadata] = yield* Effect.promise(() =>
              database.db
                .select({ identity: projects.repositoryIdentity })
                .from(projects)
                .where(eq(projects.id, worktree.projectId))
                .limit(1)
            )
            const repositoryPath = prunable
              ? (yield* projectStore.getProject(worktree.projectId))
                  .repositoryPath
              : preview.path
            const repositoryIdentity = yield* Effect.promise(() =>
              git.repositoryIdentity(repositoryPath)
            )
            if (
              !projectMetadata?.identity ||
              repositoryIdentity !== projectMetadata.identity
            ) {
              return yield* Effect.fail(
                new DomainError(
                  'REMOVE_PREVIEW_STALE',
                  'The repository identity changed after the removal preview; review it again',
                  409,
                  preview
                )
              )
            }

            const operationId = id('op')
            let checkoutIdentity: RemovalCheckoutIdentity | null = null
            if (prunable) {
              if (!checkoutBinding?.git_worktree_key) {
                return yield* Effect.fail(
                  new DomainError(
                    'REMOVE_PREVIEW_STALE',
                    'The prunable tree changed after the removal preview; review it again',
                    409,
                    preview
                  )
                )
              }
            } else {
              const markerPath = path.join(preview.path, '.git')
              const markerStat = yield* checkoutStat(markerPath)
              let gitMarker: string | null = null
              if (markerStat?.isFile()) {
                gitMarker = yield* Effect.tryPromise({
                  try: () => fs.readFile(markerPath, 'utf8'),
                  catch: (cause) => cause
                }).pipe(Effect.orElseSucceed(() => null))
              }

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
                return yield* Effect.fail(
                  new DomainError(
                    'REMOVE_PREVIEW_STALE',
                    'The tree checkout changed after the removal preview; review it again',
                    409,
                    preview
                  )
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
                  `.${path.basename(
                    preview.path
                  )}.treeport-removing-${operationId}`
                )
              }
            }

            const timestamp = now()
            yield* Effect.promise(() =>
              database.db.transaction(async (tx) => {
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
                      managedWrapperPath: checkoutBinding.managed_wrapper_path,
                      cleanupCommands: {
                        status:
                          cleanupTasks.length > 0 ? 'pending' : 'completed',
                        definitionHash: cleanupDefinitionHash,
                        skippedReason: null,
                        commands: cleanupTasks.map((task) => ({
                          name: task.label,
                          status: 'pending',
                          stdout: '',
                          stderr: '',
                          exitCode: null,
                          error: null,
                          outputTruncated: false
                        }))
                      }
                    })},
                    NULL,NULL,${timestamp},${timestamp}
                  )
                `)
              })
            )
            yield* invalidateProjectsSnapshot()
            return { operationId, preview }
          })
        ).pipe(
          Effect.onError(() => locks.release({ worktreeIds: [worktreeId] }))
        )

        const backgroundRemoval = worktreeMutations
          .enqueue(
            worktree.projectId,
            executeRemove(
              accepted.operationId,
              worktreeId,
              accepted.preview.forceRequired
            )
          )
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError(
                `Background tree removal failed for ${
                  accepted.operationId
                }: ${Cause.pretty(cause)}`
              )
            )
          )
        yield* applicationFibers.fork(backgroundRemoval)
        yield* Effect.sync(() =>
          events.publish('remove.started', {
            operationId: accepted.operationId,
            worktreeId,
            kind: 'remove'
          })
        )
        return yield* projectStore.getOperation(accepted.operationId)
      })
    )
  }

  private executeRemove(
    operationId: string,
    lockedWorktreeId: string,
    force: boolean
  ): Effect.Effect<void, never, ApplicationServices> {
    const authorizedCheckoutError = this.authorizedCheckoutError.bind(this)
    const removeAuthorizedCheckout = this.removeAuthorizedCheckout.bind(this)
    const checkoutStat = this.checkoutStat.bind(this)
    const invalidateProjectsSnapshot =
      this.invalidateProjectsSnapshot.bind(this)

    return Effect.gen(function* () {
      const database = yield* DatabasePort
      const events = yield* EventBusPort
      const git = yield* GitPort
      const runner = yield* CommandPort
      const projectStore = yield* ProjectStore
      const terminalHost = yield* TerminalHostPort
      const terminalState = yield* TerminalState
      const operation = yield* projectStore.storedOperation(operationId)
      if (
        operation?.kind !== 'remove' ||
        !operation.projectId ||
        !operation.request.preview
      ) {
        return
      }

      const projectId = operation.projectId
      const request = operation.request
      const preview = operation.request.preview
      const project = yield* projectStore.storedProject(projectId)
      if (!project) {
        return
      }

      const persistPhase = (
        phase: NonNullable<typeof request.phase>
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          request.phase = phase
        }).pipe(
          Effect.zipRight(
            Effect.promise(() =>
              database.db.run(sql`
                UPDATE operations
                SET request_json=${serializeOperation(request)},updated_at=${now()}
                WHERE id=${operationId}
              `)
            )
          ),
          Effect.asVoid
        )

      yield* Effect.promise(() =>
        database.db.run(sql`
          UPDATE operations SET status='running',error=NULL,updated_at=${now()}
          WHERE id=${operationId}
        `)
      )
      let gitRemoved =
        request.phase === 'git_removed' || request.phase === 'cleanup_pending'
      let retiredNow = false
      const workflow = Effect.gen(function* () {
        const liveWorktrees = yield* removalPromise(() =>
          git.listWorktrees(project.repositoryPath)
        )
        const acceptedKey = request.gitWorktreeKey
        const liveAccepted = liveWorktrees.find(
          (item) =>
            item.path === preview.path &&
            (request.prunable
              ? item.prunable
              : acceptedKey !== null && item.gitWorktreeKey === acceptedKey)
        )
        const liveRepositoryIdentity = yield* removalPromise(() =>
          git.repositoryIdentity(project.repositoryPath)
        )

        if (liveAccepted && !gitRemoved) {
          if (
            !request.repositoryIdentity ||
            liveRepositoryIdentity !== request.repositoryIdentity
          ) {
            return yield* Effect.fail(
              removalFailure(
                'Removal revalidation failed before destructive effects: the repository identity changed after removal was accepted'
              )
            )
          }

          if (request.prunable) {
            if (!liveAccepted.prunable) {
              return yield* Effect.fail(
                removalFailure(
                  'Removal revalidation failed before destructive effects: the accepted tree is no longer prunable'
                )
              )
            }
          } else {
            const authorizationError = yield* removalEffect(
              authorizedCheckoutError(preview.path, request.checkoutIdentity)
            )
            if (authorizationError) {
              return yield* Effect.fail(
                removalFailure(
                  `Removal revalidation failed before destructive effects: ${authorizationError}`
                )
              )
            }
          }

          yield* removalPromise(() =>
            terminalHost.killWorktree(lockedWorktreeId)
          )
          yield* persistPhase('terminals_stopped')

          const cleanupAlreadyCompleted =
            request.cleanupCommands.commands.length === 0 ||
            request.cleanupCommands.commands.every(
              (command) => command.status === 'completed'
            )
          if (!cleanupAlreadyCompleted) {
            const cleanup = yield* removalPromise(() =>
              resolveWorktreeCleanupTasks({
                mainWorktreePath: project.mainWorktreePath,
                worktreePath: preview.path
              })
            ).pipe(
              Effect.catchAll((error) => {
                request.cleanupCommands.status = 'failed'
                return Effect.promise(() =>
                  database.db.run(sql`
                    UPDATE operations
                    SET request_json=${serializeOperation(request)},updated_at=${now()}
                    WHERE id=${operationId}
                  `)
                ).pipe(
                  Effect.zipRight(
                    Effect.fail(
                      removalFailure(
                        `Project cleanup configuration is unavailable: ${removalErrorMessage(error)}`
                      )
                    )
                  )
                )
              })
            )
            if (
              cleanup.definitionHash !== request.cleanupCommands.definitionHash
            ) {
              request.cleanupCommands.status = 'failed'
              yield* Effect.promise(() =>
                database.db.run(sql`
                  UPDATE operations
                  SET request_json=${serializeOperation(request)},updated_at=${now()}
                  WHERE id=${operationId}
                `)
              )
              return yield* Effect.fail(
                removalFailure(
                  'Project cleanup configuration changed after removal was accepted'
                )
              )
            }

            if (
              cleanup.tasks.length !==
                request.cleanupCommands.commands.length ||
              cleanup.tasks.some(
                (task, index) =>
                  task.label !== request.cleanupCommands.commands[index]?.name
              )
            ) {
              request.cleanupCommands.status = 'failed'
              yield* Effect.promise(() =>
                database.db.run(sql`
                  UPDATE operations
                  SET request_json=${serializeOperation(request)},updated_at=${now()}
                  WHERE id=${operationId}
                `)
              )
              return yield* Effect.fail(
                removalFailure(
                  'Project cleanup commands changed after removal was accepted'
                )
              )
            }

            request.cleanupCommands.status = 'running'
            yield* Effect.promise(() =>
              database.db.run(sql`
                UPDATE operations
                SET request_json=${serializeOperation(request)},updated_at=${now()}
                WHERE id=${operationId}
              `)
            )
            for (const [index, task] of cleanup.tasks.entries()) {
              const progress = request.cleanupCommands.commands[index]
              if (!progress) {
                return yield* Effect.fail(
                  removalFailure(
                    'Project cleanup commands changed after removal was accepted'
                  )
                )
              }

              if (progress.status === 'completed') {
                continue
              }

              Object.assign(progress, {
                status: 'running' as const,
                stdout: '',
                stderr: '',
                exitCode: null,
                error: null,
                outputTruncated: false
              })
              yield* Effect.promise(() =>
                database.db.run(sql`
                  UPDATE operations
                  SET request_json=${serializeOperation(request)},updated_at=${now()}
                  WHERE id=${operationId}
                `)
              )

              const [executable, ...args] = task.argv
              if (!executable) {
                Object.assign(progress, {
                  status: 'failed' as const,
                  error: 'Cleanup command has no executable'
                })
              } else {
                yield* removalPromise(() =>
                  runner.run({
                    executable,
                    args,
                    cwd: task.cwd,
                    env: { ...process.env, ...task.env },
                    timeoutMs: task.timeoutMs
                  })
                ).pipe(
                  Effect.match({
                    onFailure: (error) => {
                      Object.assign(progress, {
                        status: 'failed' as const,
                        error: removalErrorMessage(error)
                      })
                    },
                    onSuccess: (result) => {
                      const stdout = boundedCleanupOutput(result.stdout)
                      const stderr = boundedCleanupOutput(result.stderr)
                      Object.assign(progress, {
                        status:
                          result.exitCode === 0
                            ? ('completed' as const)
                            : ('failed' as const),
                        stdout: stdout.output,
                        stderr: stderr.output,
                        exitCode: result.exitCode,
                        error:
                          result.exitCode === 0
                            ? null
                            : stderr.output.trim() ||
                              stdout.output.trim() ||
                              `exit ${result.exitCode}`,
                        outputTruncated: stdout.truncated || stderr.truncated
                      })
                    }
                  })
                )
              }

              if (progress.status === 'failed') {
                request.cleanupCommands.status = 'failed'
              }

              yield* Effect.promise(() =>
                database.db.run(sql`
                  UPDATE operations
                  SET request_json=${serializeOperation(request)},updated_at=${now()}
                  WHERE id=${operationId}
                `)
              )
              if (progress.status === 'failed') {
                return yield* Effect.fail(
                  removalFailure(
                    `Project cleanup command “${progress.name}” failed: ${progress.error ?? 'unknown error'}`
                  )
                )
              }
            }
          }

          request.cleanupCommands.status = 'completed'
          yield* persistPhase('cleanup_commands_completed')

          if (request.prunable) {
            yield* removalPromise(() =>
              git.pruneWorktrees(project.repositoryPath)
            )
          } else {
            yield* removalPromise(() =>
              git.removeWorktree(project.repositoryPath, preview.path, force)
            )
          }

          const stillReported = (yield* removalPromise(() =>
            git.listWorktrees(project.repositoryPath)
          )).some(
            (item) =>
              item.path === preview.path &&
              (request.prunable
                ? item.prunable
                : item.gitWorktreeKey === acceptedKey)
          )
          if (stillReported) {
            return yield* Effect.fail(
              removalFailure(
                'Git still reports the accepted worktree after removal'
              )
            )
          }
        } else if (!liveAccepted && !gitRemoved) {
          request.cleanupCommands.status = 'skipped'
          request.cleanupCommands.skippedReason =
            'Git no longer reports the accepted tree; repository cleanup was not run'
        }

        gitRemoved = true
        yield* persistPhase('git_removed')

        const [storedBinding] = yield* Effect.promise(() =>
          database.db.all<{
            id: string
            git_worktree_key: string | null
          }>(sql`
            SELECT id,git_worktree_key FROM worktrees WHERE id=${preview.worktreeId}
          `)
        )
        if (
          storedBinding &&
          (!acceptedKey || storedBinding.git_worktree_key === acceptedKey)
        ) {
          const deletion = yield* Effect.promise(() =>
            database.db.run(sql`
              DELETE FROM worktrees WHERE id=${preview.worktreeId}
            `)
          )
          retiredNow = deletion.rowsAffected > 0
          if (retiredNow) {
            const terminalIds = yield* terminalState.clearWorktree(
              preview.worktreeId
            )
            yield* invalidateProjectsSnapshot()
            yield* Effect.sync(() => {
              for (const terminalId of terminalIds) {
                events.publish('terminal.removed', {
                  worktreeId: preview.worktreeId,
                  terminalId
                })
              }
              events.publish('worktree.removed', {
                projectId: project.id,
                worktreeId: preview.worktreeId
              })
            })
          }
        }

        yield* persistPhase('cleanup_pending')
        let cleanupWarning: string | null = null
        let residualPath: string | null = null
        const currentRepositoryIdentity = yield* removalPromise(() =>
          git.repositoryIdentity(project.repositoryPath)
        ).pipe(
          Effect.match({
            onFailure: () => null,
            onSuccess: (identity) => identity
          })
        )
        if (
          request.repositoryIdentity &&
          currentRepositoryIdentity !== request.repositoryIdentity
        ) {
          cleanupWarning =
            'The repository identity changed after removal was accepted; residual files were preserved'
          residualPath = preview.path
        } else if (request.checkoutIdentity) {
          const checkoutIdentity = request.checkoutIdentity
          let cleanup: CheckoutCleanupResult = {
            removed: false,
            error: null
          }
          for (let attempt = 0; attempt < 3; attempt += 1) {
            cleanup = yield* removalEffect(
              removeAuthorizedCheckout(preview.path, checkoutIdentity)
            ).pipe(
              Effect.match({
                onFailure: (error) => ({
                  removed: false,
                  error: `Automatic residual-checkout cleanup failed: ${removalErrorMessage(error)}`
                }),
                onSuccess: (result) => result
              })
            )
            if (!cleanup.error || !cleanup.error.startsWith('Automatic ')) {
              break
            }

            if (attempt < 2) {
              yield* Effect.sleep(100)
            }
          }
          if (cleanup.error) {
            cleanupWarning = cleanup.error.slice(0, 4_096)
            residualPath = (yield* removalEffect(
              checkoutStat(checkoutIdentity.quarantinePath)
            ))
              ? checkoutIdentity.quarantinePath
              : preview.path
          }
        } else if (request.prunable) {
          const worktreeAtPath = (yield* removalPromise(() =>
            git.listWorktrees(project.repositoryPath)
          )).some((item) => item.path === preview.path)
          if (!worktreeAtPath) {
            yield* Effect.ignore(
              Effect.tryPromise({
                try: () => fs.rmdir(preview.path),
                catch: (cause) => cause
              })
            )
          }
        } else if (yield* removalEffect(checkoutStat(preview.path))) {
          cleanupWarning =
            'The residual checkout has no matching filesystem identity and was preserved'
          residualPath = preview.path
        }

        const managedWrapperPath = request.managedWrapperPath
        if (managedWrapperPath) {
          yield* Effect.ignore(
            Effect.tryPromise({
              try: () => fs.rmdir(managedWrapperPath),
              catch: (cause) => cause
            })
          )
        }

        const timestamp = now()
        yield* Effect.promise(() =>
          database.db.run(sql`
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
                    warning: cleanupWarning,
                    commands: request.cleanupCommands.commands
                  }
                })},
                error=NULL,
                updated_at=${timestamp}
            WHERE id=${operationId}
          `)
        )
        yield* Effect.sync(() =>
          events.publish('remove.completed', {
            operationId,
            worktreeId: preview.worktreeId
          })
        )
      })

      yield* Effect.catchAll(workflow, (error) =>
        Effect.gen(function* () {
          const base = removalErrorMessage(error)
          if (gitRemoved) {
            const warning = base.slice(0, 4_096)
            yield* Effect.promise(() =>
              database.db.run(sql`
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
                        warning,
                        commands: request.cleanupCommands.commands
                      }
                    })},
                    error=NULL,
                    updated_at=${now()}
                WHERE id=${operationId}
              `)
            )
            yield* Effect.sync(() =>
              events.publish('remove.completed', {
                operationId,
                worktreeId: preview.worktreeId
              })
            )
          } else {
            const message = (
              request.cleanupCommands.status === 'failed'
                ? `${base}. Git kept the tree.`
                : request.phase === 'terminals_stopped' ||
                    request.phase === 'cleanup_commands_completed'
                  ? `Terminals were stopped, but Git removal failed: ${base}`
                  : base
            ).slice(0, 4_096)
            yield* Effect.promise(() =>
              database.db.run(sql`
                UPDATE operations
                SET status='failed',result_json=NULL,error=${message},updated_at=${now()}
                WHERE id=${operationId}
              `)
            )
            yield* Effect.sync(() =>
              events.publish('remove.failed', {
                operationId,
                worktreeId: preview.worktreeId,
                error: message
              })
            )
          }
        })
      )
    }).pipe(
      Effect.ensuring(
        Effect.flatMap(MutationLocks, (locks) =>
          locks.release({ worktreeIds: [lockedWorktreeId] })
        )
      )
    )
  }

  resumeRemove(
    operationId: string,
    worktreeId: string,
    force: boolean
  ): Effect.Effect<void, never, ApplicationServices> {
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

function boundedCleanupOutput(value: string) {
  if (value.length <= CLEANUP_OUTPUT_MAX_LENGTH) {
    return { output: value, truncated: false }
  }

  return {
    output: `${CLEANUP_OUTPUT_TRUNCATION_MARKER}${value.slice(
      -(CLEANUP_OUTPUT_MAX_LENGTH - CLEANUP_OUTPUT_TRUNCATION_MARKER.length)
    )}`,
    truncated: true
  }
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
        cleanup: preview.cleanup,
        statusFingerprint,
        terminalIds: preview.terminals.map((terminal) => terminal.id).sort()
      })
    )
    .digest('hex')
}
