import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BellIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectRecord, TerminalRecord } from '@tasktty/shared'
import {
  terminalSessions,
  type TerminalBellEvent,
  type TerminalBellMetadata
} from '../../terminal-session'
import {
  targetForTerminal,
  type WorkspaceTarget
} from '../../workspace-navigation'

const EMPTY_BELLS: ReadonlyMap<string, TerminalBellMetadata> = new Map()

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
  const pendingEvents = useRef(new Map<string, TerminalBellEvent>())
  const deliverEvent = useRef<(event: TerminalBellEvent) => void>(
    () => undefined
  )

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
                  showToast(currentContext, event, true)
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
          .catch((error: unknown) => latest.current.onError(error))
        return
      }

      showToast(context, event)
      window.taskttyDesktop?.requestAttention()
    }

    deliverEvent.current = deliver
    const unsubscribe = terminalSessions.subscribeBellEvents(deliver)
    return () => {
      deliverEvent.current = () => undefined
      unsubscribe()
    }
  }, [])

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

  useEffect(() => {
    for (const [terminalId, sequence] of presentedSequences.current) {
      const bell = bells.get(terminalId)
      const context = findTerminalContext(projects, runtimeTitles, terminalId)
      if (bell?.unread && bell.sequence === sequence && context) {
        continue
      }

      presentedSequences.current.delete(terminalId)
      toast.dismiss(toastId(terminalId, sequence))
    }
  }, [bells, projects, runtimeTitles])
}
