import { Globe2Icon, MonitorIcon, PlusIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import type { ComputerSummary, DesktopShellState } from '../desktop-contract'
import { Button, Dialog, Field, FieldLabel, Input } from './ui'

function ComputerEditor({
  computer,
  onDone
}: {
  computer: ComputerSummary
  onDone: () => void
}) {
  const [name, setName] = useState(computer.nameOverride ?? '')
  const [origin, setOrigin] = useState(computer.origin)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const changed =
    name.trim() !== (computer.nameOverride ?? '') ||
    origin.trim() !== computer.origin

  function closeRemoval() {
    if (pending) {
      return
    }

    setError(null)
    setConfirmRemoval(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || !changed || confirmRemoval) {
      return
    }

    setError(null)
    setPending(true)
    const result = await window.treeportShell
      .updateComputer({ id: computer.id, origin, nameOverride: name })
      .catch(() => ({ ok: false, error: 'Could not save changes. Try again.' }))
    setPending(false)
    if (!result.ok) {
      setError(result.error)
      return
    }

    onDone()
  }

  return (
    <form
      id={`editor-${computer.id}`}
      className="flex flex-col gap-4 pt-4"
      aria-label={`Edit ${computer.name} at ${computer.origin}`}
      aria-busy={pending}
      onSubmit={submit}
    >
      <fieldset
        disabled={pending}
        className="grid min-w-0 gap-4 @sm:grid-cols-[2fr_3fr]"
      >
        <legend className="sr-only">Computer details</legend>
        <Field className="min-w-0 gap-2 text-base sm:text-sm">
          <FieldLabel htmlFor={`name-${computer.id}`}>Display name</FieldLabel>
          <Input
            autoFocus
            id={`name-${computer.id}`}
            name="name"
            type="text"
            value={name}
            placeholder={computer.name}
            className="max-sm:text-base"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field className="min-w-0 gap-2 text-base sm:text-sm">
          <FieldLabel htmlFor={`url-${computer.id}`}>Computer URL</FieldLabel>
          <Input
            id={`url-${computer.id}`}
            name="url"
            type="url"
            required
            value={origin}
            aria-invalid={!confirmRemoval && Boolean(error)}
            aria-describedby={error ? `error-${computer.id}` : undefined}
            className="max-sm:text-base"
            onChange={(event) => setOrigin(event.target.value)}
          />
        </Field>
      </fieldset>
      {error && !confirmRemoval ? (
        <p
          id={`error-${computer.id}`}
          className="text-base text-pretty text-rose-300 sm:text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-3 @sm:flex-row @sm:items-center @sm:justify-between">
        <Button
          id={`remove-${computer.id}`}
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            setError(null)
            setConfirmRemoval(true)
          }}
        >
          Remove computer…
        </Button>
        <div className="flex items-center justify-end gap-3">
          <Button variant="ghost" size="sm" disabled={pending} onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={pending || !changed}
          >
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
      {confirmRemoval ? (
        <Dialog
          role="alertdialog"
          title={`Remove ${computer.name}?`}
          description="This removes the saved connection from Treeport."
          showCloseButton={false}
          onClose={closeRemoval}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            document.getElementById(`remove-${computer.id}`)?.focus()
          }}
          footer={
            <div className="flex justify-end gap-3">
              <Button variant="ghost" disabled={pending} onClick={closeRemoval}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={async () => {
                  if (pending) {
                    return
                  }

                  setError(null)
                  setPending(true)
                  const removed = await window.treeportShell
                    .removeComputer(computer.id)
                    .catch(() => false)
                  setPending(false)
                  if (!removed) {
                    setError('Could not remove this computer. Try again.')
                    return
                  }

                  onDone()
                }}
              >
                {pending ? 'Removing…' : 'Remove computer'}
              </Button>
            </div>
          }
        >
          <p className="text-base text-pretty text-zinc-300 sm:text-sm">
            Projects and terminals on this computer will not be deleted.
          </p>
          {error ? (
            <p
              className="text-base text-pretty text-rose-300 sm:text-sm"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </form>
  )
}

export function ManageComputersDialog({
  onClose,
  onConnect,
  state
}: {
  onClose: () => void
  onConnect: () => void
  state: DesktopShellState
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  return (
    <Dialog
      title="Manage computers"
      description="Manage saved connections to your local and remote workspaces."
      size="large"
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-base text-zinc-400 sm:text-sm">
            <span className="tabular-nums">{state.computers.length}</span> saved{' '}
            {state.computers.length === 1 ? 'computer' : 'computers'}
          </p>
          <Button
            id="connect-computer"
            variant="default"
            className="pr-3 pl-2"
            onClick={onConnect}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Connect another computer
          </Button>
        </div>
      }
    >
      {state.computers.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center">
          <h2 className="text-base font-medium text-balance text-zinc-100">
            No saved computers
          </h2>
          <p className="max-w-[36ch] text-base text-pretty text-zinc-400 sm:text-sm">
            Connect a computer to access its projects, trees, and terminals.
          </p>
        </div>
      ) : (
        <ul
          role="list"
          aria-label="Saved computers"
          className="flex flex-col divide-y divide-white/8"
        >
          {state.computers.map((computer) => (
            <li
              key={computer.id}
              className="@container py-5 first:pt-0 last:pb-0"
            >
              <div className="flex items-start gap-3">
                {computer.loopback ? (
                  <MonitorIcon
                    role="img"
                    aria-label="This computer"
                    className="size-4 h-lh shrink-0 stroke-zinc-400"
                  />
                ) : (
                  <Globe2Icon
                    role="img"
                    aria-label="Remote computer"
                    className="size-4 h-lh shrink-0 stroke-zinc-400"
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <h2
                      className="min-w-0 truncate text-base font-medium text-balance text-zinc-100"
                      title={computer.name}
                    >
                      {computer.name}
                    </h2>
                    {computer.selected ? (
                      <p className="shrink-0 text-base text-cyan-300 sm:text-sm">
                        Current
                      </p>
                    ) : null}
                  </div>
                  <p
                    className="truncate font-mono text-base text-zinc-400 sm:text-sm"
                    title={computer.origin}
                  >
                    {computer.origin}
                  </p>
                </div>
                <Button
                  id={`edit-${computer.id}`}
                  variant="outline"
                  size="sm"
                  aria-label={`Edit ${computer.name}`}
                  aria-expanded={editingId === computer.id}
                  aria-controls={
                    editingId === computer.id
                      ? `editor-${computer.id}`
                      : undefined
                  }
                  disabled={editingId !== null}
                  onClick={() => setEditingId(computer.id)}
                >
                  Edit
                </Button>
              </div>
              {editingId === computer.id ? (
                <ComputerEditor
                  key={`${computer.id}:${computer.origin}:${computer.nameOverride ?? ''}`}
                  computer={computer}
                  onDone={() => {
                    // Commit the collapsed editor before restoring keyboard focus.
                    flushSync(() => setEditingId(null))
                    const focusTarget =
                      document.getElementById(`edit-${computer.id}`) ??
                      document.getElementById('connect-computer')
                    focusTarget?.focus()
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
