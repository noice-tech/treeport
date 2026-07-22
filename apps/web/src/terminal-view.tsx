import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowPathIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  PlusIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import type {
  TerminalPreset,
  TerminalRecord,
  WorktreeRecord
} from '@tasktty/shared'
import { Button } from './components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './components/ui/dropdown-menu.js'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from './components/ui/tabs.js'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from './components/ui/tooltip.js'
import { cn } from './lib/utils.js'
import {
  terminalProgressLabel,
  terminalSessions,
  type ArrowDirection,
  type TerminalProgress,
  type TerminalSession,
  type TerminalSessionSnapshot
} from './terminal-session.js'

interface TerminalViewProps {
  worktree: WorktreeRecord | null
  terminal: TerminalRecord | null
  focusTerminalId: string | null
  presets: TerminalPreset[]
  presetsLoading: boolean
  presetsError: boolean
  creatingTerminal: boolean
  mutationsDisabled: boolean
  closingTerminalId: string | null
  onSelectTerminal: (terminal: TerminalRecord) => void
  onCreateTerminal: (input: { name: string; argv?: string[] }) => void
  onManagePresets: (trigger: HTMLButtonElement | null) => void
  onCloseTerminal: (terminal: TerminalRecord) => void
  onStatusChange: () => void
}

const EMPTY_ATTENTION: ReadonlySet<string> = new Set()
const EMPTY_TITLES: ReadonlyMap<string, string> = new Map()
const EMPTY_PROGRESS: ReadonlyMap<string, TerminalProgress> = new Map()
const EMPTY_SNAPSHOT: TerminalSessionSnapshot = {
  phase: 'closed',
  degraded: false,
  controller: false,
  title: null,
  bellActive: false,
  bellSerial: 0,
  exitSerial: 0,
  fileTransfer: null,
  error: null
}

