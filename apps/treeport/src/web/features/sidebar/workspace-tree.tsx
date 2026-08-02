import type { ReactNode } from 'react'
import { CrownIcon, GitBranchIcon } from 'lucide-react'
import {
  ArrowPathIcon,
  PlusIcon,
  TrashIcon,
  WindowIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import type {
  ProjectRecord,
  TerminalRecord,
  WebPanel,
  WorktreeRecord
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger
} from '../../components/ui/context-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem
} from '../../components/ui/sidebar'
import { TerminalStatusIcon } from '../../components/terminal-status-icon'
import { cn } from '../../lib/utils'
import { terminalProgressLabel } from '../../terminal-session'
import { useTerminalNavigationMetadata } from '../../terminal-runtime-metadata-react'
import type {
  PendingWorktreeCreation,
  RemovalStage
} from '../worktrees/worktree-workflows'
import { SidebarAction } from './sidebar-action'

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
  pending?: boolean
  busy?: boolean
  id?: string
  className?: string
  ariaLabel?: string | undefined
  onClick?: () => void
}) {
  const classes = cn(
    'worktree-row flex h-auto min-h-11 w-full min-w-0 items-center justify-start gap-1.5 rounded-md px-2 py-1.5 text-left text-base/5 font-medium min-[701px]:min-h-8 min-[701px]:py-0.5 min-[701px]:text-sm/5',
    pending
      ? 'text-zinc-300'
      : selected
        ? 'selected text-zinc-50 min-[701px]:bg-white/8!'
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
    <SidebarMenuButton asChild isActive={selected}>
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
    </SidebarMenuButton>
  )
}

export interface WorkspaceTreeProps {
  projects: ProjectRecord[]
  projectsPending: boolean
  projectsError: boolean
  projectsLoaded: boolean
  activeProject: ProjectRecord | null
  selectedWorktree: WorktreeRecord | null
  selectedTerminalId: string | null
  selectedPendingTerminalId: string | null
  selectedWebPanelId: string | null
  pendingTerminals: Array<{
    id: string
    projectId: string
    worktreeId: string
    name: string
  }>
  pendingWorktrees: PendingWorktreeCreation[]
  pendingRemovals: Record<string, RemovalStage>
  onRetryProjects: () => void
  onSelectTerminal: (terminal: TerminalRecord) => void
  onSelectPendingTerminal: (terminalId: string) => void
  onCloseTerminal: (terminal: TerminalRecord) => void
  onSelectWebPanel: (panel: WebPanel) => void
  onCloseWebPanel: (panel: WebPanel, trigger?: HTMLElement) => void
  onSelectWorktree: (worktree: WorktreeRecord) => void
  onPrepareRemoval: (
    worktree: WorktreeRecord,
    trigger: HTMLElement
  ) => Promise<void>
  onOpenPanelDialog: (
    project: ProjectRecord,
    worktree: WorktreeRecord | null,
    trigger: HTMLElement
  ) => void
  onOpenWorktreeDialog: (project: ProjectRecord, trigger: HTMLElement) => void
}

