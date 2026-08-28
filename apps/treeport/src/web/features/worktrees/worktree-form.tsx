import { useState } from 'react'
import {
  TREE_CONTEXT_VALUE_MAX_LENGTH,
  type ProjectRecord,
  type TerminalPresetDefinition,
  type TerminalPresetDefinitionDiagnostic,
  type TreeContextFieldDefinition,
  type TreeContextFieldDiagnostic,
  type TreeContextValues
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
import { FormField } from '../../components/ui/form-field'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { NativeSelect } from '../../components/ui/native-select'
import { Textarea } from '../../components/ui/textarea'
import {
  terminalPresetCommand,
  terminalPresetProvenance
} from '../../terminal-preset-definition'

const INITIAL_TERMINAL_PRESET_STORAGE_KEY = 'treeport-initial-terminal-preset'

export function WorktreeForm({
  project,
  presets,
  presetDiagnostics,
  presetsLoading,
  presetsError,
  onRetryPresets,
  contextFields,
  contextFieldDiagnostics,
  contextFieldsLoading,
  contextFieldsError,
  onRetryContextFields,
  busy,
  onSubmit
}: {
  project: ProjectRecord
  presets: TerminalPresetDefinition[]
  presetDiagnostics: TerminalPresetDefinitionDiagnostic[]
  presetsLoading: boolean
  presetsError: boolean
  onRetryPresets: () => void
  contextFields: TreeContextFieldDefinition[]
  contextFieldDiagnostics: TreeContextFieldDiagnostic[]
  contextFieldsLoading: boolean
  contextFieldsError: boolean
  onRetryContextFields: () => void
  busy: boolean
  onSubmit: (
    name: string,
    base: 'default' | 'current',
    initialTerminal: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ) => void
}) {
  const [name, setName] = useState('')
  const [baseValue, setBaseValue] = useState('default')
  const [treeContext, setTreeContext] = useState<TreeContextValues>({})
  const [initialPresetId, setInitialPresetId] = useState(() => {
    const stored = localStorage.getItem(INITIAL_TERMINAL_PRESET_STORAGE_KEY)

    return stored ?? 'shell'
  })
  const initialTerminalPresets = presets.filter(
    (preset): preset is TerminalPresetDefinition & { executable: string } =>
      !preset.closeOnSuccess &&
      preset.executable !== null &&
      preset.shellCommand === null
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

        const submittedContext = Object.fromEntries(
          contextFields.flatMap((field) => {
            const value = treeContext[field.id]?.trim()
            return value ? [[field.id, value]] : []
          })
        )
        onSubmit(
          submittedName,
          base,
          selectedPreset
            ? {
                name: selectedPreset.name,
                initialTitle: selectedPreset.name,
                argv: [selectedPreset.executable, ...selectedPreset.args],
                returnToShell: true
              }
            : { name: 'Shell' },
          base === 'current' ? baseValue : undefined,
          submittedContext
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
          aria-label="Tree name"
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
      {contextFields.map((field) => (
        <FormField key={field.id}>
          <Label htmlFor={`tree-context-${field.id}`}>{field.label}</Label>
          {field.input === 'textarea' ? (
            <Textarea
              id={`tree-context-${field.id}`}
              name={`tree-context-${field.id}`}
              value={treeContext[field.id] ?? ''}
              onChange={(event) =>
                setTreeContext((current) => ({
                  ...current,
                  [field.id]: event.target.value
                }))
              }
              maxLength={TREE_CONTEXT_VALUE_MAX_LENGTH}
              disabled={busy}
              rows={4}
            />
          ) : (
            <Input
              id={`tree-context-${field.id}`}
              name={`tree-context-${field.id}`}
              value={treeContext[field.id] ?? ''}
              onChange={(event) =>
                setTreeContext((current) => ({
                  ...current,
                  [field.id]: event.target.value
                }))
              }
              maxLength={TREE_CONTEXT_VALUE_MAX_LENGTH}
              disabled={busy}
            />
          )}
        </FormField>
      ))}
      {contextFieldsLoading && (
        <p className="form-note" role="status">
          Loading tree context fields…
        </p>
      )}
      {contextFieldsError && (
        <div className="flex items-center justify-between gap-3">
          <p className="form-note">
            Tree context fields could not be loaded. You can still create the
            tree.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRetryContextFields}
          >
            Retry
          </Button>
        </div>
      )}
      {contextFieldDiagnostics.map((diagnostic) => (
        <p
          key={`${diagnostic.scope}:${diagnostic.path}:${diagnostic.message}`}
          className="form-note"
          role="status"
        >
          {diagnostic.message}
        </p>
      ))}
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
              {terminalPresetCommand(preset)}
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
      <div className="flex items-center justify-end pt-1">
        <Button
          type="submit"
          disabled={
            busy ||
            contextFieldsLoading ||
            waitingForInitialPreset ||
            !name.trim()
          }
        >
          {busy ? 'Creating…' : 'Create tree'}
        </Button>
      </div>
    </form>
  )
}
