import { lazy, Suspense, type RefObject } from 'react'
import type { Launcher } from '@treeport/shared'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { LoadingFallback } from '../../loading-fallback'

const LaunchersManager = lazy(() =>
  import('./launchers-manager').then((module) => ({
    default: module.LaunchersManager
  }))
)

export function LaunchersDialog({
  open,
  onOpenChange,
  restoreFocusTo,
  launchers,
  loading,
  loadError,
  onRetry
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: RefObject<HTMLElement | null>
  launchers: Launcher[]
  loading: boolean
  loadError: boolean
  onRetry: () => void
}) {
  if (!open) {
    return null
  }

  return (
    <Suspense
      fallback={
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent
            className="min-[701px]:[&>button:last-child]:top-5 min-[701px]:[&>button:last-child]:right-3.5"
            restoreFocusTo={restoreFocusTo}
            aria-describedby={undefined}
          >
            <DialogHeader>
              <DialogTitle className="text-base sm:text-lg">
                Launchers
              </DialogTitle>
            </DialogHeader>
            <LoadingFallback />
          </DialogContent>
        </Dialog>
      }
    >
      <LaunchersManager
        launchers={launchers}
        loading={loading}
        loadError={loadError}
        onRetry={onRetry}
        onClose={() => onOpenChange(false)}
        restoreFocusTo={restoreFocusTo}
      />
    </Suspense>
  )
}
