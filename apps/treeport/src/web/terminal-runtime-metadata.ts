import type {
  TerminalProgram,
  TerminalProgress,
  TerminalRuntimeMetadata
} from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { rpc } from './api'

export interface TerminalBellMetadata {
  sequence: number
  at: string
  unread: boolean
}

export interface TerminalBellEvent {
  terminalId: string
  sequence: number
  at: string
}

export type TerminalRuntimeMetadataInput = Omit<
  TerminalRuntimeMetadata,
  'program'
> & {
  program?: TerminalProgram | null
}

export class TerminalRuntimeMetadataStore {
  private readonly listeners = new Set<() => void>()
  private readonly bellEventListeners = new Set<
    (event: TerminalBellEvent) => void
  >()
  private attentionSnapshot: ReadonlySet<string> = new Set()
  private titleSnapshot: ReadonlyMap<string, string> = new Map()
  private programSnapshot: ReadonlyMap<string, TerminalProgram> = new Map()
  private foregroundProcessSnapshot: ReadonlySet<string> = new Set()
  private progressSnapshot: ReadonlyMap<string, TerminalProgress> = new Map()
  private bellMetadata: ReadonlyMap<string, TerminalBellMetadata> = new Map()
  private bellAcknowledgementTargets = new Map<string, number>()
  private bellAcknowledgementQueues = new Map<string, Promise<void>>()
  private bellAcknowledgementEpoch = 0
  private notificationBatchDepth = 0
  private notificationPending = false

