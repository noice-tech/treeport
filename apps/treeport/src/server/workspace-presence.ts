import {
  PRESENCE_TIMEOUT_MS,
  type PresenceUpdate,
  type ViewerIdentity,
  type WorkspacePresence
} from '@treeport/shared'
import { DomainError, type ProductEventBus } from './core/index'

export class WorkspacePresenceManager {
  private readonly sessions = new Map<
    string,
    { viewer: WorkspacePresence; expiresAt: number }
  >()
  private expiry: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly events: ProductEventBus) {}

  snapshot(): WorkspacePresence[] {
    return [...this.sessions.values()].map(({ viewer }) => viewer)
  }

  update(identity: ViewerIdentity, input: PresenceUpdate): void {
    // A session ID is a tab identifier, not a credential. Another user cannot
    // overwrite or remove this user's session, even if they know its ID.
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
      focusedPanelId:
        input.visible && input.focused ? input.focusedPanelId : null,
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
