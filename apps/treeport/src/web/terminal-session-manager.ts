import type {
  TerminalActivity,
  TerminalAttentionReason,
  TerminalProgram,
  TerminalSize
} from '@treeport/shared'
import { TerminalSession } from './terminal-session-client'
import { TerminalSessionPool } from './terminal-session-pool'
import type { TerminalFontZoom } from './terminal-session-client/state'
import {
  TerminalRuntimeMetadataStore,
  type TerminalAttentionEvent,
  type TerminalAttentionMetadata,
  type TerminalRuntimeMetadataInput
} from './terminal-runtime-metadata'

export type { TerminalAttentionEvent, TerminalAttentionMetadata }

export class TerminalSessionManager {
  private readonly pool: TerminalSessionPool
  private readonly runtimeMetadata: TerminalRuntimeMetadataStore

  constructor(
    maxSessions = 8,
    idleMs = 5 * 60_000,
    createSession: (terminalId: string) => TerminalSession = (terminalId) =>
      new TerminalSession(terminalId),
    sendAttentionAcknowledgement?: (
      terminalId: string,
      sequence: number
    ) => Promise<void>
  ) {
    this.runtimeMetadata = new TerminalRuntimeMetadataStore(
      sendAttentionAcknowledgement
    )
    this.pool = new TerminalSessionPool(
      maxSessions,
      idleMs,
      createSession,
      (terminalId, title) =>
        this.runtimeMetadata.setRuntimeTitle(terminalId, title)
    )
  }

  subscribe = (listener: () => void): (() => void) =>
    this.runtimeMetadata.subscribe(listener)

  subscribeAttentionEvents = (
    listener: (event: TerminalAttentionEvent) => void
  ): (() => void) => this.runtimeMetadata.subscribeAttentionEvents(listener)

  getAttentionSnapshot = (): ReadonlyMap<string, TerminalAttentionReason> =>
    this.runtimeMetadata.getAttentionSnapshot()
  getAttentionMetadataSnapshot = (): ReadonlyMap<
    string,
    TerminalAttentionMetadata
  > => this.runtimeMetadata.getAttentionMetadataSnapshot()
  getTitleSnapshot = (): ReadonlyMap<string, string> =>
    this.runtimeMetadata.getTitleSnapshot()
  getProgramSnapshot = (): ReadonlyMap<string, TerminalProgram> =>
    this.runtimeMetadata.getProgramSnapshot()
  getForegroundProcessSnapshot = (): ReadonlySet<string> =>
    this.runtimeMetadata.getForegroundProcessSnapshot()
  getActivitySnapshot = (): ReadonlyMap<string, TerminalActivity> =>
    this.runtimeMetadata.getActivitySnapshot()

  getInitialSize(terminalId: string): TerminalSize | null {
    return this.pool.getInitialSize(terminalId)
  }

  applyRuntimeMetadata(metadata: TerminalRuntimeMetadataInput): void {
    this.runtimeMetadata.applyRuntimeMetadata(metadata)
  }

  replaceRuntimeMetadata(
    metadata: Iterable<TerminalRuntimeMetadataInput>
  ): void {
    this.runtimeMetadata.replaceRuntimeMetadata(metadata)
  }

  zoom(terminalId: string, action: TerminalFontZoom): boolean {
    return this.pool.zoom(terminalId, action)
  }

  zoomFocused(action: TerminalFontZoom): boolean {
    return this.pool.zoomFocused(action)
  }

  acquire(terminalId: string): TerminalSession {
    return this.pool.acquire(terminalId)
  }

  release(terminalId: string): void {
    this.pool.release(terminalId)
  }

  forget(terminalId: string): void {
    this.pool.forget(terminalId)
    this.runtimeMetadata.forget(terminalId)
  }

  reconcile(terminals: Iterable<{ id: string }>): void {
    const terminalIds = [...terminals].map((terminal) => terminal.id)
    this.pool.reconcile(terminalIds)
    this.runtimeMetadata.reconcile(terminalIds)
  }

  acknowledgeAttention(terminalId: string, sequence: number): Promise<void> {
    return this.runtimeMetadata.acknowledgeAttention(terminalId, sequence)
  }
}
