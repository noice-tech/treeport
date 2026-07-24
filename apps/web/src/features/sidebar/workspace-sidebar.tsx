import {
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
  type RefObject
} from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CrownIcon, GitBranchIcon, TerminalIcon } from 'lucide-react'
import {
  ArrowPathIcon,
  Bars3Icon,
  CheckIcon,
  ChevronUpDownIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import type {
  ProjectRecord,
  TerminalRecord,
  WorktreeRecord
} from '@tasktty/shared'
import { apiClient } from '../../api.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { NativeSelect } from '../../components/ui/native-select.js'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover.js'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '../../components/ui/tooltip.js'
import type { ActionModalState, RemovalStage } from '../dialogs/action-modal.js'
import type { PendingWorktreeCreation } from '../worktrees/worktree-workflows.js'
import { cn } from '../../lib/utils.js'
import { recentProjectsQueryOptions } from '../../project-metadata.js'
import {
  terminalProgressLabel,
  type TerminalProgress
} from '../../terminal-session.js'

const MANUAL_CLEANUP_PREFIX = 'Manual cleanup required:'

function needsManualCleanup(worktree: WorktreeRecord): boolean {
  return Boolean(worktree.cleanupError?.startsWith(MANUAL_CLEANUP_PREFIX))
}

function WorktreeShell({
  name,
  title,
  icon,
  status,
  selected = false,
  linked = false,
  pending = false,
  busy = false,
  id,
  className,
  ariaLabel,
  onClick
}: {
  name: string
  title: string
  icon: ReactNode
  status?: ReactNode
  selected?: boolean
  linked?: boolean
  pending?: boolean
  busy?: boolean
  id?: string
  className?: string
  ariaLabel?: string | undefined
  onClick?: () => void
}) {
  const classes = cn(
    'worktree-row flex h-auto min-h-11 w-full min-w-0 items-center justify-start gap-1.5 rounded-md px-2 py-1.5 text-left text-base/5 font-medium min-[701px]:min-h-8 min-[701px]:py-1 min-[701px]:text-[0.8125rem]/4',
    linked && 'min-[701px]:pr-9',
    pending
      ? 'text-zinc-300'
      : selected
        ? 'selected text-zinc-50 min-[701px]:bg-white/8'
        : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-50',
    'max-[700px]:flex-1 max-[700px]:hover:bg-transparent',
    (pending || busy) && 'motion-safe:animate-pulse',
    pending && 'pointer-events-none',
    className
  )
  const content = (
    <>
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        {status}
      </span>
    </>
  )

  return (
    <Button
      id={id}
      variant="ghost"
      type="button"
      className={classes}
      onClick={pending ? undefined : onClick}
      title={title}
      role={pending ? 'status' : undefined}
      aria-label={pending ? `Creating worktree ${name}` : ariaLabel}
      aria-live={pending || ariaLabel ? 'polite' : undefined}
      aria-disabled={pending || undefined}
      tabIndex={pending ? -1 : undefined}
    >
      {content}
    </Button>
  )
}

export interface WorkspaceSidebarProps {
  projects: ProjectRecord[]
  projectsPending: boolean
  projectsError: boolean
  projectsLoaded: boolean
  onRetryProjects: () => void
  activeProject: ProjectRecord | null
  selectedWorktree: WorktreeRecord | null
  selectedTerminalId: string | null
  projectTerminals: TerminalRecord[]
  runtimeTitles: ReadonlyMap<string, string>
  bellAttention: ReadonlySet<string>
  terminalProgress: ReadonlyMap<string, TerminalProgress>
  pendingWorktrees: PendingWorktreeCreation[]
  pendingRemovals: Record<string, RemovalStage>
  closingProjectId: string | null
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  isMobile: boolean
  sidebarWidth: number
  resizingSidebar: boolean
  projectSwitcherOpen: boolean
  setProjectSwitcherOpen: (open: boolean) => void
  drawerRef: RefObject<HTMLElement | null>
  drawerTriggerRef: RefObject<HTMLButtonElement | null>
  projectSwitcherTriggerRef: RefObject<HTMLButtonElement | null>
  projectSwitcherDismissedIntoTerminalRef: MutableRefObject<boolean>
  onSelectTerminal: (terminal: TerminalRecord) => void
  onSelectWorktree: (worktree: WorktreeRecord) => void
  onSelectProject: (project: ProjectRecord) => void
  onProjectOpened: (project: ProjectRecord) => Promise<void>
  onError: (error: unknown) => void
  onRequestProjectClose: (project: ProjectRecord) => void
  onPrepareRemoval: (
    worktree: WorktreeRecord,
    trigger: HTMLElement
  ) => Promise<void>
  onOpenModal: (
    modal: Exclude<ActionModalState, null>,
    trigger?: HTMLElement
  ) => void
  minSidebarWidth: number
  maxSidebarWidth: number
  defaultSidebarWidth: number
  onStartSidebarResize: (event: PointerEvent<HTMLDivElement>) => void
  onResizeSidebar: (event: PointerEvent<HTMLDivElement>) => void
  onStopSidebarResize: (event: PointerEvent<HTMLDivElement>) => void
  onResizeSidebarWithKeyboard: (event: KeyboardEvent<HTMLDivElement>) => void
  onSetSidebarWidth: (width: number) => void
}

interface ProjectSwitcherProps {
  projects: ProjectRecord[]
  activeProject: ProjectRecord | null
  bellAttention: ReadonlySet<string>
  terminalProgress: ReadonlyMap<string, TerminalProgress>
  closingProjectId: string | null
  isMobile: boolean
  projectSwitcherOpen: boolean
  setProjectSwitcherOpen: (open: boolean) => void
  projectSwitcherTriggerRef: RefObject<HTMLButtonElement | null>
  projectSwitcherDismissedIntoTerminalRef: MutableRefObject<boolean>
  onSelectProject: (project: ProjectRecord) => void
  onProjectOpened: (project: ProjectRecord) => Promise<void>
  onError: (error: unknown) => void
  onRequestProjectClose: (project: ProjectRecord) => void
  onOpenModal: (
    modal: Exclude<ActionModalState, null>,
    trigger?: HTMLElement
  ) => void
}

function ProjectSwitcher({
  projects,
  activeProject,
  bellAttention,
  terminalProgress,
  closingProjectId,
  isMobile,
  projectSwitcherOpen,
  setProjectSwitcherOpen,
  projectSwitcherTriggerRef,
  projectSwitcherDismissedIntoTerminalRef,
  onSelectProject: selectProject,
  onProjectOpened,
  onError,
  onRequestProjectClose: requestProjectClose,
  onOpenModal: openModal
}: ProjectSwitcherProps) {
  const usesMacKeyboard = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const [projectSearch, setProjectSearch] = useState('')
  const [highlightedProjectId, setHighlightedProjectId] = useState<
    string | null
  >(null)
  const recentProjectsQuery = useQuery({
    ...recentProjectsQueryOptions,
    enabled: projectSwitcherOpen
  })
  const reopenProject = useMutation({
    mutationFn: (project: { id: string }) => apiClient.openProject(project.id),
    onSuccess: onProjectOpened,
    onError
  })
  const normalizedProjectSearch = projectSearch.trim().toLocaleLowerCase()
  const filteredOpenProjects = projects.filter(
    (project) =>
      !normalizedProjectSearch ||
      project.name.toLocaleLowerCase().includes(normalizedProjectSearch) ||
      project.repositoryPath
        .toLocaleLowerCase()
        .includes(normalizedProjectSearch)
  )
  const openProjectIds = new Set(projects.map((project) => project.id))
  const filteredRecentProjects = (recentProjectsQuery.data ?? []).filter(
    (project) =>
      !openProjectIds.has(project.id) &&
      (!normalizedProjectSearch ||
        project.name.toLocaleLowerCase().includes(normalizedProjectSearch) ||
        project.repositoryPath
          .toLocaleLowerCase()
          .includes(normalizedProjectSearch))
  )
  const projectSwitcherOptions = [
    ...filteredOpenProjects.map((project) => ({
      kind: 'open' as const,
      project
    })),
    ...filteredRecentProjects.map((project) => ({
      kind: 'recent' as const,
      project
    }))
  ]
  const highlightedProjectOption =
    projectSwitcherOptions.find(
      (option) => option.project.id === highlightedProjectId
    ) ??
    projectSwitcherOptions[0] ??
    null

  return (
    <Popover
      open={projectSwitcherOpen}
      onOpenChange={(open) => {
        setProjectSwitcherOpen(open)
        setHighlightedProjectId(null)
        setProjectSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={projectSwitcherTriggerRef}
          type="button"
          variant="ghost"
          className="h-9 min-w-0 flex-1 justify-start gap-2 px-2 text-sm text-zinc-100 hover:bg-white/5"
          aria-label={
            activeProject
              ? `Switch project, current project ${activeProject.name}`
              : 'Open project'
          }
          aria-keyshortcuts={
            usesMacKeyboard ? 'Meta+Shift+P' : 'Control+Shift+P'
          }
          title={`${activeProject?.repositoryPath ?? 'Open project'} — ${
            usesMacKeyboard ? '⌘⇧P' : 'Ctrl+Shift+P'
          }`}
        >
          <span className="truncate font-medium">
            {activeProject?.name ?? 'Open project'}
          </span>
          <ChevronUpDownIcon className="ml-auto shrink-0 fill-zinc-600" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(17rem,calc(100vw-1rem))] p-1"
        onOpenAutoFocus={(event) => {
          if (isMobile) {
            event.preventDefault()
          }
        }}
        onCloseAutoFocus={(event) => {
          if (projectSwitcherDismissedIntoTerminalRef.current) {
            event.preventDefault()
            projectSwitcherDismissedIntoTerminalRef.current = false
          }
        }}
      >
        <div className="relative mb-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 fill-zinc-600" />
          <Input
            value={projectSearch}
            onChange={(event) => {
              setProjectSearch(event.target.value)
              setHighlightedProjectId(null)
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                !projectSwitcherOptions.length
              ) {
                return
              }

              if (event.key === 'Enter') {
                event.preventDefault()
                if (highlightedProjectOption?.kind === 'open') {
                  selectProject(highlightedProjectOption.project)
                } else if (
                  highlightedProjectOption?.kind === 'recent' &&
                  !reopenProject.isPending
                ) {
                  reopenProject.mutate(highlightedProjectOption.project)
                }

                return
              }

              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                return
              }

              event.preventDefault()
              const highlightedIndex = Math.max(
                0,
                projectSwitcherOptions.findIndex(
                  (option) =>
                    option.project.id === highlightedProjectOption?.project.id
                )
              )
              const nextIndex =
                event.key === 'ArrowDown'
                  ? Math.min(
                      highlightedIndex + 1,
                      projectSwitcherOptions.length - 1
                    )
                  : Math.max(highlightedIndex - 1, 0)
              const nextOption = projectSwitcherOptions[nextIndex]!
              setHighlightedProjectId(nextOption.project.id)
              window.requestAnimationFrame(() =>
                document
                  .getElementById(
                    `project-switcher-option-${nextOption.project.id}`
                  )
                  ?.scrollIntoView({ block: 'nearest' })
              )
            }}
            className="h-8 bg-zinc-950/50 pt-0.5 pr-2 pb-1 pl-7 ring-white/8 sm:h-7 sm:text-[0.8125rem]/4 sm:placeholder:text-[0.84375rem]"
            placeholder="Search projects…"
            aria-label="Search projects"
            aria-activedescendant={
              highlightedProjectOption
                ? `project-switcher-option-${highlightedProjectOption.project.id}`
                : undefined
            }
            autoFocus={!isMobile}
          />
        </div>
        <div className="grid max-h-[min(28rem,70vh)] gap-0.5 overflow-y-auto p-0.5 [scrollbar-color:var(--color-zinc-700)_transparent]">
          {filteredOpenProjects.length ? (
            <ul role="list" className="grid gap-0.5">
              {filteredOpenProjects.map((project) => {
                const terminals = project.worktrees.flatMap(
                  (worktree) => worktree.terminals
                )
                const needsAttention = terminals.some((terminal) =>
                  bellAttention.has(terminal.id)
                )
                const progress = terminals
                  .map((terminal) => terminalProgress.get(terminal.id))
                  .find((item) => item !== undefined)

                return (
                  <li
                    key={project.id}
                    className={cn(
                      'group/project-option relative flex h-8 min-w-0 items-center gap-0.5 rounded-md pr-1 has-[button:hover]:bg-white/5 focus-within:bg-white/5',
                      highlightedProjectOption?.project.id === project.id &&
                        'bg-white/8'
                    )}
                    onMouseEnter={() => setHighlightedProjectId(project.id)}
                  >
                    <Button
                      id={`project-switcher-option-${project.id}`}
                      type="button"
                      variant="ghost"
                      className="h-8 min-w-0 flex-1 justify-start px-2 text-left hover:bg-transparent max-[700px]:pr-8"
                      data-highlighted={
                        highlightedProjectOption?.project.id === project.id
                          ? true
                          : undefined
                      }
                      onClick={() => selectProject(project)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-zinc-100">
                          {project.name}
                        </span>
                        {activeProject?.id === project.id ? (
                          <CheckIcon className="shrink-0 fill-zinc-400" />
                        ) : null}
                      </span>
                      {progress || needsAttention ? (
                        <span className="ml-auto flex shrink-0 items-center gap-1.5 min-[701px]:group-hover/project-option:opacity-0 min-[701px]:group-focus-within/project-option:opacity-0">
                          {progress ? (
                            <ArrowPathIcon
                              className={cn(
                                'size-4 shrink-0 fill-cyan-300',
                                progress.state !== 'paused' &&
                                  progress.state !== 'error' &&
                                  'animate-spin',
                                progress.state === 'error' && 'fill-rose-300',
                                progress.state === 'paused' && 'fill-amber-300'
                              )}
                              title={terminalProgressLabel(progress)}
                            />
                          ) : null}
                          {needsAttention ? (
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-amber-300 shadow-[0_0_0.5rem] shadow-amber-300/60"
                              title="Terminal needs attention"
                            />
                          ) : null}
                        </span>
                      ) : null}
                    </Button>
                    <SidebarAction
                      label={`Close project ${project.name}`}
                      tooltip="Close project"
                      disabled={closingProjectId === project.id}
                      className="absolute right-1 shrink-0 fill-zinc-500 opacity-0 hover:bg-white/5 hover:fill-rose-300 group-hover/project-option:opacity-100 group-focus-within/project-option:opacity-100 max-[700px]:opacity-100"
                      onClick={() => requestProjectClose(project)}
                    >
                      {closingProjectId === project.id ? (
                        <ArrowPathIcon className="animate-spin" />
                      ) : (
                        <XMarkIcon />
                      )}
                    </SidebarAction>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="px-2 py-1 text-sm text-zinc-500">
              No open projects found.
            </p>
          )}
          <section
            className="grid gap-0.5"
            aria-labelledby="recent-projects-switcher-title"
          >
            <div className="flex items-center justify-between gap-2 px-2 py-1">
              <h3
                id="recent-projects-switcher-title"
                className="text-xs font-medium text-zinc-500"
              >
                Recent projects
              </h3>
              {recentProjectsQuery.isFetching ? (
                <ArrowPathIcon
                  className="size-4 shrink-0 animate-spin fill-zinc-600"
                  aria-label="Refreshing recent projects"
                />
              ) : null}
            </div>
            {recentProjectsQuery.isError ? (
              <div className="flex items-center justify-between gap-2 px-2 py-1">
                <p className="text-sm text-zinc-500">
                  Recent projects unavailable.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void recentProjectsQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {recentProjectsQuery.isSuccess && filteredRecentProjects.length ? (
              <ul role="list" className="grid gap-0.5">
                {filteredRecentProjects.map((project) => (
                  <li
                    key={project.id}
                    onMouseEnter={() => setHighlightedProjectId(project.id)}
                  >
                    <Button
                      id={`project-switcher-option-${project.id}`}
                      type="button"
                      variant="ghost"
                      className={cn(
                        'h-8 w-full min-w-0 justify-start px-2 text-left',
                        highlightedProjectOption?.project.id === project.id &&
                          'bg-white/8'
                      )}
                      data-highlighted={
                        highlightedProjectOption?.project.id === project.id
                          ? true
                          : undefined
                      }
                      disabled={reopenProject.isPending}
                      onClick={() => reopenProject.mutate(project)}
                    >
                      <span className="truncate text-sm font-medium text-zinc-200">
                        {project.name}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {recentProjectsQuery.isSuccess && !filteredRecentProjects.length ? (
              <p className="px-2 py-1 text-sm text-zinc-500">
                {normalizedProjectSearch
                  ? 'No recent projects found.'
                  : 'Closed projects appear here.'}
              </p>
            ) : null}
          </section>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-0.5 h-8 w-full justify-start border-t border-white/8 py-1 text-sm font-normal text-zinc-500 hover:text-zinc-100"
          onClick={(event) => {
            setProjectSwitcherOpen(false)
            openModal({ type: 'project' }, event.currentTarget)
          }}
        >
          <PlusIcon /> Open project…
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function WorkspaceSidebar({
  projects,
  projectsPending,
  projectsError,
  projectsLoaded,
  onRetryProjects,
  activeProject,
  selectedWorktree,
  selectedTerminalId,
  projectTerminals,
  runtimeTitles,
  bellAttention,
  terminalProgress,
  pendingWorktrees,
  pendingRemovals,
  closingProjectId,
  drawerOpen,
  setDrawerOpen,
  isMobile,
  sidebarWidth,
  resizingSidebar,
  projectSwitcherOpen,
  setProjectSwitcherOpen,
  drawerRef,
  drawerTriggerRef,
  projectSwitcherTriggerRef,
  projectSwitcherDismissedIntoTerminalRef,
  onSelectTerminal: selectTerminal,
  onSelectWorktree: selectWorktree,
  onSelectProject: selectProject,
  onProjectOpened,
  onError,
  onRequestProjectClose: requestProjectClose,
  onPrepareRemoval: prepareRemoval,
  onOpenModal: openModal,
  minSidebarWidth,
  maxSidebarWidth,
  defaultSidebarWidth,
  onStartSidebarResize: startSidebarResize,
  onResizeSidebar: resizeSidebar,
  onStopSidebarResize: stopSidebarResize,
  onResizeSidebarWithKeyboard: resizeSidebarWithKeyboard,
  onSetSidebarWidth: setAndSaveSidebarWidth
}: WorkspaceSidebarProps) {
  const newWorktreeShortcut = window.taskttyDesktop
    ? window.taskttyDesktop.platform === 'darwin'
      ? '⌘N'
      : 'Ctrl+N'
    : null

  return (
    <>
      <header
        className="mobile-bar hidden min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-2 border-b border-white/8 bg-zinc-900/95 px-2 backdrop-blur max-[700px]:grid"
        inert={isMobile && drawerOpen ? true : undefined}
      >
        <Button
          ref={drawerTriggerRef}
          type="button"
          variant="ghost"
          size="icon"
          className="icon-button text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
          aria-label="Open worktree drawer"
          onClick={() => setDrawerOpen(true)}
        >
          <Bars3Icon />
          <span className="touch-target" aria-hidden="true" />
        </Button>
        <NativeSelect
          className="h-9 border-0 bg-zinc-800/80 text-base ring-0"
          name="terminal-selector"
          aria-label="Terminal selector"
          value={selectedTerminalId ?? ''}
          onChange={(event) => {
            const terminal = projectTerminals.find(
              (item) => item.id === event.target.value
            )
            if (terminal) {
              selectTerminal(terminal)
            }
          }}
        >
          <option value="">Select terminal</option>
          {projectTerminals.map((terminal) => (
            <option value={terminal.id} key={terminal.id}>
              {runtimeTitles.get(terminal.id) || terminal.name}
            </option>
          ))}
        </NativeSelect>
      </header>
      <div
        className={cn(
          'drawer-backdrop fixed inset-0 z-30 bg-black/60 opacity-0 backdrop-blur-sm transition-opacity pointer-events-none min-[701px]:hidden',
          drawerOpen && 'opacity-100 pointer-events-auto'
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        id="worktree-sidebar"
        role={isMobile ? 'dialog' : undefined}
        aria-modal={isMobile && drawerOpen ? true : undefined}
        aria-labelledby={isMobile ? 'worktree-drawer-title' : undefined}
        aria-hidden={isMobile && !drawerOpen ? true : undefined}
        inert={isMobile && !drawerOpen ? true : undefined}
        className={cn(
          'sidebar relative z-40 flex min-h-0 flex-col border-r border-white/8 bg-zinc-900/80 backdrop-blur-xl max-[700px]:fixed max-[700px]:inset-y-0 max-[700px]:left-0 max-[700px]:w-[min(88vw,21rem)] max-[700px]:-translate-x-full max-[700px]:shadow-2xl max-[700px]:transition-transform',
          drawerOpen && 'open max-[700px]:translate-x-0'
        )}
      >
        <h2 id="worktree-drawer-title" className="sr-only">
          Projects and worktrees
        </h2>
        <div
          className={cn(
            'absolute inset-y-0 right-0 z-50 w-3 translate-x-1/2 touch-none cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-white/8 after:absolute after:top-1/2 after:left-1/2 after:h-8 after:w-1 after:-translate-1/2 after:rounded-full after:bg-zinc-700 hover:before:w-0.5 hover:before:bg-cyan-400/60 hover:after:bg-cyan-400 focus-visible:before:w-0.5 focus-visible:before:bg-cyan-400 focus-visible:after:bg-cyan-400 max-[700px]:hidden',
            resizingSidebar && 'before:w-0.5 before:bg-cyan-400'
          )}
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-controls="worktree-sidebar"
          aria-valuemin={minSidebarWidth}
          aria-valuemax={maxSidebarWidth}
          aria-valuenow={sidebarWidth}
          aria-valuetext={`${sidebarWidth} pixels`}
          title="Drag to resize; double-click to reset"
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onPointerMove={resizeSidebar}
          onPointerUp={stopSidebarResize}
          onPointerCancel={stopSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          onDoubleClick={() => setAndSaveSidebarWidth(defaultSidebarWidth)}
        />
        <div className="hidden justify-end p-2 max-[700px]:flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="icon-button mobile-close text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
            aria-label="Close drawer"
            onClick={() => setDrawerOpen(false)}
          >
            <XMarkIcon />
            <span className="touch-target" aria-hidden="true" />
          </Button>
        </div>
        <div className="flex items-center gap-1 border-b border-white/8 p-2 max-[700px]:pt-0">
          <ProjectSwitcher
            projects={projects}
            activeProject={activeProject}
            bellAttention={bellAttention}
            terminalProgress={terminalProgress}
            closingProjectId={closingProjectId}
            isMobile={isMobile}
            projectSwitcherOpen={projectSwitcherOpen}
            setProjectSwitcherOpen={setProjectSwitcherOpen}
            projectSwitcherTriggerRef={projectSwitcherTriggerRef}
            projectSwitcherDismissedIntoTerminalRef={
              projectSwitcherDismissedIntoTerminalRef
            }
            onSelectProject={selectProject}
            onProjectOpened={onProjectOpened}
            onError={onError}
            onRequestProjectClose={requestProjectClose}
            onOpenModal={openModal}
          />
        </div>
        <nav
          className="tree min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-3 pb-5 min-[701px]:px-1.5 min-[701px]:pt-2 min-[701px]:pb-4 [scrollbar-color:var(--color-zinc-700)_transparent]"
          aria-label="Projects and worktrees"
        >
          {projectsPending ? (
            <p className="sidebar-note px-2 py-3 text-base text-zinc-500 min-[701px]:text-sm">
              Loading repositories…
            </p>
          ) : null}
          {projectsError && !projectsLoaded ? (
            <div className="flex flex-col items-start gap-2 px-2 py-3">
              <p className="sidebar-note text-base text-rose-300 min-[701px]:text-sm">
                Projects could not be loaded.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onRetryProjects}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {!projectsPending && !projectsError && !projects.length ? (
            <p className="sidebar-note px-2 py-3 text-base text-pretty text-zinc-500 min-[701px]:text-sm">
              Open a Git repository to begin.
            </p>
          ) : null}
          <div className="grid gap-4">
            {projects
              .filter((project) => project.id === activeProject?.id)
              .map((project) => (
                <div className="project-tree" key={project.id}>
                  {project.availability.state === 'unavailable' ? (
                    <p
                      className="mx-1 mb-2 rounded-md bg-amber-400/8 px-2 py-1.5 text-sm text-amber-200"
                      role="status"
                    >
                      {project.availability.message ||
                        'Git repository unavailable'}
                    </p>
                  ) : null}
                  <ul role="list" className="grid gap-2 min-[701px]:gap-1.5">
                    {project.worktrees.map((worktree) => (
                      <li key={worktree.id} className="group/worktree min-w-0">
                        <div
                          className={cn(
                            'relative min-w-0 max-[700px]:flex max-[700px]:items-center max-[700px]:gap-0.5 max-[700px]:rounded-md max-[700px]:has-[button:hover]:bg-white/5',
                            selectedWorktree?.id === worktree.id &&
                              'max-[700px]:bg-white/8'
                          )}
                        >
                          <WorktreeShell
                            name={worktree.name}
                            title={`${worktree.path}${
                              worktree.branch
                                ? ` · ${worktree.branch}`
                                : ` · detached at ${worktree.head.slice(0, 8)}`
                            }`}
                            linked={worktree.kind === 'linked'}
                            selected={selectedWorktree?.id === worktree.id}
                            busy={
                              Boolean(pendingRemovals[worktree.id]) ||
                              worktree.status === 'cleaning'
                            }
                            ariaLabel={
                              pendingRemovals[worktree.id] === 'checking'
                                ? `${worktree.name}, preparing removal`
                                : pendingRemovals[worktree.id] ||
                                    worktree.status === 'cleaning'
                                  ? `${worktree.name}, removing`
                                  : undefined
                            }
                            onClick={() => selectWorktree(worktree)}
                            icon={
                              pendingRemovals[worktree.id] ||
                              worktree.status === 'cleaning' ? (
                                <GitBranchIcon
                                  className="worktree-progress-icon worktree-removing-icon size-4 shrink-0 stroke-rose-400 stroke-[1.5]"
                                  aria-hidden="true"
                                />
                              ) : worktree.kind === 'main' ? (
                                <CrownIcon
                                  className="size-4 shrink-0 stroke-zinc-600 stroke-[1.5]"
                                  aria-hidden="true"
                                />
                              ) : (
                                <GitBranchIcon
                                  className="shrink-0 stroke-zinc-600 stroke-[1.5]"
                                  aria-hidden="true"
                                />
                              )
                            }
                            status={
                              worktree.status === 'cleanup_failed' ? (
                                <span
                                  className="truncate text-sm/4 font-normal text-rose-300 min-[701px]:text-[0.6875rem]"
                                  role="status"
                                  title={worktree.cleanupError ?? undefined}
                                >
                                  Removal failed
                                  {worktree.cleanupError
                                    ? `: ${worktree.cleanupError}`
                                    : ''}
                                </span>
                              ) : undefined
                            }
                          />
                          {worktree.kind === 'linked' && (
                            <div className="worktree-actions absolute top-0 right-0 z-10 flex items-center gap-0.5 opacity-0 group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100 max-[700px]:static max-[700px]:shrink-0 max-[700px]:opacity-100">
                              <SidebarAction
                                label={
                                  needsManualCleanup(worktree)
                                    ? `Manual cleanup required for ${worktree.name}`
                                    : worktree.status === 'cleanup_failed'
                                      ? `Retry removal for ${worktree.name}`
                                      : `Remove ${worktree.name}`
                                }
                                tooltip={
                                  project.availability.state === 'unavailable'
                                    ? 'Git repository unavailable'
                                    : worktree.prunable
                                      ? 'Git reports this worktree as prunable'
                                      : pendingRemovals[worktree.id] ||
                                          worktree.status === 'cleaning'
                                        ? 'Removal is already in progress'
                                        : needsManualCleanup(worktree)
                                          ? worktree.cleanupError!
                                          : worktree.status === 'cleanup_failed'
                                            ? 'Retry removal'
                                            : 'Remove worktree'
                                }
                                disabled={
                                  project.availability.state ===
                                    'unavailable' ||
                                  worktree.prunable ||
                                  Boolean(pendingRemovals[worktree.id]) ||
                                  worktree.status === 'cleaning' ||
                                  needsManualCleanup(worktree)
                                }
                                className="text-zinc-500 hover:bg-transparent hover:text-rose-300"
                                onClick={(trigger) =>
                                  void prepareRemoval(worktree, trigger)
                                }
                              >
                                <TrashIcon />
                              </SidebarAction>
                            </div>
                          )}
                        </div>
                        <ul
                          role="list"
                          className="terminal-list ml-4 grid gap-0.5 border-l border-white/6 pl-2"
                        >
                          {worktree.terminals.map((terminal) => {
                            const needsAttention = bellAttention.has(
                              terminal.id
                            )
                            const progress = terminalProgress.get(terminal.id)
                            const status = [
                              progress
                                ? terminalProgressLabel(progress)
                                : terminal.status,
                              needsAttention ? 'bell' : null
                            ]
                              .filter(Boolean)
                              .join(', ')
                            return (
                              <li key={terminal.id} className="min-w-0">
                                <Button
                                  variant="ghost"
                                  type="button"
                                  className={cn(
                                    'terminal-row grid h-auto min-h-11 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_0.5rem] gap-1.5 rounded-md px-2 py-1.5 text-left text-base/5 font-normal min-[701px]:min-h-7 min-[701px]:grid-cols-[1rem_minmax(0,1fr)_0.5rem] min-[701px]:py-0.5 min-[701px]:text-xs/4',
                                    selectedTerminalId === terminal.id
                                      ? 'selected bg-cyan-400/8 text-cyan-50'
                                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
                                  )}
                                  onClick={() => selectTerminal(terminal)}
                                  aria-label={`${
                                    runtimeTitles.get(terminal.id) ||
                                    terminal.name
                                  }, ${status}`}
                                >
                                  {progress && !needsAttention ? (
                                    <ArrowPathIcon
                                      className={cn(
                                        'size-4 shrink-0 fill-cyan-300',
                                        progress.state !== 'paused' &&
                                          progress.state !== 'error' &&
                                          'animate-spin',
                                        progress.state === 'error' &&
                                          'fill-rose-300',
                                        progress.state === 'paused' &&
                                          'fill-amber-300'
                                      )}
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <TerminalIcon
                                      className={cn(
                                        'size-4 shrink-0 stroke-zinc-600 stroke-[1.5]',
                                        needsAttention && 'stroke-amber-300'
                                      )}
                                      aria-hidden="true"
                                    />
                                  )}
                                  <span
                                    className={cn(
                                      'truncate',
                                      needsAttention && 'text-amber-200'
                                    )}
                                    aria-hidden="true"
                                  >
                                    {runtimeTitles.get(terminal.id) ||
                                      terminal.name}
                                  </span>
                                  {terminal.status !== 'running' && (
                                    <span
                                      className={cn(
                                        'status-dot size-1.5 shrink-0 rounded-full bg-zinc-600',
                                        terminal.status === 'exited' &&
                                          'bg-rose-400'
                                      )}
                                      title={status}
                                    />
                                  )}
                                </Button>
                              </li>
                            )
                          })}
                        </ul>
                      </li>
                    ))}
                    {pendingWorktrees
                      .filter(
                        (pending) =>
                          pending.projectId === project.id &&
                          !project.worktrees.some(
                            (worktree) =>
                              worktree.path === pending.destinationPath
                          )
                      )
                      .map((pending) => (
                        <li key={pending.id} className="min-w-0">
                          <WorktreeShell
                            id={`pending-worktree-${pending.id}`}
                            name={pending.typedName}
                            title={pending.destinationPath}
                            pending
                            icon={
                              <GitBranchIcon
                                className="worktree-progress-icon size-4 shrink-0 stroke-cyan-400 stroke-[1.5]"
                                aria-hidden="true"
                              />
                            }
                          />
                        </li>
                      ))}
                    <li className="min-w-0">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-h-11 w-full justify-start gap-1.5 px-2 py-1.5 text-base/5 font-normal text-zinc-500 hover:bg-white/5 hover:text-zinc-100 min-[701px]:min-h-8 min-[701px]:py-1 min-[701px]:text-[0.8125rem]/4"
                        disabled={project.availability.state === 'unavailable'}
                        aria-keyshortcuts={
                          newWorktreeShortcut
                            ? window.taskttyDesktop?.platform === 'darwin'
                              ? 'Meta+N'
                              : 'Control+N'
                            : undefined
                        }
                        title={
                          newWorktreeShortcut
                            ? `New worktree — ${newWorktreeShortcut}`
                            : undefined
                        }
                        onClick={(event) =>
                          openModal(
                            { type: 'worktree', project },
                            event.currentTarget
                          )
                        }
                      >
                        <PlusIcon />
                        <span>New worktree</span>
                        {newWorktreeShortcut ? (
                          <kbd
                            className="ml-auto font-sans text-[0.6875rem] text-zinc-500"
                            aria-hidden="true"
                          >
                            {newWorktreeShortcut}
                          </kbd>
                        ) : null}
                      </Button>
                    </li>
                  </ul>
                </div>
              ))}
          </div>
        </nav>
      </aside>
    </>
  )
}

function SidebarAction({
  label,
  tooltip = label,
  className,
  disabled,
  onClick,
  children
}: {
  label: string
  tooltip?: string
  className?: string
  disabled?: boolean
  onClick: (trigger: HTMLButtonElement) => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={className}
          aria-label={label}
          disabled={disabled}
          onClick={(event) => onClick(event.currentTarget)}
        >
          {children}
          <span className="touch-target" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
