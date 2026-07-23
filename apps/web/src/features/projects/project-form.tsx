import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ProjectRecord } from '@tasktty/shared'
import { apiClient } from '../../api.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { ModalHeading } from '../dialogs/dialog-parts.js'

export function ProjectForm({
  setError,
  onOpened
}: {
  setError: (value: string | null) => void
  onOpened: (project: ProjectRecord) => Promise<void>
}) {
  const [pathValue, setPathValue] = useState('')
  const openProject = useMutation({
    mutationFn: (path: string) => apiClient.addProject(path),
    onSuccess: onOpened,
    onError: (value) =>
      setError(value instanceof Error ? value.message : String(value))
  })
  const busy = openProject.isPending

  return (
    <div className="flex flex-col gap-5">
      <ModalHeading title="Open project" />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          openProject.mutate(pathValue)
        }}
      >
        <Input
          id="repository-path"
          name="repository-path"
          value={pathValue}
          onChange={(event) => setPathValue(event.target.value)}
          placeholder="/Users/you/Projects/example"
          aria-label="Open by repository path"
          required
          autoFocus
          disabled={busy}
        />
        <p className="form-note">
          The daemon resolves the main checkout and imports existing linked
          worktrees.
        </p>
        <Button type="submit" className="self-end" disabled={busy}>
          {busy ? 'Opening…' : 'Open project'}
        </Button>
      </form>
    </div>
  )
}
