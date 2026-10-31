import type {
  TerminalActivity,
  TerminalAttentionReason,
  TerminalProgram,
  TerminalRuntimeMetadata
} from '#protocol/terminal-session'
import { parseResponse, rpc } from './api'

export interface TerminalAttentionMetadata {
  sequence: number
  at: string
  unread: boolean
  reason: TerminalAttentionReason
}

export interface TerminalAttentionEvent {
  terminalId: string
  sequence: number
  at: string
  reason: TerminalAttentionReason
}

export type TerminalRuntimeMetadataInput = Omit<
  TerminalRuntimeMetadata,
  'program'
> & {
  program?: TerminalProgram | null
}

function sameActivity(
  left: TerminalActivity | undefined,
  right: TerminalActivity
): boolean {
  return (
    left?.state === right.state &&
    left.kind === right.kind &&
    left.progress === right.progress &&
    left.app === right.app &&
    left.message === right.message &&
    left.since === right.since
  )
}

export class TerminalRuntimeMetadataStore {
  private readonly listeners = new Set<() => void>()
  private readonly attentionEventListeners = new Set<
    (event: TerminalAttentionEvent) => void
  >()
  private attentionSnapshot: ReadonlyMap<string, TerminalAttentionReason> =
    new Map()
  private titleSnapshot: ReadonlyMap<string, string> = new Map()
  private programSnapshot: ReadonlyMap<string, TerminalProgram> = new Map()
  private foregroundProcessSnapshot: ReadonlySet<string> = new Set()
  private activitySnapshot: ReadonlyMap<string, TerminalActivity> = new Map()
  private attentionMetadata: ReadonlyMap<string, TerminalAttentionMetadata> =
    new Map()
  private attentionAcknowledgementTargets = new Map<string, number>()
  private attentionAcknowledgementQueues = new Map<string, Promise<void>>()
  private attentionAcknowledgementEpoch = 0
  private notificationBatchDepth = 0
  private notificationPending = false

