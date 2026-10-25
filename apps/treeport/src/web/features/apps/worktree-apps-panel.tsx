import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject
} from 'react'
import { GlobeAltIcon, PlusIcon, XMarkIcon } from '@heroicons/react/16/solid'
import {
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightIcon
} from 'lucide-react'
import type { BrowserApp, WebApp, WebAppDefinition } from '@treeport/shared'
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
import { useReorderableItems } from '../../use-reorderable-items'
import { WebAppIcon } from '../web-apps/web-app-icon'
import { describeWebAppPermissions } from '../web-apps/web-app-permissions'
import { useToolPicker } from './tool-picker-context'
import { useWorkspaceSurfaceFocus } from './workspace-surface-focus-context'

interface ToolPickerActionsProps {
  definitions: WebAppDefinition[]
  definitionsLoading: boolean
  definitionsError: boolean
  launchDisabled: boolean
  commandRef?: RefObject<HTMLDivElement | null>
  onCreateBrowserApp: () => void
  onSelectWebApp: (definition: WebAppDefinition) => void
}

function definitionSource(definition: WebAppDefinition): string {
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
  onCreateBrowserApp,
  onSelectWebApp
}: ToolPickerActionsProps) {
  const definitionTitleCounts = new Map<string, number>()

  for (const definition of definitions) {
    definitionTitleCounts.set(
      definition.title,
      (definitionTitleCounts.get(definition.title) ?? 0) + 1
    )
  }

  if (commandRef) {
    return (
      <Command ref={commandRef} tabIndex={0} aria-label="Available tools">
        <CommandList>
          <CommandGroup>
            <CommandItem
              value="browser tab"
              aria-label="Browser tab"
              disabled={launchDisabled}
              onSelect={onCreateBrowserApp}
            >
              <GlobeAltIcon data-icon="inline-start" />
              <span className="min-w-0 flex-1 truncate">Browser tab</span>
            </CommandItem>
            {definitions.map((definition) => {
              const hasDuplicateTitle =
                (definitionTitleCounts.get(definition.title) ?? 0) > 1

              return (
                <CommandItem
                  key={definition.id}
                  value={`${definition.title} ${definitionSource(definition)}`}
                  aria-label={`${definition.title}, web app${
                    hasDuplicateTitle ? `, ${definitionSource(definition)}` : ''
                  }`}
                  disabled={launchDisabled}
                  onSelect={() => onSelectWebApp(definition)}
                >
                  <WebAppIcon icon={definition.icon} />
                  <span className="min-w-0 flex-1 truncate">
                    {definition.title}
                  </span>
                  {hasDuplicateTitle ? (
                    <span className="max-w-1/2 truncate text-xs text-zinc-500">
                      {definitionSource(definition)}
                    </span>
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
        {definitionsLoading ? (
          <p className="px-2 py-2 text-sm text-zinc-500" role="status">
            Loading web apps…
          </p>
        ) : null}
        {definitionsError ? (
          <p className="px-2 py-2 text-sm text-zinc-500" role="status">
            Web apps unavailable
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
        aria-label="Browser tab"
        disabled={launchDisabled}
        onClick={onCreateBrowserApp}
      >
        <GlobeAltIcon data-icon="inline-start" />
        <span className="min-w-0 flex-1 truncate">Browser tab</span>
      </Button>
      {definitions.map((definition) => {
        const hasDuplicateTitle =
          (definitionTitleCounts.get(definition.title) ?? 0) > 1

        return (
          <Button
            key={definition.id}
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start px-2 py-1.5 text-left"
            aria-label={`${definition.title}, web app${
              hasDuplicateTitle ? `, ${definitionSource(definition)}` : ''
            }`}
            disabled={launchDisabled}
            onClick={() => onSelectWebApp(definition)}
          >
            <WebAppIcon icon={definition.icon} />
            <span className="min-w-0 flex-1 truncate">{definition.title}</span>
            {hasDuplicateTitle ? (
              <span className="max-w-1/2 truncate text-xs text-zinc-500">
                {definitionSource(definition)}
              </span>
            ) : null}
          </Button>
        )
      })}
      {definitionsLoading ? (
        <p className="px-2 py-2 text-sm text-zinc-500" role="status">
          Loading web apps…
        </p>
      ) : null}
      {definitionsError ? (
        <p className="px-2 py-2 text-sm text-zinc-500" role="status">
          Web apps unavailable
        </p>
      ) : null}
    </div>
  )
}

function BrowserAppFavicon({ url }: { url: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  return url && failedUrl !== url ? (
    <img
      src={url}
      alt=""
      data-icon="inline-start"
      className="size-4 shrink-0 object-contain [color-scheme:dark]"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(url)}
    />
  ) : (
    <GlobeAltIcon data-icon="inline-start" />
  )
}

function BrowserAppLoadingIcon() {
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

export function AppsPanelToggle({
  open,
  fullView,
  disabled,
  onToggle,
  onToggleFullView
}: {
  open: boolean
  fullView: boolean
  disabled: boolean
  onToggle: () => void
  onToggleFullView: () => void
}) {
  const shortcut = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    ? '⌥⌘B'
    : 'Ctrl+Alt+B'

  return (
    <div className="absolute top-1 right-1 z-40 flex items-center gap-1">
      {open ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={fullView ? 'secondary' : 'ghost'}
              size="icon-sm"
              className="max-[701px]:hidden"
              aria-label={fullView ? 'Exit full view' : 'Enter full view'}
              aria-pressed={fullView}
              aria-controls="worktree-apps-panel"
              disabled={disabled}
              onClick={onToggleFullView}
            >
              {fullView ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" sideOffset={8}>
            {fullView ? 'Exit full view' : 'Enter full view'}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={open ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label="Toggle apps panel"
            aria-expanded={open}
            aria-controls="worktree-apps-panel"
            disabled={disabled}
            onClick={onToggle}
          >
            <PanelRightIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" sideOffset={8}>
          Toggle apps panel · {shortcut}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

const MIN_APPS_PANEL_WIDTH = 320
const MIN_TERMINAL_WIDTH = 96
const APPS_PANEL_WIDTH_STORAGE_PREFIX = 'treeport-side-panel-width:'

function appsPanelMaxWidth(rail: HTMLDivElement): number {
  const layoutWidth =
    rail.parentElement?.parentElement?.parentElement?.getBoundingClientRect()
      .width

  return Math.max(
    MIN_APPS_PANEL_WIDTH,
    (layoutWidth ?? window.innerWidth) - MIN_TERMINAL_WIDTH
  )
}

function clampAppsPanelWidth(width: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(MIN_APPS_PANEL_WIDTH, width))
}

function AppsPanelResizeRail({
  width,
  defaultWidth,
  onWidthChange
}: {
  width: number
  defaultWidth: number
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
      maxWidth: appsPanelMaxWidth(event.currentTarget)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeOrigin.current) {
      return
    }

    onWidthChange(
      clampAppsPanelWidth(
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
    const maxWidth = appsPanelMaxWidth(event.currentTarget)

    let nextWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? width

    if (event.key === 'ArrowLeft') {
      nextWidth += event.shiftKey ? 32 : 16
    } else if (event.key === 'ArrowRight') {
      nextWidth -= event.shiftKey ? 32 : 16
    } else if (event.key === 'Home') {
      nextWidth = MIN_APPS_PANEL_WIDTH
    } else if (event.key === 'End') {
      nextWidth = maxWidth
    } else {
      return
    }

    event.preventDefault()
    onWidthChange(clampAppsPanelWidth(nextWidth, maxWidth))
  }

  return (
    <div
      className="absolute inset-y-0 left-0 z-30 hidden w-3 -translate-x-1/2 touch-none cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-white/8 after:absolute after:top-1/2 after:left-1/2 after:h-8 after:w-1 after:-translate-1/2 after:rounded-full after:bg-zinc-700 hover:before:w-0.5 hover:before:bg-accent-400/60 hover:after:bg-accent-400 focus-visible:before:w-0.5 focus-visible:before:bg-accent-400 focus-visible:after:bg-accent-400 min-[701px]:block"
      role="separator"
      aria-label="Resize apps panel"
      aria-orientation="vertical"
      aria-controls="worktree-apps-panel"
      aria-valuemin={MIN_APPS_PANEL_WIDTH}
      aria-valuemax={Math.max(
        MIN_APPS_PANEL_WIDTH,
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
      onDoubleClick={() => onWidthChange(defaultWidth)}
    />
  )
}

export function WorktreeAppsPanel({
  worktreeId,
  worktreeName,
  visible,
  fullView,
  tools,
  activeAppId,
  webAppRuntimeTitles,
  browserAppLoading,
  browserAppFavicons,
  definitions,
  definitionsLoading,
  definitionsError,
  launchDisabled,
  children,
  onSelectApp,
  onCloseApp,
  onReorderApps,
  onCreateBrowserApp,
  onOpenWebApp,
  onFocusSurface
}: {
  worktreeId: string
  worktreeName: string
  visible: boolean
  fullView: boolean
  tools: Array<BrowserApp | WebApp>
  activeAppId: string | null
  webAppRuntimeTitles: Record<string, string>
  browserAppLoading: Record<string, boolean>
  browserAppFavicons: Record<string, string | null>
  definitions: WebAppDefinition[]
  definitionsLoading: boolean
  definitionsError: boolean
  launchDisabled: boolean
  children: ReactNode
  onSelectApp: (app: BrowserApp | WebApp) => void
  onCloseApp: (app: BrowserApp | WebApp, trigger?: HTMLElement) => void
  onReorderApps: (appIds: string[]) => void
  onCreateBrowserApp: () => void
  onOpenWebApp: (definition: WebAppDefinition) => void
  onFocusSurface: () => void
}) {
  const {
    open: pickerOpen,
    setOpen: setPickerOpen,
    dismiss: dismissPicker
  } = useToolPicker()

  const { focusedSurface, emptyToolFocusRevision } = useWorkspaceSurfaceFocus()
  const focused = focusedSurface === 'tool'

  const {
    orderedItems: orderedTools,
    announcement: reorderAnnouncement,
    getItemProps: getReorderItemProps,
    getHandleProps: getReorderHandleProps
  } = useReorderableItems({
    items: tools,
    orientation: 'horizontal',
    onReorder: onReorderApps
  })

  const toolPickerCommandRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLElement>(null)
  const restoredEmptyFocusRevisionRef = useRef(0)

  const [preferredWidthByWorktree, setPreferredWidthByWorktree] = useState<
    Record<string, number>
  >({})

  const savedWidth = Number.parseInt(
    localStorage.getItem(`${APPS_PANEL_WIDTH_STORAGE_PREFIX}${worktreeId}`) ??
      '',
    10
  )

  const [layoutWidth, setLayoutWidth] = useState(() => window.innerWidth)
  const defaultAppsPanelWidth = layoutWidth / 2

  const preferredAppsPanelWidth =
    preferredWidthByWorktree[worktreeId] ??
    (Number.isFinite(savedWidth)
      ? Math.max(MIN_APPS_PANEL_WIDTH, savedWidth)
      : defaultAppsPanelWidth)

  const maximumAppsPanelWidth = Math.max(
    MIN_APPS_PANEL_WIDTH,
    layoutWidth - MIN_TERMINAL_WIDTH
  )

  const appsPanelWidth = clampAppsPanelWidth(
    preferredAppsPanelWidth,
    maximumAppsPanelWidth
  )

  const setAndSaveAppsPanelWidth = (width: number) => {
    const nextWidth = Math.max(MIN_APPS_PANEL_WIDTH, width)
    setPreferredWidthByWorktree((current) => ({
      ...current,
      [worktreeId]: nextWidth
    }))
    localStorage.setItem(
      `${APPS_PANEL_WIDTH_STORAGE_PREFIX}${worktreeId}`,
      String(nextWidth)
    )
  }

  const [permissionDefinition, setPermissionDefinition] =
    useState<WebAppDefinition | null>(null)

  const permissionSource = permissionDefinition
    ? permissionDefinition.source.type === 'package'
      ? `${permissionDefinition.source.scope} package ${permissionDefinition.source.source}`
      : 'this project'
    : ''

  const permissionDescription = describeWebAppPermissions(
    permissionDefinition?.permissions ?? []
  )

  const createBrowserApp = () => {
    dismissPicker()
    onCreateBrowserApp()
  }

  const selectWebApp = (definition: WebAppDefinition) => {
    dismissPicker()

    if (definition.permissions.length > 0 && !definition.permissionsGranted) {
      setPermissionDefinition(definition)

      return
    }

    onOpenWebApp(definition)
  }

  useLayoutEffect(() => {
    const layout = paneRef.current?.parentElement?.parentElement

    if (!layout) {
      return
    }

    const updateLayoutWidth = () => {
      setLayoutWidth(layout.getBoundingClientRect().width)
    }

    const observer = new ResizeObserver(updateLayoutWidth)
    observer.observe(layout)
    updateLayoutWidth()

    return () => observer.disconnect()
  }, [])

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
      onCreateBrowserApp={createBrowserApp}
      onSelectWebApp={selectWebApp}
    />
  )

  return (
    <div
      className={cn(
        'grid min-h-0 min-w-0 w-[var(--apps-panel-width)] max-[701px]:absolute max-[701px]:inset-0 max-[701px]:z-20 max-[701px]:w-full',
        !visible && 'pointer-events-none absolute inset-0 opacity-0'
      )}
      style={{ '--apps-panel-width': `${appsPanelWidth}px` }}
    >
      <section
        ref={paneRef}
        id="worktree-apps-panel"
        className={cn(
          'relative grid min-h-0 min-w-0 border-l border-white/8 bg-zinc-950 outline-none max-[701px]:border-l-0',
          tools.length > 0
            ? 'grid-rows-[auto_minmax(0,1fr)]'
            : 'grid-rows-[minmax(0,1fr)]',
          fullView && 'absolute inset-0 z-20 border-l-0'
        )}
        role="region"
        tabIndex={-1}
        aria-label={`${worktreeName} apps panel`}
        aria-hidden={visible ? undefined : true}
        inert={visible ? undefined : true}
        onPointerDownCapture={onFocusSurface}
        onFocusCapture={onFocusSurface}
      >
        {!fullView ? (
          <AppsPanelResizeRail
            width={appsPanelWidth}
            defaultWidth={defaultAppsPanelWidth}
            onWidthChange={setAndSaveAppsPanelWidth}
          />
        ) : null}
        {tools.length > 0 ? (
          <div className="flex min-w-0 items-center gap-1.5 border-b border-white/8 bg-zinc-900 py-1.5 pr-18 pl-2 max-[701px]:pr-10">
            <div
              className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              role="tablist"
              aria-label={`${worktreeName} tool tabs`}
            >
              {orderedTools.map((app, index) => {
                const title =
                  app.kind === 'web'
                    ? (webAppRuntimeTitles[app.id] ?? app.title)
                    : app.title

                const active = app.id === activeAppId

                const loading =
                  app.kind === 'browser' && Boolean(browserAppLoading[app.id])

                return (
                  <div
                    key={app.id}
                    {...getReorderItemProps(app.id)}
                    className={cn(
                      'group/tool relative flex min-w-28 max-w-56 shrink-0 items-center rounded-md',
                      active
                        ? 'bg-white/8 hover:bg-white/10 has-[button:active]:bg-white/14'
                        : 'hover:bg-white/6 has-[button:active]:bg-white/10'
                    )}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-w-0 flex-1 justify-start pr-8 hover:bg-transparent hover:text-zinc-400 active:bg-transparent"
                      role="tab"
                      aria-selected={active}
                      aria-keyshortcuts={[
                        focused && index < 9 ? `Meta+${index + 1}` : null,
                        'Alt+Shift+ArrowLeft',
                        'Alt+Shift+ArrowRight'
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={
                        app.kind === 'browser'
                          ? `${
                              title === 'Browser'
                                ? 'Browser'
                                : `${title}, Browser`
                            }${loading ? ', loading' : ''}`
                          : `${title}, web app`
                      }
                      title={title}
                      onClick={() => onSelectApp(app)}
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
                        onCloseApp(app, event.currentTarget)
                      }}
                      {...getReorderHandleProps(app.id)}
                    >
                      {app.kind === 'browser' ? (
                        loading ? (
                          <BrowserAppLoadingIcon />
                        ) : (
                          <BrowserAppFavicon
                            url={browserAppFavicons[app.id] ?? null}
                          />
                        )
                      ) : (
                        <WebAppIcon
                          icon={
                            definitions.find(
                              (definition) => definition.id === app.definitionId
                            )?.icon ?? null
                          }
                        />
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
                      onClick={(event) => onCloseApp(app, event.currentTarget)}
                    >
                      <XMarkIcon />
                    </Button>
                  </div>
                )
              })}
              <span className="sr-only" role="status">
                {reorderAnnouncement}
              </span>
            </div>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open another app"
                >
                  <PlusIcon />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-[min(17rem,calc(100vw-1rem))] p-0"
                aria-label="Open an app"
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
                  onCreateBrowserApp={createBrowserApp}
                  onSelectWebApp={selectWebApp}
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
              <EmptyTitle>Open an app</EmptyTitle>
              <EmptyDescription>
                Open Browser or a web app beside the terminal.
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
              <AlertDialogTitle>Allow privileged app access?</AlertDialogTitle>
              <AlertDialogDescription>
                {`${
                  permissionDefinition?.title ?? 'This app'
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
                    onOpenWebApp(definition)
                  }
                }}
              >
                Allow and open
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  )
}
