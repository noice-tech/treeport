import type { ReactNode } from 'react'
import { CrownIcon, GitBranchIcon } from 'lucide-react'
import { PlusIcon, TrashIcon } from '@heroicons/react/16/solid'
import type {
  ProjectRecord,
  TerminalRecord,
  WorktreeRecord
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
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
    'worktree-row flex h-auto min-h-11 w-full min-w-0 items-center justify-start gap-1.5 rounded-md px-2 py-1.5 text-left text-base/5 font-medium min-[701px]:min-h-8 min-[701px]:py-0.5 min-[701px]:text-sm/5',
    linked && 'min-[701px]:pr-9',
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
  pendingWorktrees: PendingWorktreeCreation[]
  pendingRemovals: Record<string, RemovalStage>
  onRetryProjects: () => void
  onSelectTerminal: (terminal: TerminalRecord) => void
  onSelectWorktree: (worktree: WorktreeRecord) => void
  onPrepareRemoval: (
    worktree: WorktreeRecord,
    trigger: HTMLElement
  ) => Promise<void>
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
  pendingWorktrees,
  pendingRemovals,
  onRetryProjects,
  onSelectTerminal: selectTerminal,
  onSelectWorktree: selectWorktree,
  onPrepareRemoval: prepareRemoval,
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
            <div className="project-tree" key={project.id}>
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
                              project.availability.state === 'unavailable' ||
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
                    <SidebarMenuSub className="terminal-list mr-0 ml-4 gap-px border-white/6 pr-0 pl-2 min-[701px]:ml-2.5 min-[701px]:pl-1.5">
                      {worktree.terminals.map((terminal) => {
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
                        return (
                          <SidebarMenuSubItem
                            key={terminal.id}
                            className="min-w-0"
                          >
                            <SidebarMenuSubButton
                              asChild
                              isActive={selectedTerminalId === terminal.id}
                            >
                              <Button
                                variant="ghost"
                                type="button"
                                className={cn(
                                  'terminal-row grid h-auto min-h-11 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_0.5rem] gap-1.5 rounded-md px-2 py-1.5 text-left text-base/5 font-normal min-[701px]:min-h-7 min-[701px]:grid-cols-[1rem_minmax(0,1fr)_0.5rem] min-[701px]:gap-1 min-[701px]:py-0 min-[701px]:text-xs/4',
                                  selectedTerminalId === terminal.id
                                    ? 'selected bg-cyan-400/8! text-cyan-50'
                                    : 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100'
                                )}
                                onClick={() => selectTerminal(terminal)}
                                aria-label={`${
                                  runtimeTitles.get(terminal.id) ||
                                  terminal.name
                                }, ${status}`}
                              >
                                <TerminalStatusIcon
                                  working={working}
                                  className={cn(
                                    'size-4! shrink-0 stroke-zinc-500 min-[701px]:size-3.5!',
                                    working && 'stroke-cyan-400',
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
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        )
                      })}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                ))}
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
