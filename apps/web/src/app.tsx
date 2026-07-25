import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import { XMarkIcon } from '@heroicons/react/16/solid'
import type {
  ProjectRecord,
  TerminalRecord,
  WorktreeRecord
} from '@treeport/shared'
import { Button } from './components/ui/button'
import {
  ActionModal,
  type ActionModalState
} from './features/dialogs/action-modal'
import { useBellNotifications } from './features/notifications/use-bell-notifications'
import { useProjectWorkflows } from './features/projects/project-workflows'
import { WorkspaceSidebar } from './features/sidebar/workspace-sidebar'
import { TerminalWorkspace } from './features/terminals/terminal-workspace'
import { useWorktreeWorkflows } from './features/worktrees/worktree-workflows'
import { focusableElements, trapTabKey } from './lib/focus'
import { cn } from './lib/utils'
import { METADATA_DEGRADED_GRACE_MS } from './metadata-sync'
import { useProjectEventsBridge } from './project-events-bridge'
import {
  projectsQueryOptions,
  terminalPresetsQueryOptions
} from './project-metadata'
import { terminalSessions, type TerminalProgress } from './terminal-session'
import {
  LAST_PROJECT_TERMINAL_STORAGE_PREFIX,
  LAST_WORKSPACE_ROUTE_STORAGE_KEY,
  LEGACY_ACTIVE_PROJECT_STORAGE_KEY,
  LEGACY_TERMINAL_STORAGE_KEY,
  TASKTTY_LAST_PROJECT_TERMINAL_STORAGE_PREFIX,
  TASKTTY_LAST_WORKSPACE_ROUTE_STORAGE_KEY,
  legacyResumePath,
  resolveWorkspaceRoute,
  targetForProject,
  targetForTerminal,
  targetForWorktree
} from './workspace-navigation'
import { useWorkspaceNavigate } from './workspace-router-navigation'

const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 420
const DEFAULT_SIDEBAR_WIDTH = 272
const EMPTY_BELL_ATTENTION: ReadonlySet<string> = new Set()
const EMPTY_FOREGROUND_PROCESSES: ReadonlySet<string> = new Set()
const EMPTY_RUNTIME_TITLES: ReadonlyMap<string, string> = new Map()
const EMPTY_TERMINAL_PROGRESS: ReadonlyMap<string, TerminalProgress> = new Map()
const ERROR_TOAST_DURATION_MS = 5_000

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

