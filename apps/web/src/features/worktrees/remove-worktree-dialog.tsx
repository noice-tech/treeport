import type { RemovePreview, WorktreeRecord } from '@treeport/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../components/ui/alert-dialog'
import { Button } from '../../components/ui/button'

export function RemoveWorktreeDialog({
  worktree,
  preview,
  busy,
  onOpenChange,
  restoreFocusTo,
  onConfirm
}: {
  worktree: WorktreeRecord | null
  preview: RemovePreview | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  onConfirm: (worktree: WorktreeRecord, preview: RemovePreview) => void
}) {
  const destructive = Boolean(preview?.warnings.length)
  const name = preview?.name ?? worktree?.name
  const branch = preview?.branch ?? worktree?.branch
  const detached = preview?.detached ?? worktree?.detached
  const head = preview?.head ?? worktree?.head
  const worktreePath = preview?.path ?? worktree?.path

  return (
    <AlertDialog open={worktree !== null} onOpenChange={onOpenChange}>
      {worktree && preview ? (
        <AlertDialogContent restoreFocusTo={restoreFocusTo}>
          <AlertDialogHeader>
            <p className="eyebrow">
              {destructive ? 'Destructive removal' : 'Worktree'}
            </p>
            <AlertDialogTitle>Remove worktree</AlertDialogTitle>
            <AlertDialogDescription>
              Review what will be removed before continuing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="facts">
            <div>
              <dt>Name</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>Git state</dt>
              <dd>
                {!detached && branch
                  ? `Branch ${branch} (preserved)`
                  : `Detached at ${head?.slice(0, 8)}`}
              </dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd>{worktreePath}</dd>
            </div>
            <div>
              <dt>Uncommitted</dt>
              <dd>
                {`${preview.dirty.total} (${preview.dirty.staged} staged, ${preview.dirty.unstaged} unstaged, ${preview.dirty.untracked} untracked, ${preview.dirty.conflicts} conflicted)`}
              </dd>
            </div>
            <div>
              <dt>Terminals stopped</dt>
              <dd>
                {preview.terminals
                  .map((terminal) => terminal.name)
                  .join(', ') || 'none'}
              </dd>
            </div>
          </dl>
          {preview.reasons.length > 0 ? (
            <div className="warning">
              <strong>Removal refused</strong>
              <ul role="list">
                {preview.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview.warnings.length > 0 ? (
            <div className="warning danger">
              <strong>Local work may be lost.</strong>
              <ul role="list">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || !preview.eligible}
                onClick={(event) => {
                  event.preventDefault()
                  onConfirm(worktree, preview)
                }}
              >
                {busy
                  ? 'Removing…'
                  : destructive
                    ? 'Remove anyway'
                    : 'Remove worktree'}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
