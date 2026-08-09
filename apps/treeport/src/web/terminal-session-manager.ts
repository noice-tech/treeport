import type {
  TerminalProgram,
  TerminalProgress,
  TerminalSize
} from '@treeport/shared'
import { TerminalSession } from './terminal-session-client'
import { TerminalSessionPool } from './terminal-session-pool'
import {
  TerminalRuntimeMetadataStore,
  type TerminalBellEvent,
  type TerminalBellMetadata,
  type TerminalRuntimeMetadataInput
} from './terminal-runtime-metadata'

export type { TerminalBellEvent, TerminalBellMetadata }

export class TerminalSessionManager {
  private readonly pool: TerminalSessionPool
  private readonly runtimeMetadata: TerminalRuntimeMetadataStore

  constructor(
    maxSessions = 8,
    idleMs = 5 * 60_000,
    createSession: (terminalId: string) => TerminalSession = (terminalId) =>
      new TerminalSession(terminalId),
    sendBellAcknowledgement?: (
      terminalId: string,
      sequence: number
    ) => Promise<unknown>
  ) {
    this.runtimeMetadata = new TerminalRuntimeMetadataStore(
      sendBellAcknowledgement
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

  subscribeBellEvents = (
    listener: (event: TerminalBellEvent) => void
  ): (() => void) => this.runtimeMetadata.subscribeBellEvents(listener)

  getAttentionSnapshot = (): ReadonlySet<string> =>
    this.runtimeMetadata.getAttentionSnapshot()
  getBellSnapshot = (): ReadonlyMap<string, TerminalBellMetadata> =>
    this.runtimeMetadata.getBellSnapshot()
  getTitleSnapshot = (): ReadonlyMap<string, string> =>
    this.runtimeMetadata.getTitleSnapshot()
  getProgramSnapshot = (): ReadonlyMap<string, TerminalProgram> =>
    this.runtimeMetadata.getProgramSnapshot()
  getForegroundProcessSnapshot = (): ReadonlySet<string> =>
    this.runtimeMetadata.getForegroundProcessSnapshot()
  getProgressSnapshot = (): ReadonlyMap<string, TerminalProgress> =>
    this.runtimeMetadata.getProgressSnapshot()

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

  acknowledgeBell(terminalId: string, sequence: number): Promise<void> {
    return this.runtimeMetadata.acknowledgeBell(terminalId, sequence)
  }
}
