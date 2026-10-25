import { useEffect, useRef, useState } from 'react'
import {
  PRESENCE_HEARTBEAT_MS,
  type ViewerIdentity,
  type WorkspacePresence
} from '@treeport/shared'
import { parseResponse, rpc } from '../../api'

interface PresenceSnapshot {
  identity: ViewerIdentity | null
  viewers: readonly WorkspacePresence[]
}

export interface WorkspacePresenceStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): PresenceSnapshot
  setViewers(viewers: readonly WorkspacePresence[]): void
}

// Presence changes on every navigation and heartbeat but only the viewers
// indicator displays it, so it lives outside the workspace's React state.
export function useWorkspacePresence(
  worktreeId: string | null,
  focusedAppId: string | null
): WorkspacePresenceStore {
  const [store] = useState(() => {
    const listeners = new Set<() => void>()
    let snapshot: PresenceSnapshot = { identity: null, viewers: [] }

    const update = (patch: Partial<PresenceSnapshot>) => {
      snapshot = { ...snapshot, ...patch }
      listeners.forEach((listener) => listener())
    }

    return {
      subscribe: (listener: () => void) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      },
      getSnapshot: () => snapshot,
      setViewers: (viewers: readonly WorkspacePresence[]) =>
        update({ viewers }),
      setIdentity: (identity: ViewerIdentity | null) => {
        const current = snapshot.identity

        if (
          current === identity ||
          (current &&
            identity &&
            current.source === identity.source &&
            current.login === identity.login &&
            current.name === identity.name &&
            current.profilePicture === identity.profilePicture)
        ) {
          return
        }

        update({ identity })
      }
    }
  })

  const latest = useRef({ worktreeId, focusedAppId })
  latest.current = { worktreeId, focusedAppId }
  const publish = useRef(() => {})

  useEffect(() => {
    const sessionId = crypto.randomUUID()
    let disposed = false
    let leaving = false
    let sending = false
    let pending = false

    const send = () => {
      if (sending) {
        pending = true

        return
      }

      sending = true
      pending = false

      const visible =
        !disposed && !leaving && document.visibilityState === 'visible'

      const focused = visible && document.hasFocus()
      // Serialize updates so a slow navigation/focus request cannot overwrite
      // a newer one. Each effect lifetime has its own tab session.
      void parseResponse(
        rpc.api.presence.$post(
          {
            sessionId,
            worktreeId: disposed || leaving ? null : latest.current.worktreeId,
            focusedAppId: focused ? latest.current.focusedAppId : null,
            visible,
            focused
          },
          { keepalive: true, signal: AbortSignal.timeout(10_000) }
        )
      )
        .then(
          (response) => {
            if (!disposed) {
              store.setIdentity(response.identity)
            }
          },
          () => {
            if (!disposed) {
              store.setIdentity(null)
            }
          }
        )
        .finally(() => {
          sending = false

          if (pending) {
            send()
          }
        })
    }

    const pageHide = () => {
      leaving = true
      send()
    }

    const pageShow = () => {
      leaving = false
      send()
    }

    publish.current = send
    const heartbeat = window.setInterval(send, PRESENCE_HEARTBEAT_MS)
    document.addEventListener('visibilitychange', send)
    window.addEventListener('focus', send)
    window.addEventListener('blur', send)
    window.addEventListener('pagehide', pageHide)
    window.addEventListener('pageshow', pageShow)

    return () => {
      disposed = true
      publish.current = () => {}

      clearInterval(heartbeat)
      document.removeEventListener('visibilitychange', send)
      window.removeEventListener('focus', send)
      window.removeEventListener('blur', send)
      window.removeEventListener('pagehide', pageHide)
      window.removeEventListener('pageshow', pageShow)
      send()
    }
  }, [store])

  // Navigation and workspace surface focus are external to this hook.
  useEffect(() => {
    publish.current()
  }, [worktreeId, focusedAppId])

  return store
}
