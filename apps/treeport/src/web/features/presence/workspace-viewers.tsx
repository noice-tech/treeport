import { UsersIcon } from 'lucide-react'
import type {
  ViewerIdentity,
  WorkspacePresence,
  WorktreeRecord
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'

export function WorkspaceViewers({
  worktree,
  identity,
  viewers
}: {
  worktree: WorktreeRecord | null
  identity: ViewerIdentity | null
  viewers: readonly WorkspacePresence[]
}) {
  const people = new Map<string, WorkspacePresence[]>()
  if (worktree && identity) {
    for (const viewer of viewers) {
      if (
        viewer.worktreeId !== worktree.id ||
        (viewer.identity.source === identity.source &&
          viewer.identity.login === identity.login)
      ) {
        continue
      }

      const key = JSON.stringify([
        viewer.identity.source,
        viewer.identity.login
      ])
      const sessions = people.get(key) ?? []
      sessions.push(viewer)
      people.set(key, sessions)
    }
  }

  if (people.size === 0) {
    return null
  }

  const firstPerson = people.values().next().value![0]!.identity
  const summary =
    people.size === 1
      ? `${firstPerson.name ?? firstPerson.login ?? 'Local user'} is here`
      : `${people.size} other people are here`

  return (
    <div className="flex min-w-0 items-center border-b border-border px-2 py-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="max-w-full min-w-0"
            aria-label={`People in this workspace: ${summary}`}
          >
            <UsersIcon data-icon="inline-start" />
            <span className="truncate">{summary}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72" aria-label="People in this workspace">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">In this workspace</p>
            {[...people].map(([key, sessions]) => {
              const person = sessions[0]!.identity
              const locations = new Set(
                sessions.map((session) => {
                  if (!session.visible) {
                    return 'Open in background'
                  }

                  if (!session.focused) {
                    return 'Window not focused'
                  }

                  const panel = worktree?.panels.find(
                    (panel) => panel.id === session.focusedPanelId
                  )
                  return panel
                    ? `${panel.title} · focused`
                    : 'Viewing workspace'
                })
              )
              return (
                <div key={key} className="flex min-w-0 flex-col gap-1">
                  <p className="truncate text-sm font-medium">
                    {person.name ?? person.login ?? 'Local user'}
                  </p>
                  {[...locations].map((location) => (
                    <p key={location} className="text-xs text-muted-foreground">
                      {location}
                    </p>
                  ))}
                </div>
              )
            })}
            <p className="text-xs text-muted-foreground">
              Focus is reported by each browser. It does not indicate terminal
              control.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