  constructor(
    private readonly sendAttentionAcknowledgement: (
      terminalId: string,
      sequence: number
    ) => Promise<void> = async (terminalId, sequence) => {
      await parseResponse(
        rpc.api.terminals[':terminalId'].attention.acknowledge.$post({
          param: { terminalId },
          json: { sequence }
        })
      )
    }
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  subscribeAttentionEvents = (
    listener: (event: TerminalAttentionEvent) => void
  ): (() => void) => {
    this.attentionEventListeners.add(listener)

    return () => this.attentionEventListeners.delete(listener)
  }

  getAttentionSnapshot = (): ReadonlyMap<string, TerminalAttentionReason> =>
    this.attentionSnapshot
  getAttentionMetadataSnapshot = (): ReadonlyMap<
    string,
    TerminalAttentionMetadata
  > => this.attentionMetadata
  getTitleSnapshot = (): ReadonlyMap<string, string> => this.titleSnapshot
  getProgramSnapshot = (): ReadonlyMap<string, TerminalProgram> =>
    this.programSnapshot
  getForegroundProcessSnapshot = (): ReadonlySet<string> =>
    this.foregroundProcessSnapshot
  getActivitySnapshot = (): ReadonlyMap<string, TerminalActivity> =>
    this.activitySnapshot

  applyRuntimeMetadata(metadata: TerminalRuntimeMetadataInput): void {
    this.notificationBatchDepth += 1
    const currentAttention = this.attentionMetadata.get(metadata.terminalId)
    const incomingAttention = metadata.attention

    const attentionIsCurrent =
      incomingAttention !== null &&
      (!currentAttention ||
        incomingAttention.sequence > currentAttention.sequence ||
        (incomingAttention.sequence === currentAttention.sequence &&
          (currentAttention.unread || !incomingAttention.unread)))

    const attentionMetadataChanged =
      attentionIsCurrent &&
      (currentAttention?.sequence !== incomingAttention.sequence ||
        currentAttention?.at !== incomingAttention.at ||
        currentAttention?.reason !== incomingAttention.reason ||
        currentAttention?.unread !== incomingAttention.unread)

    const attentionEvent =
      attentionIsCurrent &&
      incomingAttention.unread &&
      (!currentAttention ||
        incomingAttention.sequence > currentAttention.sequence)
        ? {
            terminalId: metadata.terminalId,
            sequence: incomingAttention.sequence,
            at: incomingAttention.at,
            reason: incomingAttention.reason
          }
        : null

    if (attentionIsCurrent) {
      if (attentionMetadataChanged) {
        const next = new Map(this.attentionMetadata)
        next.set(metadata.terminalId, {
          sequence: incomingAttention.sequence,
          at: incomingAttention.at,
          unread: incomingAttention.unread,
          reason: incomingAttention.reason
        })
        this.attentionMetadata = next
        this.emit()
      }

      this.setAttention(
        metadata.terminalId,
        incomingAttention.unread ? incomingAttention.reason : null
      )
    } else if (!currentAttention && incomingAttention === null) {
      this.setAttention(metadata.terminalId, null)
    }

    this.setRuntimeTitle(metadata.terminalId, metadata.title)
    this.setProgram(metadata.terminalId, metadata.program ?? null)
    this.setForegroundProcess(
      metadata.terminalId,
      metadata.hasForegroundProcess === true
    )
    this.setActivity(metadata.terminalId, metadata.activity)
    this.notificationBatchDepth -= 1

    if (this.notificationBatchDepth === 0 && this.notificationPending) {
      this.notificationPending = false
      this.listeners.forEach((listener) => listener())
    }

    if (attentionEvent) {
      this.attentionEventListeners.forEach((listener) =>
        listener(attentionEvent)
      )
    }
  }

  replaceRuntimeMetadata(
    metadata: Iterable<TerminalRuntimeMetadataInput>
  ): void {
    const titles = new Map<string, string>()
    const programs = new Map<string, TerminalProgram>()
    const foregroundProcesses = new Set<string>()
    const activities = new Map<string, TerminalActivity>()
    const attentionMetadata = new Map<string, TerminalAttentionMetadata>()
    const attention = new Map<string, TerminalAttentionReason>()

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

      if (item.activity.state !== 'idle') {
        const current = this.activitySnapshot.get(item.terminalId)
        activities.set(
          item.terminalId,
          current && sameActivity(current, item.activity)
            ? current
            : item.activity
        )
      }

      if (item.attention) {
        attentionMetadata.set(item.terminalId, {
          sequence: item.attention.sequence,
          at: item.attention.at,
          unread: item.attention.unread,
          reason: item.attention.reason
        })

        if (item.attention.unread) {
          attention.set(item.terminalId, item.attention.reason)
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

    const activityChanged =
      activities.size !== this.activitySnapshot.size ||
      [...activities].some(
        ([terminalId, value]) =>
          !sameActivity(this.activitySnapshot.get(terminalId), value)
      )

    const attentionChanged =
      attention.size !== this.attentionSnapshot.size ||
      [...attention].some(
        ([terminalId, reason]) =>
          this.attentionSnapshot.get(terminalId) !== reason
      )

    const attentionMetadataChanged =
      attentionMetadata.size !== this.attentionMetadata.size ||
      [...attentionMetadata].some(([terminalId, value]) => {
        const current = this.attentionMetadata.get(terminalId)

        return (
          current?.sequence !== value.sequence ||
          current?.at !== value.at ||
          current?.reason !== value.reason ||
          current?.unread !== value.unread
        )
      })

    if (attentionMetadataChanged) {
      this.attentionMetadata = attentionMetadata
    }

    this.attentionAcknowledgementEpoch += 1
    this.attentionAcknowledgementTargets.clear()

    if (titlesChanged) {
      this.titleSnapshot = titles
    }

    if (programsChanged) {
      this.programSnapshot = programs
    }

    if (foregroundProcessesChanged) {
      this.foregroundProcessSnapshot = foregroundProcesses
    }

    if (activityChanged) {
      this.activitySnapshot = activities
    }

    if (attentionChanged) {
      this.attentionSnapshot = attention
    }

    if (
      titlesChanged ||
      programsChanged ||
      foregroundProcessesChanged ||
      activityChanged ||
      attentionChanged ||
      attentionMetadataChanged
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
    if (this.attentionMetadata.has(terminalId)) {
      const attentionMetadata = new Map(this.attentionMetadata)
      attentionMetadata.delete(terminalId)
      this.attentionMetadata = attentionMetadata
      this.emit()
    }

    this.attentionAcknowledgementTargets.delete(terminalId)
    this.attentionAcknowledgementQueues.delete(terminalId)
    this.clearAttention(terminalId)
    this.clearRuntimeTitle(terminalId)
    this.setProgram(terminalId, null)
    this.setForegroundProcess(terminalId, false)
    this.setActivity(terminalId, null)
  }

  reconcile(terminalIds: Iterable<string>): void {
    const valid = new Set(terminalIds)
    let changed = false
    const attention = new Map(this.attentionSnapshot)
    const titles = new Map(this.titleSnapshot)
    const programs = new Map(this.programSnapshot)
    const foregroundProcesses = new Set(this.foregroundProcessSnapshot)
    const activities = new Map(this.activitySnapshot)

    for (const terminalId of attention.keys()) {
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

    for (const terminalId of activities.keys()) {
      if (!valid.has(terminalId)) {
        activities.delete(terminalId)
        changed = true
      }
    }

    const attentionMetadata = new Map(this.attentionMetadata)

    for (const terminalId of attentionMetadata.keys()) {
      if (!valid.has(terminalId)) {
        attentionMetadata.delete(terminalId)
        this.attentionAcknowledgementTargets.delete(terminalId)
        this.attentionAcknowledgementQueues.delete(terminalId)
        changed = true
      }
    }

    if (changed) {
      this.attentionSnapshot = attention
      this.titleSnapshot = titles
      this.programSnapshot = programs
      this.foregroundProcessSnapshot = foregroundProcesses
      this.activitySnapshot = activities
      this.attentionMetadata = attentionMetadata
      this.emit()
    }
  }

  acknowledgeAttention(terminalId: string, sequence: number): Promise<void> {
    const attention = this.attentionMetadata.get(terminalId)

    if (!attention?.unread || attention.sequence !== sequence) {
      return Promise.resolve()
    }

    const target = this.attentionAcknowledgementTargets.get(terminalId) ?? 0
    const currentQueue = this.attentionAcknowledgementQueues.get(terminalId)

    if (sequence <= target) {
      return currentQueue ?? Promise.resolve()
    }

    const epoch = this.attentionAcknowledgementEpoch
    this.attentionAcknowledgementTargets.set(terminalId, sequence)
    const previous = currentQueue ?? Promise.resolve()

    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const currentAttention = this.attentionMetadata.get(terminalId)

        if (
          this.attentionAcknowledgementEpoch !== epoch ||
          currentAttention?.sequence !== sequence ||
          !currentAttention.unread
        ) {
          if (
            this.attentionAcknowledgementTargets.get(terminalId) === sequence
          ) {
            this.attentionAcknowledgementTargets.delete(terminalId)
          }

          return
        }

        await this.sendAttentionAcknowledgement(terminalId, sequence)
      })
      .catch((error) => {
        if (this.attentionAcknowledgementTargets.get(terminalId) === sequence) {
          this.attentionAcknowledgementTargets.delete(terminalId)
        }

        throw error
      })
      .finally(() => {
        if (this.attentionAcknowledgementQueues.get(terminalId) === queued) {
          this.attentionAcknowledgementQueues.delete(terminalId)
        }
      })

    this.attentionAcknowledgementQueues.set(terminalId, queued)

    return queued
  }

  private clearAttention(terminalId: string): void {
    if (!this.attentionSnapshot.has(terminalId)) {
      return
    }

    const next = new Map(this.attentionSnapshot)
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

  private setAttention(
    terminalId: string,
    unread: TerminalAttentionReason | null
  ): void {
    if (!unread) {
      this.attentionAcknowledgementTargets.delete(terminalId)
    }

    if ((this.attentionSnapshot.get(terminalId) ?? null) === unread) {
      return
    }

    const next = new Map(this.attentionSnapshot)

    if (unread) {
      next.set(terminalId, unread)
    } else {
      next.delete(terminalId)
    }

    this.attentionSnapshot = next
    this.emit()
  }

  private setActivity(
    terminalId: string,
    activity: TerminalActivity | null
  ): void {
    const current = this.activitySnapshot.get(terminalId)
    const value = activity?.state === 'idle' ? null : activity

    if (value ? sameActivity(current, value) : !current) {
      return
    }

    const next = new Map(this.activitySnapshot)

    if (value) {
      next.set(terminalId, value)
    } else {
      next.delete(terminalId)
    }

    this.activitySnapshot = next
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
