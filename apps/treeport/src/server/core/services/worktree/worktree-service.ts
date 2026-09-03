import type {
  OperationRecord,
  PrInfo,
  RemovePreview,
  TerminalSize,
  TreeContextValues
} from '@treeport/shared'
import {
  type CreateWorktreeResult,
  WorktreeCreationService,
  type WorktreeServiceDependencies
} from './worktree-creation-service'
import { WorktreeRemovalService } from './worktree-removal-service'

export type {
  CreateWorktreeResult,
  WorktreeServiceDependencies
} from './worktree-creation-service'

/** Domain façade over the independent creation and durable-removal workflows. */
export class WorktreeService {
  private readonly creation: WorktreeCreationService
  private readonly removal: WorktreeRemovalService

  constructor(dependencies: WorktreeServiceDependencies) {
    this.creation = new WorktreeCreationService(dependencies)
    this.removal = new WorktreeRemovalService(dependencies)
  }

  listActiveOperations(
    filters: {
      projectId?: string
      kind?: OperationRecord['kind']
    } = {}
  ): Promise<OperationRecord[]> {
    return this.creation.listActiveOperations(filters)
  }

  beginCreateWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<OperationRecord> {
    return this.creation.beginCreateWorktree(
      projectId,
      inputName,
      base,
      initialTerminal,
      sourceWorktreeId,
      treeContext
    )
  }

  createWorktree(
    projectId: string,
    inputName: string,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ): Promise<CreateWorktreeResult> {
    return this.creation.createWorktree(
      projectId,
      inputName,
      base,
      initialTerminal,
      sourceWorktreeId,
      treeContext
    )
  }

  refreshPr(worktreeId: string, force = false): Promise<PrInfo> {
    return this.removal.refreshPr(worktreeId, force)
  }

  removePreview(worktreeId: string): Promise<RemovePreview> {
    return this.removal.removePreview(worktreeId)
  }

  beginRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Promise<OperationRecord> {
    return this.removal.beginRemove(worktreeId, request)
  }

  resumeRemove(
    operationId: string,
    worktreeId: string,
    force: boolean
  ): Promise<void> {
    return this.removal.resumeRemove(operationId, worktreeId, force)
  }
}
