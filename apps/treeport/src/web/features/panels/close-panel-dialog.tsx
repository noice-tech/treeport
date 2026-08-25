import type { BrowserPanel, WebPanel } from '@treeport/shared'
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

type StoredPanel = BrowserPanel | WebPanel

export function ClosePanelDialog({
  panel,
  busy,
  restoreFocusTo,
  onOpenChange,
  onConfirm
}: {
  panel: StoredPanel | null
  busy: boolean
  restoreFocusTo: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onConfirm: (panel: StoredPanel) => void
}) {
  return (
    <AlertDialog open={panel !== null} onOpenChange={onOpenChange}>
      {panel ? (
        <AlertDialogContent restoreFocusTo={restoreFocusTo}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {panel.kind === 'browser'
                ? 'Leave site?'
                : `Close ${panel.title}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {panel.kind === 'browser'
                ? 'Changes you made may not be saved.'
                : 'This panel has saved data. Closing it permanently deletes that data, including any comments or drafts.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault()
                  onConfirm(panel)
                }}
              >
                {busy
                  ? 'Closing…'
                  : panel.kind === 'browser'
                    ? 'Leave'
                    : 'Close and delete data'}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
