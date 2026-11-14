import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  CheckIcon,
  CircleAlertIcon,
  CircleIcon,
  LoaderCircleIcon
} from 'lucide-react'
import type { LocalServerUpdate } from '../desktop-contract'
import { Button, cn } from './ui'

export function UpdateChip({
  computerId,
  label,
  update,
  align,
  open,
  onOpenChange
}: {
  computerId: string | null
  label: string | null
  update: LocalServerUpdate
  align: 'center' | 'end'
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const status =
    update.status === 'running'
      ? 'Updating Treeport'
      : update.status === 'updated'
        ? 'Treeport is updated'
        : 'Treeport couldn’t update'

  const title = label ? `${status} on ${label}` : status

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="xs"
          title={title}
          className={cn(
            'pointer-events-auto px-2 [-webkit-app-region:no-drag]',
            update.status === 'running' &&
              'bg-accent-500/12 text-zinc-300 hover:bg-accent-500/18',
            update.status === 'updated' &&
              'bg-status-done/12 text-status-done hover:bg-status-done/18 hover:text-status-done',
            update.status === 'failed' &&
              'bg-status-error/14 text-status-error hover:bg-status-error/20 hover:text-status-error'
          )}
        >
          {update.status === 'running' ? (
            <LoaderCircleIcon className="stroke-accent-400 motion-safe:animate-spin" />
          ) : update.status === 'updated' ? (
            <CheckIcon />
          ) : (
            <CircleAlertIcon />
          )}
          <span>
            {label ? `${label} · ` : null}
            {update.status === 'running'
              ? 'Updating…'
              : update.status === 'updated'
                ? 'Updated'
                : 'Update failed'}
          </span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align={align}
          sideOffset={2}
          collisionPadding={4}
          className="flex w-72 max-w-[calc(100vw-0.5rem)] flex-col gap-2 rounded-lg bg-zinc-900 p-2.5 text-zinc-200 shadow-xl ring-1 ring-white/10 outline-none"
          aria-label={title}
        >
          <div>
            <div className="text-[0.8125rem] font-medium text-zinc-100">
              {title}
            </div>
            {update.commits ? (
              <div className="text-xs text-zinc-500">
                {update.commits} new commit{update.commits === 1 ? '' : 's'}
              </div>
            ) : null}
          </div>
          {update.steps.length > 0 ? (
            <ol className="flex flex-col gap-1 text-xs">
              {update.steps.map((step) => (
                <li
                  key={step.label}
                  className={cn(
                    'flex items-center gap-2',
                    step.status === 'pending' && 'text-zinc-500',
                    step.status === 'done' && 'text-zinc-300',
                    step.status === 'running' && 'text-zinc-100',
                    step.status === 'failed' && 'text-status-error'
                  )}
                >
                  {step.status === 'done' ? (
                    <CheckIcon className="size-3.5 shrink-0 stroke-status-done" />
                  ) : step.status === 'running' ? (
                    <LoaderCircleIcon className="size-3.5 shrink-0 stroke-accent-400 motion-safe:animate-spin" />
                  ) : step.status === 'failed' ? (
                    <CircleAlertIcon className="size-3.5 shrink-0" />
                  ) : (
                    <CircleIcon className="size-3.5 shrink-0 stroke-zinc-600" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{step.label}</span>
                  {step.seconds === null ? null : (
                    <span className="text-zinc-500 tabular-nums">
                      {step.seconds}s
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : null}
          {update.error ? (
            <div className="text-xs text-zinc-300">{update.error}</div>
          ) : null}
          {update.output.length > 0 ? (
            <pre className="max-h-32 overflow-auto rounded-md bg-zinc-950 p-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-zinc-400 [overflow-wrap:anywhere]">
              {update.output.join('\n')}
            </pre>
          ) : null}
          <div className="flex justify-end gap-1.5 border-t border-white/8 pt-2">
            <Button
              size="xs"
              onClick={() =>
                void window.treeportShell.showUpdateLog(computerId)
              }
            >
              Show Log
            </Button>
            {update.status === 'running' ? null : (
              <Button
                size="xs"
                onClick={() => {
                  onOpenChange(false)
                  void window.treeportShell.dismissUpdate(computerId)
                }}
              >
                Dismiss
              </Button>
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
