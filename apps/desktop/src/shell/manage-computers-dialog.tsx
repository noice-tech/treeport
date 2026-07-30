import { useState, type FormEvent } from 'react'
import type { ComputerSummary, DesktopShellState } from '../desktop-contract'
import { Button, Dialog, Field, FieldLabel, Input } from './ui'

function ComputerEditor({
  computer,
  onError
}: {
  computer: ComputerSummary
  onError: (message: string) => void
}) {
  const [name, setName] = useState(computer.nameOverride ?? '')
  const [origin, setOrigin] = useState(computer.origin)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await window.treeportShell.updateComputer({
      id: computer.id,
      origin,
      nameOverride: name
    })
    if (!result.ok) {
      onError(result.error)
    }
  }

  return (
    <form
      className="flex shrink-0 flex-col gap-3 py-3 first:pt-0 last:pb-0"
      aria-label={`Edit ${computer.name} at ${computer.origin}`}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-[2fr_3fr]">
        <Field>
          <FieldLabel htmlFor={`name-${computer.id}`}>Name</FieldLabel>
          <Input
            id={`name-${computer.id}`}
            name={`name-${computer.id}`}
            value={name}
            placeholder={computer.name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`url-${computer.id}`}>URL</FieldLabel>
          <Input
            id={`url-${computer.id}`}
            name={`url-${computer.id}`}
            type="url"
            required
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-rose-300 hover:text-rose-200"
          onClick={() => void window.treeportShell.removeComputer(computer.id)}
        >
          Remove
        </Button>
        <Button type="submit" variant="secondary" size="sm">
          Save
        </Button>
      </div>
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
  const [error, setError] = useState('')
  return (
    <Dialog title="Manage computers" size="large" onClose={onClose}>
      <div className="flex min-h-40 flex-1 flex-col overflow-y-auto divide-y divide-white/8 pr-1 [scrollbar-color:var(--color-zinc-700)_transparent]">
        {state.computers.length === 0 ? (
          <p className="grid min-h-40 place-items-center text-sm text-pretty text-zinc-400">
            No computers are saved.
          </p>
        ) : null}
        {state.computers.map((computer) => (
          <ComputerEditor
            key={computer.id}
            computer={computer}
            onError={setError}
          />
        ))}
      </div>
      {error ? (
        <p className="text-sm text-pretty text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex shrink-0 justify-end border-t border-white/8 pt-4">
        <Button variant="default" onClick={onConnect}>
          Connect to another computer…
        </Button>
      </div>
    </Dialog>
  )
}
