import { useRef, useState, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PlusIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  ArrowLeftIcon,
  CheckIcon
} from '@heroicons/react/16/solid'
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline'
import {
  TERMINAL_NAME_MAX_LENGTH,
  launcherInputNames,
  type Launcher
} from '@treeport/shared'
import { parseResponse, rpc } from '../../api'
import { formatCommandLine, parseCommandLine } from '../../command-line'
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
import { Button, buttonVariants } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { Empty, EmptyTitle } from '../../components/ui/empty'
import { FormField } from '../../components/ui/form-field'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '../../components/ui/tooltip'
import { cn } from '../../lib/utils'
import { launchersQueryKey } from '../../project-metadata'
import { notifyError } from '../notifications/error-notifications'

type LauncherValues = {
  name: string
  command: string
  treeTitle: string
  closeOnSuccess: boolean
}

type Draft = {
  editingId: string | null
  loadedUpdatedAt: string | null
  values: LauncherValues
  savedValues: LauncherValues
}

export function LaunchersManager({
  launchers,
  loading,
  loadError,
  onRetry,
  onClose,
  restoreFocusTo
}: {
  launchers: Launcher[]
  loading: boolean
  loadError: boolean
  onRetry: () => void
  onClose: () => void
  restoreFocusTo: RefObject<HTMLElement | null>
}) {
  const queryClient = useQueryClient()
  const nameInput = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [treeTitleError, setTreeTitleError] = useState<string | null>(null)
  const [newInputName, setNewInputName] = useState<string | null>(null)

  const normalizedNewInputName = (newInputName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')

  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Launcher | null>(null)

  const selected = launchers.find(
    (launcher) => launcher.id === draft?.editingId
  )

  const dirty =
    draft !== null &&
    (draft.values.name !== draft.savedValues.name ||
      draft.values.command !== draft.savedValues.command ||
      draft.values.treeTitle !== draft.savedValues.treeTitle ||
      draft.values.closeOnSuccess !== draft.savedValues.closeOnSuccess)

  const stale =
    draft?.editingId != null && selected?.updatedAt !== draft.loadedUpdatedAt

  const commandArgv = draft ? parseCommandLine(draft.values.command).argv : null

  const treeTitleArgv = draft
    ? parseCommandLine(draft.values.treeTitle).argv
    : null

  const inputNames = launcherInputNames([
    ...(commandArgv?.slice(1) ?? []),
    ...(treeTitleArgv?.slice(1) ?? [])
  ])

  const loadLauncher = (launcher: Launcher | null) => {
    const values = {
      name: launcher?.name ?? '',
      command: launcher
        ? formatCommandLine([launcher.executable, ...launcher.args])
        : '',
      treeTitle: launcher?.treeTitle
        ? formatCommandLine([
            launcher.treeTitle.executable,
            ...launcher.treeTitle.args
          ])
        : '',
      closeOnSuccess: launcher?.closeOnSuccess ?? false
    }

    setDraft({
      editingId: launcher?.id ?? null,
      loadedUpdatedAt: launcher?.updatedAt ?? null,
      values,
      savedValues: values
    })
    setCommandError(null)
    setTreeTitleError(null)
    setNewInputName(null)
  }

  const requestAction = (action: () => void) => {
    if (busy) {
      return
    }

    if (dirty) {
      setPendingAction(() => action)
    } else {
      action()
    }
  }

  const saveLauncher = useMutation({
    mutationFn: ({
      launcherId,
      input,
      expectedUpdatedAt
    }: {
      launcherId: string | null
      input: Pick<
        Launcher,
        'name' | 'executable' | 'args' | 'closeOnSuccess' | 'treeTitle'
      >
      expectedUpdatedAt: string | null
    }) =>
      launcherId
        ? parseResponse(
            rpc.api['launchers'][':launcherId'].$patch({
              param: { launcherId },
              json: { ...input, expectedUpdatedAt: expectedUpdatedAt! }
            })
          ).then((result) => result.launcher)
        : parseResponse(rpc.api['launchers'].$post({ json: input })).then(
            (result) => result.launcher
          ),
    onSuccess: (launcher, variables) => {
      queryClient.setQueryData<Launcher[]>(launchersQueryKey, (current) =>
        variables.launcherId
          ? current?.map((candidate) =>
              candidate.id === launcher.id ? launcher : candidate
            )
          : [...(current ?? []), launcher]
      )
      loadLauncher(launcher)
    },
    onError: (mutationError, { launcherId, input }) => {
      void queryClient.invalidateQueries({ queryKey: launchersQueryKey })
      notifyError(mutationError, {
        operation: `${launcherId ? 'update' : 'create'} launcher “${input.name}”`
      })
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: launchersQueryKey }),
        queryClient.invalidateQueries({
          queryKey: ['launcher-definitions']
        })
      ])
    }
  })

  const deleteLauncher = useMutation({
    mutationFn: (launcher: Launcher) =>
      parseResponse(
        rpc.api['launchers'][':launcherId'].$delete({
          param: { launcherId: launcher.id },
          json: { expectedUpdatedAt: launcher.updatedAt }
        })
      ),
    onSuccess: (_, deletedLauncher) => {
      queryClient.setQueryData<Launcher[]>(launchersQueryKey, (current) =>
        current?.filter((launcher) => launcher.id !== deletedLauncher.id)
      )
      setDraft(null)
    },
    onError: (mutationError, launcher) => {
      void queryClient.invalidateQueries({ queryKey: launchersQueryKey })
      notifyError(mutationError, {
        operation: `delete launcher “${launcher.name}”`
      })
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: launchersQueryKey }),
        queryClient.invalidateQueries({
          queryKey: ['launcher-definitions']
        })
      ])
    }
  })

  const busy = saveLauncher.isPending || deleteLauncher.isPending

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          requestAction(onClose)
        }
      }}
    >
      <DialogContent
        className="max-w-3xl shadow-none min-[701px]:[&>button:last-child]:top-5 min-[701px]:[&>button:last-child]:right-3.5"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">Launchers</DialogTitle>
          <DialogDescription className="text-base text-pretty sm:text-sm">
            Launchers saved here are available in every project. To share one
            with a repository, add it to <code>.treeport/settings.json</code>.{' '}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href="https://treeport.app/features/terminal-presets/#repository-presets"
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section
            className={cn(
              'flex min-w-0 flex-col md:pt-7',
              draft && 'max-md:hidden'
            )}
            aria-label="Saved launchers"
          >
            <div
              className="flex max-h-72 flex-col gap-0.5 overflow-y-auto md:max-h-96"
              aria-busy={loading}
            >
              <div className="flex flex-col gap-0.5">
                {launchers.map((launcher) => (
                  <button
                    key={launcher.id}
                    type="button"
                    className={cn(
                      'flex min-w-0 flex-col rounded-md px-3 py-1 text-left outline-none hover:bg-sidebar-accent active:bg-white/10 focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                      draft?.editingId === launcher.id && 'bg-sidebar-accent'
                    )}
                    aria-current={
                      draft?.editingId === launcher.id ? 'true' : undefined
                    }
                    disabled={busy}
                    onClick={() => {
                      if (draft?.editingId !== launcher.id) {
                        requestAction(() => loadLauncher(launcher))
                      }
                    }}
                  >
                    <p className="w-full truncate text-base font-medium sm:text-sm">
                      {launcher.name}
                    </p>
                    <p className="w-full truncate font-mono text-base text-sidebar-foreground/60 sm:text-sm">
                      {formatCommandLine([
                        launcher.executable,
                        ...launcher.args
                      ])}
                    </p>
                  </button>
                ))}
              </div>
              {loading ? (
                <p
                  className="p-3 text-base text-pretty text-sidebar-foreground/60 sm:text-sm"
                  role="status"
                >
                  Loading…
                </p>
              ) : loadError ? (
                <Empty>
                  <EmptyTitle className="text-base sm:text-sm">
                    Could not load launchers
                  </EmptyTitle>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onRetry}
                  >
                    Retry
                  </Button>
                </Empty>
              ) : (
                launchers.length === 0 && (
                  <Empty>
                    <EmptyTitle className="text-base sm:text-sm">
                      No launchers yet
                    </EmptyTitle>
                  </Empty>
                )
              )}
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start max-[700px]:h-9"
                disabled={busy || loading || loadError}
                onClick={() =>
                  requestAction(() => {
                    loadLauncher(null)
                    nameInput.current?.focus()
                  })
                }
              >
                <PlusIcon data-icon="inline-start" /> New launcher
              </Button>
            </div>
          </section>
          {draft ? (
            <form
              className="flex min-w-0 flex-col gap-5 md:border-l md:border-sidebar-border md:pl-6"
              onSubmit={(event) => {
                event.preventDefault()

                if (busy || stale || !draft.values.name.trim()) {
                  return
                }

                const parsed = parseCommandLine(draft.values.command)

                if (parsed.argv === null || !parsed.argv[0]) {
                  setCommandError(parsed.error ?? 'Enter an executable name.')

                  return
                }

                const treeTitle = draft.values.treeTitle.trim()
                  ? parseCommandLine(draft.values.treeTitle)
                  : null

                if (treeTitle && treeTitle.argv === null) {
                  setTreeTitleError(treeTitle.error)

                  return
                }

                const [executable, ...args] = parsed.argv

                const [treeTitleExecutable, ...treeTitleArgs] =
                  treeTitle?.argv ?? []

                saveLauncher.mutate({
                  launcherId: draft.editingId,
                  input: {
                    name: draft.values.name.trim(),
                    executable: executable!,
                    args,
                    closeOnSuccess: draft.values.closeOnSuccess,
                    treeTitle: treeTitleExecutable
                      ? { executable: treeTitleExecutable, args: treeTitleArgs }
                      : null
                  },
                  expectedUpdatedAt: draft.loadedUpdatedAt
                })
              }}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start md:hidden"
                disabled={busy}
                onClick={() => requestAction(() => setDraft(null))}
              >
                <ArrowLeftIcon data-icon="inline-start" /> All launchers
              </Button>
              {stale && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 text-base text-sidebar-foreground/60 sm:text-sm"
                >
                  <p className="text-pretty">
                    {selected
                      ? 'Changed elsewhere. Reload or duplicate to keep your edits.'
                      : 'Deleted elsewhere. Duplicate to keep your edits.'}
                  </p>
                  {selected && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      onClick={() =>
                        requestAction(() => loadLauncher(selected))
                      }
                    >
                      Reload
                    </Button>
                  )}
                </div>
              )}
              <FormField>
                <Label htmlFor="launcher-name">Name</Label>
                <Input
                  ref={nameInput}
                  id="launcher-name"
                  name="launcher-name"
                  autoComplete="off"
                  className="max-[700px]:h-9"
                  value={draft.values.name}
                  maxLength={TERMINAL_NAME_MAX_LENGTH}
                  disabled={busy}
                  required
                  autoFocus
                  placeholder="Dev server"
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      values: { ...draft.values, name: event.target.value }
                    })
                  }}
                />
              </FormField>
              <FormField>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="launcher-command">Command</Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-sidebar-ring"
                        aria-label="Shell syntax"
                      >
                        <QuestionMarkCircleIcon className="size-4 shrink-0 stroke-zinc-500" />
                        <span className="touch-target" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      align="start"
                      className="max-w-xs text-sm font-normal"
                    >
                      <p className="text-pretty">
                        For pipes or &amp;&amp;, use an explicit shell:
                      </p>
                      <p className="pt-1 font-mono">
                        sh -c 'pnpm build &amp;&amp; pnpm start'
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Input
                  id="launcher-command"
                  name="launcher-command"
                  className="font-mono max-[700px]:h-9"
                  value={draft.values.command}
                  disabled={busy}
                  required
                  placeholder="pnpm dev"
                  aria-invalid={commandError ? true : undefined}
                  aria-describedby={
                    commandError
                      ? 'launcher-command-inputs launcher-command-error'
                      : 'launcher-command-inputs'
                  }
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      values: { ...draft.values, command: event.target.value }
                    })
                    setCommandError(null)
                  }}
                />
                <div className="flex items-start justify-between gap-3">
                  <p
                    id="launcher-command-inputs"
                    className="text-base text-pretty text-sidebar-foreground/60 sm:text-sm"
                  >
                    {inputNames.length ? (
                      <>
                        Asks for{' '}
                        {inputNames.map((inputName) => (
                          <span
                            key={inputName}
                            className="mr-1 inline-flex rounded-md bg-accent-400/10 px-1.5 font-mono text-accent-200 ring-1 ring-accent-400/25"
                          >
                            {inputName}
                          </span>
                        ))}
                        when launched.
                      </>
                    ) : (
                      <>
                        Write <code className="font-mono">{'${name}'}</code> in
                        an argument to ask for it when launched.
                      </>
                    )}
                  </p>
                  {newInputName === null ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      aria-label="Add input"
                      disabled={busy || !commandArgv}
                      onClick={() => setNewInputName('')}
                    >
                      <PlusIcon data-icon="inline-start" /> Input
                    </Button>
                  ) : null}
                </div>
                {newInputName !== null && (
                  <div className="flex items-center gap-2">
                    <Input
                      id="launcher-new-input"
                      name="launcher-new-input"
                      aria-label="Input name"
                      autoComplete="off"
                      autoFocus
                      className="font-mono max-[700px]:h-9"
                      placeholder="prompt"
                      value={newInputName}
                      disabled={busy}
                      onChange={(event) => setNewInputName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          event.currentTarget.parentElement
                            ?.querySelector<HTMLButtonElement>(
                              '[data-add-input]'
                            )
                            ?.click()
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="max-[700px]:h-9"
                      data-add-input
                      disabled={
                        busy ||
                        !/^[a-z][a-z0-9_]*$/.test(normalizedNewInputName) ||
                        inputNames.includes(normalizedNewInputName)
                      }
                      onClick={() => {
                        setDraft({
                          ...draft,
                          values: {
                            ...draft.values,
                            command: `${draft.values.command.trimEnd()} \${${normalizedNewInputName}}`
                          }
                        })
                        setNewInputName(null)
                        setCommandError(null)
                      }}
                    >
                      Add
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="max-[700px]:h-9"
                      onClick={() => setNewInputName(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
                {commandError && (
                  <p
                    id="launcher-command-error"
                    className="text-base text-pretty text-rose-300 sm:text-sm"
                    role="alert"
                  >
                    {commandError}
                  </p>
                )}
              </FormField>
              <FormField>
                <Label htmlFor="launcher-tree-title">Tree title command</Label>
                <Input
                  id="launcher-tree-title"
                  name="launcher-tree-title"
                  className="font-mono max-[700px]:h-9"
                  value={draft.values.treeTitle}
                  disabled={busy}
                  placeholder="Optional"
                  aria-invalid={treeTitleError ? true : undefined}
                  aria-describedby={
                    treeTitleError
                      ? 'launcher-tree-title-hint launcher-tree-title-error'
                      : 'launcher-tree-title-hint'
                  }
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      values: { ...draft.values, treeTitle: event.target.value }
                    })
                    setTreeTitleError(null)
                  }}
                />
                <p
                  id="launcher-tree-title-hint"
                  className="text-base text-pretty text-sidebar-foreground/60 sm:text-sm"
                >
                  Runs after a new tree starts. Its first output line becomes
                  the tree title. It can use the same inputs.
                </p>
                {treeTitleError && (
                  <p
                    id="launcher-tree-title-error"
                    className="text-base text-pretty text-rose-300 sm:text-sm"
                    role="alert"
                  >
                    {treeTitleError}
                  </p>
                )}
              </FormField>
              <label
                htmlFor="launcher-close-on-success"
                className="flex items-center gap-2.5 text-base sm:text-sm"
              >
                <span className="group inline-grid size-5 shrink-0 grid-cols-1 sm:size-4">
                  <input
                    type="checkbox"
                    id="launcher-close-on-success"
                    name="launcher-close-on-success"
                    className="col-start-1 row-start-1 size-full appearance-none rounded-sm border border-white/20 bg-zinc-950 checked:border-accent-400 checked:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:opacity-50 forced-colors:appearance-auto"
                    checked={draft.values.closeOnSuccess}
                    disabled={busy}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        values: {
                          ...draft.values,
                          closeOnSuccess: event.target.checked
                        }
                      })
                    }}
                  />
                  <CheckIcon
                    aria-hidden="true"
                    className="pointer-events-none col-start-1 row-start-1 size-4 place-self-center fill-zinc-950 group-not-has-checked:opacity-0"
                  />
                </span>
                Close on success
              </label>
              <div className="flex items-center justify-between gap-3 border-t border-sidebar-border pt-4">
                <div className="flex items-center gap-3">
                  {draft.editingId && (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="max-[700px]:size-9"
                            aria-label="Duplicate"
                            disabled={busy}
                            onClick={() => {
                              setDraft({
                                ...draft,
                                editingId: null,
                                loadedUpdatedAt: null,
                                values: {
                                  ...draft.values,
                                  name: `${draft.values.name.slice(0, TERMINAL_NAME_MAX_LENGTH - 5)} copy`
                                },
                                savedValues: {
                                  name: '',
                                  command: '',
                                  treeTitle: '',
                                  closeOnSuccess: false
                                }
                              })
                              nameInput.current?.focus()
                            }}
                          >
                            <DocumentDuplicateIcon data-icon="inline-start" />
                            <span
                              className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                              aria-hidden="true"
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Duplicate</TooltipContent>
                      </Tooltip>
                      {selected && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="max-[700px]:size-9"
                              aria-label="Delete"
                              disabled={busy}
                              onClick={() => setDeleteTarget(selected)}
                            >
                              <TrashIcon data-icon="inline-start" />
                              <span
                                className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                                aria-hidden="true"
                              />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                      )}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {(dirty || !draft.editingId) && (
                    <Button
                      type="button"
                      variant="outline"
                      className="max-[700px]:h-9"
                      disabled={busy}
                      onClick={() => requestAction(() => setDraft(null))}
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    type="submit"
                    className="max-[700px]:h-9"
                    disabled={
                      busy ||
                      stale ||
                      !draft.values.name.trim() ||
                      !draft.values.command.trim() ||
                      (!!draft.editingId && !dirty)
                    }
                  >
                    {saveLauncher.isPending
                      ? 'Saving…'
                      : draft.editingId
                        ? 'Save'
                        : 'Create'}
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <Empty className="min-h-64 max-md:hidden md:border-l md:border-sidebar-border">
              <EmptyTitle className="text-base text-balance text-sidebar-foreground/60 sm:text-sm">
                {launchers.length ? 'Select a launcher' : 'Create a launcher'}
              </EmptyTitle>
            </Empty>
          )}
        </div>
        <AlertDialog
          open={pendingAction !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPendingAction(null)
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
              <AlertDialogDescription>
                Your edits will be lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  pendingAction?.()
                  setPendingAction(null)
                }}
              >
                Discard changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteTarget(null)
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete “{deleteTarget?.name}”?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This cannot be undone. Running terminals are not affected.
                {dirty && ' Your unsaved edits will also be discarded.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep launcher</AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: 'destructive' })}
                onClick={() => {
                  if (deleteTarget) {
                    deleteLauncher.mutate(deleteTarget)
                  }
                }}
              >
                Delete launcher
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
