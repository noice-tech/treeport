import type { BrowserTab, WebPanel } from '@treeport/shared'
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

type StoredTab = BrowserTab | WebPanel

export function CloseTabDialog({
  tab,
  reason,
  busy,
  restoreFocusTo,
  onOpenChange,
  onConfirm
}: {
  tab: StoredTab | null
  reason: 'browser-before-unload' | 'stored-data' | 'unsaved-changes' | null
  busy: boolean
  restoreFocusTo: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onConfirm: (tab: StoredTab) => void
}) {
  return (
    <AlertDialog open={tab !== null} onOpenChange={onOpenChange}>
      {tab ? (
        <AlertDialogContent restoreFocusTo={restoreFocusTo}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reason === 'browser-before-unload'
                ? 'Leave site?'
                : `Close ${tab.title}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {reason === 'browser-before-unload'
                ? 'Changes you made may not be saved.'
                : reason === 'unsaved-changes'
                  ? 'Changes in this tab have not been saved.'
                  : 'This tab has saved data. Closing it permanently deletes that data, including any comments or drafts.'}
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
                  onConfirm(tab)
                }}
              >
                {busy
                  ? 'Closing…'
                  : reason === 'browser-before-unload'
                    ? 'Leave'
                    : reason === 'unsaved-changes'
                      ? 'Close without saving'
                      : 'Close and delete data'}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}
