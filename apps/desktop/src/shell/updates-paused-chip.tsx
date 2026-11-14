import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { WifiOffIcon } from 'lucide-react'
import { Button } from './ui'

export function UpdatesPausedChip({
  align,
  open,
  onOpenChange
}: {
  align: 'center' | 'end'
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="xs"
          title="Can’t reach Treeport"
          className="pointer-events-auto bg-amber-500/12 px-2 text-amber-200 [-webkit-app-region:no-drag] hover:bg-amber-500/18 hover:text-amber-200"
        >
          <WifiOffIcon />
          <span>Offline</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align={align}
          sideOffset={2}
          collisionPadding={4}
          className="flex w-72 max-w-[calc(100vw-0.5rem)] flex-col gap-0.5 rounded-lg bg-zinc-900 p-2.5 text-zinc-200 shadow-xl ring-1 ring-white/10 outline-none"
          aria-label="Can’t reach Treeport"
        >
          <div className="text-[0.8125rem] font-medium text-zinc-100">
            Can’t reach Treeport
          </div>
          <div className="text-xs text-zinc-400">
            Project updates are paused. You’re seeing the last known state.
            Treeport keeps reconnecting in the background.
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