export function WorkspaceTree({
  projects,
  projectsPending,
  projectsError,
  projectsLoaded,
  activeProject,
  selectedWorktree,
  selectedTerminalId,
  selectedPendingTerminalId,
  selectedWebPanelId,
  pendingTerminals,
  pendingWorktrees,
  pendingRemovals,
  onRetryProjects,
  onSelectTerminal: selectTerminal,
  onSelectPendingTerminal: selectPendingTerminal,
  onCloseTerminal: closeTerminal,
  onSelectWebPanel: selectWebPanel,
  onCloseWebPanel: closeWebPanel,
  onSelectWorktree: selectWorktree,
  onPrepareRemoval: prepareRemoval,
  onOpenPanelDialog,
  onOpenWorktreeDialog
}: WorkspaceTreeProps) {
  const {
    attention: bellAttention,
    titles: runtimeTitles,
    progress: terminalProgress
  } = useTerminalNavigationMetadata()
  const desktopBridge = window.treeportDesktop
  const newWorktreeShortcut = desktopBridge
    ? desktopBridge.platform === 'darwin'
      ? '⌘N'
      : 'Ctrl+N'
    : null
  const newPanelShortcut = desktopBridge
    ? desktopBridge.platform === 'darwin'
      ? '⌘⇧T'
      : 'Ctrl+Shift+T'
    : null

  return (
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
            <div className="project-tree min-w-0" key={project.id}>
              {project.availability.state === 'unavailable' ? (
                <p
                  className="mx-1 mb-2 rounded-md bg-amber-400/8 px-2 py-1.5 text-sm text-amber-200"
                  role="status"
                >
                  {project.availability.message || 'Git repository unavailable'}
                </p>
              ) : null}
              <SidebarMenu className="gap-2 min-[701px]:gap-1">
                {project.worktrees.map((worktree) => (
                  <SidebarMenuItem
                    key={worktree.id}
                    className="group/worktree min-w-0"
                  >
                    <ContextMenu>
                      <ContextMenuTrigger
                        asChild
                        disabled={worktree.kind !== 'linked'}
                      >
                        <div
                          className={cn(
                            'relative min-w-0 max-[700px]:flex max-[700px]:items-center max-[700px]:gap-0.5 max-[700px]:rounded-md max-[700px]:has-[button:hover]:bg-white/5',
                            selectedWorktree?.id === worktree.id &&
                              'max-[700px]:bg-white/8'
                          )}
                        >
                          <WorktreeShell
                            id={`worktree-${worktree.id}`}
                            name={worktree.name}
                            title={`${worktree.path}${
                              worktree.branch
                                ? ` · ${worktree.branch}`
                                : ` · detached at ${worktree.head.slice(0, 8)}`
                            }`}
                            selected={selectedWorktree?.id === worktree.id}
                            className={cn(
                              selectedWorktree?.id === worktree.id &&
                                'min-[701px]:pr-6'
                            )}
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
                                  className="worktree-progress-icon worktree-removing-icon size-4 shrink-0 stroke-rose-400 stroke-[1.5] min-[701px]:size-3.5!"
                                  aria-hidden="true"
                                />
                              ) : worktree.kind === 'main' ? (
                                <CrownIcon
                                  className="size-4 shrink-0 stroke-zinc-600 stroke-[1.5] min-[701px]:size-3.5!"
                                  aria-hidden="true"
                                />
                              ) : (
                                <GitBranchIcon
                                  className="shrink-0 stroke-zinc-600 stroke-[1.5] min-[701px]:size-3.5!"
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
                          {selectedWorktree?.id === worktree.id ? (
                            <div className="worktree-actions absolute inset-y-0 right-0 z-10 flex items-center max-[700px]:static max-[700px]:shrink-0">
                              <SidebarAction
                                label={`New panel in ${worktree.name}`}
                                tooltip={`New panel in ${worktree.name}${
                                  newPanelShortcut
                                    ? ` — ${newPanelShortcut}`
                                    : ''
                                }`}
                                {...(newPanelShortcut
                                  ? {
                                      keyShortcuts:
                                        desktopBridge?.platform === 'darwin'
                                          ? 'Meta+Shift+T'
                                          : 'Control+Shift+T'
                                    }
                                  : {})}
                                className="text-zinc-500 hover:bg-transparent hover:text-zinc-100 min-[701px]:size-6"
                                onClick={(trigger) =>
                                  onOpenPanelDialog(project, worktree, trigger)
                                }
                              >
                                <PlusIcon />
                              </SidebarAction>
                            </div>
                          ) : null}
                        </div>
                      </ContextMenuTrigger>
                      {worktree.kind === 'linked' ? (
                        <ContextMenuContent>
                          <ContextMenuGroup>
                            <ContextMenuItem
                              variant="destructive"
                              disabled={
                                project.availability.state === 'unavailable' ||
                                worktree.prunable ||
                                Boolean(pendingRemovals[worktree.id]) ||
                                worktree.status === 'cleaning' ||
                                needsManualCleanup(worktree)
                              }
                              onSelect={() =>
                                void prepareRemoval(
                                  worktree,
                                  document.getElementById(
                                    `worktree-${worktree.id}`
                                  )!
                                )
                              }
                            >
                              <TrashIcon />
                              {project.availability.state === 'unavailable'
                                ? 'Git repository unavailable'
                                : worktree.prunable
                                  ? 'Removal unavailable'
                                  : pendingRemovals[worktree.id] ||
                                      worktree.status === 'cleaning'
                                    ? 'Removal in progress'
                                    : needsManualCleanup(worktree)
                                      ? 'Manual cleanup required'
                                      : worktree.status === 'cleanup_failed'
                                        ? 'Retry removal…'
                                        : 'Remove worktree…'}
                            </ContextMenuItem>
                          </ContextMenuGroup>
                        </ContextMenuContent>
                      ) : null}
                    </ContextMenu>
                    <SidebarMenuSub
                      className="terminal-list mr-0 ml-4 gap-px border-white/6 pr-0 pl-2 min-[701px]:ml-2.5 min-[701px]:pl-1.5"
                      aria-label={`${worktree.name} terminals`}
                    >
                      {worktree.terminals.map((terminal, index) => {
                        const title =
                          runtimeTitles.get(terminal.id) || terminal.name
                        const needsAttention = bellAttention.has(terminal.id)
                        const progress = terminalProgress.get(terminal.id)
                        const working =
                          !!progress &&
                          !needsAttention &&
                          progress.state !== 'paused' &&
                          progress.state !== 'error'
                        const status = [
                          progress
                            ? terminalProgressLabel(progress)
                            : terminal.status,
                          needsAttention ? 'bell' : null
                        ]
                          .filter(Boolean)
                          .join(', ')
                        const shortcutIndex =
                          selectedWorktree?.id === worktree.id && index < 9
                            ? index + 1
                            : null
                        return (
                          <SidebarMenuSubItem
                            key={terminal.id}
                            className="group/terminal relative min-w-0"
                          >
                            <SidebarMenuSubButton
                              asChild
                              isActive={selectedTerminalId === terminal.id}
                            >
                              <Button
                                variant="ghost"
                                type="button"
                                className={cn(
                                  'terminal-row grid h-auto min-h-11 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_2rem] gap-1.5 rounded-md px-2 py-1.5 text-left text-base/5 font-normal min-[701px]:min-h-7 min-[701px]:grid-cols-[1rem_minmax(0,1fr)_1.75rem] min-[701px]:gap-1 min-[701px]:py-0 min-[701px]:text-xs/4',
                                  selectedTerminalId === terminal.id
                                    ? 'selected bg-cyan-400/8! text-cyan-50'
                                    : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100'
                                )}
                                onClick={() => selectTerminal(terminal)}
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
                                  closeTerminal(terminal)
                                }}
                                aria-label={`${title}, ${status}`}
                                aria-keyshortcuts={
                                  shortcutIndex
                                    ? `Meta+${shortcutIndex}`
                                    : undefined
                                }
                              >
                                <TerminalStatusIcon
                                  working={working}
                                  className={cn(
                                    'size-4! shrink-0 stroke-zinc-500 min-[701px]:size-3.5!',
                                    working && 'stroke-cyan-400',
                                    terminal.status === 'exited' &&
                                      !progress &&
                                      'stroke-rose-300',
                                    progress?.state === 'error' &&
                                      !needsAttention &&
                                      'stroke-rose-300',
                                    progress?.state === 'paused' &&
                                      !needsAttention &&
                                      'stroke-amber-300',
                                    needsAttention && 'stroke-amber-300'
                                  )}
                                />
                                <span
                                  className={cn(
                                    'truncate',
                                    working && 'text-cyan-300',
                                    needsAttention && 'text-amber-200'
                                  )}
                                  aria-hidden="true"
                                >
                                  {title}
                                </span>
                                {shortcutIndex ? (
                                  <kbd
                                    className="justify-self-end font-sans text-[0.6875rem] font-normal text-zinc-500 tabular-nums group-hover/terminal:opacity-0 group-focus-within/terminal:opacity-0 max-[700px]:opacity-0"
                                    aria-hidden="true"
                                  >
                                    ⌘{shortcutIndex}
                                  </kbd>
                                ) : (
                                  <span aria-hidden="true" />
                                )}
                              </Button>
                            </SidebarMenuSubButton>
                            <div className="absolute inset-y-0 right-0 z-10 flex items-center opacity-0 group-hover/terminal:opacity-100 group-focus-within/terminal:opacity-100 max-[700px]:opacity-100">
                              <SidebarAction
                                label={`Close ${title}`}
                                tooltip={
                                  worktree.terminals.length === 1
                                    ? 'Every worktree keeps at least one terminal'
                                    : 'Close terminal'
                                }
                                disabled={worktree.terminals.length === 1}
                                className="text-zinc-500 hover:bg-transparent hover:text-zinc-200"
                                onClick={() => closeTerminal(terminal)}
                              >
                                <XMarkIcon />
                              </SidebarAction>
                            </div>
                          </SidebarMenuSubItem>
                        )
                      })}
                      {worktree.panels
                        .filter(
                          (panel): panel is WebPanel => panel.kind === 'web'
                        )
                        .map((panel, panelIndex) => {
                          const shortcutIndex =
                            selectedWorktree?.id === worktree.id &&
                            worktree.terminals.length + panelIndex < 9
                              ? worktree.terminals.length + panelIndex + 1
                              : null
                          return (
                            <SidebarMenuSubItem
                              key={panel.id}
                              className="group/terminal relative min-w-0"
                            >
                              <SidebarMenuSubButton
                                asChild
                                isActive={selectedWebPanelId === panel.id}
                              >
                                <Button
                                  variant="ghost"
                                  type="button"
                                  className={cn(
                                    'terminal-row grid h-auto min-h-11 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_2rem] gap-1.5 rounded-md px-2 py-1.5 text-left text-base/5 font-normal min-[701px]:min-h-7 min-[701px]:grid-cols-[1rem_minmax(0,1fr)_1.75rem] min-[701px]:gap-1 min-[701px]:py-0 min-[701px]:text-xs/4',
                                    selectedWebPanelId === panel.id
                                      ? 'selected bg-cyan-400/8! text-cyan-50'
                                      : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100'
                                  )}
                                  onClick={() => selectWebPanel(panel)}
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
                                    closeWebPanel(panel, event.currentTarget)
                                  }}
                                  aria-label={`${panel.title}, web panel`}
                                  aria-keyshortcuts={
                                    shortcutIndex
                                      ? `Meta+${shortcutIndex}`
                                      : undefined
                                  }
                                >
                                  <WindowIcon
                                    className="size-4! shrink-0 fill-zinc-500 min-[701px]:size-3.5!"
                                    aria-hidden="true"
                                  />
                                  <span className="truncate" aria-hidden="true">
                                    {panel.title}
                                  </span>
                                  {shortcutIndex ? (
                                    <kbd
                                      className="justify-self-end font-sans text-[0.6875rem] font-normal text-zinc-500 tabular-nums group-hover/terminal:opacity-0 group-focus-within/terminal:opacity-0 max-[700px]:opacity-0"
                                      aria-hidden="true"
                                    >
                                      ⌘{shortcutIndex}
                                    </kbd>
                                  ) : (
                                    <span aria-hidden="true" />
                                  )}
                                </Button>
                              </SidebarMenuSubButton>
                              <div className="absolute inset-y-0 right-0 z-10 flex items-center opacity-0 group-hover/terminal:opacity-100 group-focus-within/terminal:opacity-100 max-[700px]:opacity-100">
                                <SidebarAction
                                  label={`Close ${panel.title}`}
                                  tooltip="Close web panel"
                                  className="text-zinc-500 hover:bg-transparent hover:text-zinc-200"
                                  onClick={(trigger) =>
                                    closeWebPanel(panel, trigger)
                                  }
                                >
                                  <XMarkIcon />
                                </SidebarAction>
                              </div>
                            </SidebarMenuSubItem>
                          )
                        })}
                      {pendingTerminals
                        .filter((pending) => pending.worktreeId === worktree.id)
                        .map((pending, pendingIndex) => {
                          const webPanelCount = worktree.panels.filter(
                            (panel) => panel.kind === 'web'
                          ).length
                          const index =
                            worktree.terminals.length +
                            webPanelCount +
                            pendingIndex
                          return (
                            <SidebarMenuSubItem
                              key={pending.id}
                              className="min-w-0"
                            >
                              <SidebarMenuSubButton
                                asChild
                                isActive={
                                  selectedPendingTerminalId === pending.id
                                }
                              >
                                <Button
                                  variant="ghost"
                                  type="button"
                                  className={cn(
                                    'terminal-row grid h-auto min-h-11 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-1.5 rounded-md px-2 py-1.5 text-left text-base/5 font-normal min-[701px]:min-h-7 min-[701px]:grid-cols-[1rem_minmax(0,1fr)_auto] min-[701px]:gap-1 min-[701px]:py-0 min-[701px]:text-xs/4',
                                    selectedPendingTerminalId === pending.id
                                      ? 'selected bg-cyan-400/8! text-cyan-50'
                                      : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100'
                                  )}
                                  onClick={() =>
                                    selectPendingTerminal(pending.id)
                                  }
                                  aria-label={`${pending.name}, starting`}
                                  aria-keyshortcuts={
                                    selectedWorktree?.id === worktree.id &&
                                    index < 9
                                      ? `Meta+${index + 1}`
                                      : undefined
                                  }
                                >
                                  <ArrowPathIcon
                                    className="animate-spin fill-zinc-500"
                                    aria-hidden="true"
                                  />
                                  <span className="truncate" aria-hidden="true">
                                    {pending.name}
                                  </span>
                                  <span
                                    className="text-[0.6875rem] text-zinc-500"
                                    aria-hidden="true"
                                  >
                                    Starting…
                                  </span>
                                </Button>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          )
                        })}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                ))}
                {!selectedWorktree ? (
                  <SidebarMenuItem className="min-w-0">
                    <SidebarMenuButton asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-h-11 w-full justify-start gap-1.5 px-2 py-1.5 text-base/5 font-normal text-zinc-500 hover:bg-white/5 hover:text-zinc-100 min-[701px]:min-h-8 min-[701px]:py-0.5 min-[701px]:text-sm/5"
                        aria-label="New panel"
                        onClick={(event) =>
                          onOpenPanelDialog(project, null, event.currentTarget)
                        }
                      >
                        <PlusIcon className="min-[701px]:size-3.5!" />
                        <span>New panel</span>
                      </Button>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
                {pendingWorktrees
                  .filter((pending) => pending.projectId === project.id)
                  .map((pending) => (
                    <SidebarMenuItem key={pending.id} className="min-w-0">
                      <WorktreeShell
                        id={`pending-worktree-${pending.id}`}
                        name={pending.typedName}
                        title={`Creating ${pending.typedName}`}
                        pending
                        icon={
                          <GitBranchIcon
                            className="worktree-progress-icon size-4 shrink-0 stroke-cyan-400 stroke-[1.5] min-[701px]:size-3.5!"
                            aria-hidden="true"
                          />
                        }
                      />
                    </SidebarMenuItem>
                  ))}
                <SidebarMenuItem className="min-w-0">
                  <SidebarMenuButton asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto min-h-11 w-full justify-start gap-1.5 px-2 py-1.5 text-base/5 font-normal text-zinc-500 hover:bg-white/5 hover:text-zinc-100 min-[701px]:min-h-8 min-[701px]:py-0.5 min-[701px]:text-sm/5"
                      disabled={project.availability.state === 'unavailable'}
                      aria-keyshortcuts={
                        newWorktreeShortcut
                          ? desktopBridge?.platform === 'darwin'
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
                        onOpenWorktreeDialog(project, event.currentTarget)
                      }
                    >
                      <PlusIcon className="min-[701px]:size-3.5!" />
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
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </div>
          ))}
      </div>
    </nav>
  )
}
