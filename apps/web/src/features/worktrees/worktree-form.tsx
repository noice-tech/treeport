import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectRecord, TerminalPreset } from '@tasktty/shared'
import { apiClient } from '../../api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { NativeSelect } from '../../components/ui/native-select'
import { cn } from '../../lib/utils'
import { FormField, ModalHeading } from '../dialogs/dialog-parts'

const INITIAL_TERMINAL_PRESET_STORAGE_KEY = 'tasktty-initial-terminal-preset'

export interface WorktreeDestination {
  name: string
  path: string
}

export function WorktreeForm({
  project,
  presets,
  presetsLoading,
  presetsError,
  onRetryPresets,
  busy,
  onSubmit
}: {
  project: ProjectRecord
  presets: TerminalPreset[]
  presetsLoading: boolean
  presetsError: boolean
  onRetryPresets: () => void
  busy: boolean
  onSubmit: (
    name: string,
    base: 'default' | 'current',
    destination: WorktreeDestination,
    initialTerminal: {
      name: string
      argv?: string[]
      returnToShell?: boolean
    },
    sourceWorktreeId?: string
  ) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [debouncedName, setDebouncedName] = useState('')
  const [resolvingSubmission, setResolvingSubmission] = useState(false)
  const [baseValue, setBaseValue] = useState('default')
  const [initialPresetId, setInitialPresetId] = useState(
    () => localStorage.getItem(INITIAL_TERMINAL_PRESET_STORAGE_KEY) ?? 'shell'
  )
  const initialPresetAvailable = presets.some(
    (preset) => preset.id === initialPresetId
  )
  const initialPresetUnavailable =
    initialPresetId !== 'shell' && !initialPresetAvailable
  const waitingForInitialPreset = initialPresetUnavailable && presetsLoading
  const initialPresetMissing =
    initialPresetUnavailable && !presetsLoading && !presetsError
  const effectiveInitialPresetId =
    initialPresetUnavailable && !presetsLoading ? 'shell' : initialPresetId
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedName(name), 250)
    return () => window.clearTimeout(timeout)
  }, [name])
  useEffect(() => {
    if (initialPresetMissing) {
      localStorage.setItem(INITIAL_TERMINAL_PRESET_STORAGE_KEY, 'shell')
    }
  }, [initialPresetMissing])
  const destinationQuery = useQuery({
    queryKey: ['worktree-destination', project.id, debouncedName],
    queryFn: () => apiClient.worktreeDestination(project.id, debouncedName),
    enabled: Boolean(debouncedName.trim()),
    placeholderData: (previous) => previous,
    retry: false
  })
  const base = baseValue === 'default' ? 'default' : 'current'
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy || resolvingSubmission) {
          return
        }

        const submittedName = String(
          new FormData(event.currentTarget).get('worktree-name') ?? ''
        )
        if (!submittedName.trim()) {
          return
        }

        setName(submittedName)
        setDebouncedName(submittedName)
        setResolvingSubmission(true)

        const readyDestination =
          submittedName === debouncedName &&
          !destinationQuery.isFetching &&
          !destinationQuery.isError
            ? destinationQuery.data
            : undefined
        let destination: WorktreeDestination
        if (readyDestination) {
          destination = readyDestination
        } else {
          try {
            destination = await queryClient.fetchQuery({
              queryKey: ['worktree-destination', project.id, submittedName],
              queryFn: () =>
                apiClient.worktreeDestination(project.id, submittedName),
              retry: false
            })
          } catch {
            setResolvingSubmission(false)
            return
          }
        }

        const selectedPreset = presets.find(
          (preset) => preset.id === effectiveInitialPresetId
        )
        onSubmit(
          submittedName,
          base,
          destination,
          selectedPreset
            ? {
                name: selectedPreset.name,
                argv: [selectedPreset.executable, ...selectedPreset.args],
                returnToShell: true
              }
            : { name: 'Shell' },
          base === 'current' ? baseValue : undefined
        )
      }}
    >
      <ModalHeading eyebrow={project.name} title="New worktree" />
      <FormField>
        <Label htmlFor="worktree-name">Name</Label>
        <Input
          id="worktree-name"
          name="worktree-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="investigate-cache"
          aria-label="Worktree name"
          required
          autoFocus
          data-modal-autofocus
          aria-invalid={destinationQuery.isError}
        />
      </FormField>
      <FormField>
        <Label htmlFor="worktree-base">Base</Label>
        <NativeSelect
          id="worktree-base"
          name="worktree-base"
          value={baseValue}
          onChange={(event) => setBaseValue(event.target.value)}
        >
          <option value="default">
            {project.defaultBranch} (latest from origin)
          </option>
          {project.worktrees
            .filter((worktree) => worktree.status === 'active')
            .map((worktree) => (
              <option key={worktree.id} value={worktree.id}>
                {worktree.name} (current commit)
              </option>
            ))}
        </NativeSelect>
      </FormField>
      <FormField>
        <Label htmlFor="initial-terminal-preset">Initial terminal</Label>
        <NativeSelect
          id="initial-terminal-preset"
          name="initial-terminal-preset"
          value={effectiveInitialPresetId}
          onChange={(event) => {
            setInitialPresetId(event.target.value)
            localStorage.setItem(
              INITIAL_TERMINAL_PRESET_STORAGE_KEY,
              event.target.value
            )
          }}
        >
          {waitingForInitialPreset && (
            <option value={initialPresetId}>Loading saved preset…</option>
          )}
          <option value="shell">Shell</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </NativeSelect>
        {initialPresetMissing && (
          <p className="form-note" role="status">
            The selected preset was deleted. Initial terminal changed to Shell.
          </p>
        )}
        {presetsLoading && (
          <p className="form-note" role="status">
            Loading terminal presets…
          </p>
        )}
        {presetsError && (
          <div className="flex items-center justify-between gap-3">
            <p className="form-note">
              Presets could not be loaded. Shell is still available.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRetryPresets}
            >
              Retry
            </Button>
          </div>
        )}
      </FormField>
      <p
        className={cn(
          'form-note min-h-5 truncate',
          destinationQuery.isError && 'text-rose-300'
        )}
        title={destinationQuery.data?.path}
        aria-live="polite"
      >
        {destinationQuery.data
          ? `Destination: ${destinationQuery.data.path}`
          : destinationQuery.error
            ? destinationQuery.error.message
            : name.trim()
              ? 'Resolving destination…'
              : 'Enter a name to preview the destination.'}
      </p>
      <Button
        type="submit"
        className="self-end"
        disabled={
          busy || resolvingSubmission || waitingForInitialPreset || !name.trim()
        }
      >
        {busy || resolvingSubmission ? 'Creating…' : 'Create worktree'}
      </Button>
    </form>
  )
}
