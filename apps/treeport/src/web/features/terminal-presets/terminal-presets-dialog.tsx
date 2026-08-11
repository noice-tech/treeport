import type { TerminalPreset } from '@treeport/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { TerminalPresetsManager } from './presets-manager'

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" restoreFocusTo={restoreFocusTo}>
        <DialogHeader>
          <DialogTitle>Global terminal presets</DialogTitle>
          <DialogDescription>
            Create commands available in every repository. Arguments are passed
            exactly as entered.
          </DialogDescription>
        </DialogHeader>
        <TerminalPresetsManager
          presets={presets}
          loading={loading}
          loadError={loadError}
          onRetry={onRetry}
        />
      </DialogContent>
    </Dialog>
  )
}