export default function App() {
  const desktopBridge = window.treeportDesktop ?? window.taskttyDesktop
  const navigateToWorkspace = useWorkspaceNavigate()
  const location = useLocation()
  const projectsQuery = useQuery(projectsQueryOptions)
  const projects = projectsQuery.data ?? []
  const presetsQuery = useQuery(terminalPresetsQueryOptions)
  const presets = presetsQuery.data ?? []
  const storedResumePath =
    localStorage.getItem(LAST_WORKSPACE_ROUTE_STORAGE_KEY) ??
    localStorage.getItem(TASKTTY_LAST_WORKSPACE_ROUTE_STORAGE_KEY)
  const legacyPath = legacyResumePath(
    projects,
    localStorage.getItem(LEGACY_TERMINAL_STORAGE_KEY),
    localStorage.getItem(LEGACY_ACTIVE_PROJECT_STORAGE_KEY)
  )
  const workspaceResolution = projectsQuery.data
    ? resolveWorkspaceRoute(
        projects,
        location.pathname,
        storedResumePath ?? legacyPath
      )
    : null
  const selectedProject = workspaceResolution?.selection.project ?? null
  const selectedWorktree = workspaceResolution?.selection.worktree ?? null
  const selectedTerminal = workspaceResolution?.selection.terminal ?? null
  const selectedTerminalId = selectedTerminal?.id ?? null
  const activeProject = selectedProject
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [desktopFullscreen, setDesktopFullscreen] = useState(false)
  const desktopPlatform = desktopBridge?.platform
  const showDesktopTitlebar =
    desktopBridge !== undefined &&
    !(desktopPlatform === 'darwin' && desktopFullscreen)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<ActionModalState>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth =
      localStorage.getItem('treeport-sidebar-width') ??
      localStorage.getItem('tasktty-sidebar-width')
    if (storedWidth !== null) {
      localStorage.setItem('treeport-sidebar-width', storedWidth)
      localStorage.setItem('tasktty-sidebar-width', storedWidth)
    }

    const savedWidth = Number.parseInt(storedWidth ?? '', 10)
    return Number.isFinite(savedWidth)
      ? clampSidebarWidth(savedWidth)
      : DEFAULT_SIDEBAR_WIDTH
  })
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const eventsDisconnected = useProjectEventsBridge(projectsQuery.data)
  const [showSyncDegraded, setShowSyncDegraded] = useState(false)
  const resizeOrigin = useRef<{ pointerX: number; width: number } | null>(null)
  const drawerRef = useRef<HTMLElement | null>(null)
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const projectSwitcherTriggerRef = useRef<HTMLButtonElement | null>(null)
  const projectSwitcherDismissedIntoTerminalRef = useRef(false)
  const modalTriggerRef = useRef<HTMLElement | null>(null)
  const openModal = (
    nextModal: Exclude<ActionModalState, null>,
    trigger?: HTMLElement
  ) => {
    modalTriggerRef.current =
      trigger ?? (document.activeElement as HTMLElement | null)
    setModal(nextModal)
  }

  useEffect(() => {
    if (!error) {
      return
    }

    const timer = window.setTimeout(
      () => setError(null),
      ERROR_TOAST_DURATION_MS
    )
    return () => window.clearTimeout(timer)
  }, [error])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const usesMacKeyboard = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      const modifierPressed = usesMacKeyboard
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey

      if (
        event.isComposing ||
        event.key.toLocaleLowerCase() !== 'p' ||
        !event.shiftKey ||
        event.altKey ||
        !modifierPressed ||
        modal
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      if (isMobile) {
        setDrawerOpen(true)
      }

      setProjectSwitcherOpen(true)
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [isMobile, modal])

  useEffect(() => {
    if (!workspaceResolution || workspaceResolution.canonical) {
      return
    }

    void navigateToWorkspace(workspaceResolution.target, true)
  }, [
    navigateToWorkspace,
    workspaceResolution?.canonical,
    workspaceResolution?.target.pathname
  ])

  useEffect(() => {
    if (!workspaceResolution?.canonical) {
      return
    }

    localStorage.removeItem(LEGACY_ACTIVE_PROJECT_STORAGE_KEY)
    localStorage.removeItem(LEGACY_TERMINAL_STORAGE_KEY)
    if (workspaceResolution.target.kind === 'root') {
      localStorage.removeItem(LAST_WORKSPACE_ROUTE_STORAGE_KEY)
      localStorage.removeItem(TASKTTY_LAST_WORKSPACE_ROUTE_STORAGE_KEY)
    } else {
      localStorage.setItem(
        LAST_WORKSPACE_ROUTE_STORAGE_KEY,
        workspaceResolution.target.pathname
      )
      localStorage.setItem(
        TASKTTY_LAST_WORKSPACE_ROUTE_STORAGE_KEY,
        workspaceResolution.target.pathname
      )
    }

    if (workspaceResolution.target.kind === 'terminal') {
      localStorage.setItem(
        `${LAST_PROJECT_TERMINAL_STORAGE_PREFIX}${workspaceResolution.target.projectId}`,
        workspaceResolution.target.terminalId
      )
      localStorage.setItem(
        `${TASKTTY_LAST_PROJECT_TERMINAL_STORAGE_PREFIX}${workspaceResolution.target.projectId}`,
        workspaceResolution.target.terminalId
      )
    }
  }, [workspaceResolution?.canonical, workspaceResolution?.target.pathname])

  useEffect(() => {
    const degraded =
      projectsQuery.data !== undefined &&
      (eventsDisconnected || projectsQuery.isRefetchError)
    if (!degraded) {
      setShowSyncDegraded(false)
      return
    }

    const timer = window.setTimeout(
      () => setShowSyncDegraded(true),
      METADATA_DEGRADED_GRACE_MS
    )
    return () => window.clearTimeout(timer)
  }, [eventsDisconnected, projectsQuery.data, projectsQuery.isRefetchError])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => desktopBridge?.onFullscreenChange(setDesktopFullscreen), [])

  useEffect(() => {
    if (!desktopBridge) {
      return
    }

    return desktopBridge.onCommand((command) => {
      if (
        command !== 'new-worktree' ||
        !activeProject ||
        activeProject.availability.state === 'unavailable' ||
        modal ||
        projectSwitcherOpen ||
        (isMobile && drawerOpen)
      ) {
        return
      }

      modalTriggerRef.current = document.activeElement as HTMLElement | null
      setModal({ type: 'worktree', project: activeProject })
    })
  }, [activeProject, drawerOpen, isMobile, modal, projectSwitcherOpen])

  useEffect(() => {
    if (!isMobile || !drawerOpen) {
      return
    }

    const drawer = drawerRef.current
    if (!drawer) {
      return
    }

    const previouslyFocused = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => {
      focusableElements(drawer)[0]?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      } else {
        drawerTriggerRef.current?.focus()
      }
    }
  }, [drawerOpen, isMobile])

  useEffect(() => {
    if (!isMobile || !drawerOpen || modal || projectSwitcherOpen) {
      return
    }

    const drawer = drawerRef.current
    if (!drawer) {
      return
    }

    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDrawerOpen(false)
        return
      }

      trapTabKey(event, drawer)
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [drawerOpen, isMobile, modal, projectSwitcherOpen])

  const activeProjectTerminals = useMemo(
    () =>
      activeProject?.worktrees.flatMap((worktree) => worktree.terminals) ?? [],
    [activeProject]
  )
  const bellAttention = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getAttentionSnapshot,
    () => EMPTY_BELL_ATTENTION
  )
  const runtimeTitles = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getTitleSnapshot,
    () => EMPTY_RUNTIME_TITLES
  )
  const foregroundProcesses = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getForegroundProcessSnapshot,
    () => EMPTY_FOREGROUND_PROCESSES
  )
  const terminalProgress = useSyncExternalStore(
    terminalSessions.subscribe,
    terminalSessions.getProgressSnapshot,
    () => EMPTY_TERMINAL_PROGRESS
  )
  useBellNotifications({
    projects,
    projectsLoaded: projectsQuery.data !== undefined,
    selectedTerminalId,
    runtimeTitles,
    navigateToWorkspace,
    onError: showError(setError)
  })
  const selectTerminal = (terminal: TerminalRecord) => {
    const target = targetForTerminal(projects, terminal)
    if (target) {
      void navigateToWorkspace(target)
    }

    setDrawerOpen(false)
  }

  const selectWorktree = (worktree: WorktreeRecord) => {
    const target = targetForWorktree(projects, worktree, selectedTerminalId)
    if (target) {
      void navigateToWorkspace(target)
    }

    setDrawerOpen(false)
  }

  const rememberedTargetForProject = (project: ProjectRecord) =>
    targetForProject(
      project,
      localStorage.getItem(
        `${LAST_PROJECT_TERMINAL_STORAGE_PREFIX}${project.id}`
      ) ??
        localStorage.getItem(
          `${TASKTTY_LAST_PROJECT_TERMINAL_STORAGE_PREFIX}${project.id}`
        )
    )

  const selectProject = (project: ProjectRecord) => {
    void navigateToWorkspace(rememberedTargetForProject(project))
    setProjectSwitcherOpen(false)
  }

  const { closingProjectId, requestProjectClose, projectOpened } =
    useProjectWorkflows({
      projects,
      selectedProject,
      targetForProject: rememberedTargetForProject,
      projectSwitcherTriggerRef,
      closeProjectUi: () => setProjectSwitcherOpen(false),
      openedProjectUi: () => {
        setProjectSwitcherOpen(false)
        setModal(null)
      },
      setError
    })
  const {
    pendingWorktrees,
    pendingRemovals,
    submitWorktreeCreation,
    prepareRemoval,
    confirmRemoval
  } = useWorktreeWorkflows({
    setDrawerOpen,
    setModal,
    openModal,
    setError,
    selectedTerminalId
  })

  const setAndSaveSidebarWidth = (width: number) => {
    const nextWidth = clampSidebarWidth(width)
    setSidebarWidth(nextWidth)
    localStorage.setItem('treeport-sidebar-width', String(nextWidth))
    localStorage.setItem('tasktty-sidebar-width', String(nextWidth))
  }

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    resizeOrigin.current = { pointerX: event.clientX, width: sidebarWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizingSidebar(true)
  }

  const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeOrigin.current) {
      return
    }

    setAndSaveSidebarWidth(
      resizeOrigin.current.width + event.clientX - resizeOrigin.current.pointerX
    )
  }

  const stopSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeOrigin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    setResizingSidebar(false)
  }

  const resizeSidebarWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    let nextWidth = sidebarWidth
    if (event.key === 'ArrowLeft') {
      nextWidth -= event.shiftKey ? 32 : 16
    } else if (event.key === 'ArrowRight') {
      nextWidth += event.shiftKey ? 32 : 16
    } else if (event.key === 'Home') {
      nextWidth = MIN_SIDEBAR_WIDTH
    } else if (event.key === 'End') {
      nextWidth = MAX_SIDEBAR_WIDTH
    } else {
      return
    }

    event.preventDefault()
    setAndSaveSidebarWidth(nextWidth)
  }

  return (
    <div
      className={cn(
        'app-frame isolate grid h-dvh grid-cols-[var(--sidebar-width)_minmax(0,1fr)] bg-zinc-950 max-[700px]:grid-cols-1',
        showDesktopTitlebar
          ? 'grid-rows-[2rem_minmax(0,1fr)] max-[700px]:grid-rows-[2rem_3.25rem_minmax(0,1fr)]'
          : 'max-[700px]:grid-rows-[3.25rem_minmax(0,1fr)]',
        resizingSidebar && 'select-none'
      )}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      {showDesktopTitlebar && (
        <div
          className="desktop-titlebar col-span-full h-8 bg-zinc-950"
          data-treeport-desktop-titlebar
          aria-hidden="true"
        />
      )}
      <WorkspaceSidebar
        projects={projects}
        projectsPending={projectsQuery.isPending}
        projectsError={projectsQuery.isError}
        projectsLoaded={projectsQuery.data !== undefined}
        onRetryProjects={() => void projectsQuery.refetch()}
        activeProject={activeProject}
        selectedWorktree={selectedWorktree}
        selectedTerminalId={selectedTerminalId}
        projectTerminals={activeProjectTerminals}
        runtimeTitles={runtimeTitles}
        bellAttention={bellAttention}
        terminalProgress={terminalProgress}
        pendingWorktrees={pendingWorktrees}
        pendingRemovals={pendingRemovals}
        closingProjectId={closingProjectId}
        drawerOpen={drawerOpen}
        setDrawerOpen={setDrawerOpen}
        isMobile={isMobile}
        sidebarWidth={sidebarWidth}
        resizingSidebar={resizingSidebar}
        projectSwitcherOpen={projectSwitcherOpen}
        setProjectSwitcherOpen={setProjectSwitcherOpen}
        drawerRef={drawerRef}
        drawerTriggerRef={drawerTriggerRef}
        projectSwitcherTriggerRef={projectSwitcherTriggerRef}
        projectSwitcherDismissedIntoTerminalRef={
          projectSwitcherDismissedIntoTerminalRef
        }
        onSelectTerminal={selectTerminal}
        onSelectWorktree={selectWorktree}
        onSelectProject={selectProject}
        onProjectOpened={projectOpened}
        onError={showError(setError)}
        onRequestProjectClose={requestProjectClose}
        onPrepareRemoval={prepareRemoval}
        onOpenModal={openModal}
        minSidebarWidth={MIN_SIDEBAR_WIDTH}
        maxSidebarWidth={MAX_SIDEBAR_WIDTH}
        defaultSidebarWidth={DEFAULT_SIDEBAR_WIDTH}
        onStartSidebarResize={startSidebarResize}
        onResizeSidebar={resizeSidebar}
        onStopSidebarResize={stopSidebarResize}
        onResizeSidebarWithKeyboard={resizeSidebarWithKeyboard}
        onSetSidebarWidth={setAndSaveSidebarWidth}
      />
      <div
        className="contents"
        inert={isMobile && drawerOpen ? true : undefined}
        aria-hidden={isMobile && drawerOpen ? true : undefined}
        onPointerDownCapture={() => {
          if (projectSwitcherOpen) {
            projectSwitcherDismissedIntoTerminalRef.current = true
            setProjectSwitcherOpen(false)
          }
        }}
      >
        <TerminalWorkspace
          projects={projects}
          selectedProject={selectedProject}
          selectedWorktree={selectedWorktree}
          selectedTerminal={selectedTerminal}
          loading={projectsQuery.isPending}
          presets={presets}
          presetsLoading={presetsQuery.isPending}
          presetsError={presetsQuery.isError}
          foregroundProcesses={foregroundProcesses}
          runtimeTitles={runtimeTitles}
          modalOpen={modal !== null}
          projectSwitcherOpen={projectSwitcherOpen}
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          setDrawerOpen={setDrawerOpen}
          setError={setError}
          onSelectTerminal={selectTerminal}
          onManagePresets={(trigger) =>
            openModal({ type: 'presets' }, trigger ?? undefined)
          }
        />
      </div>
      {showSyncDegraded && (
        <div
          className="fixed right-4 bottom-4 z-70 flex max-w-[min(30rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-zinc-800 p-3 text-sm text-zinc-300 shadow-2xl ring-1 ring-white/10"
          role="status"
          inert={isMobile && drawerOpen ? true : undefined}
          aria-hidden={isMobile && drawerOpen ? true : undefined}
        >
          <span>Updates paused; showing the last known project state.</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void projectsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {error && (
        <div
          className="toast fixed right-4 bottom-4 z-80 flex max-w-[min(27.5rem,calc(100vw-2rem))] items-start gap-3 rounded-lg bg-rose-950 p-3 text-sm text-pretty text-rose-200 shadow-2xl ring-1 ring-rose-800/80"
          role="alert"
          inert={isMobile && drawerOpen ? true : undefined}
          aria-hidden={isMobile && drawerOpen ? true : undefined}
        >
          {error}
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            className="text-rose-300 hover:bg-rose-900 hover:text-rose-100"
            aria-label="Dismiss error"
            onClick={() => setError(null)}
          >
            <XMarkIcon />
          </Button>
        </div>
      )}
      {modal && (
        <ActionModal
          modal={modal}
          close={() => setModal(null)}
          restoreFocusTo={modalTriggerRef.current}
          setError={setError}
          presets={presets}
          presetsLoading={presetsQuery.isPending}
          presetsError={presetsQuery.isError}
          onRetryPresets={() => void presetsQuery.refetch()}
          onCreateWorktree={submitWorktreeCreation}
          removalStage={
            modal.type === 'remove'
              ? (pendingRemovals[modal.worktree.id] ?? null)
              : null
          }
          onConfirmRemoval={confirmRemoval}
          onProjectOpened={projectOpened}
        />
      )}
    </div>
  )
}

function showError(setError: (value: string | null) => void) {
  return (value: unknown) =>
    setError(value instanceof Error ? value.message : String(value))
}
