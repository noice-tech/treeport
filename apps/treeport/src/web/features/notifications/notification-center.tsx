import { useMemo, useState } from 'react'
import {
  terminalAttentionNotification,
  type ProjectRecord
} from '@treeport/shared'
import { BellIcon } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Empty, EmptyDescription, EmptyTitle } from '../../components/ui/empty'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import { terminalSessions } from '../../terminal-session'
import { useTerminalAttentionMetadata } from '../../terminal-runtime-metadata-react'
import {
  targetForTerminal,
  type WorkspaceTarget
} from '../../workspace-navigation'
import { notifyError } from './error-notifications'
import { PushNotificationControl } from './push-notification-control'

function formatTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()

  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  ).format(date)
}

export function NotificationCenter({
  projects,
  navigateToWorkspace,
  open,
  onOpenChange
}: {
  projects: ProjectRecord[]
  navigateToWorkspace: (
    target: WorkspaceTarget,
    replace?: boolean
  ) => Promise<void>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { attention, titles, activity } = useTerminalAttentionMetadata()
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  const notifications = useMemo(
    () =>
      projects
        .flatMap((project) =>
          project.worktrees.flatMap((worktree) =>
            worktree.terminals.flatMap((terminal) => {
              const entry = attention.get(terminal.id)
              const target = targetForTerminal(projects, terminal)

              return entry?.unread && target
                ? [
                    {
                      terminalId: terminal.id,
                      sequence: entry.sequence,
                      occurredAt: entry.at,
                      ...terminalAttentionNotification({
                        terminalTitle: titles.get(terminal.id) ?? terminal.name,
                        projectName: project.name,
                        reason: entry.reason,
                        activityMessage:
                          activity.get(terminal.id)?.message ?? null
                      }),
                      target
                    }
                  ]
                : []
            })
          )
        )
        .sort(
          (left, right) =>
            right.occurredAt.localeCompare(left.occurredAt) ||
            left.terminalId.localeCompare(right.terminalId)
        ),
    [activity, attention, projects, titles]
  )

  const count = notifications.length

  const label =
    count === 0
      ? 'Notifications, no unread notifications'
      : `Notifications, ${count} unread`

  const acknowledge = async (
    terminalId: string,
    sequence: number,
    title: string
  ): Promise<void> => {
    setPending((current) => new Set(current).add(terminalId))
    await terminalSessions
      .acknowledgeAttention(terminalId, sequence)
      .catch((error) => {
        notifyError(error, {
          operation: `mark notification for terminal “${title}” as read`
        })
      })
    setPending((current) => {
      const next = new Set(current)
      next.delete(terminalId)

      return next
    })
  }

  return (
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="icon-button text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
          aria-label={label}
        >
          <BellIcon />
          {count > 0 ? (
            <Badge
              size="counter"
              className="pointer-events-none absolute -top-0.5 -right-0.5 motion-safe:animate-badge-in"
              aria-hidden
            >
              {count > 99 ? '99+' : count}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-[min(26rem,calc(100dvh-1rem))] w-[min(22rem,calc(100vw-1rem))] animate-none! touch-manipulation flex-col overflow-hidden p-0 select-none"
        aria-label="Notifications"
      >
        <div className="shrink-0 px-3 pt-3 pb-2">
          <h2 className="text-sm font-semibold">Notifications</h2>
        </div>
        {notifications.length === 0 ? (
          <Empty className="min-h-28 p-4">
            <EmptyTitle>All caught up</EmptyTitle>
            <EmptyDescription>No unread notifications.</EmptyDescription>
          </Empty>
        ) : (
          <div className="min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
            <ul role="list" className="flex flex-col gap-0.5">
              {notifications.map((notification) => (
                <li key={notification.terminalId} className="min-w-0">
                  <button
                    type="button"
                    className="w-full min-w-0 cursor-default rounded-md px-2 py-2 text-left outline-none hover:bg-white/5 active:bg-white/10 focus-visible:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-45"
                    disabled={pending.has(notification.terminalId)}
                    aria-label={`Open ${notification.title}`}
                    onClick={() => {
                      onOpenChange(false)
                      void acknowledge(
                        notification.terminalId,
                        notification.sequence,
                        notification.title
                      )
                      void navigateToWorkspace(notification.target)
                    }}
                  >
                    <h3 className="truncate text-sm font-medium text-zinc-100">
                      {notification.title}
                    </h3>
                    <div className="flex min-w-0 items-baseline gap-1.5 text-xs text-zinc-500">
                      <p className="min-w-0 truncate">{notification.body}</p>
                      <span className="shrink-0" aria-hidden>
                        ·
                      </span>
                      <time
                        dateTime={notification.occurredAt}
                        className="shrink-0 tabular-nums"
                      >
                        {formatTime(notification.occurredAt)}
                      </time>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <PushNotificationControl />
      </PopoverContent>
    </Popover>
  )
}
