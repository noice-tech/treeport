import { useRef } from 'react'
import type { ProjectRecord, TerminalPreset } from '@treeport/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { WorktreeForm } from './worktree-form'

export function CreateWorktreeDialog({
  project,
  onOpenChange,
  restoreFocusTo,
  presets,
  presetsLoading,
  presetsError,
  onRetryPresets,
  onSubmit
}: {
  project: ProjectRecord | null
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  presets: TerminalPreset[]
  presetsLoading: boolean
  presetsError: boolean
  onRetryPresets: () => void
  onSubmit: (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    initialTerminal: {
      name: string
      argv?: string[]
      returnToShell?: boolean
    },
    sourceWorktreeId?: string
  ) => void
}) {
  const submittedRef = useRef(false)

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      {project ? (
        <DialogContent
          className="max-w-md"
          restoreFocusTo={restoreFocusTo}
          onCloseAutoFocus={(event) => {
            if (submittedRef.current) {
              submittedRef.current = false
              event.preventDefault()
            }
          }}
        >
          <DialogHeader>
            <p className="eyebrow">{project.name}</p>
            <DialogTitle>Create worktree</DialogTitle>
            <DialogDescription className="sr-only">
              Create a linked worktree and choose its starting point and initial
              terminal.
            </DialogDescription>
          </DialogHeader>
          <WorktreeForm
            project={project}
            presets={presets}
            presetsLoading={presetsLoading}
            presetsError={presetsError}
            onRetryPresets={onRetryPresets}
            busy={false}
            onSubmit={(name, base, initialTerminal, sourceWorktreeId) => {
              submittedRef.current = true
              onSubmit(project, name, base, initialTerminal, sourceWorktreeId)
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
