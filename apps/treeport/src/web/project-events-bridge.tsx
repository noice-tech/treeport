import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { io, type Socket } from 'socket.io-client'
import {
  parseEventsSnapshot,
  parseProductEvent,
  SOCKET_IO_PATH
} from '@treeport/shared'
import type {
  EventsClientToServerEvents,
  EventsServerToClientEvents,
  ProductEventDataMap,
  ProjectRecord
} from '@treeport/shared'
import { createInvalidationCoalescer } from './metadata-sync'
import { projectsQueryKey, recentProjectsQueryKey } from './project-metadata'
import { terminalSessions } from './terminal-session'

export function useProjectEventsBridge(
  projects: ProjectRecord[] | undefined,
  onPanelOpenRequested?: (
    request: ProductEventDataMap['panel.open_requested']
  ) => void
): boolean {
  const queryClient = useQueryClient()
  const onPanelOpenRequestedRef = useRef(onPanelOpenRequested)
  onPanelOpenRequestedRef.current = onPanelOpenRequested
  const [eventsDisconnected, setEventsDisconnected] = useState(false)

  useEffect(() => {
    const events: Socket<
      EventsServerToClientEvents,
      EventsClientToServerEvents
    > = io('/events', {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      autoConnect: false,
      retries: 0
    })
    const refreshes = createInvalidationCoalescer(() =>
      queryClient.invalidateQueries(
        { queryKey: projectsQueryKey },
        { cancelRefetch: false }
      )
    )
    const projectRefreshes = createInvalidationCoalescer(() =>
      Promise.all([
        queryClient.invalidateQueries(
          { queryKey: projectsQueryKey },
          { cancelRefetch: false }
        ),
        queryClient.invalidateQueries(
          { queryKey: recentProjectsQueryKey },
          { cancelRefetch: false }
        ),
        queryClient.invalidateQueries(
          { queryKey: ['terminal-preset-definitions'] },
          { cancelRefetch: false }
        ),
        queryClient.invalidateQueries(
          { queryKey: ['web-panel-definitions'] },
          { cancelRefetch: false }
        )
      ])
    )
    const refresh = () => {
      refreshes.schedule()
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['worktree-creations'] }),
        queryClient.invalidateQueries({ queryKey: ['worktree-removals'] })
      ])
    }
    const refreshProjects = () => projectRefreshes.schedule()
    const snapshot = (value: unknown) => {
      const payload = parseEventsSnapshot(value)
      if (!payload) {
        setEventsDisconnected(true)
        return
      }

      terminalSessions.replaceRuntimeMetadata(payload.terminalMetadata)
      setEventsDisconnected(false)
      refresh()
    }
    const productEvent = (value: unknown) => {
      const event = parseProductEvent(value)
      if (!event) {
        return
      }

      if (event.type === 'terminal.metadata') {
        terminalSessions.applyRuntimeMetadata({
          terminalId: event.data.terminalId,
          title: event.data.title,
          program: event.data.program,
          hasForegroundProcess: event.data.hasForegroundProcess,
          progress: event.data.progress,
          progressStartedAt: event.data.progressStartedAt,
          progressClearedAt: event.data.progressClearedAt,
          bell: event.data.bell
        })
        return
      }

      if (event.type === 'panel.open_requested') {
        refresh()
        onPanelOpenRequestedRef.current?.(event.data)
        return
      }

      if (event.type === 'project.updated') {
        refreshProjects()
        return
      }

      if (event.type === 'project.removed') {
        refreshProjects()
        return
      }

      if (event.type !== 'terminal.controller_changed') {
        refresh()
      }
    }
    const disconnected = () => setEventsDisconnected(true)
    events.on('snapshot', snapshot)
    events.on('product_event', productEvent)
    events.on('disconnect', disconnected)
    events.on('connect_error', disconnected)
    events.connect()
    return () => {
      refreshes.dispose()
      projectRefreshes.dispose()
      events.disconnect()
    }
  }, [queryClient])

  useEffect(() => {
    if (!projects) {
      return
    }

    terminalSessions.reconcile(
      projects.flatMap((project) =>
        project.worktrees.flatMap((worktree) => worktree.terminals)
      )
    )
  }, [projects])

  return eventsDisconnected
}