export function TerminalView({
  worktree,
  terminal,
  focusTerminalId,
  presets,
  presetsLoading,
  presetsError,
  creatingTerminal,
  mutationsDisabled,
  closingTerminalId,
  onSelectTerminal,
  onCreateTerminal,
  onManagePresets,
  onCloseTerminal,
  onStatusChange
}: TerminalViewProps) {
  const shellRef = useRef<HTMLElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const newTerminalTriggerRef = useRef<HTMLButtonElement>(null)
  const [session, setSession] = useState<TerminalSession | null>(null)
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  const lastExitSerial = useRef(0)
  const lastExitSessionId = useRef<string | null>(null)
  const focusedTerminalId = useRef<string | null>(null)
  const shortcutFocusTerminalId = useRef<string | null>(null)

  useEffect(() => {
    if (!terminal) {
      setSession(null)
      return
    }

    const next = terminalSessions.acquire(terminal.id)
    setSession(next)
    return () => terminalSessions.release(terminal.id)
  }, [terminal?.id])

  const activeSession = session?.terminalId === terminal?.id ? session : null
  const snapshot = useSyncExternalStore(
    activeSession?.subscribe ?? (() => () => undefined),
    activeSession?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT
  )
  const bellAttention = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getAttentionSnapshot,
    () => EMPTY_ATTENTION
  )
  const runtimeTitles = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getTitleSnapshot,
    () => EMPTY_TITLES
  )
  const terminalProgress = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getProgressSnapshot,
    () => EMPTY_PROGRESS
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host || !activeSession) {
      return
    }

    activeSession.mount(host)
    return () => activeSession.unmount(host)
  }, [activeSession])

  useEffect(() => {
    if (!activeSession) {
      return
    }

    const focusAfterCreation =
      activeSession.terminalId === focusTerminalId &&
      focusedTerminalId.current !== focusTerminalId
    const focusAfterShortcut =
      activeSession.terminalId === shortcutFocusTerminalId.current
    if (!focusAfterCreation && !focusAfterShortcut) {
      return
    }

    focusedTerminalId.current = activeSession.terminalId
    shortcutFocusTerminalId.current = null
    activeSession.focus()
  }, [activeSession, focusTerminalId])

  useEffect(() => {
    if (lastExitSessionId.current !== terminal?.id) {
      lastExitSessionId.current = terminal?.id ?? null
      lastExitSerial.current = snapshot.exitSerial
      return
    }

    if (snapshot.exitSerial <= lastExitSerial.current) {
      return
    }

    lastExitSerial.current = snapshot.exitSerial
    onStatusChange()
  }, [onStatusChange, snapshot.exitSerial, terminal?.id])

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

  const visibleTitle = terminal
    ? runtimeTitles.get(terminal.id) || terminal.name
    : ''
  const terminals = worktree?.terminals ?? []
  const launchDisabled = !worktree || mutationsDisabled || creatingTerminal

  useEffect(() => {
    // Mod+W stays browser-owned here; reserve it for Electron, where we can override the window accelerator.
    const keydown = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey ||
        shellRef.current?.closest('[inert]')
      ) {
        return
      }

      const index = Number(event.key) - 1
      if (!Number.isInteger(index) || index < 0 || index > 8) {
        return
      }

      const nextTerminal = terminals[index]
      if (!nextTerminal) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      if (activeSession?.terminalId === nextTerminal.id) {
        activeSession.focus()
      } else {
        shortcutFocusTerminalId.current = nextTerminal.id
      }

      onSelectTerminal(nextTerminal)
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [activeSession, onSelectTerminal, terminals])

  return (
    <Tabs
      value={terminal?.id ?? ''}
      onValueChange={(terminalId) => {
        const nextTerminal = terminals.find((item) => item.id === terminalId)
        if (nextTerminal) {
          onSelectTerminal(nextTerminal)
        }
      }}
      asChild
    >
      <main
        ref={shellRef}
        className={cn(
          'terminal-shell grid min-h-0 min-w-0 grid-rows-[2.5rem_minmax(0,1fr)] bg-zinc-950 max-[700px]:grid-rows-[2.75rem_minmax(0,1fr)_3.25rem]',
          snapshot.bellActive && 'terminal-bell'
        )}
        aria-label={terminal ? `${visibleTitle} terminal` : 'Terminal panel'}
      >
        <header className="terminal-header flex min-w-0 items-stretch border-b border-white/8 bg-zinc-900/70">
          <div className="min-w-0 max-w-full flex-1 overflow-x-auto">
            <TabsList
              className="flex h-full min-w-full items-stretch"
              aria-label={`${worktree?.name ?? 'Worktree'} terminals`}
            >
              {terminals.map((item, index) => {
                const selected = item.id === terminal?.id
                const title = runtimeTitles.get(item.id) || item.name
                const needsAttention = bellAttention.has(item.id)
                const progress = terminalProgress.get(item.id)
                const status = [
                  item.status,
                  selected && snapshot.degraded ? 'reconnecting' : null,
                  progress ? terminalProgressLabel(progress) : null,
                  needsAttention ? 'bell' : null
                ]
                  .filter(Boolean)
                  .join(', ')
                const closing = closingTerminalId === item.id
                return (
                  <div
                    key={item.id}
                    className={cn(
                      'group/tab relative flex min-w-36 flex-1 basis-0 items-center border-r border-white/6 hover:bg-white/4 after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-cyan-400 after:opacity-0',
                      selected &&
                        'bg-zinc-800 hover:bg-zinc-700/70 after:opacity-100'
                    )}
                  >
                    <TabsTrigger
                      value={item.id}
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 py-0 pr-0.5 pl-3 font-normal text-zinc-500 outline-none group-hover/tab:text-zinc-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan-400 data-[state=active]:text-zinc-50"
                      aria-label={`${title}, ${status}`}
                      aria-keyshortcuts={
                        index < 9 ? `Meta+${index + 1}` : undefined
                      }
                      title={title}
                    >
                      {progress ? (
                        <ArrowPathIcon
                          className={cn(
                            'size-4 shrink-0 fill-cyan-300',
                            progress.state !== 'paused' &&
                              progress.state !== 'error' &&
                              'animate-spin',
                            progress.state === 'error' && 'fill-rose-300',
                            progress.state === 'paused' && 'fill-amber-300',
                            needsAttention &&
                              'drop-shadow-[0_0_0.35rem_#fcd34d]'
                          )}
                          aria-hidden="true"
                        />
                      ) : item.status !== 'running' || needsAttention ? (
                        <span
                          className={cn(
                            'size-1.5 shrink-0 rounded-full bg-zinc-600',
                            item.status === 'exited' && 'bg-rose-400',
                            needsAttention &&
                              'bg-amber-300 shadow-[0_0_0.5rem] shadow-amber-300/60'
                          )}
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-base sm:text-[0.734375rem]">
                        {title}
                      </span>
                      {index < 9 && (
                        <span
                          className={cn(
                            'ml-1 shrink-0 text-[0.6875rem]/4 font-normal text-zinc-600 tabular-nums group-hover/tab:text-zinc-400',
                            selected && 'text-zinc-400'
                          )}
                          aria-hidden="true"
                        >
                          ⌘{index + 1}
                        </span>
                      )}
                    </TabsTrigger>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className={cn(
                            'mr-1 shrink-0 self-center text-zinc-600 group-hover/tab:text-zinc-400 hover:bg-transparent hover:text-zinc-200',
                            selected && 'text-zinc-400'
                          )}
                          aria-label={`Close ${title}`}
                          disabled={closing}
                          onClick={() => onCloseTerminal(item)}
                        >
                          {closing ? (
                            <ArrowPathIcon className="animate-spin" />
                          ) : (
                            <XMarkIcon />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        Close terminal
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )
              })}
            </TabsList>
          </div>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    ref={newTerminalTriggerRef}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="m-0 size-11 shrink-0 text-zinc-500 hover:bg-white/5 hover:text-zinc-100 min-[701px]:m-1 min-[701px]:size-7"
                    aria-label="New terminal"
                    disabled={creatingTerminal}
                  >
                    {creatingTerminal ? (
                      <ArrowPathIcon className="animate-spin" />
                    ) : (
                      <PlusIcon />
                    )}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">New terminal</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" side="bottom">
              <DropdownMenuLabel>New terminal</DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={launchDisabled}
                  onSelect={() => onCreateTerminal({ name: 'Shell' })}
                >
                  <CommandLineIcon />
                  Shell
                </DropdownMenuItem>
                {presets.map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    disabled={launchDisabled}
                    title={JSON.stringify([preset.executable, ...preset.args])}
                    onSelect={() =>
                      onCreateTerminal({
                        name: preset.name,
                        argv: [preset.executable, ...preset.args]
                      })
                    }
                  >
                    <CommandLineIcon />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate">{preset.name}</span>
                      <span className="truncate text-xs text-zinc-500">
                        {preset.executable}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
                {presetsLoading && (
                  <DropdownMenuItem disabled>Loading presets…</DropdownMenuItem>
                )}
                {presetsError && (
                  <DropdownMenuItem disabled>
                    Presets unavailable
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onSelect={() =>
                    onManagePresets(newTerminalTriggerRef.current)
                  }
                >
                  <Cog6ToothIcon />
                  Manage presets
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {terminal && snapshot.phase === 'ready' && !snapshot.controller && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="my-1 mr-1 ml-auto shrink-0"
              onClick={() => activeSession?.takeControl()}
            >
              Take control
            </Button>
          )}
        </header>
        {terminal ? (
          <div className="relative min-h-0 min-w-0 overflow-hidden">
            <TabsContent
              value={terminal.id}
              key={terminal.id}
              forceMount
              className="xterm-host absolute inset-0 min-h-0 min-w-0 overflow-hidden p-2.5 outline-none max-[700px]:p-1.5"
              ref={hostRef}
              onMouseDown={() => activeSession?.focus()}
            />
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
                      snapshot.fileTransfer.state === 'error'
                        ? 'alert'
                        : 'status'
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
              {snapshot.bellActive ? `Bell from ${visibleTitle}` : ''}
            </span>
          </div>
        ) : (
          <div className="empty-state grid min-h-0 place-items-center bg-[radial-gradient(circle_at_center,var(--color-zinc-900)_0,var(--color-zinc-950)_55%)] p-8">
            <div className="grid max-w-lg gap-3">
              <p className="eyebrow">No terminal open</p>
              <h1 className="text-balance text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">
                {worktree
                  ? 'Start a terminal for this worktree.'
                  : 'Choose a worktree.'}
              </h1>
              <p className="max-w-[52ch] text-base text-pretty text-zinc-400 sm:text-sm">
                {worktree
                  ? 'Use the New terminal menu to start a login shell or preset.'
                  : 'Select a worktree from the sidebar to view its terminals.'}
              </p>
            </div>
          </div>
        )}
        {terminal && (
          <div
            className="accessory-row hidden min-w-0 overflow-x-auto border-t border-white/8 bg-zinc-900 pt-1 pr-[env(safe-area-inset-right)] pb-[calc(0.25rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] max-[700px]:flex [&_button]:h-11 [&_button]:min-w-11 [&_button]:grow [&_button]:rounded-none [&_button]:border-r [&_button]:border-white/8 [&_button]:text-sm [&_button:last-child]:border-r-0"
            aria-label="Terminal accessory keys"
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
              onClick={() => setCtrl((value) => !value)}
            >
              Ctrl
            </Button>
            <Button
              variant="ghost"
              type="button"
              className={alt ? 'latched bg-cyan-950 text-cyan-100' : ''}
              onClick={() => setAlt((value) => !value)}
            >
              Alt
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => sendInput('\t')}
            >
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
            <Button
              variant="ghost"
              type="button"
              onClick={() => sendInput('\r')}
            >
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
    </Tabs>
  )
}
