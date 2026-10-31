import { lazy, Suspense, useRef, type RefObject } from 'react'
import type { ProjectRecord } from '#protocol/project'
import type {
  LauncherDefinition,
  LauncherTreeTitle,
  LauncherDefinitionDiagnostic
} from '#protocol/launcher'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { LoadingFallback } from '../../loading-fallback'

const WorktreeForm = lazy(() =>
  import('./worktree-form').then((module) => ({ default: module.WorktreeForm }))
)

export function CreateWorktreeDialog({
  project,
  onOpenChange,
  restoreFocusTo,
  launchers,
  launcherDiagnostics,
  launchersLoading,
  launchersError,
  onRetryLaunchers,
  onSubmit
}: {
  project: ProjectRecord | null
  onOpenChange: (open: boolean) => void
  restoreFocusTo: RefObject<HTMLElement | null>
  launchers: LauncherDefinition[]
  launcherDiagnostics: LauncherDefinitionDiagnostic[]
  launchersLoading: boolean
  launchersError: boolean
  onRetryLaunchers: () => void
  onSubmit: (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    initialTerminal: {
      name: string
      command?: string
    },
    sourceWorktreeId?: string,
    treeTitle?: LauncherTreeTitle
  ) => void
}) {
  const submittedRef = useRef(false)

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      {project ? (
        <DialogContent
          className="max-w-md"
          mobilePresentation="dialog"
          restoreFocusTo={restoreFocusTo}
          onPointerDownOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            if (submittedRef.current) {
              submittedRef.current = false
              event.preventDefault()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Create tree</DialogTitle>
            <DialogDescription className="sr-only">
              Create a linked tree and choose its starting point and initial
              terminal.
            </DialogDescription>
          </DialogHeader>
          <Suspense fallback={<LoadingFallback />}>
            <WorktreeForm
              key={project.id}
              project={project}
              launchers={launchers}
              launcherDiagnostics={launcherDiagnostics}
              launchersLoading={launchersLoading}
              launchersError={launchersError}
              onRetryLaunchers={onRetryLaunchers}
              busy={false}
              onSubmit={(...submission) => {
                submittedRef.current = true
                onSubmit(project, ...submission)
              }}
            />
          </Suspense>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
