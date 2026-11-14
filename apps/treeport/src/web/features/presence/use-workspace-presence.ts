import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  PRESENCE_HEARTBEAT_MS,
  type ViewerIdentity,
  type WorkspacePresence
} from '#protocol/presence'
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

export const WorkspacePresenceContext =
  createContext<WorkspacePresenceStore | null>(null)

export function isOtherPerson(
  viewer: WorkspacePresence,
  identity: ViewerIdentity,
  worktreeId: string
): boolean {
  return (
    viewer.worktreeId === worktreeId &&
    viewer.identity.source !== 'local' &&
    (viewer.identity.source !== identity.source ||
      viewer.identity.login !== identity.login)
  )
}

export function useOtherPersonViewing(worktreeId: string | null): boolean {
  const presence = useContext(WorkspacePresenceContext)

  return useSyncExternalStore(
    presence?.subscribe ?? (() => () => undefined),
    () => {
      const snapshot = presence?.getSnapshot()

      return Boolean(
        worktreeId &&
        snapshot?.identity &&
        snapshot.viewers.some(
          (viewer) =>
            viewer.visible &&
            isOtherPerson(viewer, snapshot.identity!, worktreeId)
        )
      )
    }
  )
}

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

  useLayoutEffect(() => {
    latest.current = { worktreeId, focusedAppId }
  })

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

  useEffect(() => {
    publish.current()
  }, [worktreeId, focusedAppId])

  return store
}
