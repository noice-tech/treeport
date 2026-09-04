import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RpcClient } from '@effect/rpc'
import {
  EVENT_PROTOCOL_VERSION,
  TreeportRpcs,
  treeportRpcClientLayer,
  type EventsSnapshot,
  type NetworkProductEvent,
  type ProductEventDataMap,
  type ProjectRecord
} from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import { createInvalidationCoalescer } from './metadata-sync'
import { removeProjectTerminal, upsertProjectTerminal } from './project-cache'
import { projectsQueryKey, recentProjectsQueryKey } from './project-metadata'
import { terminalSessions } from './terminal-session'

export function useProjectEventsBridge(
  projects: ProjectRecord[] | undefined,
  onPanelOpenRequested?: (
    request: ProductEventDataMap['panel.open_requested']
  ) => void,
  onWorkspaceOpenRequested?: (
    request: ProductEventDataMap['workspace.open_requested']
  ) => void
): boolean {
  const queryClient = useQueryClient()
  const onPanelOpenRequestedRef = useRef(onPanelOpenRequested)
  onPanelOpenRequestedRef.current = onPanelOpenRequested
  const onWorkspaceOpenRequestedRef = useRef(onWorkspaceOpenRequested)
  onWorkspaceOpenRequestedRef.current = onWorkspaceOpenRequested
  const [eventsDisconnected, setEventsDisconnected] = useState(false)

  useEffect(() => {
    let disposed = false
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
          { queryKey: ['tree-context-fields'] },
          { cancelRefetch: false }
        ),
        queryClient.invalidateQueries(
          { queryKey: ['web-panel-definitions'] },
          { cancelRefetch: false }
        )
      ]).then(() => undefined)
    )
    const refresh = () => {
      refreshes.schedule()
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['worktree-creations'] }),
        queryClient.invalidateQueries({ queryKey: ['worktree-removals'] })
      ])
    }
    const refreshProjects = () => projectRefreshes.schedule()
    const snapshot = (payload: EventsSnapshot) => {
      terminalSessions.replaceRuntimeMetadata(payload.terminalMetadata)
      setEventsDisconnected(false)
      refresh()
    }
    const productEvent = (event: NetworkProductEvent) => {
      if (event.type === 'terminal.created') {
        let targetFound = false
        queryClient.setQueryData<ProjectRecord[]>(
          projectsQueryKey,
          (current) => {
            const update = upsertProjectTerminal(
              current,
              event.data.terminal.worktreeId,
              event.data.terminal
            )
            targetFound = update.found
            return update.projects
          }
        )
        if (!targetFound) {
          refresh()
        }

        return
      }

      if (event.type === 'terminal.removed') {
        terminalSessions.forget(event.data.terminalId)
        const worktreeId = event.data.worktreeId
        if (!worktreeId) {
          refresh()
          return
        }

        let worktreeFound = false
        queryClient.setQueryData<ProjectRecord[]>(
          projectsQueryKey,
          (current) => {
            const update = removeProjectTerminal(
              current,
              worktreeId,
              event.data.terminalId
            )
            worktreeFound = update.worktreeFound
            return update.projects
          }
        )
        if (!worktreeFound) {
          refresh()
        }

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

      if (event.type === 'workspace.open_requested') {
        refresh()
        onWorkspaceOpenRequestedRef.current?.(event.data)
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
    const connect = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(TreeportRpcs)
        yield* client
          .WatchProjectEvents({
            protocol: EVENT_PROTOCOL_VERSION
          })
          .pipe(
            Stream.runForEach((item) =>
              Effect.sync(() => {
                if (item._tag === 'Snapshot') {
                  snapshot(item.snapshot)
                } else {
                  productEvent(item.event)
                }
              })
            )
          )
      })
    ).pipe(Effect.provide(treeportRpcClientLayer('/api/rpc')))
    const program = Effect.forever(
      connect.pipe(
        Effect.catchAllCause((cause) =>
          disposed
            ? Effect.failCause(cause)
            : Effect.sync(() => {
                console.error(
                  '[Treeport] Project event RPC disconnected',
                  cause
                )
                setEventsDisconnected(true)
              })
        ),
        Effect.zipRight(Effect.sleep(500))
      )
    )
    const fiber = Effect.runFork(program)
    return () => {
      disposed = true
      refreshes.dispose()
      projectRefreshes.dispose()
      Effect.runFork(Fiber.interrupt(fiber))
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
