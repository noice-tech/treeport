import type {
  CreateOperationRequest,
  OperationRecord,
  RemovePreview
} from '#protocol/operation'
import type { LauncherTreeTitle } from '#protocol/launcher'
import type { TerminalAfterExit } from '#protocol/terminal'
import type { TerminalSize } from '#protocol/terminal-session'
import type * as Effect from 'effect/Effect'
import type { DomainError } from '../../domain.ts'
import type { ApplicationServices } from '../infrastructure/application-runtime.ts'
import {
  type CreateWorktreeResult,
  WorktreeCreationService
} from './worktree-creation-service.ts'
import { WorktreeRemovalService } from './worktree-removal-service.ts'

export type { CreateWorktreeResult } from './worktree-creation-service.ts'

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
    inputName: string | undefined,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      command?: string
      afterExit?: TerminalAfterExit
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeTitle?: LauncherTreeTitle,
    originWorktreeId?: string
  ): Effect.Effect<OperationRecord, DomainError<unknown>, ApplicationServices> {
    return this.creation.beginCreateWorktree(
      projectId,
      inputName,
      base,
      initialTerminal,
      sourceWorktreeId,
      treeTitle,
      originWorktreeId
    )
  }

  resumeCreate(
    operationId: string,
    projectId: string,
    request: CreateOperationRequest
  ): Effect.Effect<void, DomainError<unknown>, ApplicationServices> {
    return this.creation.resumeCreate(operationId, projectId, request)
  }

  createWorktree(
    projectId: string,
    inputName: string | undefined,
    base: 'default' | 'current',
    initialTerminal?: {
      name: string
      command?: string
      afterExit?: TerminalAfterExit
      initialSize?: TerminalSize
    },
    sourceWorktreeId?: string,
    treeTitle?: LauncherTreeTitle,
    originWorktreeId?: string
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
      treeTitle,
      originWorktreeId
    )
  }

  removePreview(
    worktreeId: string
  ): Effect.Effect<RemovePreview, DomainError<unknown>, ApplicationServices> {
    return this.removal.removePreview(worktreeId)
  }

  beginRemove(
    worktreeId: string,
    request: {
      confirmationToken: string
      confirmDestructive: boolean
      skipCleanup?: boolean
    }
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
