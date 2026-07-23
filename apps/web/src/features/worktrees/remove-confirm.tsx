import type { RemovePreview, WorktreeRecord } from '@tasktty/shared'
import { Button } from '../../components/ui/button.js'
import { ModalHeading } from '../dialogs/dialog-parts.js'

export function RemoveConfirm({
  worktree,
  preview,
  busy,
  onConfirm
}: {
  worktree: WorktreeRecord
  preview: RemovePreview | null
  busy: boolean
  onConfirm: (preview: RemovePreview) => void
}) {
  const destructive = Boolean(preview?.warnings.length)
  const name = preview?.name ?? worktree.name
  const branch = preview ? preview.branch : worktree.branch
  const detached = preview?.detached ?? worktree.detached
  const head = preview?.head ?? worktree.head
  const worktreePath = preview?.path ?? worktree.path
  return (
    <div className="flex flex-col gap-5">
      <ModalHeading
        eyebrow={destructive ? 'Destructive removal' : 'Worktree'}
        title="Remove worktree"
      />
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
              : `Detached at ${head.slice(0, 8)}`}
          </dd>
        </div>
        <div>
          <dt>Path</dt>
          <dd>{worktreePath}</dd>
        </div>
        <div>
          <dt>Uncommitted</dt>
          <dd>
            {preview
              ? `${preview.dirty.total} (${preview.dirty.staged} staged, ${preview.dirty.unstaged} unstaged, ${preview.dirty.untracked} untracked, ${preview.dirty.conflicts} conflicted)`
              : 'checking…'}
          </dd>
        </div>
        <div>
          <dt>Terminals stopped</dt>
          <dd>
            {preview
              ? preview.terminals.map((terminal) => terminal.name).join(', ') ||
                'none'
              : 'checking…'}
          </dd>
        </div>
      </dl>
      {preview && preview.reasons.length > 0 && (
        <div className="warning">
          <strong>Removal refused</strong>
          <ul role="list">
            {preview.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {preview && preview.warnings.length > 0 && (
        <div className="warning danger">
          <strong>Local work may be lost.</strong>
          <ul role="list">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <Button
        type="button"
        variant="destructive"
        className="self-end"
        disabled={busy || !preview?.eligible}
        onClick={() => preview && onConfirm(preview)}
      >
        {busy ? 'Removing…' : destructive ? 'Remove anyway' : 'Remove worktree'}
      </Button>
    </div>
  )
}
