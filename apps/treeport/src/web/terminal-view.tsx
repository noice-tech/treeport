import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { ArrowPathIcon } from '@heroicons/react/16/solid'
import type { TerminalRecord, WorktreeRecord } from '@treeport/shared'
import { Button } from './components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from './components/ui/dialog'
import { cn } from './lib/utils'
import { useIsMobile } from './hooks/use-mobile'
import { useTerminalAutoFocus } from './terminal-focus'
import {
  terminalSessions,
  type ArrowDirection,
  type TerminalSession,
  type TerminalSessionSnapshot
} from './terminal-session'
import { useTerminalNavigationMetadata } from './terminal-runtime-metadata-react'

interface PendingTerminalTab {
  id: string
  name: string
}

interface TerminalViewProps {
  worktree: WorktreeRecord | null
  terminal: TerminalRecord | null
  pendingTerminals: PendingTerminalTab[]
  selectedPendingTerminalId: string | null
  loading: boolean
  autoFocusBlocked: boolean
  onStatusChange: () => void
}

const EMPTY_SNAPSHOT: TerminalSessionSnapshot = {
  phase: 'closed',
  degraded: false,
  controller: false,
  controlPending: false,
  title: null,
  bellActive: false,
  bellSerial: 0,
  exitSerial: 0,
  fileTransfer: null,
  hasSelection: false,
  selecting: false,
  viewingHistory: false,
  pasteRequestSerial: 0,
  error: null
}

