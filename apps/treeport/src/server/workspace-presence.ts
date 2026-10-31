import {
  PRESENCE_TIMEOUT_MS,
  type PresenceUpdate,
  type ViewerIdentity,
  type WorkspacePresence
} from '@treeport/shared'
import { DomainError, type ProductEventBus } from './core/index.ts'

export class WorkspacePresenceManager {
  private readonly sessions = new Map<
    string,
    { viewer: WorkspacePresence; expiresAt: number }
  >()
  private expiry: ReturnType<typeof setTimeout> | null = null

  private readonly events: ProductEventBus

  constructor(events: ProductEventBus) {
    this.events = events
  }

  snapshot(): WorkspacePresence[] {
    return [...this.sessions.values()].map(({ viewer }) => viewer)
  }

  update(identity: ViewerIdentity, input: PresenceUpdate): void {
    const key = JSON.stringify([
      identity.source,
      identity.login,
      input.sessionId
    ])

    const previous = this.sessions.get(key)

    if (input.worktreeId === null) {
      if (this.sessions.delete(key)) {
        this.events.publish('presence.changed', { viewers: this.snapshot() })
        this.scheduleExpiry()
      }

      return
    }

    if (!previous && this.sessions.size >= 256) {
      throw new DomainError('PRESENCE_LIMIT', 'Too many workspace viewers', 429)
    }

    const viewer: WorkspacePresence = {
      ...input,
      focused: input.visible && input.focused,
      focusedAppId: input.visible && input.focused ? input.focusedAppId : null,
      identity
    }

    this.sessions.set(key, {
      viewer,
      expiresAt: Date.now() + PRESENCE_TIMEOUT_MS
    })

    if (JSON.stringify(previous?.viewer) !== JSON.stringify(viewer)) {
      this.events.publish('presence.changed', { viewers: this.snapshot() })
    }

    this.scheduleExpiry()
  }

  private scheduleExpiry(): void {
    if (this.expiry) {
      clearTimeout(this.expiry)
      this.expiry = null
    }

    if (this.sessions.size === 0) {
      return
    }

    const next = Math.min(
      ...[...this.sessions.values()].map((session) => session.expiresAt)
    )

    this.expiry = setTimeout(
      () => {
        for (const [key, session] of this.sessions) {
          if (session.expiresAt <= Date.now()) {
            this.sessions.delete(key)
          }
        }

        this.events.publish('presence.changed', { viewers: this.snapshot() })
        this.scheduleExpiry()
      },
      Math.max(0, next - Date.now())
    )
    this.expiry.unref()
  }

  dispose(): void {
    if (this.expiry) {
      clearTimeout(this.expiry)
    }

    this.sessions.clear()
  }
}
