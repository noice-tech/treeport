import type { OperationRecord, ProjectRecord } from '@treeport/shared'
import { sql } from 'drizzle-orm'
import type { TreeportDatabase } from '../../database'
import type { PackageSystem } from '../../package-system'
import type { TerminalSessionBackend } from '../../terminal'
import type {
  PromiseMutationLocks,
  PromiseMutationQueue
} from './application-runtime'

const now = (): string => new Date().toISOString()

export interface ApplicationLifecycleDependencies {
  readonly database: TreeportDatabase
  readonly terminalHost: TerminalSessionBackend
  readonly packages: PackageSystem
  readonly locks: PromiseMutationLocks
  readonly worktreeMutations: PromiseMutationQueue
  readonly terminalMutations: PromiseMutationQueue
  readonly treeFileMutations: PromiseMutationQueue
  readonly projectObservations: PromiseMutationQueue
  readonly reconcileProjects: () => Promise<void>
  readonly storedOperation: (
    operationId: string
  ) => Promise<OperationRecord | null>
  readonly resumeRemove: (
    operationId: string,
    worktreeId: string,
    force: boolean
  ) => Promise<void>
  readonly storedProjects: () => Promise<ProjectRecord[]>
}

export class ApplicationLifecycle {
  constructor(
    private readonly dependencies: ApplicationLifecycleDependencies
  ) {}

  async initialize(): Promise<void> {
    const {
      database,
      packages,
      reconcileProjects,
      resumeRemove,
      storedOperation,
      storedProjects,
      terminalHost,
      locks,
      worktreeMutations
    } = this.dependencies
    await terminalHost.initialize()
    const interrupted = await database.db.all<{
      id: string
      kind: OperationRecord['kind']
    }>(sql`
      SELECT id, kind
      FROM operations
      WHERE status IN ('pending','running')
    `)
    const timestamp = now()
    await database.db.transaction(async (tx) => {
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
    await reconcileProjects()

    for (const interruptedOperation of interrupted) {
      if (interruptedOperation.kind !== 'remove') {
        continue
      }

      const operation = await storedOperation(interruptedOperation.id)
      if (
        operation?.kind !== 'remove' ||
        !operation.projectId ||
        !operation.request.preview
      ) {
        continue
      }

      const worktreeId = operation.request.preview.worktreeId
      await locks.acquire({ worktreeIds: [worktreeId] })
      void worktreeMutations
        .enqueue(operation.projectId, () =>
          resumeRemove(
            operation.id,
            worktreeId,
            operation.request.preview!.forceRequired
          )
        )
        .catch(async () => {
          await locks.release({ worktreeIds: [worktreeId] })
        })
    }

    await packages.initialize(await storedProjects())
  }

  async drain(): Promise<void> {
    const {
      projectObservations,
      terminalMutations,
      treeFileMutations,
      worktreeMutations
    } = this.dependencies
    await Promise.all([
      worktreeMutations.drain(),
      terminalMutations.drain(),
      treeFileMutations.drain(),
      projectObservations.drain()
    ])
  }
}
