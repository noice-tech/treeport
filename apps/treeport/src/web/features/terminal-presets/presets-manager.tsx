import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PlusIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  ArrowLeftIcon,
  CheckIcon
} from '@heroicons/react/16/solid'
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline'
import { TERMINAL_NAME_MAX_LENGTH, type TerminalPreset } from '@treeport/shared'
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
import { terminalPresetsQueryKey } from '../../project-metadata'
import { notifyError } from '../notifications/error-notifications'

type PresetValues = { name: string; command: string; closeOnSuccess: boolean }
type Draft = {
  editingId: string | null
  loadedUpdatedAt: string | null
  values: PresetValues
  savedValues: PresetValues
}

export function TerminalPresetsManager({
  presets,
  loading,
  loadError,
  onRetry,
  onClose,
  restoreFocusTo
}: {
  presets: TerminalPreset[]
  loading: boolean
  loadError: boolean
  onRetry: () => void
  onClose: () => void
  restoreFocusTo: HTMLElement | null
}) {
  const queryClient = useQueryClient()
  const nameInput = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TerminalPreset | null>(null)
  const selected = presets.find((preset) => preset.id === draft?.editingId)
  const dirty =
    draft !== null &&
    (draft.values.name !== draft.savedValues.name ||
      draft.values.command !== draft.savedValues.command ||
      draft.values.closeOnSuccess !== draft.savedValues.closeOnSuccess)
  const stale =
    draft?.editingId != null && selected?.updatedAt !== draft.loadedUpdatedAt

  const loadPreset = (preset: TerminalPreset | null) => {
    const values = {
      name: preset?.name ?? '',
      command: preset
        ? formatCommandLine([preset.executable, ...preset.args])
        : '',
      closeOnSuccess: preset?.closeOnSuccess ?? false
    }
    setDraft({
      editingId: preset?.id ?? null,
      loadedUpdatedAt: preset?.updatedAt ?? null,
      values,
      savedValues: values
    })
    setCommandError(null)
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

  const savePreset = useMutation({
    mutationFn: ({
      presetId,
      input,
      expectedUpdatedAt
    }: {
      presetId: string | null
      input: Pick<
        TerminalPreset,
        'name' | 'executable' | 'args' | 'closeOnSuccess'
      >
      expectedUpdatedAt: string | null
    }) =>
      presetId
        ? parseResponse(
            rpc.api['terminal-presets'][':presetId'].$patch({
              param: { presetId },
              json: { ...input, expectedUpdatedAt: expectedUpdatedAt! }
            })
          ).then((result) => result.preset)
        : parseResponse(
            rpc.api['terminal-presets'].$post({ json: input })
          ).then((result) => result.preset),
    onSuccess: (preset, variables) => {
      queryClient.setQueryData<TerminalPreset[]>(
        terminalPresetsQueryKey,
        (current) =>
          variables.presetId
            ? current?.map((candidate) =>
                candidate.id === preset.id ? preset : candidate
              )
            : [...(current ?? []), preset]
      )
      loadPreset(preset)
    },
    onError: (mutationError, { presetId, input }) => {
      void queryClient.invalidateQueries({ queryKey: terminalPresetsQueryKey })
      notifyError(mutationError, {
        operation: `${presetId ? 'update' : 'create'} terminal preset “${input.name}”`
      })
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: terminalPresetsQueryKey }),
        queryClient.invalidateQueries({
          queryKey: ['terminal-preset-definitions']
        })
      ])
    }
  })

  const deletePreset = useMutation({
    mutationFn: (preset: TerminalPreset) =>
      parseResponse(
        rpc.api['terminal-presets'][':presetId'].$delete({
          param: { presetId: preset.id },
          json: { expectedUpdatedAt: preset.updatedAt }
        })
      ),
    onSuccess: (_, deletedPreset) => {
      queryClient.setQueryData<TerminalPreset[]>(
        terminalPresetsQueryKey,
        (current) => current?.filter((preset) => preset.id !== deletedPreset.id)
      )
      setDraft(null)
    },
    onError: (mutationError, preset) => {
      void queryClient.invalidateQueries({ queryKey: terminalPresetsQueryKey })
      notifyError(mutationError, {
        operation: `delete terminal preset “${preset.name}”`
      })
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: terminalPresetsQueryKey }),
        queryClient.invalidateQueries({
          queryKey: ['terminal-preset-definitions']
        })
      ])
    }
  })

  const busy = savePreset.isPending || deletePreset.isPending

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
          <DialogTitle className="text-base sm:text-lg">
            Terminal presets
          </DialogTitle>
          <DialogDescription className="sr-only">
            Manage commands available in every repository.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section
            className={cn(
              'flex min-w-0 flex-col md:pt-7',
              draft && 'max-md:hidden'
            )}
            aria-label="Saved presets"
          >
            <div
              className="flex max-h-72 flex-col gap-0.5 overflow-y-auto md:max-h-96"
              aria-busy={loading}
            >
              <div className="flex flex-col gap-0.5">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={cn(
                      'flex min-w-0 flex-col rounded-md px-3 py-1 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                      draft?.editingId === preset.id && 'bg-sidebar-accent'
                    )}
                    aria-current={
                      draft?.editingId === preset.id ? 'true' : undefined
                    }
                    disabled={busy}
                    onClick={() => {
                      if (draft?.editingId !== preset.id) {
                        requestAction(() => loadPreset(preset))
                      }
                    }}
                  >
                    <p className="w-full truncate text-base font-medium sm:text-sm">
                      {preset.name}
                    </p>
                    <p className="w-full truncate font-mono text-base text-sidebar-foreground/60 sm:text-sm">
                      {formatCommandLine([preset.executable, ...preset.args])}
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
                    Could not load presets
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
                presets.length === 0 && (
                  <Empty>
                    <EmptyTitle className="text-base sm:text-sm">
                      No presets yet
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
                    loadPreset(null)
                    nameInput.current?.focus()
                  })
                }
              >
                <PlusIcon data-icon="inline-start" /> New preset
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

                const [executable, ...args] = parsed.argv
                savePreset.mutate({
                  presetId: draft.editingId,
                  input: {
                    name: draft.values.name.trim(),
                    executable: executable!,
                    args,
                    closeOnSuccess: draft.values.closeOnSuccess
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
                <ArrowLeftIcon data-icon="inline-start" /> All presets
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
                      onClick={() => requestAction(() => loadPreset(selected))}
                    >
                      Reload
                    </Button>
                  )}
                </div>
              )}
              <FormField>
                <Label htmlFor="preset-name">Name</Label>
                <Input
                  ref={nameInput}
                  id="preset-name"
                  name="preset-name"
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
                  <Label htmlFor="preset-command">Command</Label>
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
                  id="preset-command"
                  name="preset-command"
                  className="font-mono max-[700px]:h-9"
                  value={draft.values.command}
                  disabled={busy}
                  required
                  placeholder="pnpm dev"
                  aria-invalid={commandError ? true : undefined}
                  aria-describedby={
                    commandError ? 'preset-command-error' : undefined
                  }
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      values: { ...draft.values, command: event.target.value }
                    })
                    setCommandError(null)
                  }}
                />
                {commandError && (
                  <p
                    id="preset-command-error"
                    className="text-base text-pretty text-rose-300 sm:text-sm"
                    role="alert"
                  >
                    {commandError}
                  </p>
                )}
              </FormField>
              <label
                htmlFor="preset-close-on-success"
                className="flex items-center gap-2.5 text-base sm:text-sm"
              >
                <span className="group inline-grid size-5 shrink-0 grid-cols-1 sm:size-4">
                  <input
                    type="checkbox"
                    id="preset-close-on-success"
                    name="preset-close-on-success"
                    className="col-start-1 row-start-1 size-full appearance-none rounded-sm border border-white/20 bg-zinc-950 checked:border-cyan-400 checked:bg-cyan-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 disabled:opacity-50 forced-colors:appearance-auto"
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
                    {savePreset.isPending
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
                {presets.length ? 'Select a preset' : 'Create a preset'}
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
              <AlertDialogCancel>Keep preset</AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: 'destructive' })}
                onClick={() => {
                  if (deleteTarget) {
                    deletePreset.mutate(deleteTarget)
                  }
                }}
              >
                Delete preset
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
