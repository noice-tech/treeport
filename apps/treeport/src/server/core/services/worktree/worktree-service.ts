import type {
  OperationRecord,
  PrInfo,
  RemovePreview,
  TerminalSize,
  TreeContextValues
} from '@treeport/shared'
import type * as Effect from 'effect/Effect'
import type { DomainError } from '../../domain'
import type { ApplicationServices } from '../infrastructure/application-runtime'
import {
  type CreateWorktreeResult,
  WorktreeCreationService
} from './worktree-creation-service'
import { WorktreeRemovalService } from './worktree-removal-service'

export type { CreateWorktreeResult } from './worktree-creation-service'

/** Domain façade over the independent creation and durable-removal workflows. */
export class WorktreeService {
  private readonly creation: WorktreeCreationService
  private readonly removal: WorktreeRemovalService

  constructor() {
    this.creation = new WorktreeCreationService()
    this.removal = new WorktreeRemovalService()
  }

  listActiveOperations(
    filters: {
      projectId?: string
      kind?: OperationRecord['kind']
    } = {}
  ): Effect.Effect<
    OperationRecord[],
    DomainError<unknown>,
    ApplicationServices
  > {
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
  ): Effect.Effect<OperationRecord, DomainError<unknown>, ApplicationServices> {
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
  ): Effect.Effect<
    CreateWorktreeResult,
    DomainError<unknown>,
    ApplicationServices
  > {
    return this.creation.createWorktree(
      projectId,
      inputName,
      base,
      initialTerminal,
      sourceWorktreeId,
      treeContext
    )
  }

  refreshPr(
    worktreeId: string,
    force = false
  ): Effect.Effect<PrInfo, DomainError<unknown>, ApplicationServices> {
    return this.removal.refreshPr(worktreeId, force)
  }

  removePreview(
    worktreeId: string
  ): Effect.Effect<RemovePreview, DomainError<unknown>, ApplicationServices> {
    return this.removal.removePreview(worktreeId)
  }

  beginRemove(
    worktreeId: string,
    request: { confirmationToken: string; confirmDestructive: boolean }
  ): Effect.Effect<OperationRecord, DomainError<unknown>, ApplicationServices> {
    return this.removal.beginRemove(worktreeId, request)
  }

  resumeRemove(
    operationId: string,
    worktreeId: string,
    force: boolean
  ): Effect.Effect<void, never, ApplicationServices> {
    return this.removal.resumeRemove(operationId, worktreeId, force)
  }
}
