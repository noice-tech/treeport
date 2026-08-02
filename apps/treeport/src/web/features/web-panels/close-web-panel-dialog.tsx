import type { WebPanel } from '@treeport/shared'
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

export function CloseWebPanelDialog({
  panel,
  busy,
  restoreFocusTo,
  onOpenChange,
  onConfirm
}: {
  panel: WebPanel | null
  busy: boolean
  restoreFocusTo: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onConfirm: (panel: WebPanel) => void
}) {
  return (
    <AlertDialog open={panel !== null} onOpenChange={onOpenChange}>
      {panel ? (
        <AlertDialogContent restoreFocusTo={restoreFocusTo}>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {panel.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This panel has saved data. Closing it permanently deletes that
              data, including any comments or drafts.
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
                {busy ? 'Closing…' : 'Close and delete data'}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
