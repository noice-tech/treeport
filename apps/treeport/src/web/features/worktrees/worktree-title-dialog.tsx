import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  WORKTREE_TITLE_MAX_LENGTH,
  type WorktreeRecord
} from '@treeport/shared'
import { parseResponse, rpc } from '../../api'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { FormField } from '../../components/ui/form-field'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { projectsQueryKey } from '../../project-metadata'
import { notifyError } from '../notifications/error-notifications'

export function WorktreeTitleDialog({
  worktree,
  onClose
}: {
  worktree: WorktreeRecord
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState(worktree.title ?? '')

  const saveTitle = useMutation({
    mutationFn: (nextTitle: string | null) =>
      parseResponse(
        rpc.api.worktrees[':worktreeId'].$patch({
          param: { worktreeId: worktree.id },
          json: { title: nextTitle }
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
      onClose()
    },
    onError: (error) => {
      notifyError(error, { operation: `title tree “${worktree.name}”` })
    }
  })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">Tree title</DialogTitle>
          <DialogDescription className="text-base text-pretty sm:text-sm">
            Shown instead of the folder name, {worktree.name}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault()
            saveTitle.mutate(title.trim() || null)
          }}
        >
          <FormField>
            <Label htmlFor="worktree-title">Title</Label>
            <Input
              id="worktree-title"
              name="worktree-title"
              value={title}
              maxLength={WORKTREE_TITLE_MAX_LENGTH}
              placeholder={worktree.name}
              autoFocus
              disabled={saveTitle.isPending}
              onChange={(event) => setTitle(event.target.value)}
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveTitle.isPending}>
              {saveTitle.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
