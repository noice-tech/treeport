import { lazy, Suspense, type RefObject } from 'react'
import type { ProjectRecord } from '@treeport/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { LoadingFallback } from '../../loading-fallback'

const ProjectForm = lazy(() =>
  import('./project-form').then((module) => ({ default: module.ProjectForm }))
)

export function OpenProjectDialog({
  open,
  onOpenChange,
  restoreFocusTo,
  onOpened
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: RefObject<HTMLElement | null>
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
        <Suspense fallback={<LoadingFallback />}>
          <ProjectForm onOpened={onOpened} />
        </Suspense>
      </DialogContent>
    </Dialog>
  )
}
