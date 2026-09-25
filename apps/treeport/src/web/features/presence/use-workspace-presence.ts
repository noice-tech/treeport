import { useEffect, useRef, useState } from 'react'
import {
  PRESENCE_HEARTBEAT_MS,
  type ViewerIdentity,
  type WorkspacePresence
} from '@treeport/shared'
import { parseResponse, rpc } from '../../api'

export function useWorkspacePresence(
  worktreeId: string | null,
  focusedPanelId: string | null
) {
  const [identity, setIdentity] = useState<ViewerIdentity | null>(null)
  const [viewers, setViewers] = useState<readonly WorkspacePresence[]>([])
  const latest = useRef({ worktreeId, focusedPanelId })
  latest.current = { worktreeId, focusedPanelId }
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
            focusedPanelId: focused ? latest.current.focusedPanelId : null,
            visible,
            focused
          },
          { keepalive: true, signal: AbortSignal.timeout(10_000) }
        )
      )
        .then(
          (response) => {
            if (!disposed) {
              setIdentity(response.identity)
            }
          },
          () => {
            if (!disposed) {
              setIdentity(null)
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
  }, [])

  // Navigation and workspace surface focus are external to this hook.
  useEffect(() => {
    publish.current()
  }, [worktreeId, focusedPanelId])

  // Display-only fixture: never sent to the daemon or used as our identity.
  const mockViewer: WorkspacePresence | null =
    import.meta.env.DEV &&
    import.meta.env.VITE_TREEPORT_MOCK_PRESENCE === '1' &&
    worktreeId
      ? {
          sessionId: '00000000-0000-4000-8000-000000000001',
          worktreeId,
          focusedPanelId,
          visible: true,
          focused: true,
          identity: {
            source: 'tailscale',
            login: 'bob@treeport.invalid',
            name: 'Bob (demo)',
            profilePicture: null
          }
        }
      : null

  return {
    identity,
    viewers: mockViewer ? [...viewers, mockViewer] : viewers,
    setViewers
  }
}
