import { useId, useRef, useState } from 'react'
import { SettingsIcon } from 'lucide-react'
import { CommandLineIcon } from '@heroicons/react/16/solid'
import { Button } from '../../components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import { Separator } from '../../components/ui/separator'
import { useSidebar } from '../../components/ui/sidebar'
import { cn } from '../../lib/utils'
import { ACCENT_PRESETS, applyTheme, storedTheme } from './theme'

// Previews keep each mode's own colors, independent of the active one, and
// show the chosen accent at that mode's accent-400 lightness.
const modePreviews = {
  light: {
    canvas: 'bg-[oklch(95.5%_0.006_253)]',
    panel: 'bg-[oklch(99%_0.003_250)] ring-1 ring-[oklch(20%_0.02_260/0.08)]',
    line: 'bg-[oklch(20%_0.02_260/0.2)]',
    accent: 'bg-[oklch(from_var(--accent-color)_54%_calc(c*1.22)_h)]'
  },
  dark: {
    canvas: 'bg-[oklch(21.2%_0.016_261)]',
    panel: 'bg-[oklch(15.2%_0.013_262)]',
    line: 'bg-[oklch(100%_0_0/0.2)]',
    accent: 'bg-(--accent-color)'
  }
}

export function SettingsMenu({
  onManageLaunchers
}: {
  onManageLaunchers: (trigger: HTMLElement) => void
}) {
  const { isMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState(storedTheme)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const id = useId()
  const update = (next: typeof theme) => {
    setTheme(next)
    applyTheme(next)
  }
  const customAccent = !ACCENT_PRESETS.some(
    (preset) => preset.color === theme.accent
  )

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
        className="grid w-60 gap-1 p-1.5"
        aria-label="Settings"
      >
        <div className="grid gap-2 p-1.5">
          <h2
            id={`${id}-theme`}
            className="text-base/6 font-medium text-zinc-200 min-[701px]:text-sm/6"
          >
            Theme
          </h2>
          <div
            className="grid grid-cols-3 gap-2"
            role="radiogroup"
            aria-labelledby={`${id}-theme`}
          >
            {(
              [
                { mode: 'light', label: 'Light' },
                { mode: 'dark', label: 'Dark' },
                { mode: 'auto', label: 'Auto' }
              ] as const
            ).map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={theme.mode === mode}
                className="group/mode grid gap-1.5 text-base text-zinc-400 outline-none hover:text-zinc-200 aria-checked:text-zinc-50 min-[701px]:text-sm"
                onClick={() => update({ ...theme, mode })}
              >
                <span
                  className="relative h-12 overflow-hidden rounded-md ring-1 ring-white/10 outline-offset-2 outline-accent-400 group-focus-visible/mode:outline-2 group-aria-checked/mode:outline-2 min-[701px]:h-10"
                  aria-hidden="true"
                >
                  {(['light', 'dark'] as const)
                    .filter((layer) => mode === 'auto' || mode === layer)
                    .map((layer) => (
                      <span
                        key={layer}
                        className={cn(
                          'absolute inset-0 flex gap-1 p-1',
                          modePreviews[layer].canvas,
                          mode === 'auto' &&
                            layer === 'dark' &&
                            '[clip-path:polygon(70%_0,100%_0,100%_100%,30%_100%)]'
                        )}
                      >
                        <span className="grid w-1/3 content-start gap-1 p-0.5">
                          <span
                            className={cn(
                              'h-1 rounded-full',
                              modePreviews[layer].accent
                            )}
                          />
                          <span
                            className={cn(
                              'h-1 w-3/4 rounded-full',
                              modePreviews[layer].line
                            )}
                          />
                          <span
                            className={cn(
                              'h-1 rounded-full opacity-60',
                              modePreviews[layer].line
                            )}
                          />
                        </span>
                        <span
                          className={cn(
                            'grid flex-1 content-start gap-1 rounded-sm p-1',
                            modePreviews[layer].panel
                          )}
                        >
                          <span
                            className={cn(
                              'h-1 w-1/2 rounded-full',
                              modePreviews[layer].line
                            )}
                          />
                          <span
                            className={cn(
                              'h-1 w-3/4 rounded-full opacity-60',
                              modePreviews[layer].line
                            )}
                          />
                        </span>
                      </span>
                    ))}
                </span>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-2 p-1.5 pt-0">
          <h2
            id={`${id}-accent`}
            className="text-base/6 font-medium text-zinc-200 min-[701px]:text-sm/6"
          >
            Accent
          </h2>
          <div
            className="flex items-center justify-between px-1 pb-1"
            role="radiogroup"
            aria-labelledby={`${id}-accent`}
          >
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.color}
                type="button"
                role="radio"
                aria-checked={theme.accent === preset.color}
                aria-label={preset.label}
                title={preset.label}
                className="relative size-6 rounded-full bg-current inset-ring inset-ring-white/15 outline-none ring-offset-2 ring-offset-zinc-900 focus-visible:ring-2 focus-visible:ring-accent-400 aria-checked:ring-2 aria-checked:ring-current min-[701px]:size-5"
                style={{ color: preset.color }}
                onClick={() => update({ ...theme, accent: preset.color })}
              >
                <span className="touch-target" aria-hidden="true" />
              </button>
            ))}
            <label
              title="Custom color"
              className={cn(
                'relative size-6 cursor-pointer rounded-full inset-ring inset-ring-white/15 ring-offset-2 ring-offset-zinc-900 has-focus-visible:ring-2 has-focus-visible:ring-accent-400 min-[701px]:size-5',
                customAccent
                  ? 'bg-current ring-2 ring-current'
                  : 'bg-[conic-gradient(oklch(80%_0.12_0),oklch(80%_0.12_120),oklch(80%_0.12_240),oklch(80%_0.12_360))]'
              )}
              style={{ color: theme.accent }}
            >
              <input
                type="color"
                name="accent"
                className="sr-only"
                aria-label="Custom accent color"
                value={theme.accent}
                onChange={(event) =>
                  update({ ...theme, accent: event.target.value })
                }
              />
              <span className="touch-target" aria-hidden="true" />
            </label>
          </div>
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
