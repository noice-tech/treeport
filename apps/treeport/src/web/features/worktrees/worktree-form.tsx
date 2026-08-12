import { useState } from 'react'
import type {
  ProjectRecord,
  TerminalPresetDefinition,
  TerminalPresetDefinitionDiagnostic
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
import { FormField } from '../../components/ui/form-field'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { NativeSelect } from '../../components/ui/native-select'
import { formatCommandLine } from '../../command-line'
import { terminalPresetProvenance } from '../../terminal-preset-definition'

const INITIAL_TERMINAL_PRESET_STORAGE_KEY = 'treeport-initial-terminal-preset'

export function WorktreeForm({
  project,
  presets,
  presetDiagnostics,
  presetsLoading,
  presetsError,
  onRetryPresets,
  busy,
  onSubmit
}: {
  project: ProjectRecord
  presets: TerminalPresetDefinition[]
  presetDiagnostics: TerminalPresetDefinitionDiagnostic[]
  presetsLoading: boolean
  presetsError: boolean
  onRetryPresets: () => void
  busy: boolean
  onSubmit: (
    name: string,
    base: 'default' | 'current',
    initialTerminal: {
      name: string
      argv?: string[]
      returnToShell?: boolean
    },
    sourceWorktreeId?: string
  ) => void
}) {
  const [name, setName] = useState('')
  const [baseValue, setBaseValue] = useState('default')
  const [initialPresetId, setInitialPresetId] = useState(() => {
    const stored = localStorage.getItem(INITIAL_TERMINAL_PRESET_STORAGE_KEY)

    return stored ?? 'shell'
  })
  const initialTerminalPresets = presets.filter(
    (preset) => !preset.closeOnSuccess
  )
  const initialPresetAvailable = initialTerminalPresets.some(
    (preset) => preset.id === initialPresetId
  )
  const initialPresetUnavailable =
    initialPresetId !== 'shell' && !initialPresetAvailable
  const waitingForInitialPreset = initialPresetUnavailable && presetsLoading
  const initialPresetMissing =
    initialPresetUnavailable && !presetsLoading && !presetsError
  const effectiveInitialPresetId =
    initialPresetUnavailable && !presetsLoading ? 'shell' : initialPresetId
  const base = baseValue === 'default' ? 'default' : 'current'
  return (
    <form
      className="flex flex-col gap-5"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault()
        const submittedName = name.trim()
        if (busy || !submittedName) {
          return
        }

        const selectedPreset = initialTerminalPresets.find(
          (preset) => preset.id === effectiveInitialPresetId
        )
        if (initialPresetMissing) {
          localStorage.setItem(INITIAL_TERMINAL_PRESET_STORAGE_KEY, 'shell')
        }

        onSubmit(
          submittedName,
          base,
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
      <FormField>
        <Label htmlFor="worktree-name">Name</Label>
        <Input
          id="worktree-name"
          name="worktree-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="feature-name"
          aria-label="Worktree name"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          disabled={busy}
        />
      </FormField>
      <FormField>
        <Label htmlFor="worktree-base">Start from</Label>
        <NativeSelect
          id="worktree-base"
          name="worktree-base"
          value={baseValue}
          onChange={(event) => setBaseValue(event.target.value)}
          disabled={busy}
        >
          <option value="default">
            {project.defaultBranch} · latest from origin
          </option>
          {project.worktrees.map((worktree) => (
            <option key={worktree.id} value={worktree.id}>
              {worktree.name} · current commit
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
          disabled={busy}
        >
          {waitingForInitialPreset && (
            <option value={initialPresetId}>Loading saved preset…</option>
          )}
          <option value="shell">Shell</option>
          {initialTerminalPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name} — {terminalPresetProvenance(preset)} —{' '}
              {formatCommandLine([preset.executable, ...preset.args])}
            </option>
          ))}
        </NativeSelect>
        {initialPresetMissing && (
          <p className="form-note" role="status">
            The selected preset cannot be used as an initial terminal. Initial
            terminal changed to Shell.
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
        {presetDiagnostics.map((diagnostic) => (
          <p
            key={`${diagnostic.path}:${diagnostic.itemId ?? 'file'}:${diagnostic.message}`}
            className="form-note"
            role="status"
          >
            {diagnostic.message}
          </p>
        ))}
      </FormField>
      <div className="flex items-center justify-between gap-4 pt-1">
        <p className="hidden text-xs text-zinc-600 sm:block">
          Press Enter to create
        </p>
        <Button
          type="submit"
          className="ml-auto"
          disabled={busy || waitingForInitialPreset || !name.trim()}
        >
          {busy ? 'Creating…' : 'Create worktree'}
        </Button>
      </div>
    </form>
  )
}
