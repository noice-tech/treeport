import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject
} from 'react'
import {
  GlobeAltIcon,
  PlusIcon,
  WindowIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import { LoaderCircleIcon, PanelRightIcon } from 'lucide-react'
import type {
  BrowserPanel,
  WebPanel,
  WebPanelDefinition
} from '@treeport/shared'
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
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList
} from '../../components/ui/command'
import { Empty, EmptyDescription, EmptyTitle } from '../../components/ui/empty'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '../../components/ui/tooltip'
import { cn } from '../../lib/utils'
import { describeWebPanelPermissions } from '../web-panels/web-panel-permissions'
import { useToolPicker } from './tool-picker-context'
import { useWorkspaceSurfaceFocus } from './workspace-surface-focus-context'

interface ToolPickerActionsProps {
  definitions: WebPanelDefinition[]
  definitionsLoading: boolean
  definitionsError: boolean
  launchDisabled: boolean
  commandRef?: RefObject<HTMLDivElement | null>
  onCreateBrowserPanel: () => void
  onSelectWebPanel: (definition: WebPanelDefinition) => void
}

function definitionSource(definition: WebPanelDefinition): string {
  return definition.source.type === 'project'
    ? 'Project'
    : `${definition.source.scope === 'project' ? 'Project' : 'Global'} · ${
        definition.source.packageId
      }`
}

