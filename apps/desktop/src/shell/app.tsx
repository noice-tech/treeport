import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState
} from 'react'
import { ComputerSelector } from './computer-selector'
import { ConnectDialog } from './connect-dialog'
import { ConnectionPage } from './connection-page'
import { ManageComputersDialog } from './manage-computers-dialog'
import { OpenOnPhoneDialog } from './open-on-phone-dialog'
import { selectedComputer, useShellState } from './shell-state'
import { Button } from './ui'

function Titlebar() {
  const state = useShellState()
  if (!state || (state.platform === 'darwin' && state.fullscreen)) {
    return null
  }

  const shortcutSuffix = state.platform === 'darwin'

  return (
    <header className="fixed inset-x-0 top-0 z-80 flex h-8 select-none items-center bg-zinc-900 [-webkit-app-region:drag]">
      <nav
        aria-label="Workspace history"
        className={`flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag] ${state.platform === 'darwin' ? 'ml-[76px]' : 'ml-2'}`}
      >
        <Button
          variant="ghost"
          size={null}
          className="size-6 p-0 text-zinc-500 [&_svg]:size-4"
          title={`Back${shortcutSuffix ? ' (⌘[)' : ''}`}
          aria-label="Back"
          disabled={!state.navigation.canGoBack}
          onClick={() => window.treeportShell.navigateHistory('back')}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size={null}
          className="size-6 p-0 text-zinc-500 [&_svg]:size-4"
          title={`Forward${shortcutSuffix ? ' (⌘])' : ''}`}
          aria-label="Forward"
          disabled={!state.navigation.canGoForward}
          onClick={() => window.treeportShell.navigateHistory('forward')}
        >
          <ChevronRightIcon />
        </Button>
      </nav>
    </header>
  )
}

export function App() {
  const state = useShellState()
  const [dialog, setDialog] = useState<'connect' | 'manage' | 'phone' | null>(
    null
  )
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [terminalSelectionActive, setTerminalSelectionActive] = useState(false)

  useEffect(
    () =>
      window.treeportShell.onTerminalSelectionActive(
        setTerminalSelectionActive
      ),
    []
  )
  const openDialog = (nextDialog: 'connect' | 'manage' | 'phone') => {
    setSelectorOpen(false)
    setDialog(nextDialog)
  }
  const computer = state ? selectedComputer(state) : undefined
  const showTitlebar =
    state && !(state.platform === 'darwin' && state.fullscreen)
  const connectionReady = state?.connection.status === 'ready' && computer

  useEffect(() => {
    window.treeportShell.setOverlayOpen(dialog !== null || selectorOpen)
  }, [dialog, selectorOpen])

  const captureTerminalSelectionPointer = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (
      event.buttons & 1 &&
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  return (
    <>
      <Titlebar />
      {terminalSelectionActive && showTitlebar ? (
        <div
          className="fixed inset-x-0 top-0 z-90 h-8 [-webkit-app-region:no-drag]"
          onPointerEnter={captureTerminalSelectionPointer}
          onPointerMove={captureTerminalSelectionPointer}
          onPointerUp={() => window.treeportShell.releaseTerminalSelection()}
          onPointerCancel={() =>
            window.treeportShell.releaseTerminalSelection()
          }
        />
      ) : null}
      <div
        className={
          showTitlebar
            ? 'fixed inset-x-0 top-8 bottom-0 min-h-0'
            : 'fixed inset-0 min-h-0'
        }
      >
        {connectionReady ? null : (
          <ConnectionPage
            onConnect={() => openDialog('connect')}
            onManage={() => openDialog('manage')}
            onOpenMenu={() => setSelectorOpen(true)}
          />
        )}
      </div>
      {showTitlebar ? (
        <div
          className={
            state.platform === 'darwin'
              ? 'pointer-events-none fixed top-0 right-2 z-80 flex h-8 items-center'
              : 'pointer-events-none fixed inset-x-0 top-0 z-80 flex h-8 items-center justify-center'
          }
        >
          {state.updateReady || state.updateError ? (
            <Button
              variant="ghost"
              size="xs"
              className="pointer-events-auto text-accent-300 hover:text-accent-100 [-webkit-app-region:no-drag]"
              title={state.updateError ?? 'Restart to update Treeport'}
              onClick={() => window.treeportShell.installUpdate()}
            >
              <DownloadIcon data-icon="inline-start" />
              {state.updateError ? 'Desktop update failed' : 'Update & restart'}
            </Button>
          ) : null}
          <ComputerSelector
            state={state}
            open={selectorOpen}
            onOpenChange={setSelectorOpen}
            onConnect={() => openDialog('connect')}
            onManage={() => openDialog('manage')}
            onOpenOnPhone={() => openDialog('phone')}
          />
        </div>
      ) : null}
      {computer && dialog === 'phone' ? (
        <OpenOnPhoneDialog
          key={computer.id}
          computer={computer}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {state && dialog === 'connect' ? (
        <ConnectDialog state={state} onClose={() => setDialog(null)} />
      ) : null}
      {state && dialog === 'manage' ? (
        <ManageComputersDialog
          state={state}
          onClose={() => setDialog(null)}
          onConnect={() => openDialog('connect')}
        />
      ) : null}
    </>
  )
}
