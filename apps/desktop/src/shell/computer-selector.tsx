import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, Globe2Icon, MonitorIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ComputerActivity, DesktopShellState } from '../desktop-contract'
import { selectedComputer } from './shell-state'
import { Button, cn } from './ui'

export function ComputerSelector({
  state,
  open,
  onOpenChange,
  onConnect,
  onManage,
  onOpenOnPhone
}: {
  state: DesktopShellState
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnect: () => void
  onManage: () => void
  onOpenOnPhone: () => void
}) {
  const [activity, setActivity] = useState<ComputerActivity[]>([])

  const computerOrigins = JSON.stringify(
    state.computers.map(({ id, origin }) => [id, origin])
  )

  useEffect(() => {
    if (!open || computerOrigins === '[]') {
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = async () => {
      const result = await window.treeportShell
        .computerActivity()
        .catch(() => [])

      if (!cancelled) {
        setActivity(result)
        timer = setTimeout(() => void refresh(), 5_000)
      }
    }

    void refresh()

    return () => {
      cancelled = true

      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }, [open, computerOrigins])

  const selected = selectedComputer(state)
  const label = selected?.name ?? 'Connect to a computer'
  const localLabel = state.platform === 'darwin' ? 'This Mac' : 'This computer'

  const computers = [
    ...state.computers.filter((computer) => computer.loopback),
    ...state.computers.filter((computer) => !computer.loopback)
  ]

  const trigger = (
    <Button
      variant="ghost"
      size="xs"
      title={label}
      aria-label={
        selected
          ? `${selected.loopback ? localLabel : 'Remote computer'}: ${selected.name}`
          : label
      }
      className="pointer-events-auto max-w-[min(16rem,calc(100vw-9rem))] pr-2 pl-1.5 text-zinc-300 hover:text-zinc-100 [-webkit-app-region:no-drag]"
      onClick={state.computers.length === 0 ? onConnect : undefined}
    >
      {selected && !selected.loopback ? (
        <Globe2Icon data-icon="inline-start" />
      ) : (
        <MonitorIcon data-icon="inline-start" />
      )}
      <span className="truncate">{label}</span>
    </Button>
  )

  if (state.computers.length === 0) {
    return trigger
  }

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align={state.platform === 'darwin' ? 'end' : 'center'}
          sideOffset={2}
          collisionPadding={4}
          className="flex max-h-[calc(100dvh-2.25rem)] w-72 max-w-[calc(100vw-0.5rem)] flex-col gap-1 overflow-y-auto rounded-lg bg-zinc-900 p-1.5 text-zinc-200 shadow-xl ring-1 ring-white/10 outline-none [scrollbar-color:var(--color-zinc-700)_transparent]"
          aria-label="Computers"
        >
          <DropdownMenu.RadioGroup
            value={state.selectedComputerId ?? ''}
            onValueChange={(id) => void window.treeportShell.selectComputer(id)}
          >
            {computers.map((computer) => {
              const observation = activity.find(
                (item) =>
                  item.id === computer.id && item.origin === computer.origin
              )

              const counts = observation?.activity

              const status = counts?.needsAttention
                ? 'Needs attention'
                : counts?.working
                  ? 'Working'
                  : null

              const iconClassName = cn(
                'size-4 shrink-0',
                status === 'Working' && 'motion-safe:animate-pulse',
                status === 'Needs attention'
                  ? 'stroke-amber-300'
                  : status === 'Working'
                    ? 'stroke-accent-400'
                    : 'stroke-zinc-400'
              )

              return (
                <DropdownMenu.RadioItem
                  key={computer.id}
                  value={computer.id}
                  title={status ?? undefined}
                  aria-label={
                    status
                      ? `${computer.name}, ${computer.origin}, ${status}`
                      : undefined
                  }
                  className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-zinc-200 outline-none data-[highlighted]:bg-white/8"
                >
                  {computer.loopback ? (
                    <MonitorIcon aria-hidden="true" className={iconClassName} />
                  ) : (
                    <Globe2Icon aria-hidden="true" className={iconClassName} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.8125rem] font-medium text-zinc-100">
                      {computer.name}
                    </div>
                    <div
                      className="truncate text-xs text-zinc-500"
                      title={
                        computer.origin.length > 'https://127.0.0.1:8733'.length
                          ? computer.origin
                          : undefined
                      }
                    >
                      {computer.origin}
                    </div>
                  </div>
                  <DropdownMenu.ItemIndicator>
                    <CheckIcon className="size-4 shrink-0 stroke-accent-300" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              )
            })}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="h-px shrink-0 bg-white/8" />
          <DropdownMenu.Group>
            <DropdownMenu.Item
              className="flex h-8 cursor-pointer items-center rounded-md px-2.5 text-sm text-zinc-400 outline-none data-[highlighted]:bg-white/6 data-[highlighted]:text-zinc-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-45"
              disabled={!selected}
              onSelect={onOpenOnPhone}
            >
              Open on phone…
            </DropdownMenu.Item>
          </DropdownMenu.Group>
          <DropdownMenu.Separator className="h-px shrink-0 bg-white/8" />
          <DropdownMenu.Group>
            <DropdownMenu.Item
              className="flex h-8 cursor-pointer items-center rounded-md px-2.5 text-sm text-zinc-400 outline-none data-[highlighted]:bg-white/6 data-[highlighted]:text-zinc-100"
              onSelect={onConnect}
            >
              Connect to another computer…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="flex h-8 cursor-pointer items-center rounded-md px-2.5 text-sm text-zinc-400 outline-none data-[highlighted]:bg-white/6 data-[highlighted]:text-zinc-100"
              onSelect={onManage}
            >
              Manage computers…
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
