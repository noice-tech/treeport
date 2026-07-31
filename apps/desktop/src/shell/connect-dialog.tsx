import { useState, type FormEvent } from 'react'
import type { DesktopShellState } from '../desktop-contract'
import { Button, Dialog, Field, FieldLabel, Input } from './ui'

export function ConnectDialog({
  onClose,
  state
}: {
  onClose: () => void
  state: DesktopShellState
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [duplicateId, setDuplicateId] = useState<string>()
  const duplicate = state.computers.find(
    (computer) => computer.id === duplicateId
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await window.treeportShell.addComputer(url)
    if (result.ok) {
      onClose()
      return
    }

    setError(result.error)
    setDuplicateId(result.duplicateId)
  }

  return (
    <Dialog
      title="Connect to another computer"
      showCloseButton={false}
      onClose={onClose}
    >
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="computer-url">Computer URL</FieldLabel>
          <Input
            autoFocus
            id="computer-url"
            name="url"
            type="url"
            required
            autoComplete="url"
            placeholder="https://treeport.example.ts.net"
            value={url}
            aria-invalid={Boolean(error)}
            onChange={(event) => setUrl(event.target.value)}
          />
          <p className="text-base text-pretty text-zinc-400 sm:text-sm">
            Remote computers require HTTPS with a trusted certificate.
          </p>
        </Field>
        {error ? (
          <p className="text-sm text-pretty text-rose-300" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col-reverse items-stretch gap-2 min-[440px]:flex-row min-[440px]:items-center min-[440px]:justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {duplicateId ? (
            <Button
              variant="default"
              onClick={async () => {
                await window.treeportShell.selectComputer(duplicateId)
                onClose()
              }}
            >
              Switch to {duplicate?.name ?? 'saved computer'}
            </Button>
          ) : (
            <Button type="submit" variant="default">
              Connect
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  )
}
