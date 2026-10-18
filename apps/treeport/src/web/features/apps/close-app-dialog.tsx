import type { BrowserApp, WebApp } from '@treeport/shared'
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

type StoredApp = BrowserApp | WebApp

export function CloseAppDialog({
  app,
  reason,
  busy,
  restoreFocusTo,
  onOpenChange,
  onConfirm
}: {
  app: StoredApp | null
  reason: 'browser-before-unload' | 'stored-data' | 'unsaved-changes' | null
  busy: boolean
  restoreFocusTo: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onConfirm: (app: StoredApp) => void
}) {
  return (
    <AlertDialog open={app !== null} onOpenChange={onOpenChange}>
      {app ? (
        <AlertDialogContent restoreFocusTo={restoreFocusTo}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reason === 'browser-before-unload'
                ? 'Leave site?'
                : `Close ${app.title}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {reason === 'browser-before-unload'
                ? 'Changes you made may not be saved.'
                : reason === 'unsaved-changes'
                  ? 'Changes in this app have not been saved.'
                  : 'This app has saved data. Closing it permanently deletes that data, including any comments or drafts.'}
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
                  onConfirm(app)
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
