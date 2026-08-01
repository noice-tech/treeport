import { useState } from 'react'
import {
  Cog6ToothIcon,
  CommandLineIcon,
  MagnifyingGlassIcon,
  WindowIcon
} from '@heroicons/react/16/solid'
import type { TerminalPreset, WebPanelContribution } from '@treeport/shared'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '../../components/ui/dialog'
import { formatCommandLine } from '../../command-line'
import type { CreateTerminalInput } from '../terminals/terminal-workspace'

export function NewPanelDialog({
  open,
  onOpenChange,
  restoreFocusTo,
  worktreeName,
  presets,
  presetsLoading,
  presetsError,
  contributions,
  contributionsLoading,
  contributionsError,
  launchDisabled,
  onCreateTerminal,
  onCreateWebPanel,
  onManagePresets
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  worktreeName: string | null
  presets: TerminalPreset[]
  presetsLoading: boolean
  presetsError: boolean
  contributions: WebPanelContribution[]
  contributionsLoading: boolean
  contributionsError: boolean
  launchDisabled: boolean
  onCreateTerminal: (input: CreateTerminalInput) => void
  onCreateWebPanel: (contribution: WebPanelContribution) => void
  onManagePresets: () => void
}) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const showShell = 'shell'.includes(normalizedQuery)
  const filteredPresets = presets.filter((preset) =>
    [
      preset.name,
      preset.executable,
      formatCommandLine([preset.executable, ...preset.args])
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )
  const filteredContributions = contributions.filter((contribution) =>
    [contribution.title, contribution.extensionId].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    )
  )
  const terminalActionCount = filteredPresets.length + (showShell ? 1 : 0)
  const noResults =
    terminalActionCount === 0 && filteredContributions.length === 0

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setQuery('')
          setSelectedIndex(0)
        }

        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden rounded-xl bg-zinc-800/95 p-0 shadow-2xl ring-white/15 backdrop-blur-2xl max-[700px]:p-0 max-[700px]:pb-0 [&>button.absolute]:hidden"
        mobilePresentation="dialog"
        overlayClassName="bg-transparent backdrop-blur-[1px]"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogTitle className="sr-only">New panel</DialogTitle>
        <DialogDescription className="sr-only">
          Search for a terminal or web panel to start
          {worktreeName ? ` in ${worktreeName}` : ''}.
        </DialogDescription>
        <div className="flex min-w-0 items-center gap-3 border-b border-white/8 px-4">
          <MagnifyingGlassIcon
            className="size-4 shrink-0 fill-zinc-400"
            aria-hidden="true"
          />
          <input
            type="search"
            name="panel-launcher-search"
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-zinc-50 outline-none placeholder:text-zinc-500 sm:h-12 sm:text-sm"
            value={query}
            autoComplete="off"
            autoFocus
            aria-label="Search panels"
            placeholder={
              worktreeName ? `New panel in ${worktreeName}` : 'New panel'
            }
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={(event) => {
              const actions = Array.from(
                event.currentTarget
                  .closest('[role="dialog"]')
                  ?.querySelectorAll<HTMLButtonElement>(
                    '[data-panel-launch]:not(:disabled)'
                  ) ?? []
              )
              if (actions.length === 0) {
                return
              }

              if (event.key === 'Enter') {
                event.preventDefault()
                actions[selectedIndex]?.click()
                return
              }

              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                return
              }

              event.preventDefault()
              const offset = event.key === 'ArrowDown' ? 1 : -1
              setSelectedIndex(
                (selectedIndex + offset + actions.length) % actions.length
              )
            }}
          />
          <kbd className="hidden shrink-0 rounded bg-white/6 px-1.5 py-0.5 font-sans text-[0.6875rem] text-zinc-500 ring-1 ring-white/8 sm:inline">
            esc
          </kbd>
        </div>
        <div
          className="max-h-[min(22rem,55dvh)] overflow-y-auto p-1.5 [scrollbar-color:var(--color-zinc-600)_transparent] [&_[data-selected]]:bg-white/8"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
              return
            }

            const actions = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[data-panel-launch]:not(:disabled)'
              )
            )
            const index = actions.indexOf(event.target as HTMLButtonElement)
            if (index < 0 || actions.length < 2) {
              return
            }

            event.preventDefault()
            const offset = event.key === 'ArrowDown' ? 1 : -1
            actions[(index + offset + actions.length) % actions.length]?.focus()
          }}
        >
          <div role="group" aria-label="Terminals">
            {terminalActionCount > 0 || presetsLoading || presetsError ? (
              <p className="px-2 py-1 text-xs font-medium text-zinc-500">
                Terminals
              </p>
            ) : null}
            {showShell ? (
              <Button
                type="button"
                variant="ghost"
                className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                aria-label="Shell"
                data-panel-launch
                data-selected={selectedIndex === 0 ? '' : undefined}
                disabled={launchDisabled}
                onFocus={() => setSelectedIndex(0)}
                onMouseMove={() => setSelectedIndex(0)}
                onClick={() => {
                  setQuery('')
                  setSelectedIndex(0)
                  onCreateTerminal({ name: 'Shell' })
                }}
              >
                <CommandLineIcon
                  className="size-4 shrink-0 fill-zinc-400"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-left">Shell</span>
                <span className="shrink-0 text-zinc-500">Login shell</span>
              </Button>
            ) : null}
            {filteredPresets.map((preset, index) => {
              const actionIndex = index + (showShell ? 1 : 0)
              return (
                <Button
                  key={preset.id}
                  type="button"
                  variant="ghost"
                  className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                  aria-label={preset.name}
                  data-panel-launch
                  data-selected={selectedIndex === actionIndex ? '' : undefined}
                  disabled={launchDisabled}
                  onFocus={() => setSelectedIndex(actionIndex)}
                  onMouseMove={() => setSelectedIndex(actionIndex)}
                  onClick={() => {
                    setQuery('')
                    setSelectedIndex(0)
                    onCreateTerminal({
                      name: preset.name,
                      argv: [preset.executable, ...preset.args],
                      ...(preset.closeOnSuccess
                        ? { closeOnSuccess: true }
                        : { returnToShell: true })
                    })
                  }}
                >
                  <CommandLineIcon
                    className="size-4 shrink-0 fill-zinc-400"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {preset.name}
                  </span>
                  <span className="min-w-0 max-w-1/2 truncate text-zinc-500">
                    {formatCommandLine([preset.executable, ...preset.args])}
                  </span>
                </Button>
              )
            })}
            {presetsLoading ? (
              <p
                className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                role="status"
              >
                Loading presets…
              </p>
            ) : null}
            {presetsError ? (
              <p
                className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                role="status"
              >
                Presets unavailable
              </p>
            ) : null}
          </div>
          <div role="group" aria-label="Web panels">
            {filteredContributions.length > 0 ||
            contributionsLoading ||
            contributionsError ? (
              <p className="mt-1 px-2 py-1 text-xs font-medium text-zinc-500">
                Web panels
              </p>
            ) : null}
            {filteredContributions.map((contribution, index) => {
              const actionIndex = terminalActionCount + index
              return (
                <Button
                  key={`${contribution.extensionId}:${contribution.contributionId}`}
                  type="button"
                  variant="ghost"
                  className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                  aria-label={`${contribution.title}, web panel`}
                  data-panel-launch
                  data-selected={selectedIndex === actionIndex ? '' : undefined}
                  disabled={launchDisabled}
                  onFocus={() => setSelectedIndex(actionIndex)}
                  onMouseMove={() => setSelectedIndex(actionIndex)}
                  onClick={() => {
                    setQuery('')
                    setSelectedIndex(0)
                    onCreateWebPanel(contribution)
                  }}
                >
                  <WindowIcon
                    className="size-4 shrink-0 fill-zinc-400"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {contribution.title}
                  </span>
                  <span className="min-w-0 max-w-1/2 truncate text-zinc-500">
                    {contribution.extensionId}
                  </span>
                </Button>
              )
            })}
            {contributionsLoading ? (
              <p
                className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                role="status"
              >
                Loading web panels…
              </p>
            ) : null}
            {contributionsError ? (
              <p
                className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                role="status"
              >
                Web panels unavailable
              </p>
            ) : null}
          </div>
          {noResults && !presetsLoading && !contributionsLoading ? (
            <p className="px-3 py-8 text-center text-base text-zinc-500 sm:text-sm">
              No matching panels.
            </p>
          ) : null}
        </div>
        <div className="border-t border-white/8 p-1.5">
          <Button
            type="button"
            variant="ghost"
            className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-400 hover:bg-white/8 hover:text-zinc-100 sm:h-9 sm:text-sm"
            onClick={() => {
              setQuery('')
              setSelectedIndex(0)
              onManagePresets()
            }}
          >
            <Cog6ToothIcon
              className="size-4 shrink-0 fill-zinc-500"
              aria-hidden="true"
            />
            <span>Manage presets</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
