import type {
  RemoveOperationRecord,
  RemovePreview,
  WorktreeRecord
} from '@treeport/shared'
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
  operation,
  skipCleanup,
  busy,
  onOpenChange,
  restoreFocusTo,
  onConfirm,
  onSkipCleanup,
  onRetry
}: {
  worktree: WorktreeRecord | null
  preview: RemovePreview | null
  operation: RemoveOperationRecord | null
  skipCleanup: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  onConfirm: (worktree: WorktreeRecord, preview: RemovePreview) => void
  onSkipCleanup: (worktree: WorktreeRecord, preview: RemovePreview) => void
  onRetry: (worktree: WorktreeRecord) => void
}) {
  const destructive = Boolean(preview?.warnings.length) || skipCleanup
  const name = preview?.name ?? worktree?.name
  const branch = preview?.branch ?? worktree?.branch
  const detached = preview?.detached ?? worktree?.detached
  const head = preview?.head ?? worktree?.head
  const worktreePath = preview?.path ?? worktree?.path
  const removalFailed = operation?.status === 'failed'
  const removalCompleted = operation?.status === 'completed'
  const cleanup = operation?.request.cleanupCommands
  const cleanupFailed = cleanup?.status === 'failed'
  const activeCommand = cleanup?.commands.find(
    (command) => command.status === 'running'
  )

  return (
    <AlertDialog open={worktree !== null} onOpenChange={onOpenChange}>
      {worktree && preview ? (
        <AlertDialogContent restoreFocusTo={restoreFocusTo}>
          <AlertDialogHeader>
            <p className="eyebrow">
              {operation
                ? removalFailed
                  ? 'Removal failed'
                  : removalCompleted
                    ? 'Removal complete'
                    : 'Removal in progress'
                : destructive
                  ? 'Destructive removal'
                  : 'Tree'}
            </p>
            <AlertDialogTitle>
              {operation ? `Remove ${name}` : 'Remove tree'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removalFailed
                ? cleanupFailed
                  ? 'Project cleanup failed. Git kept the tree.'
                  : 'Tree removal failed. Git kept the tree.'
                : removalCompleted
                  ? cleanup?.status === 'skipped'
                    ? 'Treeport skipped project cleanup and removed the tree.'
                    : 'Treeport completed project cleanup and removed the tree.'
                  : operation
                    ? activeCommand
                      ? `Running cleanup command: ${activeCommand.name}`
                      : 'Treeport is preparing the tree for removal.'
                    : 'Review what will be removed before continuing.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!operation ? (
            <>
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
                <div>
                  <dt>Cleanup commands</dt>
                  <dd>{preview.cleanup.commands.join(', ') || 'none'}</dd>
                </div>
              </dl>
              {skipCleanup ? (
                <div className="warning danger">
                  <strong>Project cleanup will be skipped.</strong>
                  <p>This action can leave project resources behind.</p>
                </div>
              ) : preview.cleanup.commands.length > 0 ? (
                <p>
                  Treeport stops terminals before cleanup. Git removes the tree
                  only after all cleanup commands succeed.
                </p>
              ) : null}
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
            </>
          ) : (
            <div aria-live="polite">
              {cleanup?.commands.map((command, index) => (
                <section key={`${index}:${command.name}`}>
                  <strong>
                    {command.name}: {command.status}
                  </strong>
                  {command.stdout ? <pre>{command.stdout}</pre> : null}
                  {command.stderr ? <pre>{command.stderr}</pre> : null}
                  {command.error ? <p>{command.error}</p> : null}
                  {command.outputTruncated ? (
                    <p>Cleanup output was truncated.</p>
                  ) : null}
                </section>
              ))}
              {operation.error ? <p>{operation.error}</p> : null}
              {cleanupFailed && preview.cleanup.commands.length > 0 ? (
                <div className="warning danger">
                  <strong>Cleanup can be skipped.</strong>
                  <p>
                    Removing without cleanup can leave project resources behind.
                  </p>
                </div>
              ) : null}
            </div>
          )}
          <AlertDialogFooter>
            {operation ? (
              <>
                {removalFailed ? (
                  <>
                    {cleanupFailed && preview.cleanup.commands.length > 0 ? (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => onSkipCleanup(worktree, preview)}
                      >
                        {busy ? 'Removing…' : 'Remove without cleanup'}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => onRetry(worktree)}
                    >
                      {busy ? 'Retrying…' : 'Retry'}
                    </Button>
                  </>
                ) : null}
                <AlertDialogCancel>Close</AlertDialogCancel>
              </>
            ) : (
              <>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy || !preview.eligible}
                    onClick={(event) => {
                      event.preventDefault()
                      if (skipCleanup) {
                        onSkipCleanup(worktree, preview)
                      } else {
                        onConfirm(worktree, preview)
                      }
                    }}
                  >
                    {busy
                      ? 'Removing…'
                      : skipCleanup
                        ? 'Remove without cleanup'
                        : destructive
                          ? 'Remove anyway'
                          : 'Remove tree'}
                  </Button>
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
