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
import { DatabasePort, PackageSystemPort, TerminalHostPort } from './ports'

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

      yield* Effect.promise(() => terminalHost.initialize())
      const interrupted = yield* Effect.promise(() =>
        database.db.all<{
          id: string
          kind: OperationRecord['kind']
        }>(sql`
          SELECT id, kind
          FROM operations
          WHERE status IN ('pending','running')
        `)
      )
      const timestamp = now()
      yield* Effect.promise(() =>
        database.db.transaction(async (tx) => {
          for (const operation of interrupted) {
            if (operation.kind === 'remove') {
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
      yield* observations.reconcile()

      for (const interruptedOperation of interrupted) {
        if (interruptedOperation.kind !== 'remove') {
          continue
        }

        const operation = yield* projectStore.storedOperation(
          interruptedOperation.id
        )
        if (
          operation?.kind !== 'remove' ||
          !operation.projectId ||
          !operation.request.preview
        ) {
          continue
        }

        const worktreeId = operation.request.preview.worktreeId
        yield* locks.acquire({ worktreeIds: [worktreeId] })
        const recovery = worktreeMutations
          .enqueue(
            operation.projectId,
            worktrees.resumeRemove(
              operation.id,
              worktreeId,
              operation.request.preview!.forceRequired
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
        yield* applicationFibers.fork(recovery)
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
