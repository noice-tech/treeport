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
  onOpened
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  onOpened: (project: ProjectRecord) => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl gap-3 p-4 max-[700px]:gap-4"
        restoreFocusTo={restoreFocusTo}
      >
        <DialogHeader>
          <DialogTitle className="text-lg tracking-normal sm:text-lg">
            Open project
          </DialogTitle>
          <DialogDescription>
            Browse folders on the Treeport server.
          </DialogDescription>
        </DialogHeader>
        <ProjectForm onOpened={onOpened} />
      </DialogContent>
    </Dialog>
  )
}
