import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, MonitorIcon } from 'lucide-react'
import type { DesktopShellState } from '../desktop-contract'
import { selectedComputer } from './shell-state'
import { Button } from './ui'

export function ComputerSelector({
  state,
  open,
  onOpenChange,
  onConnect,
  onManage
}: {
  state: DesktopShellState
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnect: () => void
  onManage: () => void
}) {
  const selected = selectedComputer(state)
  const label = selected?.name ?? 'Connect to a computer'
  const trigger = (
    <Button
      variant="ghost"
      size="xs"
      title={label}
      aria-label={selected ? `Connected computer: ${selected.name}` : label}
      className="pointer-events-auto max-w-[min(16rem,calc(100vw-1rem))] pr-2 pl-1.5 text-zinc-500 hover:text-zinc-100 [-webkit-app-region:no-drag]"
      onClick={state.computers.length === 0 ? onConnect : undefined}
    >
      <MonitorIcon data-icon="inline-start" />
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
          className="flex max-h-[calc(100dvh-2.25rem)] w-72 flex-col gap-1 overflow-y-auto rounded-lg bg-zinc-900 p-1.5 text-zinc-200 shadow-xl ring-1 ring-white/10 outline-none [scrollbar-color:var(--color-zinc-700)_transparent]"
          aria-label="Computers"
        >
          <DropdownMenu.Group>
            <DropdownMenu.RadioGroup
              value={state.selectedComputerId ?? ''}
              onValueChange={(id) =>
                void window.treeportShell.selectComputer(id)
              }
            >
              {state.computers.map((computer) => (
                <DropdownMenu.RadioItem
                  key={computer.id}
                  value={computer.id}
                  className="grid min-h-10 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left text-zinc-200 outline-none data-[highlighted]:bg-white/6 data-[state=checked]:bg-white/6"
                >
                  <div className="flex h-5 items-center justify-center">
                    <DropdownMenu.ItemIndicator>
                      <CheckIcon className="size-4 shrink-0 stroke-cyan-300" />
                    </DropdownMenu.ItemIndicator>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[0.8125rem] font-medium text-zinc-100">
                      {computer.name}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {computer.origin}
                    </div>
                  </div>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
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
