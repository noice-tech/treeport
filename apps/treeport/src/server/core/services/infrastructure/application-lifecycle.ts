import type { OperationRecord } from '@treeport/shared'
import { sql } from 'drizzle-orm'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import {
  ApplicationFibers,
  type ApplicationServices,
  ProjectObservations,
  TerminalAttachmentMutations,
  TerminalMetadataMutations,
  TerminalMutations,
  TerminalUploadMutations,
  TreeFileMutations,
  WorktreeMutations
} from './application-runtime'
import { MutationLocks } from './mutation-locks'
import {
  ProjectObservationOperations,
  WorktreeOperations
} from '../domain-services'
import { PackageMutations } from '../package/package-mutations'
import { ProjectStore } from '../project/project-store'
import { PackageSystemPort, TerminalHostPort } from './ports'
import { DatabasePort } from '../../database'

const now = (): string => new Date().toISOString()

export class ApplicationLifecycle {
  initialize(): Effect.Effect<void, never, ApplicationServices> {
    return Effect.gen(function* () {
      const applicationFibers = yield* ApplicationFibers
      const database = yield* DatabasePort
      const locks = yield* MutationLocks
      const packages = yield* PackageSystemPort
      const observations = yield* ProjectObservationOperations
      const projectStore = yield* ProjectStore
      const terminalHost = yield* TerminalHostPort
      const worktrees = yield* WorktreeOperations
      const worktreeMutations = yield* WorktreeMutations

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
      yield* observations.reconcile()

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
                yield* locks.acquire({ worktreeIds: [worktreeId] })
                yield* worktreeMutations
                  .enqueue(
                    projectId,
                    worktrees.resumeRemove(
                      operation.id,
                      worktreeId,
                      operation.request.preview.forceRequired
                    )
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
              }
            }
          })
        )
      }

      const projects = yield* projectStore.storedProjects()
      yield* packages.initialize(projects)
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

      // Accepted background workflows may enqueue mutations after shutdown
      // starts. Wait for their supervised fibers before taking the final queue
      // drain so no late work is interrupted by runtime disposal.
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
