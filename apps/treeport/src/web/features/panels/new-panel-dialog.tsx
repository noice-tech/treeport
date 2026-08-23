import { useState } from 'react'
import {
  BookOpenIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  MagnifyingGlassIcon,
  WindowIcon
} from '@heroicons/react/16/solid'
import type {
  TerminalPresetDefinition,
  TerminalPresetDefinitionDiagnostic,
  WebPanelDefinition
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '../../components/ui/dialog'
import {
  terminalPresetCommand,
  terminalPresetProvenance
} from '../../terminal-preset-definition'
import type { CreateTerminalInput } from '../terminals/terminal-workspace'

export function NewPanelDialog({
  open,
  onOpenChange,
  restoreFocusTo,
  worktreeName,
  presets,
  presetDiagnostics,
  presetsLoading,
  presetsError,
  webPanelDefinitions,
  webPanelDefinitionsLoading,
  webPanelDefinitionsError,
  launchDisabled,
  onCreateTerminal,
  onCreateWebPanel,
  onManagePresets
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  worktreeName: string | null
  presets: TerminalPresetDefinition[]
  presetDiagnostics: TerminalPresetDefinitionDiagnostic[]
  presetsLoading: boolean
  presetsError: boolean
  webPanelDefinitions: WebPanelDefinition[]
  webPanelDefinitionsLoading: boolean
  webPanelDefinitionsError: boolean
  launchDisabled: boolean
  onCreateTerminal: (input: CreateTerminalInput) => void
  onCreateWebPanel: (definition: WebPanelDefinition) => void
  onManagePresets: () => void
}) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [permissionDefinition, setPermissionDefinition] =
    useState<WebPanelDefinition | null>(null)
  const permissionSource = permissionDefinition
    ? permissionDefinition.source.type === 'package'
      ? `${permissionDefinition.source.scope} package ${permissionDefinition.source.source}`
      : 'this project'
    : ''
  const permissionDescription = [
    permissionDefinition?.permissions.includes('host-browser')
      ? 'It will start an isolated browser on the Treeport daemon host. It can reach localhost, local network services, and internet sites available from that host.'
      : '',
    permissionDefinition?.permissions.includes('same-origin')
      ? "It will share Treeport's web origin. It can access Treeport browser storage, the Treeport page, and API routes available to this client."
      : ''
  ]
    .filter(Boolean)
    .join(' ')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const showShell = 'shell'.includes(normalizedQuery)
  const filteredPresets = presets.filter((preset) =>
    [
      preset.name,
      preset.executable ?? '',
      terminalPresetProvenance(preset),
      terminalPresetCommand(preset)
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )
  const filteredWebPanelDefinitions = webPanelDefinitions.filter((definition) =>
    [definition.title, definition.id].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    )
  )
  const terminalActionCount = filteredPresets.length + (showShell ? 1 : 0)
  const noResults =
    terminalActionCount === 0 && filteredWebPanelDefinitions.length === 0

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
            // SAFETY: The component contract supplies the asserted browser value used here.
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
            {terminalActionCount > 0 ||
            presetsLoading ||
            presetsError ||
            presetDiagnostics.length > 0 ? (
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
              const provenance = terminalPresetProvenance(preset)
              const command = terminalPresetCommand(preset)
              return (
                <Button
                  key={preset.id}
                  type="button"
                  variant="ghost"
                  className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                  aria-label={`${preset.name}, ${provenance}, ${command}`}
                  data-panel-launch
                  data-selected={selectedIndex === actionIndex ? '' : undefined}
                  disabled={launchDisabled}
                  onFocus={() => setSelectedIndex(actionIndex)}
                  onMouseMove={() => setSelectedIndex(actionIndex)}
                  onClick={() => {
                    setQuery('')
                    setSelectedIndex(0)
                    const input: CreateTerminalInput = {
                      name: preset.name
                    }
                    if (preset.shellCommand !== null) {
                      input.shellCommand = preset.shellCommand
                    } else if (preset.executable) {
                      input.argv = [preset.executable, ...preset.args]
                    } else {
                      return
                    }

                    if (preset.cwd) {
                      input.cwd = preset.cwd
                    }

                    if (Object.keys(preset.env).length) {
                      input.env = { ...preset.env }
                    }

                    if (preset.closeOnSuccess) {
                      input.closeOnSuccess = true
                    } else {
                      input.returnToShell = true
                    }

                    onCreateTerminal(input)
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
                    {provenance} · {command}
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
            {presetDiagnostics.map((diagnostic) => (
              <p
                key={`${diagnostic.path}:${diagnostic.itemId ?? 'file'}:${diagnostic.message}`}
                className="px-3 py-2 text-base text-amber-300 sm:text-sm"
                role="status"
              >
                {diagnostic.message}
              </p>
            ))}
          </div>
          <div role="group" aria-label="Web panels">
            {filteredWebPanelDefinitions.length > 0 ||
            webPanelDefinitionsLoading ||
            webPanelDefinitionsError ? (
              <p className="mt-1 px-2 py-1 text-xs font-medium text-zinc-500">
                Web panels
              </p>
            ) : null}
            {filteredWebPanelDefinitions.map((definition, index) => {
              const actionIndex = terminalActionCount + index
              return (
                <Button
                  key={definition.id}
                  type="button"
                  variant="ghost"
                  className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                  aria-label={`${definition.title}, web panel`}
                  data-panel-launch
                  data-selected={selectedIndex === actionIndex ? '' : undefined}
                  disabled={launchDisabled}
                  onFocus={() => setSelectedIndex(actionIndex)}
                  onMouseMove={() => setSelectedIndex(actionIndex)}
                  onClick={() => {
                    if (
                      definition.permissions.length > 0 &&
                      !definition.permissionsGranted
                    ) {
                      setPermissionDefinition(definition)
                      return
                    }

                    setQuery('')
                    setSelectedIndex(0)
                    onCreateWebPanel(definition)
                  }}
                >
                  <WindowIcon
                    className="size-4 shrink-0 fill-zinc-400"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {definition.title}
                  </span>
                  <span className="min-w-0 max-w-1/2 truncate text-zinc-500">
                    {definition.source.type === 'project'
                      ? 'Project'
                      : `${definition.source.scope === 'project' ? 'Project' : 'Global'} · ${definition.source.packageId}`}
                  </span>
                </Button>
              )
            })}
            {webPanelDefinitionsLoading ? (
              <p
                className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                role="status"
              >
                Loading web panels…
              </p>
            ) : null}
            {webPanelDefinitionsError ? (
              <p
                className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                role="status"
              >
                Web panels unavailable
              </p>
            ) : null}
          </div>
          {noResults && !presetsLoading && !webPanelDefinitionsLoading ? (
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
            <span>Manage global presets</span>
          </Button>
          <Button
            asChild
            variant="ghost"
            className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-400 hover:bg-white/8 hover:text-zinc-100 sm:h-9 sm:text-sm"
          >
            <a
              href="https://treeport.app/features/terminal-presets/#repository-presets"
              target="_blank"
              rel="noreferrer"
            >
              <BookOpenIcon
                className="size-4 shrink-0 fill-zinc-500"
                aria-hidden="true"
              />
              <span>Configure repository presets</span>
            </a>
          </Button>
        </div>
        <AlertDialog
          open={permissionDefinition !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setPermissionDefinition(null)
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Allow privileged panel access?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {`${permissionDefinition?.title ?? 'This panel'} is from ${permissionSource}. ${permissionDescription}`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const definition = permissionDefinition
                  setPermissionDefinition(null)
                  if (definition) {
                    setQuery('')
                    setSelectedIndex(0)
                    onCreateWebPanel(definition)
                  }
                }}
              >
                Allow and open
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
