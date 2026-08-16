import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, TrashIcon } from '@heroicons/react/16/solid'
import { TERMINAL_NAME_MAX_LENGTH, type TerminalPreset } from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { rpc } from '../../api'
import { formatCommandLine, parseCommandLine } from '../../command-line'
import { Button } from '../../components/ui/button'
import { Checkbox } from '../../components/ui/checkbox'
import { FormField } from '../../components/ui/form-field'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { cn } from '../../lib/utils'
import { terminalPresetsQueryKey } from '../../project-metadata'
import { notifyError } from '../notifications/error-notifications'

export function TerminalPresetsManager({
  presets,
  loading,
  loadError,
  onRetry
}: {
  presets: TerminalPreset[]
  loading: boolean
  loadError: boolean
  onRetry: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState({
    // SAFETY: The component contract supplies the asserted browser value used here.
    editingId: null as string | null,
    // SAFETY: The component contract supplies the asserted browser value used here.
    loadedUpdatedAt: null as string | null,
    name: '',
    command: '',
    closeOnSuccess: false,
    // SAFETY: The component contract supplies the asserted browser value used here.
    commandError: null as string | null,
    // SAFETY: The component contract supplies the asserted browser value used here.
    notice: null as string | null
  })
  const {
    editingId,
    loadedUpdatedAt,
    name,
    command,
    closeOnSuccess,
    commandError,
    notice
  } = draft

  const resetForm = () => {
    setDraft({
      editingId: null,
      loadedUpdatedAt: null,
      name: '',
      command: '',
      closeOnSuccess: false,
      commandError: null,
      notice: null
    })
  }

  if (editingId) {
    const preset = presets.find((candidate) => candidate.id === editingId)
    if (!preset) {
      setDraft({
        editingId: null,
        loadedUpdatedAt: null,
        name: '',
        command: '',
        closeOnSuccess: false,
        commandError: null,
        notice: 'That preset was deleted. You can create a new one.'
      })
    } else if (preset.updatedAt !== loadedUpdatedAt) {
      setDraft({
        editingId: preset.id,
        loadedUpdatedAt: preset.updatedAt,
        name: preset.name,
        command: formatCommandLine([preset.executable, ...preset.args]),
        closeOnSuccess: preset.closeOnSuccess,
        commandError: null,
        notice: loadedUpdatedAt
          ? 'This preset changed, so the latest saved values were loaded.'
          : notice
      })
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
      setDraft({
        editingId: preset.id,
        loadedUpdatedAt: preset.updatedAt,
        name: preset.name,
        command: formatCommandLine([preset.executable, ...preset.args]),
        closeOnSuccess: preset.closeOnSuccess,
        commandError: null,
        notice: 'Preset saved.'
      })
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
      if (editingId === deletedPreset.id) {
        setDraft({
          editingId: null,
          loadedUpdatedAt: null,
          name: '',
          command: '',
          closeOnSuccess: false,
          commandError: null,
          notice: 'Preset deleted.'
        })
      }
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
    <>
      <div className="grid min-h-0 gap-5 border-t border-white/8 pt-4 md:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.35fr)]">
        <section
          className="flex min-w-0 flex-col gap-2"
          aria-labelledby="saved-presets-title"
        >
          <div className="flex min-h-8 items-center justify-between gap-3">
            <h3
              id="saved-presets-title"
              className="text-sm font-medium text-zinc-200"
            >
              Presets
            </h3>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={resetForm}
            >
              <PlusIcon /> New
            </Button>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg bg-white/3 p-1 ring-1 ring-white/8 [scrollbar-color:var(--color-zinc-700)_transparent]">
            <div className="grid min-h-14 min-w-0 content-center gap-0.5 rounded-md px-3 py-2">
              <span className="truncate text-sm font-medium text-zinc-100">
                Shell
              </span>
              <span className="truncate text-xs text-zinc-500">
                Built in · login shell
              </span>
            </div>
            {presets.map((preset) => (
              <div
                key={preset.id}
                className={cn(
                  'group/preset flex min-h-14 items-center rounded-md px-1 transition-colors hover:bg-white/5',
                  editingId === preset.id && 'bg-white/7 hover:bg-white/7'
                )}
              >
                <button
                  type="button"
                  className="grid min-w-0 flex-1 cursor-pointer gap-0.5 rounded-sm px-2 py-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-cyan-400"
                  aria-current={editingId === preset.id ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => {
                    setDraft({
                      editingId: preset.id,
                      loadedUpdatedAt: preset.updatedAt,
                      name: preset.name,
                      command: formatCommandLine([
                        preset.executable,
                        ...preset.args
                      ]),
                      closeOnSuccess: preset.closeOnSuccess,
                      commandError: null,
                      notice: null
                    })
                  }}
                >
                  <span className="truncate text-sm font-medium text-zinc-100">
                    {preset.name}
                  </span>
                  <span className="truncate text-xs text-zinc-500">
                    {formatCommandLine([preset.executable, ...preset.args])}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="mr-1 size-11 shrink-0 hover:text-rose-300 min-[701px]:size-8 min-[701px]:opacity-0 min-[701px]:group-hover/preset:opacity-100 min-[701px]:focus-visible:opacity-100"
                  aria-label={`Delete ${preset.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(`Delete terminal preset “${preset.name}”?`)
                    ) {
                      deletePreset.mutate(preset)
                    }
                  }}
                >
                  <TrashIcon />
                </Button>
              </div>
            ))}
            {loading && (
              <p className="px-2.5 py-3 text-sm text-zinc-500" role="status">
                Loading presets…
              </p>
            )}
            {loadError && (
              <div className="flex items-center justify-between gap-3 px-2.5 py-3">
                <p className="text-sm text-zinc-400">Could not load presets.</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              </div>
            )}
          </div>
        </section>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            const parsed = parseCommandLine(command)
            if (parsed.argv === null) {
              setDraft((current) => ({
                ...current,
                commandError: parsed.error
              }))
              return
            }

            const [executable, ...args] = parsed.argv
            savePreset.mutate({
              presetId: editingId,
              input: {
                name,
                executable: executable!,
                args,
                closeOnSuccess
              },
              expectedUpdatedAt: loadedUpdatedAt
            })
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-zinc-200">
              Preset details
            </h3>
            {notice && (
              <span className="text-xs text-zinc-400" role="status">
                {notice}
              </span>
            )}
          </div>
          <FormField>
            <Label htmlFor="preset-name">Name</Label>
            <Input
              id="preset-name"
              name="preset-name"
              value={name}
              maxLength={TERMINAL_NAME_MAX_LENGTH}
              disabled={busy}
              autoFocus
              required
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                  notice: null
                }))
              }}
              placeholder="Code review"
            />
          </FormField>
          <FormField>
            <Label htmlFor="preset-command">Command</Label>
            <Input
              id="preset-command"
              name="preset-command"
              value={command}
              disabled={busy}
              required
              aria-invalid={commandError ? true : undefined}
              aria-describedby={
                commandError ? 'preset-command-error' : undefined
              }
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  command: event.target.value,
                  commandError: null,
                  notice: null
                }))
              }}
              placeholder="diff main --mode split"
            />
            {commandError && (
              <p
                id="preset-command-error"
                className="text-xs text-rose-300"
                role="alert"
              >
                {commandError}
              </p>
            )}
          </FormField>
          <FormField>
            <div className="flex items-start gap-2.5">
              <Checkbox
                id="preset-close-on-success"
                checked={closeOnSuccess}
                disabled={busy}
                onCheckedChange={(checked) => {
                  setDraft((current) => ({
                    ...current,
                    closeOnSuccess: checked === true,
                    notice: null
                  }))
                }}
              />
              <div className="grid gap-1">
                <Label htmlFor="preset-close-on-success">
                  Close on success
                </Label>
                <p className="form-note">
                  Use for one-off commands such as opening an editor. Failed
                  commands remain open for inspection.
                </p>
              </div>
            </div>
          </FormField>
          <Button
            type="submit"
            className="self-end"
            disabled={
              busy ||
              !name.trim() ||
              !command.trim() ||
              (editingId !== null && loadedUpdatedAt === null)
            }
          >
            {savePreset.isPending
              ? 'Saving…'
              : editingId
                ? 'Save changes'
                : 'Create preset'}
          </Button>
        </form>
      </div>
    </>
  )
}
