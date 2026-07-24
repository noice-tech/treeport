import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BellIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectRecord, TerminalRecord } from '@tasktty/shared'
import {
  terminalSessions,
  type TerminalBellEvent,
  type TerminalBellMetadata
} from '../../terminal-session.js'
import {
  targetForTerminal,
  type WorkspaceTarget
} from '../../workspace-navigation.js'

const EMPTY_BELLS: ReadonlyMap<string, TerminalBellMetadata> = new Map()

type BellAction = {
  type: 'view' | 'dismiss'
  terminalId: string
  sequence: number
}

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

function browserToastId(terminalId: string, sequence: number): string {
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

export function useBellNotifications({
  projects,
  projectsLoaded,
  selectedTerminalId,
  runtimeTitles,
  navigateToWorkspace,
  onError
}: {
  projects: ProjectRecord[]
  projectsLoaded: boolean
  selectedTerminalId: string | null
  runtimeTitles: ReadonlyMap<string, string>
  navigateToWorkspace: (
    target: WorkspaceTarget,
    replace?: boolean
  ) => Promise<void>
  onError: (error: unknown) => void
}) {
  const bells = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getBellSnapshot,
    () => EMPTY_BELLS
  )
  const [presence, setPresence] = useState<Presence>(() => ({
    focused: document.hasFocus(),
    visible: document.visibilityState === 'visible'
  }))
  const latest = useRef({
    projects,
    projectsLoaded,
    selectedTerminalId,
    runtimeTitles,
    navigateToWorkspace,
    onError,
    presence
  })
  latest.current = {
    projects,
    projectsLoaded,
    selectedTerminalId,
    runtimeTitles,
    navigateToWorkspace,
    onError,
    presence
  }
  const presentedSequences = useRef(new Map<string, number>())
  const pendingBellEvents = useRef(new Map<string, TerminalBellEvent>())
  const deliverBellEvent = useRef<(event: TerminalBellEvent) => void>(
    () => undefined
  )
  const pendingViewAction = useRef<BellAction | null>(null)

  useEffect(() => {
    const updatePresence = () => {
      const next = {
        focused: document.hasFocus(),
        visible: document.visibilityState === 'visible'
      }
      latest.current.presence = next
      setPresence((current) =>
        current.focused === next.focused && current.visible === next.visible
          ? current
          : next
      )
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

  useEffect(() => {
    if (!presence.focused || !presence.visible || !selectedTerminalId) {
      return
    }

    const bell = bells.get(selectedTerminalId)
    if (bell?.unread) {
      void terminalSessions
        .acknowledgeBell(selectedTerminalId, bell.sequence)
        .catch((error: unknown) => latest.current.onError(error))
    }
  }, [bells, presence.focused, presence.visible, selectedTerminalId])

  useEffect(() => {
    const showBrowserToast = (
      context: TerminalContext,
      event: TerminalBellEvent,
      retry = false
    ) => {
      const previousSequence = presentedSequences.current.get(event.terminalId)
      if (
        previousSequence !== undefined &&
        previousSequence !== event.sequence
      ) {
        toast.dismiss(browserToastId(event.terminalId, previousSequence))
      }

      const id = browserToastId(event.terminalId, event.sequence)
      presentedSequences.current.set(event.terminalId, event.sequence)
      toast(context.title, {
        id,
        icon: <BellIcon aria-hidden="true" />,
        description: retry
          ? `Couldn’t dismiss. Terminal bell · ${context.projectName} · ${context.worktreeName}`
          : `Terminal bell · ${context.projectName} · ${context.worktreeName}`,
        duration: Infinity,
        dismissible: true,
        action: {
          label: 'View',
          onClick: () => {
            presentedSequences.current.delete(event.terminalId)
            toast.dismiss(id)
            const target = targetForTerminal(
              latest.current.projects,
              context.terminal
            )
            if (target) {
              void latest.current.navigateToWorkspace(target)
            }
          }
        },
        cancel: {
          label: retry ? 'Try again' : 'Dismiss',
          onClick: () => {
            presentedSequences.current.delete(event.terminalId)
            toast.dismiss(id)
            void terminalSessions
              .acknowledgeBell(event.terminalId, event.sequence)
              .catch((error: unknown) => {
                latest.current.onError(error)
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
                  showBrowserToast(currentContext, event, true)
                }
              })
          }
        },
        onDismiss: () => {
          if (
            presentedSequences.current.get(event.terminalId) === event.sequence
          ) {
            presentedSequences.current.delete(event.terminalId)
          }
        }
      })
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
          pendingBellEvents.current.set(event.terminalId, event)
        } else {
          pendingBellEvents.current.delete(event.terminalId)
        }

        return
      }

      pendingBellEvents.current.delete(event.terminalId)
      const activelyViewed =
        current.selectedTerminalId === event.terminalId &&
        current.presence.focused &&
        current.presence.visible
      if (activelyViewed) {
        void terminalSessions
          .acknowledgeBell(event.terminalId, event.sequence)
          .catch((error: unknown) => latest.current.onError(error))
        return
      }

      if (window.taskttyDesktop) {
        presentedSequences.current.set(event.terminalId, event.sequence)
        window.taskttyDesktop.showBellNotification({
          terminalId: event.terminalId,
          sequence: event.sequence,
          title: context.title,
          projectName: context.projectName,
          worktreeName: context.worktreeName
        })
        return
      }

      if (current.presence.focused && current.presence.visible) {
        showBrowserToast(context, event)
      }
    }
    deliverBellEvent.current = deliver
    const unsubscribe = terminalSessions.subscribeBellEvents(deliver)
    return () => {
      deliverBellEvent.current = () => undefined
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!projectsLoaded) {
      return
    }

    for (const event of pendingBellEvents.current.values()) {
      const bell = bells.get(event.terminalId)
      if (bell?.unread && bell.sequence === event.sequence) {
        deliverBellEvent.current(event)
      } else {
        pendingBellEvents.current.delete(event.terminalId)
      }
    }
  }, [bells, projectsLoaded])

  useEffect(() => {
    for (const [terminalId, sequence] of presentedSequences.current) {
      const bell = bells.get(terminalId)
      const context = findTerminalContext(projects, runtimeTitles, terminalId)
      if (bell?.unread && bell.sequence === sequence && context) {
        continue
      }

      if (window.taskttyDesktop) {
        window.taskttyDesktop.clearBellNotification({ terminalId, sequence })
      } else {
        toast.dismiss(browserToastId(terminalId, sequence))
      }

      presentedSequences.current.delete(terminalId)
    }

    if (window.taskttyDesktop) {
      for (const [terminalId, bell] of bells) {
        if (!bell.unread) {
          window.taskttyDesktop.clearBellNotification({
            terminalId,
            sequence: bell.sequence
          })
        }
      }
    }
  }, [bells, projects, runtimeTitles])

  useEffect(() => {
    const desktop = window.taskttyDesktop
    if (!desktop) {
      return
    }

    const handleAction = (action: BellAction) => {
      if (action.type === 'dismiss') {
        void terminalSessions
          .acknowledgeBell(action.terminalId, action.sequence)
          .catch((error: unknown) => {
            latest.current.onError(error)
            const bell = terminalSessions
              .getBellSnapshot()
              .get(action.terminalId)
            const context = findTerminalContext(
              latest.current.projects,
              terminalSessions.getTitleSnapshot(),
              action.terminalId
            )
            if (bell?.unread && bell.sequence === action.sequence && context) {
              desktop.showBellNotification({
                terminalId: action.terminalId,
                sequence: action.sequence,
                title: context.title,
                projectName: context.projectName,
                worktreeName: context.worktreeName
              })
            }
          })
        return
      }

      const current = latest.current
      if (!current.projectsLoaded) {
        pendingViewAction.current = action
        return
      }

      const context = findTerminalContext(
        current.projects,
        current.runtimeTitles,
        action.terminalId
      )
      const target = context
        ? targetForTerminal(current.projects, context.terminal)
        : null
      if (target) {
        void current.navigateToWorkspace(target)
      } else {
        desktop.clearBellNotification({
          terminalId: action.terminalId,
          sequence: action.sequence
        })
      }
    }

    return desktop.onBellNotificationAction(handleAction)
  }, [])

  useEffect(() => {
    const action = pendingViewAction.current
    if (!projectsLoaded || !action) {
      return
    }

    pendingViewAction.current = null
    const context = findTerminalContext(
      projects,
      runtimeTitles,
      action.terminalId
    )
    const target = context
      ? targetForTerminal(projects, context.terminal)
      : null
    if (target) {
      void navigateToWorkspace(target)
    } else {
      window.taskttyDesktop?.clearBellNotification({
        terminalId: action.terminalId,
        sequence: action.sequence
      })
    }
  }, [navigateToWorkspace, projects, projectsLoaded, runtimeTitles])
}
