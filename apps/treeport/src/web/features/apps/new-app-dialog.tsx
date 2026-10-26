import { useState } from 'react'
import {
  Cog6ToothIcon,
  CommandLineIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon
} from '@heroicons/react/16/solid'
import {
  formatCommandLine,
  launcherInputNames,
  resolveLauncherArgs,
  type LauncherDefinition,
  type LauncherDefinitionDiagnostic,
  type WebAppDefinition
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
  launcherCommand,
  launcherDisambiguator,
  launcherInputLabel,
  launcherProvenance
} from '../../launcher-definition'
import { FilePasteTextarea } from '../../components/file-paste-textarea'
import { WebAppIcon } from '../web-apps/web-app-icon'
import type { CreateTerminalInput } from '../terminals/terminal-workspace'
import { describeWebAppPermissions } from '../web-apps/web-app-permissions'

export function NewAppDialog({
  open,
  onOpenChange,
  restoreFocusTo,
  worktreeName,
  launchers,
  launcherDiagnostics,
  launchersLoading,
  launchersError,
  webAppDefinitions,
  webAppDefinitionsLoading,
  webAppDefinitionsError,
  launchDisabled,
  onCreateTerminal,
  onCreateBrowserApp,
  onCreateWebApp,
  onManageLaunchers
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  worktreeName: string | null
  launchers: LauncherDefinition[]
  launcherDiagnostics: LauncherDefinitionDiagnostic[]
  launchersLoading: boolean
  launchersError: boolean
  webAppDefinitions: WebAppDefinition[]
  webAppDefinitionsLoading: boolean
  webAppDefinitionsError: boolean
  launchDisabled: boolean
  onCreateTerminal: (input: CreateTerminalInput) => void
  onCreateBrowserApp: () => void
  onCreateWebApp: (definition: WebAppDefinition) => void
  onManageLaunchers: () => void
}) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const [permissionDefinition, setPermissionDefinition] =
    useState<WebAppDefinition | null>(null)

  const [inputLauncher, setInputLauncher] = useState<LauncherDefinition | null>(
    null
  )

  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState(0)
  const inputNames = inputLauncher ? launcherInputNames(inputLauncher.args) : []

  const launch = (
    launcher: LauncherDefinition,
    values: Record<string, string>
  ) => {
    setQuery('')
    setSelectedIndex(0)
    setInputLauncher(null)
    setInputs({})

    const input: CreateTerminalInput = {
      name: launcher.name,
      initialTitle: launcher.name
    }

    if (launcher.shellCommand !== null) {
      input.command = launcher.shellCommand
    } else if (launcher.executable) {
      input.command = formatCommandLine([
        launcher.executable,
        ...resolveLauncherArgs(
          launcher.args,
          Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, value.trim()])
          )
        )
      ])
    } else {
      return
    }

    if (launcher.cwd) {
      input.cwd = launcher.cwd
    }

    if (Object.keys(launcher.env).length) {
      input.env = { ...launcher.env }
    }

    if (launcher.closeOnSuccess) {
      input.afterExit = 'closeOnSuccess'
    }

    onCreateTerminal(input)
  }

  const permissionSource = permissionDefinition
    ? permissionDefinition.source.type === 'package'
      ? `${permissionDefinition.source.scope} package ${permissionDefinition.source.source}`
      : 'this project'
    : ''

  const permissionDescription = describeWebAppPermissions(
    permissionDefinition?.permissions ?? []
  )

  const normalizedQuery = query.trim().toLocaleLowerCase()

  const showTerminal = ['terminal', 'shell'].some((keyword) =>
    keyword.includes(normalizedQuery)
  )

  const filteredLaunchers = launchers.filter((launcher) =>
    [
      launcher.name,
      launcher.executable ?? '',
      launcherProvenance(launcher),
      launcherCommand(launcher)
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )

  const showBrowser = 'browser'.includes(normalizedQuery)

  const filteredWebAppDefinitions = webAppDefinitions.filter((definition) =>
    [definition.title, definition.id].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    )
  )

  const browserIndex = showTerminal ? 1 : 0

  const appActionCount =
    browserIndex + (showBrowser ? 1 : 0) + filteredWebAppDefinitions.length

  const noResults = appActionCount === 0 && filteredLaunchers.length === 0

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setQuery('')
          setSelectedIndex(0)
          setInputLauncher(null)
          setInputs({})
        }

        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden rounded-xl bg-zinc-800/95 p-0 shadow-2xl ring-white/15 max-[700px]:p-0 max-[700px]:pb-0 [&>button.absolute]:hidden"
        mobilePresentation="dialog"
        overlayClassName="bg-transparent"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogTitle className="sr-only">New app</DialogTitle>
        <DialogDescription className="sr-only">
          Search for an app or launcher to start
          {worktreeName ? ` in ${worktreeName}` : ''}.
        </DialogDescription>
        {inputLauncher ? (
          <form
            className="flex flex-col gap-3 p-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault()

              if (!launchDisabled && uploads === 0) {
                launch(inputLauncher, inputs)
              }
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                event.currentTarget.requestSubmit()
              }
            }}
          >
            <p className="text-sm font-medium text-zinc-100">
              {inputLauncher.name}
              {worktreeName ? (
                <span className="font-normal text-zinc-500">
                  {` in ${worktreeName}`}
                </span>
              ) : null}
            </p>
            {inputNames.map((inputName, index) => {
              const id = `app-launcher-input-${inputName}`

              return (
                <div key={inputName} className="flex flex-col gap-1.5">
                  <label
                    htmlFor={id}
                    className="text-xs font-medium text-zinc-400"
                  >
                    {launcherInputLabel(inputName)}
                  </label>
                  <FilePasteTextarea
                    id={id}
                    value={inputs[inputName] ?? ''}
                    autoFocus={index === 0}
                    disabled={false}
                    onValueChange={(value) =>
                      setInputs((current) => ({
                        ...current,
                        [inputName]: value
                      }))
                    }
                    onUploadingChange={(uploading) =>
                      setUploads((current) => current + (uploading ? 1 : -1))
                    }
                  />
                </div>
              )
            })}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setInputLauncher(null)}
              >
                Back
              </Button>
              <Button type="submit" disabled={launchDisabled || uploads > 0}>
                Start
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-3 border-b border-white/8 px-4">
              <MagnifyingGlassIcon
                className="size-4 shrink-0 fill-zinc-400"
                aria-hidden="true"
              />
              <input
                type="search"
                name="app-launcher-search"
                className="h-14 min-w-0 flex-1 bg-transparent text-base text-zinc-50 outline-none placeholder:text-zinc-500 sm:h-12 sm:text-sm"
                value={query}
                autoComplete="off"
                autoFocus
                aria-label="Search apps"
                placeholder={
                  worktreeName ? `New app in ${worktreeName}` : 'New app'
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
                        '[data-app-launch]:not(:disabled)'
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
                    '[data-app-launch]:not(:disabled)'
                  )
                )

                const index =
                  event.target instanceof HTMLButtonElement
                    ? actions.indexOf(event.target)
                    : -1

                if (index < 0 || actions.length < 2) {
                  return
                }

                event.preventDefault()
                const offset = event.key === 'ArrowDown' ? 1 : -1
                actions[
                  (index + offset + actions.length) % actions.length
                ]?.focus()
              }}
            >
              <div role="group" aria-label="Apps">
                {appActionCount > 0 ||
                webAppDefinitionsLoading ||
                webAppDefinitionsError ? (
                  <p className="px-2 py-1 text-xs font-medium text-zinc-500">
                    Apps
                  </p>
                ) : null}
                {showTerminal ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                    aria-label="Terminal"
                    data-app-launch
                    data-selected={selectedIndex === 0 ? '' : undefined}
                    disabled={launchDisabled}
                    onFocus={() => setSelectedIndex(0)}
                    onMouseMove={() => setSelectedIndex(0)}
                    onClick={() => {
                      setQuery('')
                      setSelectedIndex(0)
                      onCreateTerminal({ name: 'Terminal' })
                    }}
                  >
                    <CommandLineIcon
                      className="size-4 shrink-0 fill-zinc-400"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-left">
                      Terminal
                    </span>
                  </Button>
                ) : null}
                {showBrowser ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                    aria-label="Browser, hosted browser"
                    data-app-launch
                    data-selected={
                      selectedIndex === browserIndex ? '' : undefined
                    }
                    disabled={launchDisabled}
                    onFocus={() => setSelectedIndex(browserIndex)}
                    onMouseMove={() => setSelectedIndex(browserIndex)}
                    onClick={() => {
                      setQuery('')
                      setSelectedIndex(0)
                      onCreateBrowserApp()
                    }}
                  >
                    <GlobeAltIcon aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      Browser
                    </span>
                    <span className="min-w-0 max-w-1/2 truncate text-zinc-500">
                      Runs on the daemon computer
                    </span>
                  </Button>
                ) : null}
                {filteredWebAppDefinitions.map((definition, index) => {
                  const actionIndex =
                    browserIndex + (showBrowser ? 1 : 0) + index

                  return (
                    <Button
                      key={definition.id}
                      type="button"
                      variant="ghost"
                      className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                      aria-label={`${definition.title}, web app`}
                      data-app-launch
                      data-selected={
                        selectedIndex === actionIndex ? '' : undefined
                      }
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
                        onCreateWebApp(definition)
                      }}
                    >
                      <WebAppIcon
                        icon={definition.icon}
                        className="fill-zinc-400"
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
                {webAppDefinitionsLoading ? (
                  <p
                    className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                    role="status"
                  >
                    Loading web apps…
                  </p>
                ) : null}
                {webAppDefinitionsError ? (
                  <p
                    className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                    role="status"
                  >
                    Web apps unavailable
                  </p>
                ) : null}
              </div>
              <div role="group" aria-label="Launchers">
                {filteredLaunchers.length > 0 ||
                launchersLoading ||
                launchersError ||
                launcherDiagnostics.length > 0 ? (
                  <p className="mt-1 px-2 py-1 text-xs font-medium text-zinc-500">
                    Launchers
                  </p>
                ) : null}
                {filteredLaunchers.map((launcher, index) => {
                  const actionIndex = appActionCount + index

                  const disambiguator = launcherDisambiguator(
                    launcher,
                    launchers
                  )

                  return (
                    <Button
                      key={launcher.id}
                      type="button"
                      variant="ghost"
                      className="h-12 w-full justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-base font-normal text-zinc-100 hover:bg-white/8 focus-visible:bg-white/8 sm:h-9 sm:text-sm"
                      aria-label={
                        disambiguator
                          ? `${launcher.name}, ${disambiguator}`
                          : launcher.name
                      }
                      data-app-launch
                      data-selected={
                        selectedIndex === actionIndex ? '' : undefined
                      }
                      disabled={launchDisabled}
                      onFocus={() => setSelectedIndex(actionIndex)}
                      onMouseMove={() => setSelectedIndex(actionIndex)}
                      onClick={() => {
                        if (
                          launcher.shellCommand === null &&
                          launcherInputNames(launcher.args).length > 0
                        ) {
                          setInputLauncher(launcher)

                          return
                        }

                        launch(launcher, {})
                      }}
                    >
                      <CommandLineIcon
                        className="size-4 shrink-0 fill-zinc-400"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {launcher.name}
                      </span>
                      {disambiguator ? (
                        <span className="min-w-0 max-w-1/2 truncate text-zinc-500">
                          {disambiguator}
                        </span>
                      ) : null}
                    </Button>
                  )
                })}
                {launchersLoading ? (
                  <p
                    className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                    role="status"
                  >
                    Loading launchers…
                  </p>
                ) : null}
                {launchersError ? (
                  <p
                    className="px-3 py-2 text-base text-zinc-500 sm:text-sm"
                    role="status"
                  >
                    Launchers unavailable
                  </p>
                ) : null}
                {launcherDiagnostics.map((diagnostic) => (
                  <p
                    key={`${diagnostic.path}:${diagnostic.itemId ?? 'file'}:${diagnostic.message}`}
                    className="px-3 py-2 text-base text-amber-300 sm:text-sm"
                    role="status"
                  >
                    {diagnostic.message}
                  </p>
                ))}
              </div>
              {noResults && !launchersLoading && !webAppDefinitionsLoading ? (
                <p className="px-3 py-8 text-center text-base text-zinc-500 sm:text-sm">
                  No matching apps.
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
                  onManageLaunchers()
                }}
              >
                <Cog6ToothIcon
                  className="size-4 shrink-0 fill-zinc-500"
                  aria-hidden="true"
                />
                <span>Manage launchers</span>
              </Button>
            </div>
          </>
        )}
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
              <AlertDialogTitle>Allow privileged app access?</AlertDialogTitle>
              <AlertDialogDescription>
                {`${permissionDefinition?.title ?? 'This app'} is from ${permissionSource}. ${permissionDescription}`}
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
                    onCreateWebApp(definition)
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
