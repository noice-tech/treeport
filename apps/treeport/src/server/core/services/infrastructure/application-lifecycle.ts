import type { OperationRecord } from '@treeport/shared'
import { sql } from 'drizzle-orm'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import {
  ApplicationDaemons,
  ApplicationFibers,
  type ApplicationServices,
  ProjectObservations,
  TerminalAttachmentMutations,
  TerminalMetadataMutations,
  TerminalMutations,
  TerminalUploadMutations,
  TreeFileMutations,
  WorktreeMutations
} from './application-runtime.ts'
import { MutationLocks } from './mutation-locks.ts'
import {
  ProjectObservationOperations,
  ProjectSnapshotOperations,
  WorktreeOperations
} from '../domain-services.ts'
import { PackageMutations } from '../package/package-mutations.ts'
import { ProjectStore } from '../project/project-store.ts'
import { PackageSystemPort, TerminalHostPort } from './ports.ts'
import { DatabasePort } from '../../database.ts'

const now = (): string => new Date().toISOString()

type InterruptedOperation = Pick<OperationRecord, 'id' | 'kind' | 'status'>

export class ApplicationLifecycle {
  private interruptedOperations: InterruptedOperation[] = []

  prepareStartup(): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(this, function* () {
      const database = yield* DatabasePort
      const packages = yield* PackageSystemPort
      const projectStore = yield* ProjectStore
      const terminalHost = yield* TerminalHostPort

      yield* terminalHost.initialize().pipe(Effect.orDie)

      const interrupted = yield* database
        .execute('application.lifecycle.41', (db) =>
          db.all<{
            id: string
            kind: OperationRecord['kind']
            status: OperationRecord['status']
          }>(sql`
          SELECT id, kind, status
          FROM operations
          WHERE status IN ('pending','running')
          ORDER BY created_at, id
        `)
        )
        .pipe(Effect.orDie)

      const timestamp = now()
      yield* database
        .execute('application.lifecycle.52', (db) =>
          db.transaction(async (tx) => {
            for (const operation of interrupted) {
              if (
                operation.kind === 'remove' ||
                (operation.kind === 'create' && operation.status === 'pending')
              ) {
                continue
              }

              await tx.run(sql`
              UPDATE operations
              SET status = 'failed',
                  error = ${
                    operation.kind === 'create'
                      ? 'Daemon restarted before tree creation completed; existing Git state will be discovered without replaying the creation'
                      : 'Daemon restarted before the operation completed; external state was preserved for retry'
                  },
                  updated_at = ${timestamp}
              WHERE id = ${operation.id}
            `)
            }
          })
        )
        .pipe(Effect.orDie)
      this.interruptedOperations = interrupted

      const projects = yield* projectStore.storedProjects()
      yield* packages.initialize(projects)
    })
  }

  activateStartup(): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(this, function* () {
      const applicationFibers = yield* ApplicationFibers
      const locks = yield* MutationLocks
      const observations = yield* ProjectObservationOperations
      const projectStore = yield* ProjectStore
      const worktrees = yield* WorktreeOperations
      const worktreeMutations = yield* WorktreeMutations

      yield* observations.reconcile()

      const daemons = yield* ApplicationDaemons
      const snapshots = yield* ProjectSnapshotOperations
      yield* daemons.fork(
        Effect.forever(
          snapshots.refreshGitState().pipe(
            Effect.catchAllCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError(
                    `Git metadata refresh failed: ${Cause.pretty(cause)}`
                  )
            ),
            Effect.zipRight(Effect.sleep('2 seconds'))
          )
        )
      )

      const interrupted = this.interruptedOperations
      this.interruptedOperations = []
      const recoveries = new Map<string, OperationRecord[]>()

      for (const interruptedOperation of interrupted) {
        const operation = yield* projectStore.storedOperation(
          interruptedOperation.id
        )

        if (
          !operation?.projectId ||
          (operation.kind === 'create' && operation.status !== 'pending') ||
          (operation.kind !== 'create' &&
            (operation.kind !== 'remove' || !operation.request.preview))
        ) {
          continue
        }

        const projectRecoveries = recoveries.get(operation.projectId) ?? []
        projectRecoveries.push(operation)
        recoveries.set(operation.projectId, projectRecoveries)
      }

      for (const [projectId, operations] of recoveries) {
        yield* applicationFibers.fork(
          Effect.gen(function* () {
            for (const operation of operations) {
              if (operation.kind === 'create') {
                yield* worktreeMutations
                  .enqueue(
                    projectId,
                    worktrees.resumeCreate(
                      operation.id,
                      projectId,
                      operation.request
                    )
                  )
                  .pipe(
                    Effect.catchAllCause((cause) =>
                      Effect.logError(
                        `Interrupted tree creation recovery failed for ${
                          operation.id
                        }: ${Cause.pretty(cause)}`
                      )
                    )
                  )
                continue
              }

              if (operation.kind === 'remove' && operation.request.preview) {
                const worktreeId = operation.request.preview.worktreeId
                yield* locks.acquire({
                  worktreeIds: [worktreeId],
                  worktreeRemovalProjectId: projectId
                })
                yield* applicationFibers.fork(
                  worktrees
                    .resumeRemove(
                      operation.id,
                      worktreeId,
                      operation.request.preview.forceRequired
                    )
                    .pipe(
                      Effect.catchAllCause((cause) =>
                        Effect.logError(
                          `Interrupted removal recovery failed for ${
                            operation.id
                          }: ${Cause.pretty(cause)}`
                        )
                      )
                    )
                )
              }
            }
          })
        )
      }
    })
  }

  drain(): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(function* () {
      const applicationFibers = yield* ApplicationFibers
      const packageMutations = yield* PackageMutations
      const projectObservations = yield* ProjectObservations
      const terminalAttachmentMutations = yield* TerminalAttachmentMutations
      const terminalMetadataMutations = yield* TerminalMetadataMutations
      const terminalMutations = yield* TerminalMutations
      const terminalUploadMutations = yield* TerminalUploadMutations
      const treeFileMutations = yield* TreeFileMutations
      const worktreeMutations = yield* WorktreeMutations

      yield* applicationFibers.awaitEmpty
      yield* Effect.all(
        [
          worktreeMutations.drain,
          packageMutations.drain,
          terminalMutations.drain,
          terminalAttachmentMutations.drain,
          terminalMetadataMutations.drain,
          terminalUploadMutations.drain,
          treeFileMutations.drain,
          projectObservations.drain
        ],
        { concurrency: 'unbounded', discard: true }
      )
    })
  }
}