export function TerminalView({
  worktree,
  terminal,
  pendingTerminals,
  selectedPendingTerminalId,
  loading,
  autoFocusBlocked,
  onStatusChange
}: TerminalViewProps) {
  const shellRef = useRef<HTMLElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const pasteTriggerRef = useRef<HTMLButtonElement>(null)
  const [session, setSession] = useState<TerminalSession | null>(null)
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  const [paste, setPaste] = useState({
    // SAFETY: The component contract supplies the asserted browser value used here.
    terminalId: null as string | null,
    open: false,
    value: ''
  })
  const onStatusChangeRef = useRef(onStatusChange)
  onStatusChangeRef.current = onStatusChange
  const isMobile = useIsMobile()

  useLayoutEffect(() => {
    if (!terminal) {
      setSession(null)
      return
    }

    const next = terminalSessions.acquire(terminal.id)
    setSession(next)
    return () => terminalSessions.release(terminal.id)
  }, [terminal?.id])

  const activeSession = session?.terminalId === terminal?.id ? session : null
  const subscribeToActiveSession = useCallback(
    (onStoreChange: () => void) => {
      if (!activeSession) {
        return () => undefined
      }

      let previous = activeSession.getSnapshot()
      return activeSession.subscribe(() => {
        const next = activeSession.getSnapshot()
        if (next.pasteRequestSerial > previous.pasteRequestSerial) {
          setPaste((current) => ({
            terminalId: activeSession.terminalId,
            open: true,
            value:
              current.terminalId === activeSession.terminalId
                ? current.value
                : ''
          }))
        }

        if (next.exitSerial > previous.exitSerial) {
          onStatusChangeRef.current()
        }

        previous = next
        onStoreChange()
      })
    },
    [activeSession]
  )
  const snapshot = useSyncExternalStore(
    subscribeToActiveSession,
    activeSession?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT
  )
  const pasteOpen = paste.terminalId === terminal?.id && paste.open
  const pasteValue = paste.terminalId === terminal?.id ? paste.value : ''
  const { titles: runtimeTitles } = useTerminalNavigationMetadata()

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || !activeSession) {
      return
    }

    activeSession.mount(host)
    return () => activeSession.unmount(host)
  }, [activeSession])

  useTerminalAutoFocus({
    terminalId: terminal?.id ?? null,
    session: activeSession,
    blocked: autoFocusBlocked
  })

  useEffect(() => {
    if (!activeSession) {
      return
    }

    activeSession.setInputModifiers(ctrl, alt, () => {
      setCtrl(false)
      setAlt(false)
    })
    return () => activeSession.setInputModifiers(false, false, () => undefined)
  }, [activeSession, alt, ctrl])

  const sendInput = (value: string) => {
    let data = value
    if (ctrl && value.length === 1) {
      data = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31)
    }

    if (alt) {
      data = `\u001b${data}`
    }

    activeSession?.sendText(data)
    setCtrl(false)
    setAlt(false)
  }

  const sendArrow = (direction: ArrowDirection) => {
    activeSession?.sendArrow(direction, alt)
    setCtrl(false)
    setAlt(false)
  }

  const pasteIntoTerminal = (text: string) => {
    if (!text) {
      return
    }

    activeSession?.pasteText(text)
    setPaste({
      terminalId: terminal?.id ?? null,
      open: false,
      value: ''
    })
  }

  const requestPaste = () => {
    activeSession?.requestControl()
    setPaste((current) => ({
      terminalId: terminal?.id ?? null,
      open: true,
      value: current.terminalId === terminal?.id ? current.value : ''
    }))
    if (!navigator.clipboard) {
      return
    }

    void navigator.clipboard.readText().then(
      (text) => pasteIntoTerminal(text),
      () => undefined
    )
  }

  const pasteControls = (
    <>
      <label
        htmlFor="terminal-paste-input"
        className="text-xs font-medium text-zinc-200"
      >
        Paste text here
      </label>
      <textarea
        id="terminal-paste-input"
        autoFocus
        rows={2}
        value={pasteValue}
        placeholder="Touch and hold here, then choose Paste"
        className="min-h-16 resize-none rounded-md border border-white/10 bg-zinc-950 px-3 py-2 text-base text-zinc-100 outline-none focus:border-cyan-500"
        onChange={(event) =>
          setPaste({
            terminalId: terminal?.id ?? null,
            open: true,
            value: event.target.value
          })
        }
        onPaste={(event) => {
          const text = event.clipboardData.getData('text')
          if (!text) {
            return
          }

          event.preventDefault()
          pasteIntoTerminal(text)
        }}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            setPaste({
              terminalId: terminal?.id ?? null,
              open: false,
              value: ''
            })
          }
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!pasteValue}
          onClick={() => pasteIntoTerminal(pasteValue)}
        >
          Send
        </Button>
      </div>
    </>
  )
  const selectedPendingTerminal = pendingTerminals.find(
    (candidate) => candidate.id === selectedPendingTerminalId
  )
  const visibleTitle = terminal
    ? runtimeTitles.get(terminal.id) || terminal.name
    : (selectedPendingTerminal?.name ?? '')
  return (
    <main
      ref={shellRef}
      className={cn(
        'terminal-shell grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] bg-zinc-950 max-[700px]:grid-rows-[minmax(0,1fr)_3.25rem]',
        snapshot.bellActive && 'terminal-bell'
      )}
      aria-label={
        selectedPendingTerminal
          ? `Starting ${selectedPendingTerminal.name} terminal`
          : terminal
            ? `${visibleTitle} terminal`
            : 'Terminal panel'
      }
    >
      {selectedPendingTerminal ? (
        <div className="grid min-h-0 place-items-center bg-[radial-gradient(circle_at_center,var(--color-zinc-900)_0,var(--color-zinc-950)_55%)] p-8">
          <div
            className="flex items-center gap-2 text-sm text-zinc-300"
            role="status"
          >
            <ArrowPathIcon
              className="size-4 animate-spin fill-zinc-500"
              aria-hidden="true"
            />
            Starting {selectedPendingTerminal.name}…
          </div>
        </div>
      ) : terminal ? (
        <div className="relative min-h-0 min-w-0 overflow-hidden">
          <div
            key={terminal.id}
            className="xterm-host absolute inset-0 min-h-0 min-w-0 overflow-hidden p-2.5 outline-none max-[700px]:p-1.5"
            ref={hostRef}
            onMouseDown={() => activeSession?.focus({ requestControl: true })}
          />
          {snapshot.viewingHistory && !pasteOpen ? (
            <div className="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900/95 py-1 pr-1 pl-3 text-xs text-zinc-300 shadow-lg ring-1 ring-amber-400/20 backdrop-blur">
              <span role="status" className="whitespace-nowrap leading-tight">
                <strong className="block font-medium text-zinc-100">
                  {snapshot.hasSelection || snapshot.selecting
                    ? 'Selection is active'
                    : 'Scrolled back in tmux'}
                </strong>
                <span className="block text-[0.6875rem] text-zinc-400">
                  New output is continuing off-screen
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 rounded-full px-2.5 text-xs text-cyan-200 hover:bg-white/8 hover:text-cyan-100"
                onClick={() => {
                  if (snapshot.hasSelection || snapshot.selecting) {
                    activeSession?.clearSelectionAndJumpToLatest()
                  } else {
                    activeSession?.jumpToLatest()
                  }
                }}
              >
                {snapshot.hasSelection || snapshot.selecting
                  ? 'Clear'
                  : 'Follow latest'}
              </Button>
            </div>
          ) : null}
          {snapshot.phase === 'ready' && !snapshot.controller ? (
            <span
              className="absolute top-3 right-3 z-10 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-900/90 px-2 py-1 text-[0.6875rem] font-medium text-zinc-400 shadow ring-1 ring-white/8 backdrop-blur"
              title="Interact with the terminal to control it"
            >
              <span
                className={cn(
                  'size-1.5 rounded-full bg-zinc-500',
                  snapshot.controlPending && 'animate-pulse bg-cyan-400'
                )}
                aria-hidden="true"
              />
              {snapshot.controlPending ? 'Taking control…' : 'Viewing'}
            </span>
          ) : null}
          {pasteOpen &&
            (isMobile ? (
              <Dialog
                open
                onOpenChange={(open) => {
                  if (!open) {
                    setPaste({
                      terminalId: terminal.id,
                      open: false,
                      value: ''
                    })
                  }
                }}
              >
                <DialogContent
                  className="max-w-sm gap-3 p-4"
                  mobilePresentation="dialog"
                  restoreFocusTo={pasteTriggerRef.current}
                >
                  <DialogHeader>
                    <DialogTitle className="text-lg sm:text-lg">
                      Paste into terminal
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                      Paste text and send it to the active terminal.
                    </DialogDescription>
                  </DialogHeader>
                  {pasteControls}
                </DialogContent>
              </Dialog>
            ) : (
              <div
                className="absolute inset-x-3 bottom-3 z-20 grid gap-2 rounded-lg bg-zinc-900 p-3 shadow-xl ring-1 ring-white/15"
                role="dialog"
                aria-label="Paste into terminal"
              >
                {pasteControls}
              </div>
            ))}
          {snapshot.hasSelection && !pasteOpen && (
            <div
              className="terminal-selection-actions absolute right-3 bottom-3 z-10 overflow-hidden rounded-md bg-zinc-800 shadow-lg ring-1 ring-white/15 max-[700px]:bottom-2"
              aria-label="Terminal text selection"
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-none border-r border-white/10 px-3 text-zinc-100"
                onClick={() => activeSession?.copySelection()}
              >
                Copy
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-none px-3 text-zinc-300"
                onClick={() => activeSession?.clearSelection()}
              >
                Clear
              </Button>
            </div>
          )}
          {(snapshot.degraded || snapshot.fileTransfer) && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2">
              {snapshot.degraded && (
                <span className="max-w-[calc(100%-1.5rem)] rounded-full bg-zinc-900/90 px-3 py-1 text-center text-xs text-amber-200 shadow ring-1 ring-amber-400/20 backdrop-blur">
                  {snapshot.error
                    ? `${snapshot.error} Retrying…`
                    : 'Reconnecting…'}
                </span>
              )}
              {snapshot.fileTransfer && (
                <span
                  className={cn(
                    'rounded-full bg-zinc-900/90 px-3 py-1 text-xs shadow ring-1 backdrop-blur',
                    snapshot.fileTransfer.state === 'error'
                      ? 'text-rose-100 ring-rose-400/30'
                      : 'text-cyan-100 ring-cyan-400/20'
                  )}
                  role={
                    snapshot.fileTransfer.state === 'error' ? 'alert' : 'status'
                  }
                >
                  {snapshot.fileTransfer.message}
                </span>
              )}
            </div>
          )}
          {snapshot.phase === 'closed' && snapshot.error && (
            <div className="absolute inset-x-0 top-3 z-10 flex justify-center">
              <div className="flex items-center gap-2 rounded-full bg-rose-950/95 px-3 py-1 text-xs text-rose-100 shadow ring-1 ring-rose-400/30 backdrop-blur">
                <span>{snapshot.error}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-rose-100 hover:bg-rose-900"
                  onClick={() => activeSession?.retry()}
                >
                  Retry
                </Button>
              </div>
            </div>
          )}
          <span className="sr-only" aria-live="polite">
            {snapshot.phase === 'ready'
              ? snapshot.controller
                ? 'Controlling terminal'
                : snapshot.controlPending
                  ? 'Taking control of terminal'
                  : 'Viewing terminal'
              : ''}
            {snapshot.bellActive ? ` Bell from ${visibleTitle}` : ''}
          </span>
        </div>
      ) : loading ? (
        <div className="grid min-h-0 place-items-center bg-[radial-gradient(circle_at_center,var(--color-zinc-900)_0,var(--color-zinc-950)_55%)] p-8">
          <div role="status" aria-label="Loading workspace">
            <ArrowPathIcon
              className="size-6 animate-spin fill-zinc-500"
              aria-hidden="true"
            />
          </div>
        </div>
      ) : (
        <div className="empty-state grid min-h-0 place-items-center bg-[radial-gradient(circle_at_center,var(--color-zinc-900)_0,var(--color-zinc-950)_55%)] p-8">
          <div className="grid max-w-lg gap-3">
            <p className="eyebrow">No terminal open</p>
            <h1 className="text-balance text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">
              {worktree ? 'Start a terminal for this tree.' : 'Choose a tree.'}
            </h1>
            <p className="max-w-[52ch] text-base text-pretty text-zinc-400 sm:text-sm">
              {worktree
                ? 'Use New panel in the sidebar to start a login shell, preset, or web panel.'
                : 'Select a tree from the sidebar to view its terminals.'}
            </p>
          </div>
        </div>
      )}
      {terminal && (
        <div
          className="accessory-row hidden min-w-0 touch-pan-x overflow-x-auto overflow-y-hidden border-t border-white/8 bg-zinc-900 pt-1 pr-[env(safe-area-inset-right)] pb-[calc(0.25rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] max-[700px]:flex [&_button]:h-11 [&_button]:min-w-11 [&_button]:grow [&_button]:rounded-none [&_button]:border-r [&_button]:border-white/8 [&_button]:text-sm [&_button:last-child]:border-r-0"
          aria-label="Terminal accessory keys"
          onPointerDownCapture={() => activeSession?.requestControl()}
        >
          <Button
            variant="ghost"
            type="button"
            onClick={() => sendInput('\u001b')}
          >
            Esc
          </Button>
          <Button
            variant="ghost"
            type="button"
            className={ctrl ? 'latched bg-cyan-950 text-cyan-100' : ''}
            aria-pressed={ctrl}
            onClick={() => {
              setCtrl((value) => !value)
              activeSession?.focus()
            }}
          >
            Ctrl
          </Button>
          <Button
            variant="ghost"
            type="button"
            className={alt ? 'latched bg-cyan-950 text-cyan-100' : ''}
            aria-pressed={alt}
            onClick={() => {
              setAlt((value) => !value)
              activeSession?.focus()
            }}
          >
            Alt
          </Button>
          <Button
            ref={pasteTriggerRef}
            variant="ghost"
            type="button"
            onClick={requestPaste}
          >
            Paste
          </Button>
          <Button variant="ghost" type="button" onClick={() => sendInput('\t')}>
            Tab
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              // Shift+Tab has a fixed terminal sequence and ignores modifier latches.
              activeSession?.sendText('\u001b[Z')
              setCtrl(false)
              setAlt(false)
            }}
          >
            Shift+Tab
          </Button>
          <Button variant="ghost" type="button" onClick={() => sendInput('\r')}>
            Enter
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-label="Arrow left"
            onClick={() => sendArrow('left')}
          >
            ←
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-label="Arrow up"
            onClick={() => sendArrow('up')}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-label="Arrow down"
            onClick={() => sendArrow('down')}
          >
            ↓
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-label="Arrow right"
            onClick={() => sendArrow('right')}
          >
            →
          </Button>
        </div>
      )}
    </main>
  )
}
