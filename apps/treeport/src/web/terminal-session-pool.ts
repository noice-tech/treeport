import type { TerminalSize } from '@treeport/shared'
import { TerminalSession } from './terminal-session-client'

interface SessionEntry {
  session: TerminalSession
  references: number
  lastUsed: number
  idleTimer: number | null
  lastTitle: string | null
  unsubscribe: () => void
}

export class TerminalSessionPool {
  private readonly entries = new Map<string, SessionEntry>()

  constructor(
    private readonly maxSessions = 8,
    private readonly idleMs = 5 * 60_000,
    private readonly createSession: (terminalId: string) => TerminalSession = (
      terminalId
    ) => new TerminalSession(terminalId),
    private readonly onTitleChange: (
      terminalId: string,
      title: string | null
    ) => void = () => undefined
  ) {}

  getInitialSize(terminalId: string): TerminalSize | null {
    return this.entries.get(terminalId)?.session.getInitialSize() ?? null
  }

  acquire(terminalId: string): TerminalSession {
    let entry = this.entries.get(terminalId)
    if (!entry) {
      const session = this.createSession(terminalId)
      entry = {
        session,
        references: 0,
        lastUsed: Date.now(),
        idleTimer: null,
        lastTitle: session.getSnapshot().title,
        unsubscribe: () => undefined
      }
      const observedEntry = entry
      entry.unsubscribe = session.subscribe(() => {
        const snapshot = session.getSnapshot()
        if (snapshot.title !== observedEntry.lastTitle) {
          observedEntry.lastTitle = snapshot.title
          this.onTitleChange(terminalId, snapshot.title)
        }
      })
      this.entries.set(terminalId, entry)
      if (entry.lastTitle) {
        this.onTitleChange(terminalId, entry.lastTitle)
      }
    }

    entry.references += 1
    entry.lastUsed = Date.now()
    if (entry.idleTimer !== null) {
      window.clearTimeout(entry.idleTimer)
    }

    entry.idleTimer = null
    this.evictOverCapacity(terminalId)
    return entry.session
  }

  release(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) {
      return
    }

    entry.references = Math.max(0, entry.references - 1)
    entry.lastUsed = Date.now()
    if (entry.references === 0 && entry.idleTimer === null) {
      entry.idleTimer = window.setTimeout(
        () => this.disposeEntry(terminalId),
        this.idleMs
      )
    }
  }

  forget(terminalId: string): void {
    this.disposeEntry(terminalId)
  }

  reconcile(terminalIds: Iterable<string>): void {
    const valid = new Set(terminalIds)
    for (const terminalId of this.entries.keys()) {
      if (!valid.has(terminalId)) {
        this.disposeEntry(terminalId)
      }
    }
  }

  private disposeEntry(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) {
      return
    }

    if (entry.idleTimer !== null) {
      window.clearTimeout(entry.idleTimer)
    }

    entry.unsubscribe()
    entry.session.dispose()
    this.entries.delete(terminalId)
  }

  private evictOverCapacity(selectedId: string): void {
    while (this.entries.size > this.maxSessions) {
      const candidate = [...this.entries.entries()]
        .filter(([id, entry]) => id !== selectedId && entry.references === 0)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0]
      if (!candidate) {
        return
      }

      this.disposeEntry(candidate[0])
    }
  }
}
