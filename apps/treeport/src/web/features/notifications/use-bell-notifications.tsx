import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { ProjectRecord, TerminalRecord } from '@treeport/shared'
import { Button } from '../../components/ui/button'
import {
  terminalSessions,
  type TerminalBellEvent
} from '../../terminal-session'
import { useTerminalBellMetadata } from '../../terminal-runtime-metadata-react'
import { notifyError } from './error-notifications'
import {
  targetForTerminal,
  type WorkspaceTarget
} from '../../workspace-navigation'

type Presence = {
  focused: boolean
  visible: boolean
}

type TerminalContext = {
  projectName: string
  worktreeName: string
  terminal: TerminalRecord
  title: string
}

function toastId(terminalId: string, sequence: number): string {
  return `bell:${terminalId}:${sequence}`
}

function findTerminalContext(
  projects: ProjectRecord[],
  runtimeTitles: ReadonlyMap<string, string>,
  terminalId: string
): TerminalContext | null {
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find(
        (candidate) => candidate.id === terminalId
      )
      if (terminal) {
        return {
          projectName: project.name,
          worktreeName: worktree.name,
          terminal,
          title: runtimeTitles.get(terminalId) ?? terminal.name
        }
      }
    }
  }

  return null
}

export function TerminalBellNotifications({
  projects,
  projectsLoaded,
  selectedTerminalId,
  navigateToWorkspace
}: {
  projects: ProjectRecord[]
  projectsLoaded: boolean
  selectedTerminalId: string | null
  navigateToWorkspace: (
    target: WorkspaceTarget,
    replace?: boolean
  ) => Promise<void>
}) {
  const { bells, titles: runtimeTitles } = useTerminalBellMetadata()
  const latest = useRef({
    projects,
    projectsLoaded,
    selectedTerminalId,
    runtimeTitles,
    navigateToWorkspace,
    presence: {
      focused: document.hasFocus(),
      visible: document.visibilityState === 'visible'
    } as Presence
  })
  latest.current.projects = projects
  latest.current.projectsLoaded = projectsLoaded
  latest.current.selectedTerminalId = selectedTerminalId
  latest.current.runtimeTitles = runtimeTitles
  latest.current.navigateToWorkspace = navigateToWorkspace
  const presentedSequences = useRef(new Map<string, number>())
  const pendingEvents = useRef(new Map<string, TerminalBellEvent>())
  const deliverEvent = useRef<(event: TerminalBellEvent) => void>(
    () => undefined
  )

  const acknowledgeSelectedTerminal = () => {
    const current = latest.current
    const terminalId = current.selectedTerminalId
    if (!terminalId || !current.presence.focused || !current.presence.visible) {
      return
    }

    const presentedSequence = presentedSequences.current.get(terminalId)
    if (presentedSequence !== undefined) {
      toast.dismiss(toastId(terminalId, presentedSequence))
    }

    const bell = terminalSessions.getBellSnapshot().get(terminalId)
    if (bell?.unread) {
      const context = findTerminalContext(
        current.projects,
        current.runtimeTitles,
        terminalId
      )
      void terminalSessions
        .acknowledgeBell(terminalId, bell.sequence)
        .catch((error: unknown) => {
          notifyError(error, {
            operation: context
              ? `acknowledge notification for terminal “${context.title}”`
              : 'acknowledge terminal notification'
          })
        })
    }
  }

  useEffect(() => {
    const updatePresence = () => {
      latest.current.presence = {
        focused: document.hasFocus(),
        visible: document.visibilityState === 'visible'
      }
      acknowledgeSelectedTerminal()
    }

    document.addEventListener('visibilitychange', updatePresence)
    window.addEventListener('focus', updatePresence)
    window.addEventListener('blur', updatePresence)
    return () => {
      document.removeEventListener('visibilitychange', updatePresence)
      window.removeEventListener('focus', updatePresence)
      window.removeEventListener('blur', updatePresence)
    }
  }, [])

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- Route and external bell-store changes are not child-owned UI events. */
  useEffect(() => {
    acknowledgeSelectedTerminal()
  }, [bells, selectedTerminalId])
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  useEffect(() => {
    const showToast = (
      context: TerminalContext,
      event: TerminalBellEvent,
      retry = false
    ) => {
      const previousSequence = presentedSequences.current.get(event.terminalId)
      presentedSequences.current.set(event.terminalId, event.sequence)
      if (
        previousSequence !== undefined &&
        previousSequence !== event.sequence
      ) {
        toast.dismiss(toastId(event.terminalId, previousSequence))
      }

      const id = toastId(event.terminalId, event.sequence)
      const description = `${context.projectName} · ${context.worktreeName}`
      toast.custom(
        () => (
          <div className="w-(--width) max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-zinc-900 p-3.5 text-zinc-100">
            <p className="m-0 truncate text-sm font-medium">{context.title}</p>
            <div className="flex flex-col gap-0.5">
              <p className="m-0 truncate text-sm text-zinc-400">
                {description}
              </p>
              {retry ? (
                <p className="m-0 text-sm text-amber-300">
                  Couldn’t dismiss this notification.
                </p>
              ) : null}
              <div className="flex justify-end gap-1.5 pt-2.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    toast.dismiss(id)
                    void terminalSessions
                      .acknowledgeBell(event.terminalId, event.sequence)
                      .catch((error: unknown) => {
                        notifyError(error, {
                          operation: `dismiss notification for terminal “${context.title}”`
                        })
                        const currentBell = terminalSessions
                          .getBellSnapshot()
                          .get(event.terminalId)
                        const currentContext = findTerminalContext(
                          latest.current.projects,
                          latest.current.runtimeTitles,
                          event.terminalId
                        )
                        if (
                          currentBell?.unread &&
                          currentBell.sequence === event.sequence &&
                          currentContext
                        ) {
                          showToast(currentContext, event, true)
                        }
                      })
                  }}
                >
                  {retry ? 'Try again' : 'Dismiss'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    toast.dismiss(id)
                    const target = targetForTerminal(
                      latest.current.projects,
                      context.terminal
                    )
                    if (target) {
                      void latest.current.navigateToWorkspace(target)
                    }
                  }}
                >
                  View
                </Button>
              </div>
            </div>
          </div>
        ),
        {
          id,
          duration: Infinity,
          dismissible: true,
          onDismiss: () => {
            if (
              presentedSequences.current.get(event.terminalId) ===
              event.sequence
            ) {
              presentedSequences.current.delete(event.terminalId)
            }
          }
        }
      )
    }

    const deliver = (event: TerminalBellEvent) => {
      const current = latest.current
      const context = findTerminalContext(
        current.projects,
        terminalSessions.getTitleSnapshot(),
        event.terminalId
      )
      if (!context) {
        if (!current.projectsLoaded) {
          pendingEvents.current.set(event.terminalId, event)
        }

        return
      }

      pendingEvents.current.delete(event.terminalId)
      const activelyViewed =
        current.selectedTerminalId === event.terminalId &&
        current.presence.focused &&
        current.presence.visible
      if (activelyViewed) {
        void terminalSessions
          .acknowledgeBell(event.terminalId, event.sequence)
          .catch((error: unknown) => {
            notifyError(error, {
              operation: `acknowledge notification for terminal “${context.title}”`
            })
          })
        return
      }

      showToast(context, event)
      void window.treeportDesktop?.requestAttention()
    }

    deliverEvent.current = deliver
    const unsubscribe = terminalSessions.subscribeBellEvents(deliver)
    return () => {
      deliverEvent.current = () => undefined
      unsubscribe()
    }
  }, [])

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- Loaded project metadata synchronizes pending external bell events. */
  useEffect(() => {
    if (!projectsLoaded) {
      return
    }

    for (const event of pendingEvents.current.values()) {
      const bell = bells.get(event.terminalId)
      if (bell?.unread && bell.sequence === event.sequence) {
        deliverEvent.current(event)
      } else {
        pendingEvents.current.delete(event.terminalId)
      }
    }
  }, [bells, projectsLoaded])
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  return null
}
