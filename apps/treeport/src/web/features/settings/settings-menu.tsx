import { useRef, useState } from 'react'
import { SettingsIcon } from 'lucide-react'
import { CheckIcon, CommandLineIcon } from '@heroicons/react/16/solid'
import type { TreeportTheme } from '@treeport/desktop-bridge'
import { Button } from '../../components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import { Separator } from '../../components/ui/separator'
import { useSidebar } from '../../components/ui/sidebar'
import { cn } from '../../lib/utils'
import { applyTheme, storedTheme } from './theme'

// Swatches preview each theme with fixed colors, independent of the active one.
const themes = [
  {
    id: 'tide',
    label: 'Tide',
    canvas: 'bg-[oklch(21.2%_0.016_261)]',
    panel: 'bg-[oklch(15.2%_0.013_262)]',
    accent: 'bg-[oklch(81%_0.115_232)]'
  },
  {
    id: 'moss',
    label: 'Moss',
    canvas: 'bg-[oklch(21.2%_0.01_163)]',
    panel: 'bg-[oklch(15.2%_0.008_165)]',
    accent: 'bg-[oklch(84%_0.13_152)]'
  }
] as const satisfies ReadonlyArray<
  { id: TreeportTheme } & Record<string, string>
>

export function SettingsMenu({
  onManageLaunchers
}: {
  onManageLaunchers: (trigger: HTMLElement) => void
}) {
  const { isMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState(storedTheme)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          size="icon"
          variant="ghost"
          className="icon-button text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
          aria-label="Settings"
        >
          <SettingsIcon />
          <span className="touch-target" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        portalled={!isMobile}
        className="grid w-60 gap-1.5 p-1.5"
        aria-label="Settings"
      >
        <h2 className="px-1.5 pt-1 text-xs font-medium text-zinc-500">Theme</h2>
        <div
          className="grid grid-cols-2 gap-1.5"
          role="radiogroup"
          aria-label="Theme"
        >
          {themes.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={theme === option.id}
              className="group/theme grid gap-1.5 rounded-md p-1.5 text-left outline-none hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-accent-400"
              onClick={() => {
                setTheme(option.id)
                applyTheme(option.id)
              }}
            >
              <span
                className={cn(
                  'relative h-11 overflow-hidden rounded-md ring-1 ring-white/10',
                  option.canvas,
                  theme === option.id && 'ring-2 ring-accent-400'
                )}
                aria-hidden="true"
              >
                <span
                  className={cn(
                    'absolute inset-y-1.5 right-1.5 left-6 rounded-sm',
                    option.panel
                  )}
                />
                <span
                  className={cn(
                    'absolute top-2.5 left-1.5 h-1 w-3 rounded-full',
                    option.accent
                  )}
                />
                <span className="absolute top-4.5 left-1.5 h-1 w-2.5 rounded-full bg-white/20" />
                <span className="absolute top-6.5 left-1.5 h-1 w-3 rounded-full bg-white/12" />
              </span>
              <span className="flex items-center justify-between px-0.5 text-sm text-zinc-200">
                {option.label}
                {theme === option.id ? (
                  <CheckIcon className="size-3.5 fill-accent-400" />
                ) : null}
              </span>
            </button>
          ))}
        </div>
        <Separator className="bg-white/8" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start font-normal text-zinc-300 hover:text-zinc-100 min-[701px]:h-7"
          onClick={(event) => {
            setOpen(false)
            onManageLaunchers(triggerRef.current ?? event.currentTarget)
          }}
        >
          <CommandLineIcon data-icon="inline-start" /> Manage launchers…
        </Button>
      </PopoverContent>
    </Popover>
  )
}
