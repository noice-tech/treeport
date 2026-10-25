import { useEffect, useRef } from 'react'
import type { ProjectRecord } from '@treeport/shared'
import {
  terminalSessions,
  type TerminalAttentionEvent
} from '../../terminal-session'
import { useTerminalAttentionMetadata } from '../../terminal-runtime-metadata-react'
import { notifyError } from './error-notifications'

type Presence = {
  focused: boolean
  visible: boolean
}

function terminalTitle(
  projects: ProjectRecord[],
  runtimeTitles: ReadonlyMap<string, string>,
  terminalId: string
): string | null {
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const terminal = worktree.terminals.find(
        (candidate) => candidate.id === terminalId
      )

      if (terminal) {
        return runtimeTitles.get(terminalId) ?? terminal.name
      }
    }
  }

  return null
}

export function TerminalAttention({
  projects,
  selectedTerminalId
}: {
  projects: ProjectRecord[]
  selectedTerminalId: string | null
}) {
  const { attention, titles } = useTerminalAttentionMetadata()

  const latest = useRef({
    projects,
    selectedTerminalId,
    titles,
    // SAFETY: The component contract supplies the asserted browser value used here.
    presence: {
      focused: document.hasFocus(),
      visible: document.visibilityState === 'visible'
    } as Presence
  })

  latest.current.projects = projects
  latest.current.selectedTerminalId = selectedTerminalId
  latest.current.titles = titles

  const acknowledgeSelectedTerminal = () => {
    const current = latest.current
    const terminalId = current.selectedTerminalId

    if (!terminalId || !current.presence.focused || !current.presence.visible) {
      return
    }

    const attention = terminalSessions
      .getAttentionMetadataSnapshot()
      .get(terminalId)

    if (!attention?.unread) {
      return
    }

    const title = terminalTitle(current.projects, current.titles, terminalId)
    void terminalSessions
      .acknowledgeAttention(terminalId, attention.sequence)
      .catch((error) => {
        notifyError(error, {
          operation: title
            ? `acknowledge notification for terminal “${title}”`
            : 'acknowledge terminal notification'
        })
      })
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

  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- Route and external attention-store changes are not child-owned UI events. */
  useEffect(() => {
    acknowledgeSelectedTerminal()
  }, [attention, selectedTerminalId])
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  useEffect(() => {
    const handleAttention = (event: TerminalAttentionEvent) => {
      const current = latest.current

      const activelyViewed =
        current.selectedTerminalId === event.terminalId &&
        current.presence.focused &&
        current.presence.visible

      if (activelyViewed) {
        const title = terminalTitle(
          current.projects,
          terminalSessions.getTitleSnapshot(),
          event.terminalId
        )

        void terminalSessions
          .acknowledgeAttention(event.terminalId, event.sequence)
          .catch((error) => {
            notifyError(error, {
              operation: title
                ? `acknowledge notification for terminal “${title}”`
                : 'acknowledge terminal notification'
            })
          })

        return
      }

      void window.treeportDesktop?.requestAttention?.()
    }

    return terminalSessions.subscribeAttentionEvents(handleAttention)
  }, [])

  return null
}
