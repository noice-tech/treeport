import type { ProjectRecord } from '@treeport/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { ProjectForm } from './project-form'

export function OpenProjectDialog({
  open,
  onOpenChange,
  restoreFocusTo,
  setError,
  onOpened
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  setError: (value: string | null) => void
  onOpened: (project: ProjectRecord) => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" restoreFocusTo={restoreFocusTo}>
        <DialogHeader>
          <DialogTitle>Open project</DialogTitle>
          <DialogDescription>
            Browse folders on the Treeport server. Paths refer to the server’s
            filesystem.
          </DialogDescription>
        </DialogHeader>
        <ProjectForm setError={setError} onOpened={onOpened} />
      </DialogContent>
    </Dialog>
  )
}