function ToolPickerActions({
  definitions,
  definitionsLoading,
  definitionsError,
  launchDisabled,
  commandRef,
  onCreateBrowserPanel,
  onSelectWebPanel
}: ToolPickerActionsProps) {
  if (commandRef) {
    return (
      <Command ref={commandRef} tabIndex={0} aria-label="Available tools">
        <CommandList>
          <CommandGroup>
            <CommandItem
              value="browser"
              aria-label="Browser, new tab"
              disabled={launchDisabled}
              onSelect={onCreateBrowserPanel}
            >
              <GlobeAltIcon data-icon="inline-start" />
              <span className="min-w-0 flex-1 truncate">Browser</span>
              <span className="text-xs text-zinc-500">New tab</span>
            </CommandItem>
            {definitions.map((definition) => (
              <CommandItem
                key={definition.id}
                value={`${definition.title} ${definitionSource(definition)}`}
                aria-label={`${definition.title}, web panel, ${definitionSource(
                  definition
                )}`}
                disabled={launchDisabled}
                onSelect={() => onSelectWebPanel(definition)}
              >
                <WindowIcon data-icon="inline-start" />
                <span className="min-w-0 flex-1 truncate">
                  {definition.title}
                </span>
                <span className="max-w-1/2 truncate text-xs text-zinc-500">
                  {definitionSource(definition)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
        {definitionsLoading ? (
          <p className="px-2 py-2 text-sm text-zinc-500" role="status">
            Loading web panels…
          </p>
        ) : null}
        {definitionsError ? (
          <p className="px-2 py-2 text-sm text-zinc-500" role="status">
            Web panels unavailable
          </p>
        ) : null}
      </Command>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-1" aria-label="Available tools">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start px-2 py-1.5 text-left"
        aria-label="Browser, new tab"
        disabled={launchDisabled}
        onClick={onCreateBrowserPanel}
      >
        <GlobeAltIcon data-icon="inline-start" />
        <span className="min-w-0 flex-1 truncate">Browser</span>
        <span className="text-xs text-zinc-500">New tab</span>
      </Button>
      {definitions.map((definition) => (
        <Button
          key={definition.id}
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start px-2 py-1.5 text-left"
          aria-label={`${definition.title}, web panel, ${definitionSource(
            definition
          )}`}
          disabled={launchDisabled}
          onClick={() => onSelectWebPanel(definition)}
        >
          <WindowIcon data-icon="inline-start" />
          <span className="min-w-0 flex-1 truncate">{definition.title}</span>
          <span className="max-w-1/2 truncate text-xs text-zinc-500">
            {definitionSource(definition)}
          </span>
        </Button>
      ))}
      {definitionsLoading ? (
        <p className="px-2 py-2 text-sm text-zinc-500" role="status">
          Loading web panels…
        </p>
      ) : null}
      {definitionsError ? (
        <p className="px-2 py-2 text-sm text-zinc-500" role="status">
          Web panels unavailable
        </p>
      ) : null}
    </div>
  )
}

function BrowserPanelLoadingIcon() {
  const [showSpinner, setShowSpinner] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setShowSpinner(true), 200)
    return () => window.clearTimeout(timer)
  }, [])

  return showSpinner ? (
    <LoaderCircleIcon
      className="shrink-0 text-zinc-500 motion-safe:animate-spin"
      aria-hidden="true"
    />
  ) : (
    <GlobeAltIcon className="shrink-0 fill-zinc-500" aria-hidden="true" />
  )
}

export function SidePanelToggle({
  open,
  disabled,
  onToggle
}: {
  open: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const shortcut = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    ? '⌥⌘B'
    : 'Ctrl+Alt+B'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={open ? 'secondary' : 'ghost'}
          size="icon-sm"
          className="absolute top-1 right-1 z-40"
          aria-label="Toggle side panel"
          aria-expanded={open}
          aria-controls="worktree-side-panel"
          disabled={disabled}
          onClick={onToggle}
        >
          <PanelRightIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">
        Toggle side panel · {shortcut}
      </TooltipContent>
    </Tooltip>
  )
}

const MIN_SIDE_PANEL_WIDTH = 320
const MIN_TERMINAL_WIDTH = 96
const DEFAULT_SIDE_PANEL_WIDTH = 560
const SIDE_PANEL_WIDTH_STORAGE_KEY = 'treeport-side-panel-width'

function sidePanelMaxWidth(rail: HTMLDivElement): number {
  const layoutWidth =
    rail.parentElement?.parentElement?.getBoundingClientRect().width
  return Math.max(
    MIN_SIDE_PANEL_WIDTH,
    (layoutWidth ?? window.innerWidth) - MIN_TERMINAL_WIDTH
  )
}

function clampSidePanelWidth(width: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(MIN_SIDE_PANEL_WIDTH, width))
}

function SidePanelResizeRail({
  width,
  onWidthChange
}: {
  width: number
  onWidthChange: (width: number) => void
}) {
  const resizeOrigin = useRef<{
    pointerX: number
    width: number
    maxWidth: number
  } | null>(null)

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    resizeOrigin.current = {
      pointerX: event.clientX,
      width:
        event.currentTarget.parentElement?.getBoundingClientRect().width ??
        width,
      maxWidth: sidePanelMaxWidth(event.currentTarget)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeOrigin.current) {
      return
    }

    onWidthChange(
      clampSidePanelWidth(
        resizeOrigin.current.width +
          resizeOrigin.current.pointerX -
          event.clientX,
        resizeOrigin.current.maxWidth
      )
    )
  }
  const stopResize = (event: PointerEvent<HTMLDivElement>) => {
    resizeOrigin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const maxWidth = sidePanelMaxWidth(event.currentTarget)
    let nextWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? width
    if (event.key === 'ArrowLeft') {
      nextWidth += event.shiftKey ? 32 : 16
    } else if (event.key === 'ArrowRight') {
      nextWidth -= event.shiftKey ? 32 : 16
    } else if (event.key === 'Home') {
      nextWidth = MIN_SIDE_PANEL_WIDTH
    } else if (event.key === 'End') {
      nextWidth = maxWidth
    } else {
      return
    }

    event.preventDefault()
    onWidthChange(clampSidePanelWidth(nextWidth, maxWidth))
  }

  return (
    <div
      className="absolute inset-y-0 left-0 z-30 hidden w-3 -translate-x-1/2 touch-none cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-white/8 after:absolute after:top-1/2 after:left-1/2 after:h-8 after:w-1 after:-translate-1/2 after:rounded-full after:bg-zinc-700 hover:before:w-0.5 hover:before:bg-cyan-400/60 hover:after:bg-cyan-400 focus-visible:before:w-0.5 focus-visible:before:bg-cyan-400 focus-visible:after:bg-cyan-400 min-[701px]:block"
      role="separator"
      aria-label="Resize side panel"
      aria-orientation="vertical"
      aria-controls="worktree-side-panel"
      aria-valuemin={MIN_SIDE_PANEL_WIDTH}
      aria-valuemax={Math.max(
        MIN_SIDE_PANEL_WIDTH,
        window.innerWidth - MIN_TERMINAL_WIDTH
      )}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      title="Drag to resize; double-click to reset"
      tabIndex={0}
      onPointerDown={startResize}
      onPointerMove={continueResize}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => onWidthChange(DEFAULT_SIDE_PANEL_WIDTH)}
    />
  )
}

