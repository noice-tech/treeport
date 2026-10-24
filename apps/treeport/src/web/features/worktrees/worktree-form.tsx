import { useRef, useState } from 'react'
import {
  availableTreeName,
  launcherInputNames,
  resolveLauncherArgs,
  type ProjectRecord,
  type LauncherDefinition,
  type LauncherDefinitionDiagnostic
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
import { FormField } from '../../components/ui/form-field'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { NativeSelect } from '../../components/ui/native-select'
import {
  launcherDisambiguator,
  launcherInputLabel
} from '../../launcher-definition'
import { LauncherInputTextarea } from '../launchers/launcher-input-textarea'

const INITIAL_LAUNCHER_STORAGE_KEY = 'treeport-initial-launcher'

export function WorktreeForm({
  project,
  launchers,
  launcherDiagnostics,
  launchersLoading,
  launchersError,
  onRetryLaunchers,
  busy,
  onSubmit
}: {
  project: ProjectRecord
  launchers: LauncherDefinition[]
  launcherDiagnostics: LauncherDefinitionDiagnostic[]
  launchersLoading: boolean
  launchersError: boolean
  onRetryLaunchers: () => void
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
    treeTitleCommand?: string[]
  ) => void
}) {
  const submitButtonRef = useRef<HTMLButtonElement>(null)
  const usesMacKeyboard = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const [name, setName] = useState('')
  const [baseValue, setBaseValue] = useState('default')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState(0)
  const initialTerminalStorageKey = `${INITIAL_LAUNCHER_STORAGE_KEY}:${project.id}`
  const [initialLauncherId, setInitialLauncherId] = useState(() => {
    const stored = localStorage.getItem(initialTerminalStorageKey)

    return stored ?? 'shell'
  })
  const initialLaunchers = launchers.filter(
    (launcher): launcher is LauncherDefinition & { executable: string } =>
      !launcher.closeOnSuccess &&
      launcher.executable !== null &&
      launcher.shellCommand === null
  )
  const initialLauncherAvailable = initialLaunchers.some(
    (launcher) => launcher.id === initialLauncherId
  )
  const initialLauncherUnavailable =
    initialLauncherId !== 'shell' && !initialLauncherAvailable
  const waitingForInitialLauncher =
    initialLauncherUnavailable && launchersLoading
  const initialLauncherMissing =
    initialLauncherUnavailable && !launchersLoading && !launchersError
  const effectiveInitialLauncherId =
    initialLauncherUnavailable && !launchersLoading
      ? 'shell'
      : initialLauncherId
  const selectedLauncher = initialLaunchers.find(
    (launcher) => launcher.id === effectiveInitialLauncherId
  )
  const inputNames = selectedLauncher
    ? launcherInputNames([
        ...selectedLauncher.args,
        ...(selectedLauncher.treeTitle?.args ?? [])
      ])
    : []
  const submittedInputs = Object.fromEntries(
    inputNames.flatMap((inputName) => {
      const value = inputs[inputName]?.trim()
      return value ? [[inputName, value]] : []
    })
  )
  const generatedName = availableTreeName(
    project.worktrees.map((worktree) => worktree.name)
  )
  const base = baseValue === 'default' ? 'default' : 'current'
  return (
    <form
      className="flex flex-col gap-5 max-[700px]:gap-2.5"
      autoComplete="off"
      onKeyDown={(event) => {
        if (
          event.key !== 'Enter' ||
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.shiftKey ||
          !(usesMacKeyboard
            ? event.metaKey && !event.ctrlKey
            : event.ctrlKey && !event.metaKey)
        ) {
          return
        }

        event.preventDefault()
        if (submitButtonRef.current && !submitButtonRef.current.disabled) {
          event.currentTarget.requestSubmit(submitButtonRef.current)
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || uploads > 0) {
          return
        }

        if (initialLauncherMissing) {
          localStorage.setItem(initialTerminalStorageKey, 'shell')
        }

        onSubmit(
          name.trim() || generatedName,
          base,
          selectedLauncher
            ? {
                name: selectedLauncher.name,
                initialTitle: selectedLauncher.name,
                argv: [
                  selectedLauncher.executable,
                  ...resolveLauncherArgs(selectedLauncher.args, submittedInputs)
                ],
                returnToShell: true
              }
            : { name: 'Terminal' },
          base === 'current' ? baseValue : undefined,
          selectedLauncher?.treeTitle
            ? [
                selectedLauncher.treeTitle.executable,
                ...resolveLauncherArgs(
                  selectedLauncher.treeTitle.args,
                  submittedInputs
                )
              ]
            : undefined
        )
      }}
    >
      {inputNames.map((inputName, index) => {
        const id = `launcher-input-${inputName}`
        return (
          <FormField key={inputName}>
            <Label htmlFor={id}>{launcherInputLabel(inputName)}</Label>
            <LauncherInputTextarea
              id={id}
              value={inputs[inputName] ?? ''}
              autoFocus={index === 0}
              disabled={busy}
              onValueChange={(value) =>
                setInputs((current) => ({ ...current, [inputName]: value }))
              }
              onUploadingChange={(uploading) =>
                setUploads((current) => current + (uploading ? 1 : -1))
              }
            />
          </FormField>
        )
      })}
      <FormField>
        <Label htmlFor="initial-launcher">Open with</Label>
        <NativeSelect
          id="initial-launcher"
          name="initial-launcher"
          value={effectiveInitialLauncherId}
          onChange={(event) => {
            setInitialLauncherId(event.target.value)
            localStorage.setItem(initialTerminalStorageKey, event.target.value)
          }}
          disabled={busy}
        >
          {waitingForInitialLauncher && (
            <option value={initialLauncherId}>Loading saved launcher…</option>
          )}
          <option value="shell">Terminal</option>
          {initialLaunchers.map((launcher) => {
            const disambiguator = launcherDisambiguator(
              launcher,
              initialLaunchers
            )
            return (
              <option key={launcher.id} value={launcher.id}>
                {launcher.name}
                {disambiguator ? ` — ${disambiguator}` : ''}
              </option>
            )
          })}
        </NativeSelect>
        {initialLauncherMissing && (
          <p className="form-note" role="status">
            The selected launcher cannot open a new tree. Changed to Terminal.
          </p>
        )}
        {launchersLoading && (
          <p className="form-note" role="status">
            Loading launchers…
          </p>
        )}
        {launchersError && (
          <div className="flex items-center justify-between gap-3">
            <p className="form-note">
              Launchers could not be loaded. Terminal is still available.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRetryLaunchers}
            >
              Retry
            </Button>
          </div>
        )}
        {launcherDiagnostics.map((diagnostic) => (
          <p
            key={`${diagnostic.path}:${diagnostic.itemId ?? 'file'}:${diagnostic.message}`}
            className="form-note"
            role="status"
          >
            {diagnostic.message}
          </p>
        ))}
      </FormField>
      <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
        <FormField>
          <Label htmlFor="worktree-name">Tree name</Label>
          <Input
            id="worktree-name"
            name="worktree-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={generatedName}
            aria-label="Tree name"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={inputNames.length === 0}
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
      </div>
      <div className="flex items-center justify-end pt-1">
        <Button
          ref={submitButtonRef}
          type="submit"
          aria-keyshortcuts={usesMacKeyboard ? 'Meta+Enter' : 'Control+Enter'}
          disabled={busy || waitingForInitialLauncher || uploads > 0}
        >
          {busy ? 'Creating…' : 'Create tree'}
          <kbd
            aria-hidden="true"
            className="relative top-[0.5px] inline-flex items-baseline gap-0.5 font-sans text-xs font-medium leading-5"
          >
            <span>{usesMacKeyboard ? '⌘' : 'Ctrl+'}</span>
            <span>↵</span>
          </kbd>
        </Button>
      </div>
    </form>
  )
}
