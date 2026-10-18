import { lazy, Suspense } from 'react'
import type { TerminalPreset } from '@treeport/shared'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { LoadingFallback } from '../../loading-fallback'

const TerminalPresetsManager = lazy(() =>
  import('./presets-manager').then((module) => ({
    default: module.TerminalPresetsManager
  }))
)

export function TerminalPresetsDialog({
  open,
  onOpenChange,
  restoreFocusTo,
  presets,
  loading,
  loadError,
  onRetry
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  presets: TerminalPreset[]
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
                Terminal presets
              </DialogTitle>
            </DialogHeader>
            <LoadingFallback />
          </DialogContent>
        </Dialog>
      }
    >
      <TerminalPresetsManager
        presets={presets}
        loading={loading}
        loadError={loadError}
        onRetry={onRetry}
        onClose={() => onOpenChange(false)}
        restoreFocusTo={restoreFocusTo}
      />
    </Suspense>
  )
}