export function WorktreeToolPane({
  worktreeName,
  visible,
  tools,
  activePanelId,
  webPanelRuntimeTitles,
  browserPanelLoading,
  definitions,
  definitionsLoading,
  definitionsError,
  launchDisabled,
  children,
  onSelectPanel,
  onClosePanel,
  onCreateBrowserPanel,
  onOpenWebPanel,
  onFocusSurface
}: {
  worktreeName: string
  visible: boolean
  tools: Array<BrowserPanel | WebPanel>
  activePanelId: string | null
  webPanelRuntimeTitles: Record<string, string>
  browserPanelLoading: Record<string, boolean>
  definitions: WebPanelDefinition[]
  definitionsLoading: boolean
  definitionsError: boolean
  launchDisabled: boolean
  children: ReactNode
  onSelectPanel: (panel: BrowserPanel | WebPanel) => void
  onClosePanel: (panel: BrowserPanel | WebPanel, trigger?: HTMLElement) => void
  onCreateBrowserPanel: () => void
  onOpenWebPanel: (definition: WebPanelDefinition) => void
  onFocusSurface: () => void
}) {
  const {
    open: pickerOpen,
    setOpen: setPickerOpen,
    dismiss: dismissPicker
  } = useToolPicker()
  const { focusedSurface, emptyToolFocusRevision } = useWorkspaceSurfaceFocus()
  const focused = focusedSurface === 'tool'
  const toolPickerCommandRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLElement>(null)
  const restoredEmptyFocusRevisionRef = useRef(0)
  const [sidePanelWidth, setSidePanelWidth] = useState(() => {
    const savedWidth = Number.parseInt(
      localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY) ?? '',
      10
    )
    return Number.isFinite(savedWidth)
      ? clampSidePanelWidth(
          savedWidth,
          Math.max(MIN_SIDE_PANEL_WIDTH, window.innerWidth - MIN_TERMINAL_WIDTH)
        )
      : DEFAULT_SIDE_PANEL_WIDTH
  })
  const setAndSaveSidePanelWidth = (width: number) => {
    setSidePanelWidth(width)
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(width))
  }
  const [permissionDefinition, setPermissionDefinition] =
    useState<WebPanelDefinition | null>(null)
  const permissionSource = permissionDefinition
    ? permissionDefinition.source.type === 'package'
      ? `${permissionDefinition.source.scope} package ${permissionDefinition.source.source}`
      : 'this project'
    : ''
  const permissionDescription = describeWebPanelPermissions(
    permissionDefinition?.permissions ?? []
  )
  const createBrowserPanel = () => {
    dismissPicker()
    onCreateBrowserPanel()
  }
  const selectWebPanel = (definition: WebPanelDefinition) => {
    dismissPicker()
    if (definition.permissions.length > 0 && !definition.permissionsGranted) {
      setPermissionDefinition(definition)
      return
    }

    onOpenWebPanel(definition)
  }
  useEffect(() => {
    if (
      emptyToolFocusRevision <= restoredEmptyFocusRevisionRef.current ||
      tools.length > 0 ||
      !visible
    ) {
      return
    }

    restoredEmptyFocusRevisionRef.current = emptyToolFocusRevision
    const frame = window.requestAnimationFrame(() => {
      const pane = paneRef.current
      if (!pane || pane.contains(document.activeElement)) {
        return
      }

      const firstAction = pane.querySelector<HTMLButtonElement>(
        'button:not(:disabled)'
      )
      if (firstAction) {
        firstAction.focus()
      } else {
        pane.focus()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [emptyToolFocusRevision, tools.length, visible])

  const actions = (
    <ToolPickerActions
      definitions={definitions}
      definitionsLoading={definitionsLoading}
      definitionsError={definitionsError}
      launchDisabled={launchDisabled}
      onCreateBrowserPanel={createBrowserPanel}
      onSelectWebPanel={selectWebPanel}
    />
  )

  return (
    <section
      ref={paneRef}
      id="worktree-side-panel"
      className={cn(
        'relative grid min-h-0 min-w-0 w-[var(--side-panel-width)] border-l border-white/8 bg-zinc-950 outline-none max-[700px]:w-full max-[700px]:border-l-0',
        tools.length > 0
          ? 'grid-rows-[auto_minmax(0,1fr)]'
          : 'grid-rows-[minmax(0,1fr)]',
        !visible && 'pointer-events-none absolute inset-0 opacity-0'
      )}
      style={
        // SAFETY: This custom property contains a clamped CSS pixel value.
        { '--side-panel-width': `${sidePanelWidth}px` } as CSSProperties
      }
      role="region"
      tabIndex={-1}
      aria-label={`${worktreeName} tool tab group`}
      aria-hidden={visible ? undefined : true}
      inert={visible ? undefined : true}
      onPointerDownCapture={onFocusSurface}
      onFocusCapture={onFocusSurface}
    >
      <SidePanelResizeRail
        width={sidePanelWidth}
        onWidthChange={setAndSaveSidePanelWidth}
      />
      {tools.length > 0 ? (
        <div className="flex min-w-0 items-center gap-1.5 border-b border-white/8 bg-zinc-900 py-1.5 pr-10 pl-2">
          <div
            className="flex min-w-0 items-center gap-1.5 overflow-x-auto"
            role="tablist"
            aria-label={`${worktreeName} tool tabs`}
          >
            {tools.map((panel, index) => {
              const title =
                panel.kind === 'web'
                  ? (webPanelRuntimeTitles[panel.id] ?? panel.title)
                  : panel.title
              const active = panel.id === activePanelId
              const loading =
                panel.kind === 'browser' &&
                Boolean(browserPanelLoading[panel.id])
              return (
                <div
                  key={panel.id}
                  className={cn(
                    'group/tool relative flex min-w-28 max-w-56 shrink-0 items-center rounded-md',
                    active ? 'bg-white/8 hover:bg-white/10' : 'hover:bg-white/6'
                  )}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-w-0 flex-1 justify-start pr-8 hover:bg-transparent hover:text-zinc-400"
                    role="tab"
                    aria-selected={active}
                    aria-keyshortcuts={
                      focused && index < 9 ? `Meta+${index + 1}` : undefined
                    }
                    aria-label={
                      panel.kind === 'browser'
                        ? `${
                            title === 'Browser'
                              ? 'Browser'
                              : `${title}, Browser`
                          }${loading ? ', loading' : ''}`
                        : `${title}, web panel`
                    }
                    title={title}
                    onClick={() => onSelectPanel(panel)}
                    onMouseDown={(event) => {
                      if (event.button === 1) {
                        event.preventDefault()
                      }
                    }}
                    onAuxClick={(event) => {
                      if (event.button !== 1) {
                        return
                      }

                      event.preventDefault()
                      onClosePanel(panel, event.currentTarget)
                    }}
                  >
                    {panel.kind === 'browser' ? (
                      loading ? (
                        <BrowserPanelLoadingIcon />
                      ) : (
                        <GlobeAltIcon data-icon="inline-start" />
                      )
                    ) : (
                      <WindowIcon data-icon="inline-start" />
                    )}
                    <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%_-_1rem),transparent)]">
                      {title}
                    </span>
                    {index < 9 ? (
                      <kbd
                        className={cn(
                          'font-sans text-[0.6875rem] font-normal text-zinc-500 tabular-nums group-hover/tool:opacity-0 group-focus-within/tool:opacity-0 max-[700px]:hidden pointer-coarse:hidden',
                          !focused && 'invisible'
                        )}
                        aria-hidden="true"
                      >
                        ⌘{index + 1}
                      </kbd>
                    ) : null}
                  </Button>
                  <Button
                    type="button"
                    variant="link"
                    size="icon-sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100 pointer-coarse:opacity-100"
                    aria-label={`Close ${title}`}
                    onClick={(event) =>
                      onClosePanel(panel, event.currentTarget)
                    }
                  >
                    <XMarkIcon />
                  </Button>
                </div>
              )
            })}
          </div>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Open another tool"
              >
                <PlusIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[min(17rem,calc(100vw-1rem))] p-0"
              aria-label="Open a tool"
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                toolPickerCommandRef.current?.focus()
              }}
            >
              <ToolPickerActions
                definitions={definitions}
                definitionsLoading={definitionsLoading}
                definitionsError={definitionsError}
                launchDisabled={launchDisabled}
                commandRef={toolPickerCommandRef}
                onCreateBrowserPanel={createBrowserPanel}
                onSelectWebPanel={selectWebPanel}
              />
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
      <div
        className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]"
        onPointerDownCapture={dismissPicker}
        onFocusCapture={dismissPicker}
      >
        {tools.length === 0 ? (
          <Empty className="mx-auto w-full max-w-md items-stretch text-left">
            <EmptyTitle>Open a tool</EmptyTitle>
            <EmptyDescription>
              Open Browser or a web panel beside the terminal.
            </EmptyDescription>
            <div className="mt-2">{actions}</div>
          </Empty>
        ) : null}
        {children}
      </div>
      <AlertDialog
        open={permissionDefinition !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPermissionDefinition(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow privileged panel access?</AlertDialogTitle>
            <AlertDialogDescription>
              {`${
                permissionDefinition?.title ?? 'This panel'
              } is from ${permissionSource}. ${permissionDescription}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const definition = permissionDefinition
                setPermissionDefinition(null)
                if (definition) {
                  onOpenWebPanel(definition)
                }
              }}
            >
              Allow and open
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
