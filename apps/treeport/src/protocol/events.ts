import type { WebApp } from '@treeport/app-sdk'
import type { WorkspacePresence } from './presence.ts'
import type { TerminalRecord } from './terminal.ts'
import type { TerminalRuntimeMetadata } from './terminal-session.ts'
import type { BrowserApp } from './browser.ts'

interface ProductEventPayloadMap {
  'presence.changed': {
    viewers: readonly WorkspacePresence[]
  }
  'project.created': { projectId: string }
  'project.updated': { projectId: string }
  'project.removed': { projectId: string }
  'worktree.created': { projectId: string; worktreeId: string }
  'worktree.updated': { worktreeId: string }
  'worktree.removed': { projectId: string; worktreeId: string }
  'worktree.git_changed': { projectId: string; worktreeId: string }
  'create.started': { projectId: string; operationId: string }
  'create.completed': {
    projectId: string
    operationId: string
    worktreeId: string
  }
  'create.failed': { projectId: string; operationId: string }
  'terminal.created': {
    projectId?: string | undefined
    worktreeId: string
    terminalId: string
    terminal: TerminalRecord
  }
  'terminal.updated': { worktreeId: string; terminalId: string }
  'terminal.removed': { worktreeId: string; terminalId: string }
  'terminal.metadata': TerminalRuntimeMetadata
  'terminal.controller_changed': { terminalId: string; controlled: boolean }
  'app.created': { worktreeId: string; appId: string }
  'app.updated': { worktreeId: string; appId: string }
  'app.open_requested': {
    worktreeId: string
    appId: string
    app: BrowserApp | WebApp
    requestId?: string | null
    sourceTerminalId: string | null
    sourceAppId: string | null
  }
  'app.removed': { worktreeId: string; appId: string }
  'workspace.open_requested': {
    worktreeId: string
    sourceTerminalId: string
  }
  'remove.started': {
    operationId: string
    worktreeId: string
    kind: 'remove'
  }
  'remove.completed': { operationId: string; worktreeId: string }
  'remove.failed': {
    operationId: string
    worktreeId: string
    error: string
  }
}

export type ProductEventType = keyof ProductEventPayloadMap

export type ProductEventInputDataMap = {
  [Type in ProductEventType]: ProductEventPayloadMap[Type] & {
    worktreeId?: string | undefined
  }
}

export type ProductEventDataMap = {
  [Type in ProductEventType]: Omit<
    ProductEventPayloadMap[Type],
    'worktreeId'
  > & {
    worktreeId: string | null
  }
}

export type ProductEvent<Type extends ProductEventType = ProductEventType> = {
  [EventType in Type]: {
    id: string
    type: EventType
    at: string
    data: ProductEventDataMap[EventType]
  }
}[Type]
