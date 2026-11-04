import type { KeyboardEvent } from 'react'
import type { BrowserSelect } from '#protocol/browser'
import type { BrowserAppConnection } from '../../browser-session-client'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import { cn } from '../../lib/utils'

export function BrowserSelectPicker({
  request,
  anchor,
  connection,
  onClose
}: {
  request: BrowserSelect
  anchor: { left: number; top: number; width: number; height: number }
  connection: BrowserAppConnection
  onClose(): void
}) {
  const respond = (index: number | null) => {
    connection.send({
      type: 'selectResponse',
      requestId: request.requestId,
      index
    })
    onClose()
  }

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not(:disabled)'
      )
    ]

    const current = items.findIndex((item) => item === document.activeElement)

    const next =
      event.key === 'ArrowDown'
        ? Math.min(items.length - 1, current + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, current - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null

    if (next !== null) {
      event.preventDefault()
      items[next]?.focus()
    }
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          respond(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        {/* EXTERNAL: The anchor covers the page's select so a second click
            toggles the picker closed instead of reaching the page, where the
            select would reopen it. */}
        <div aria-hidden className="fixed z-50" style={anchor} />
      </PopoverTrigger>
      <PopoverContent
        sideOffset={2}
        collisionPadding={8}
        className="max-h-(--radix-popover-content-available-height) w-auto max-w-(--radix-popover-content-available-width) overflow-y-auto p-1"
        style={{ minWidth: anchor.width }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const list = event.currentTarget

          if (!(list instanceof HTMLElement)) {
            return
          }

          const option =
            list.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
            list.querySelector<HTMLButtonElement>(
              '[role="option"]:not(:disabled)'
            )

          option?.focus()
          option?.scrollIntoView({ block: 'nearest' })
        }}
      >
        <div role="listbox" onKeyDown={move}>
          {request.options.map((option, index) =>
            option.hidden ? null : (
              <div key={index}>
                {option.group !== null &&
                option.group !== request.options[index - 1]?.group ? (
                  <div className="px-2 pt-1.5 pb-0.5 text-xs font-semibold text-zinc-400">
                    {option.group}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === request.selectedIndex}
                  disabled={option.disabled}
                  className={cn(
                    'flex w-full rounded-sm px-2 py-1.5 text-left text-sm whitespace-pre outline-none focus:bg-white/10 disabled:text-zinc-500',
                    option.group !== null && 'pl-4',
                    index === request.selectedIndex && 'text-zinc-50'
                  )}
                  onClick={() => respond(index)}
                >
                  {option.label || ' '}
                </button>
              </div>
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