  constructor(
    private readonly sendBellAcknowledgement: (
      terminalId: string,
      sequence: number
    ) => Promise<unknown> = (terminalId, sequence) =>
      parseResponse(
        rpc.api.terminals[':terminalId'].bell.acknowledge.$post({
          param: { terminalId },
          json: { sequence }
        })
      )
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeBellEvents = (
    listener: (event: TerminalBellEvent) => void
  ): (() => void) => {
    this.bellEventListeners.add(listener)
    return () => this.bellEventListeners.delete(listener)
  }

  getAttentionSnapshot = (): ReadonlySet<string> => this.attentionSnapshot
  getBellSnapshot = (): ReadonlyMap<string, TerminalBellMetadata> =>
    this.bellMetadata
  getTitleSnapshot = (): ReadonlyMap<string, string> => this.titleSnapshot
  getProgramSnapshot = (): ReadonlyMap<string, TerminalProgram> =>
    this.programSnapshot
  getForegroundProcessSnapshot = (): ReadonlySet<string> =>
    this.foregroundProcessSnapshot
  getProgressSnapshot = (): ReadonlyMap<string, TerminalProgress> =>
    this.progressSnapshot

  applyRuntimeMetadata(metadata: TerminalRuntimeMetadataInput): void {
    this.notificationBatchDepth += 1
    const currentBell = this.bellMetadata.get(metadata.terminalId)
    const incomingBell = metadata.bell
    const bellIsCurrent =
      incomingBell !== null &&
      (!currentBell ||
        incomingBell.sequence > currentBell.sequence ||
        (incomingBell.sequence === currentBell.sequence &&
          (currentBell.unread || !incomingBell.unread)))
    const bellChanged =
      bellIsCurrent &&
      (currentBell?.sequence !== incomingBell.sequence ||
        currentBell?.at !== incomingBell.at ||
        currentBell?.unread !== incomingBell.unread)
    const bellEvent =
      bellIsCurrent &&
      incomingBell.unread &&
      (!currentBell || incomingBell.sequence > currentBell.sequence)
        ? {
            terminalId: metadata.terminalId,
            sequence: incomingBell.sequence,
            at: incomingBell.at
          }
        : null
    if (bellIsCurrent) {
      if (bellChanged) {
        const next = new Map(this.bellMetadata)
        next.set(metadata.terminalId, {
          sequence: incomingBell.sequence,
          at: incomingBell.at,
          unread: incomingBell.unread
        })
        this.bellMetadata = next
        this.emit()
      }

      this.setAttention(metadata.terminalId, incomingBell.unread)
    } else if (!currentBell && incomingBell === null) {
      this.setAttention(metadata.terminalId, false)
    }

    this.setRuntimeTitle(metadata.terminalId, metadata.title)
    this.setProgram(metadata.terminalId, metadata.program ?? null)
    this.setForegroundProcess(
      metadata.terminalId,
      metadata.hasForegroundProcess === true
    )
    this.setProgress(metadata.terminalId, metadata.progress)
    this.notificationBatchDepth -= 1
    if (this.notificationBatchDepth === 0 && this.notificationPending) {
      this.notificationPending = false
      this.listeners.forEach((listener) => listener())
    }

    if (bellEvent) {
      this.bellEventListeners.forEach((listener) => listener(bellEvent))
    }
  }

  replaceRuntimeMetadata(
    metadata: Iterable<TerminalRuntimeMetadataInput>
  ): void {
    const titles = new Map<string, string>()
    const programs = new Map<string, TerminalProgram>()
    const foregroundProcesses = new Set<string>()
    const progress = new Map<string, TerminalProgress>()
    const bells = new Map<string, TerminalBellMetadata>()
    const attention = new Set<string>()
    for (const item of metadata) {
      const title = item.title?.trim().slice(0, 256)
      if (title) {
        titles.set(item.terminalId, title)
      }

      if (item.program) {
        programs.set(item.terminalId, item.program)
      }

      if (item.hasForegroundProcess) {
        foregroundProcesses.add(item.terminalId)
      }

      if (item.progress) {
        const current = this.progressSnapshot.get(item.terminalId)
        progress.set(
          item.terminalId,
          current?.state === item.progress.state &&
            current.value === item.progress.value
            ? current
            : item.progress
        )
      }

      if (item.bell) {
        bells.set(item.terminalId, {
          sequence: item.bell.sequence,
          at: item.bell.at,
          unread: item.bell.unread
        })
        if (item.bell.unread) {
          attention.add(item.terminalId)
        }
      }
    }
    const titlesChanged =
      titles.size !== this.titleSnapshot.size ||
      [...titles].some(
        ([terminalId, title]) => this.titleSnapshot.get(terminalId) !== title
      )
    const programsChanged =
      programs.size !== this.programSnapshot.size ||
      [...programs].some(
        ([terminalId, program]) =>
          this.programSnapshot.get(terminalId) !== program
      )
    const foregroundProcessesChanged =
      foregroundProcesses.size !== this.foregroundProcessSnapshot.size ||
      [...foregroundProcesses].some(
        (terminalId) => !this.foregroundProcessSnapshot.has(terminalId)
      )
    const progressChanged =
      progress.size !== this.progressSnapshot.size ||
      [...progress].some(([terminalId, value]) => {
        const current = this.progressSnapshot.get(terminalId)
        return current?.state !== value.state || current.value !== value.value
      })
    const attentionChanged =
      attention.size !== this.attentionSnapshot.size ||
      [...attention].some(
        (terminalId) => !this.attentionSnapshot.has(terminalId)
      )
    const bellsChanged =
      bells.size !== this.bellMetadata.size ||
      [...bells].some(([terminalId, value]) => {
        const current = this.bellMetadata.get(terminalId)
        return (
          current?.sequence !== value.sequence ||
          current?.at !== value.at ||
          current?.unread !== value.unread
        )
      })
    if (bellsChanged) {
      this.bellMetadata = bells
    }

    this.bellAcknowledgementEpoch += 1
    this.bellAcknowledgementTargets.clear()

    if (titlesChanged) {
      this.titleSnapshot = titles
    }

    if (programsChanged) {
      this.programSnapshot = programs
    }

    if (foregroundProcessesChanged) {
      this.foregroundProcessSnapshot = foregroundProcesses
    }

    if (progressChanged) {
      this.progressSnapshot = progress
    }

    if (attentionChanged) {
      this.attentionSnapshot = attention
    }

    if (
      titlesChanged ||
      programsChanged ||
      foregroundProcessesChanged ||
      progressChanged ||
      attentionChanged ||
      bellsChanged
    ) {
      this.emit()
    }
  }

  setRuntimeTitle(terminalId: string, value: string | null): void {
    const title = value?.trim().slice(0, 256) || null
    if (title === null) {
      this.clearRuntimeTitle(terminalId)
      return
    }

    if (this.titleSnapshot.get(terminalId) === title) {
      return
    }

    this.titleSnapshot = new Map(this.titleSnapshot).set(terminalId, title)
    this.emit()
  }

  forget(terminalId: string): void {
    if (this.bellMetadata.has(terminalId)) {
      const bells = new Map(this.bellMetadata)
      bells.delete(terminalId)
      this.bellMetadata = bells
      this.emit()
    }

    this.bellAcknowledgementTargets.delete(terminalId)
    this.bellAcknowledgementQueues.delete(terminalId)
    this.clearAttention(terminalId)
    this.clearRuntimeTitle(terminalId)
    this.setProgram(terminalId, null)
    this.setForegroundProcess(terminalId, false)
    this.setProgress(terminalId, null)
  }

  reconcile(terminalIds: Iterable<string>): void {
    const valid = new Set(terminalIds)
    let changed = false
    const attention = new Set(this.attentionSnapshot)
    const titles = new Map(this.titleSnapshot)
    const programs = new Map(this.programSnapshot)
    const foregroundProcesses = new Set(this.foregroundProcessSnapshot)
    const progress = new Map(this.progressSnapshot)
    for (const terminalId of attention) {
      if (!valid.has(terminalId)) {
        attention.delete(terminalId)
        changed = true
      }
    }
    for (const terminalId of titles.keys()) {
      if (!valid.has(terminalId)) {
        titles.delete(terminalId)
        changed = true
      }
    }
    for (const terminalId of programs.keys()) {
      if (!valid.has(terminalId)) {
        programs.delete(terminalId)
        changed = true
      }
    }
    for (const terminalId of foregroundProcesses) {
      if (!valid.has(terminalId)) {
        foregroundProcesses.delete(terminalId)
        changed = true
      }
    }
    for (const terminalId of progress.keys()) {
      if (!valid.has(terminalId)) {
        progress.delete(terminalId)
        changed = true
      }
    }
    const bells = new Map(this.bellMetadata)
    for (const terminalId of bells.keys()) {
      if (!valid.has(terminalId)) {
        bells.delete(terminalId)
        this.bellAcknowledgementTargets.delete(terminalId)
        this.bellAcknowledgementQueues.delete(terminalId)
        changed = true
      }
    }
    if (changed) {
      this.attentionSnapshot = attention
      this.titleSnapshot = titles
      this.programSnapshot = programs
      this.foregroundProcessSnapshot = foregroundProcesses
      this.progressSnapshot = progress
      this.bellMetadata = bells
      this.emit()
    }
  }

  acknowledgeBell(terminalId: string, sequence: number): Promise<void> {
    const bell = this.bellMetadata.get(terminalId)
    if (!bell?.unread || bell.sequence !== sequence) {
      return Promise.resolve()
    }

    const target = this.bellAcknowledgementTargets.get(terminalId) ?? 0
    const currentQueue = this.bellAcknowledgementQueues.get(terminalId)
    if (sequence <= target) {
      return currentQueue ?? Promise.resolve()
    }

    const epoch = this.bellAcknowledgementEpoch
    this.bellAcknowledgementTargets.set(terminalId, sequence)
    const previous = currentQueue ?? Promise.resolve()
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const currentBell = this.bellMetadata.get(terminalId)
        if (
          this.bellAcknowledgementEpoch !== epoch ||
          currentBell?.sequence !== sequence ||
          !currentBell.unread
        ) {
          if (this.bellAcknowledgementTargets.get(terminalId) === sequence) {
            this.bellAcknowledgementTargets.delete(terminalId)
          }

          return
        }

        await this.sendBellAcknowledgement(terminalId, sequence)
      })
      .catch((error: unknown) => {
        if (this.bellAcknowledgementTargets.get(terminalId) === sequence) {
          this.bellAcknowledgementTargets.delete(terminalId)
        }

        throw error
      })
      .finally(() => {
        if (this.bellAcknowledgementQueues.get(terminalId) === queued) {
          this.bellAcknowledgementQueues.delete(terminalId)
        }
      })
    this.bellAcknowledgementQueues.set(terminalId, queued)
    return queued
  }

  private clearAttention(terminalId: string): void {
    if (!this.attentionSnapshot.has(terminalId)) {
      return
    }

    const next = new Set(this.attentionSnapshot)
    next.delete(terminalId)
    this.attentionSnapshot = next
    this.emit()
  }

  private clearRuntimeTitle(terminalId: string): void {
    if (!this.titleSnapshot.has(terminalId)) {
      return
    }

    const titles = new Map(this.titleSnapshot)
    titles.delete(terminalId)
    this.titleSnapshot = titles
    this.emit()
  }

  private setProgram(
    terminalId: string,
    program: TerminalProgram | null
  ): void {
    if (this.programSnapshot.get(terminalId) === program) {
      return
    }

    const next = new Map(this.programSnapshot)
    if (program) {
      next.set(terminalId, program)
    } else {
      next.delete(terminalId)
    }

    this.programSnapshot = next
    this.emit()
  }

  private setForegroundProcess(
    terminalId: string,
    hasForegroundProcess: boolean
  ): void {
    if (
      this.foregroundProcessSnapshot.has(terminalId) === hasForegroundProcess
    ) {
      return
    }

    const next = new Set(this.foregroundProcessSnapshot)
    if (hasForegroundProcess) {
      next.add(terminalId)
    } else {
      next.delete(terminalId)
    }

    this.foregroundProcessSnapshot = next
    this.emit()
  }

  private setAttention(terminalId: string, unread: boolean): void {
    if (!unread) {
      this.bellAcknowledgementTargets.delete(terminalId)
    }

    if (this.attentionSnapshot.has(terminalId) === unread) {
      return
    }

    const next = new Set(this.attentionSnapshot)
    if (unread) {
      next.add(terminalId)
    } else {
      next.delete(terminalId)
    }

    this.attentionSnapshot = next
    this.emit()
  }

  private setProgress(
    terminalId: string,
    progress: TerminalProgress | null
  ): void {
    const current = this.progressSnapshot.get(terminalId)
    if (
      progress &&
      current?.state === progress.state &&
      current.value === progress.value
    ) {
      return
    }

    if (!progress && !current) {
      return
    }

    const next = new Map(this.progressSnapshot)
    if (progress) {
      next.set(terminalId, progress)
    } else {
      next.delete(terminalId)
    }

    this.progressSnapshot = next
    this.emit()
  }

  private emit(): void {
    if (this.notificationBatchDepth > 0) {
      this.notificationPending = true
      return
    }

    this.listeners.forEach((listener) => listener())
  }
}
