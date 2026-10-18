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
  type ProjectRecord,
  type WorkspacePresence
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
  onAppOpenRequested?: (
    request: ProductEventDataMap['app.open_requested']
  ) => void,
  onWorkspaceOpenRequested?: (
    request: ProductEventDataMap['workspace.open_requested']
  ) => void,
  onPresenceChanged?: (viewers: readonly WorkspacePresence[]) => void
): boolean {
  const queryClient = useQueryClient()
  const onPresenceChangedRef = useRef(onPresenceChanged)
  onPresenceChangedRef.current = onPresenceChanged
  const onAppOpenRequestedRef = useRef(onAppOpenRequested)
  onAppOpenRequestedRef.current = onAppOpenRequested
  const onWorkspaceOpenRequestedRef = useRef(onWorkspaceOpenRequested)
  onWorkspaceOpenRequestedRef.current = onWorkspaceOpenRequested
  const [eventsDisconnected, setEventsDisconnected] = useState(false)

  useEffect(() => {
    let disposed = false
    let reconnecting = false
    let connectedAt: number | null = null
    let reconnectAttempts = 0
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
          { queryKey: ['web-app-definitions'] },
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
      connectedAt ??= Date.now()
      terminalSessions.replaceRuntimeMetadata(payload.terminalMetadata)
      onPresenceChangedRef.current?.(payload.presence)
      setEventsDisconnected(false)
      refresh()
    }
    const productEvent = (event: NetworkProductEvent) => {
      if (event.type === 'presence.changed') {
        onPresenceChangedRef.current?.(event.data.viewers)
        return
      }

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

      if (event.type === 'app.open_requested') {
        refresh()
        onAppOpenRequestedRef.current?.(event.data)
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
        if (reconnecting) {
          // A closed stream does not imply a new daemon UI. Compare the served
          // module entry points with the document we actually loaded, before
          // decoding a potentially changed RPC protocol. Vite fingerprints
          // production assets; development updates are handled by HMR.
          const modules = yield* Effect.tryPromise(async (signal) => {
            const response = await fetch(window.location.href, {
              cache: 'no-store',
              signal
            })
            if (
              !response.ok ||
              !response.headers.get('content-type')?.includes('text/html')
            ) {
              return null
            }

            const nextDocument = new DOMParser().parseFromString(
              await response.text(),
              'text/html'
            )
            return [document, nextDocument].map((page) =>
              Array.from(
                page.querySelectorAll('script[type="module"][src]'),
                (script) =>
                  new URL(
                    script.getAttribute('src') ?? '',
                    window.location.href
                  ).href
              ).sort()
            )
          }).pipe(
            Effect.timeout('5 seconds'),
            Effect.catchAll(() => Effect.succeed(null))
          )
          if (disposed || !modules?.[0]?.length || !modules[1]?.length) {
            return
          }

          if (JSON.stringify(modules[0]) !== JSON.stringify(modules[1])) {
            window.location.reload()
            yield* Effect.never
          }
        }

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
      Effect.gen(function* () {
        yield* connect.pipe(
          Effect.catchAllCause((cause) =>
            disposed
              ? Effect.failCause(cause)
              : Effect.sync(() => {
                  console.error(
                    '[Treeport] Project event RPC disconnected',
                    cause
                  )
                })
          )
        )
        if (disposed) {
          return
        }

        // Treat a clean EOF like a failed stream, and only reset backoff after
        // a stable connection so a host that repeatedly accepts/closes slows down.
        reconnecting = true
        setEventsDisconnected(true)
        onPresenceChangedRef.current?.([])
        if (connectedAt !== null && Date.now() - connectedAt >= 30_000) {
          reconnectAttempts = 0
        }

        connectedAt = null
        yield* Effect.sleep(
          Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempts++, 6))
        )
      })
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
