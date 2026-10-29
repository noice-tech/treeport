import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { CrownIcon, GitBranchIcon } from 'lucide-react'
import {
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  FolderIcon,
  LinkSlashIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import type {
  ProjectRecord,
  TerminalRecord,
  TreeDecoration,
  TreeDecorationTone,
  WorktreeRecord
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger
} from '../../components/ui/hover-card'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
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
import {
  TerminalStatusIcon,
  terminalAttentionColor
} from '../../components/terminal-status-icon'
import { cn } from '../../lib/utils'
import {
  terminalActivityLabel,
  terminalDisplayTitle
} from '../../terminal-session'
import { ReorderableItems } from '../../use-reorderable-items'
import { useTerminalNavigationMetadata } from '../../terminal-runtime-metadata-react'
import { terminalLayoutDrag } from '../terminals/terminal-layout-drag'
import {
  disconnectTerminalFromLayout,
  normalizeTerminalWorkspaceLayout,
  terminalIdsInLayoutNode,
  terminalWorkspaceLayouts
} from '../terminals/terminal-workspace-layout'
import { useWorkspaceSurfaceFocus } from '../apps/workspace-surface-focus-context'
import type {
  PendingWorktreeCreation,
  RemovalStage
} from '../worktrees/worktree-workflows'
import { WorktreeTitleDialog } from '../worktrees/worktree-title-dialog'
import { SidebarAction } from './sidebar-action'

function copyText(text: string) {
  const copyBuffer = document.createElement('textarea')
  copyBuffer.value = text
  copyBuffer.readOnly = true
  copyBuffer.style.position = 'fixed'
  copyBuffer.style.left = '-9999px'
  copyBuffer.style.opacity = '0'
  ;(document.activeElement?.parentElement ?? document.body).appendChild(
    copyBuffer
  )
  copyBuffer.focus({ preventScroll: true })
  copyBuffer.select()
  copyBuffer.setSelectionRange(0, text.length)
  const copied = document.execCommand('copy')
  copyBuffer.remove()

  if (!copied) {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  }
}

const treeDecorationToneClasses = {
  neutral: 'text-zinc-400',
  info: 'text-blue-400',
  success: 'text-emerald-400',
  warning: 'text-amber-400',
  danger: 'text-rose-400',
  done: 'text-violet-400'
} satisfies Record<TreeDecorationTone, string>

const treeDecorationToneRank = (tone: TreeDecorationTone) =>
  tone === 'danger' ? 0 : tone === 'warning' ? 1 : 2

const VISIBLE_TREE_DECORATIONS = 2

const COLLAPSED_TERMINALS_STORAGE_KEY = 'treeport-collapsed-terminals'

function sortTreeDecorations(decorations: TreeDecoration[]): TreeDecoration[] {
  return [...decorations].sort(
    (left, right) =>
      treeDecorationToneRank(left.tone) - treeDecorationToneRank(right.tone)
  )
}

function TreeDecorationLabel({
  decoration,
  className
}: {
  decoration: TreeDecoration
  className?: string
}) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 text-xs font-medium tabular-nums',
        decoration.icon
          ? 'text-zinc-400'
          : treeDecorationToneClasses[decoration.tone],
        className
      )}
    >
      {decoration.icon ? (
        <span
          aria-hidden
          className={cn(
            'size-3 shrink-0 bg-current mask-contain mask-center mask-no-repeat',
            treeDecorationToneClasses[decoration.tone]
          )}
          style={{
            maskImage: `url("data:image/svg+xml,${encodeURIComponent(decoration.icon)}")`
          }}
        />
      ) : null}
      <span className="min-w-0 truncate">{decoration.text}</span>
    </span>
  )
}

function WorktreeShell({
  name,
  title,
  icon,
  status,
  decorations = [],
  selected = false,
  pending = false,
  titlePending = false,
  busy = false,
  id,
  className,
  ariaLabel,
  onClick,
  onOpenDecoration
}: {
  name: string
  title: string
  icon: ReactNode
  status?: ReactNode
  decorations?: TreeDecoration[]
  selected?: boolean
  pending?: boolean
  titlePending?: boolean
  busy?: boolean
  id?: string
  className?: string
  ariaLabel?: string | undefined
  onClick?: () => void
  onOpenDecoration?: (url: string) => void
}) {
  const [decorationsOpen, setDecorationsOpen] = useState(false)

  const classes = cn(
    'worktree-row flex h-auto min-h-8 max-[700px]:h-auto w-full min-w-0 items-center justify-start gap-1.5 rounded-md px-2 py-1 text-left text-[0.8125rem]/4 font-medium min-[701px]:text-sm/5 min-[701px]:min-h-8 min-[701px]:py-0.5',
    pending
      ? 'text-zinc-300'
      : selected
        ? 'selected text-zinc-50 [&>svg]:text-accent-400 max-[700px]:bg-transparent! min-[701px]:bg-white/7! min-[701px]:active:bg-white/10!'
        : 'text-zinc-200 hover:bg-white/5 hover:text-zinc-50',
    'max-[700px]:flex-1 max-[700px]:hover:bg-transparent max-[700px]:active:bg-transparent',
    (pending || busy) && 'motion-safe:animate-pulse',
    pending && 'pointer-events-none',
    className
  )

  const sortedDecorations = sortTreeDecorations(decorations)
  const hiddenDecorations = sortedDecorations.slice(VISIBLE_TREE_DECORATIONS)

  const content = (
    <>
      {icon}
      <span className="flex min-w-12 flex-1 flex-col">
        <span
          className={cn('truncate', titlePending && 'worktree-title-pending')}
        >
          {name}
        </span>
        {status}
      </span>
      {decorations.length ? (
        <HoverCard open={decorationsOpen} onOpenChange={setDecorationsOpen}>
          <HoverCardTrigger asChild>
            {/* EXTERNAL: An empty title stops the row's native title from stacking on this hover card. */}
            <span title="" className="flex min-w-0 items-center gap-2.5">
              {sortedDecorations
                .slice(0, VISIBLE_TREE_DECORATIONS)
                .map((decoration) => (
                  <TreeDecorationLabel
                    key={decoration.key}
                    decoration={decoration}
                    className="max-w-28"
                  />
                ))}
              {hiddenDecorations.length ? (
                <span className="shrink-0 text-xs font-medium text-zinc-500 tabular-nums">
                  +{hiddenDecorations.length}
                </span>
              ) : null}
            </span>
          </HoverCardTrigger>
          <HoverCardContent
            side="right"
            align="start"
            className="flex w-max max-w-80 flex-col"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            {sortedDecorations.map((decoration) => {
              const row = (
                <>
                  <TreeDecorationLabel
                    decoration={decoration}
                    className="text-sm"
                  />
                  <span className="line-clamp-2 text-[0.8125rem]/4.5 text-zinc-400 wrap-anywhere">
                    {decoration.title}
                  </span>
                </>
              )

              return decoration.url ? (
                <button
                  key={decoration.key}
                  type="button"
                  className="flex flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-white/7 focus-visible:bg-white/7 active:bg-white/10"
                  onClick={() => {
                    setDecorationsOpen(false)
                    onOpenDecoration?.(decoration.url!)
                  }}
                >
                  {row}
                </button>
              ) : (
                <div
                  key={decoration.key}
                  className="flex flex-col gap-0.5 px-2 py-1.5"
                >
                  {row}
                </div>
              )
            })}
          </HoverCardContent>
        </HoverCard>
      ) : null}
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
        aria-label={pending ? `Creating tree ${name}` : ariaLabel}
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
  onCloseTerminal: (terminal: TerminalRecord) => void
  onReorderTerminals: (worktree: WorktreeRecord, terminalIds: string[]) => void
  onSelectWorktree: (worktree: WorktreeRecord) => void
  onPrepareRemoval: (
    worktree: WorktreeRecord,
    trigger: HTMLElement
  ) => Promise<void>
  onOpenAppDialog: (
    project: ProjectRecord,
    worktree: WorktreeRecord | null,
    trigger: HTMLElement
  ) => void
  onOpenWorktreeDialog: (project: ProjectRecord, trigger: HTMLElement) => void
  onOpenBrowserUrl: (
    project: ProjectRecord,
    worktree: WorktreeRecord,
    url: string
  ) => void
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
  onCloseTerminal: closeTerminal,
  onReorderTerminals: reorderTerminals,
  onSelectWorktree: selectWorktree,
  onPrepareRemoval: prepareRemoval,
  onOpenAppDialog,
  onOpenWorktreeDialog,
  onOpenBrowserUrl
}: WorkspaceTreeProps) {
  useSyncExternalStore(
    terminalWorkspaceLayouts.subscribe,
    terminalWorkspaceLayouts.getSnapshot,
    terminalWorkspaceLayouts.getSnapshot
  )
  const { focusedSurface } = useWorkspaceSurfaceFocus()

  const [titleWorktree, setTitleWorktree] = useState<WorktreeRecord | null>(
    null
  )

  const [collapsedTerminalIds, setCollapsedTerminalIds] = useState(
    () =>
      new Set(
        localStorage
          .getItem(COLLAPSED_TERMINALS_STORAGE_KEY)
          ?.split(',')
          .filter(Boolean) ?? []
      )
  )

  const terminalOwners = new Map(
    projects.flatMap((project) =>
      project.worktrees.flatMap((worktree) =>
        worktree.terminals.map(
          (terminal) => [terminal.id, { terminal, worktree }] as const
        )
      )
    )
  )

  const toggleTerminalChildren = (terminalId: string) => {
    const next = new Set(collapsedTerminalIds)

    if (!next.delete(terminalId)) {
      next.add(terminalId)
    }

    const retained = [...next].filter((id) => terminalOwners.has(id))
    localStorage.setItem(COLLAPSED_TERMINALS_STORAGE_KEY, retained.join(','))
    setCollapsedTerminalIds(new Set(retained))
  }

  const {
    attention: terminalAttention,
    titles: runtimeTitles,
    programs: terminalPrograms,
    activity: terminalActivity
  } = useTerminalNavigationMetadata()

  const desktopBridge = window.treeportDesktop

  const newWorktreeShortcut = desktopBridge?.onCommand
    ? desktopBridge.platform === 'darwin'
      ? '⌘N'
      : 'Ctrl+N'
    : null

  const usesMacKeyboard = /Mac|iPhone|iPad|iPod/.test(navigator.platform)

  const orderedWorktrees = new Map(
    projects.map((project) => {
      const ids = new Set(project.worktrees.map((worktree) => worktree.id))

      const withChildTrees = (worktree: WorktreeRecord): WorktreeRecord[] => [
        worktree,
        ...project.worktrees
          .filter(
            (candidate) =>
              candidate.originWorktreeId === worktree.id &&
              candidate.id !== worktree.id
          )
          .flatMap(withChildTrees)
      ]

      return [
        project.id,
        project.worktrees
          .filter(
            (worktree) =>
              !worktree.originWorktreeId || !ids.has(worktree.originWorktreeId)
          )
          .flatMap(withChildTrees)
      ] as const
    })
  )

  const terminalTrees = new Map<
    string,
    {
      visibleTerminals: TerminalRecord[]
      depths: Map<string, number>
      childCounts: Map<string, number>
      runningDescendants: Map<string, number>
      splitMembers: Map<string, 'first' | 'middle' | 'last'>
    }
  >()

  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const terminalsById = new Map(
        worktree.terminals.map((terminal) => [terminal.id, terminal])
      )

      const layout = normalizeTerminalWorkspaceLayout(
        terminalWorkspaceLayouts.read(worktree.id),
        worktree.terminals.map((terminal) => terminal.id)
      )

      const groups = layout.groups.map(terminalIdsInLayoutNode)
      const splitMembers = new Map<string, 'first' | 'middle' | 'last'>()
      const childGroups = new Map<string, string[][]>()
      const rootGroups: string[][] = []

      for (const groupIds of groups) {
        const parentId =
          groupIds.length === 1
            ? terminalsById.get(groupIds[0]!)!.parentTerminalId
            : null

        if (
          parentId &&
          parentId !== groupIds[0] &&
          terminalsById.has(parentId)
        ) {
          childGroups.set(parentId, [
            ...(childGroups.get(parentId) ?? []),
            groupIds
          ])
        } else {
          rootGroups.push(groupIds)
        }
      }

      const visibleIds: string[] = []
      const depths = new Map<string, number>()
      const childCounts = new Map<string, number>()
      const runningDescendants = new Map<string, number>()

      const visitGroup = (
        groupIds: string[],
        depth: number,
        visible: boolean
      ): number => {
        let running = 0
        const unvisitedIds = groupIds.filter((id) => !depths.has(id))

        for (const terminalId of unvisitedIds) {
          depths.set(terminalId, depth)

          if (visible) {
            visibleIds.push(terminalId)
          }
        }

        for (const terminalId of unvisitedIds) {
          const children = childGroups.get(terminalId) ?? []
          let childRunning = 0

          for (const child of children) {
            childRunning += visitGroup(
              child,
              depth + 1,
              visible && !collapsedTerminalIds.has(terminalId)
            )
          }

          childCounts.set(terminalId, children.length)
          runningDescendants.set(terminalId, childRunning)
          running +=
            childRunning +
            (terminalsById.get(terminalId)!.status === 'running' ? 1 : 0)
        }

        return running
      }

      for (const groupIds of rootGroups) {
        visitGroup(groupIds, 0, true)
      }

      for (const groupIds of groups) {
        visitGroup(groupIds, 0, true)
      }

      for (const groupIds of groups) {
        if (groupIds.length < 2) {
          continue
        }

        groupIds.forEach((terminalId, index) => {
          splitMembers.set(
            terminalId,
            index === 0
              ? 'first'
              : index === groupIds.length - 1
                ? 'last'
                : 'middle'
          )
        })
      }

      terminalTrees.set(worktree.id, {
        visibleTerminals: visibleIds.map((terminalId) =>
          terminalsById.get(terminalId)!
        ),
        depths,
        childCounts,
        runningDescendants,
        splitMembers
      })
    }
  }

  return (
    <nav
      className="tree min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pt-1.5 pb-3 min-[701px]:px-1.5 min-[701px]:pt-2 min-[701px]:pb-4 [scrollbar-color:var(--color-zinc-700)_transparent]"
      aria-label="Projects and trees"
    >
      {projectsPending ? (
        <p className="sidebar-note px-2 py-2 text-sm text-zinc-500 min-[701px]:text-sm">
          Loading projects…
        </p>
      ) : null}
      {projectsError && !projectsLoaded ? (
        <div className="flex flex-col items-start gap-2 px-2 py-3">
          <p className="sidebar-note text-sm text-rose-300 min-[701px]:text-sm">
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
        <p className="sidebar-note px-2 py-2 text-sm text-pretty text-zinc-500 min-[701px]:text-sm">
          Open a folder or Git repository to begin.
        </p>
      ) : null}
      <div className="grid gap-4 max-[700px]:gap-2">
        {projects
          .filter((project) => project.id === activeProject?.id)
          .map((project) => (
            <div className="project-tree min-w-0" key={project.id}>
              {project.availability.state === 'unavailable' ? (
                <p
                  className="mx-1 mb-2 rounded-md bg-amber-400/8 px-2 py-1.5 text-sm text-amber-200"
                  role="status"
                >
                  {project.availability.message || 'Project folder unavailable'}
                </p>
              ) : null}
              <SidebarMenu className="gap-0.5 min-[701px]:gap-1">
                {orderedWorktrees.get(project.id)!.map((worktree) => (
                  <SidebarMenuItem
                    key={worktree.id}
                    className={cn(
                      'group/worktree min-w-0',
                      project.worktrees.some(
                        (candidate) =>
                          candidate.id === worktree.originWorktreeId
                      ) && 'worktree-origin-child'
                    )}
                  >
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            'relative min-w-0 max-[700px]:flex max-[700px]:items-center max-[700px]:gap-0.5 max-[700px]:rounded-md max-[700px]:[@media(hover:hover)_and_(pointer:fine)]:has-[button:hover]:bg-white/5 max-[700px]:has-[button:active]:bg-white/10 max-[700px]:select-none',
                            selectedWorktree?.id === worktree.id &&
                              'max-[700px]:bg-white/8'
                          )}
                        >
                          <WorktreeShell
                            id={`worktree-${worktree.id}`}
                            name={
                              worktree.title ??
                              worktree.pendingTitle ??
                              worktree.name
                            }
                            titlePending={worktree.pendingTitle !== null}
                            title={
                              worktree.kind === 'folder'
                                ? worktree.path
                                : `${(worktree.title ?? worktree.pendingTitle) ? `${worktree.name} · ` : ''}${worktree.path}${
                                    worktree.branch
                                      ? ` · ${worktree.branch}`
                                      : ` · detached at ${worktree.head.slice(
                                          0,
                                          8
                                        )}`
                                  }`
                            }
                            decorations={worktree.decorations}
                            selected={selectedWorktree?.id === worktree.id}
                            className={cn(
                              selectedWorktree?.id === worktree.id &&
                                'min-[701px]:pr-6'
                            )}
                            busy={Boolean(pendingRemovals[worktree.id])}
                            ariaLabel={
                              pendingRemovals[worktree.id] === 'checking'
                                ? `${worktree.name}, preparing removal`
                                : pendingRemovals[worktree.id]
                                  ? `${worktree.name}, removing`
                                  : undefined
                            }
                            onClick={() => selectWorktree(worktree)}
                            onOpenDecoration={(url) =>
                              onOpenBrowserUrl(project, worktree, url)
                            }
                            icon={
                              pendingRemovals[worktree.id] ? (
                                <GitBranchIcon
                                  className="worktree-progress-icon worktree-removing-icon size-4 shrink-0 stroke-rose-400 stroke-[1.5] min-[701px]:size-3.5!"
                                  aria-hidden="true"
                                />
                              ) : worktree.kind === 'folder' ? (
                                <FolderIcon
                                  className="size-4 shrink-0 text-zinc-600 min-[701px]:size-3.5!"
                                  aria-hidden="true"
                                />
                              ) : worktree.kind === 'main' ? (
                                <CrownIcon
                                  className="size-4 shrink-0 stroke-[1.5] text-zinc-600 min-[701px]:size-3.5!"
                                  aria-hidden="true"
                                />
                              ) : (
                                <GitBranchIcon
                                  className="shrink-0 stroke-[1.5] text-zinc-600 min-[701px]:size-3.5!"
                                  aria-hidden="true"
                                />
                              )
                            }
                          />
                          {selectedWorktree?.id === worktree.id ? (
                            <div className="worktree-actions absolute inset-y-0 right-0 z-10 flex items-center max-[700px]:static max-[700px]:shrink-0">
                              <SidebarAction
                                label={`New app in ${worktree.name}`}
                                tooltip={`New app in ${worktree.name} — ${
                                  usesMacKeyboard ? '⌘P' : 'Ctrl+P'
                                }`}
                                keyShortcuts={
                                  usesMacKeyboard ? 'Meta+P' : 'Control+P'
                                }
                                className="text-zinc-500 hover:bg-transparent hover:text-zinc-100 active:bg-transparent max-[700px]:text-zinc-300 min-[701px]:size-6"
                                onClick={(trigger) =>
                                  onOpenAppDialog(project, worktree, trigger)
                                }
                              >
                                <PlusIcon />
                              </SidebarAction>
                            </div>
                          ) : null}
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="max-w-[min(20rem,var(--radix-context-menu-content-available-width))]">
                        <ContextMenuGroup>
                          <ContextMenuItem
                            onSelect={() => setTitleWorktree(worktree)}
                          >
                            <PencilIcon />
                            Edit title…
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => copyText(worktree.id)}
                          >
                            <DocumentDuplicateIcon />
                            Copy tree ID
                          </ContextMenuItem>
                          {project.worktrees.some(
                            (candidate) =>
                              candidate.id === worktree.originWorktreeId
                          ) ? (
                            <ContextMenuItem
                              onSelect={() =>
                                selectWorktree(
                                  project.worktrees.find(
                                    (candidate) =>
                                      candidate.id === worktree.originWorktreeId
                                  )!
                                )
                              }
                            >
                              <ArrowUturnLeftIcon />
                              Go to origin tree
                            </ContextMenuItem>
                          ) : null}
                        </ContextMenuGroup>
                        {worktree.decorations.length &&
                        globalThis.matchMedia?.('(pointer: coarse)').matches ? (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuGroup>
                              {sortTreeDecorations(worktree.decorations).map(
                                (decoration) => (
                                  <ContextMenuItem
                                    key={decoration.key}
                                    disabled={!decoration.url}
                                    className="data-[disabled]:opacity-100"
                                    onSelect={() =>
                                      onOpenBrowserUrl(
                                        project,
                                        worktree,
                                        decoration.url!
                                      )
                                    }
                                  >
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                      <TreeDecorationLabel
                                        decoration={decoration}
                                        className="text-sm"
                                      />
                                      <span className="line-clamp-2 text-[0.8125rem]/4.5 text-zinc-400 wrap-anywhere">
                                        {decoration.title}
                                      </span>
                                    </span>
                                  </ContextMenuItem>
                                )
                              )}
                            </ContextMenuGroup>
                          </>
                        ) : null}
                        {worktree.kind === 'linked' ? (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuGroup>
                              <ContextMenuItem
                                variant="destructive"
                                disabled={
                                  project.availability.state ===
                                    'unavailable' ||
                                  Boolean(pendingRemovals[worktree.id])
                                }
                                onSelect={() => {
                                  void prepareRemoval(
                                    worktree,
                                    document.getElementById(
                                      `worktree-${worktree.id}`
                                    )!
                                  )
                                }}
                              >
                                <TrashIcon />
                                {project.availability.state === 'unavailable'
                                  ? 'Git repository unavailable'
                                  : pendingRemovals[worktree.id]
                                    ? 'Preparing removal…'
                                    : 'Remove tree…'}
                              </ContextMenuItem>
                            </ContextMenuGroup>
                          </>
                        ) : null}
                      </ContextMenuContent>
                    </ContextMenu>
                    <SidebarMenuSub
                      className="terminal-list mr-0 ml-2.5 gap-px border-white/6 pr-0 pl-1.5 min-[701px]:ml-2.5 min-[701px]:gap-px"
                      aria-label={`${worktree.name} terminal tabs`}
                    >
                      <ReorderableItems
                        items={
                          terminalTrees.get(worktree.id)?.visibleTerminals ??
                          worktree.terminals
                        }
                        orientation="vertical"
                        onReorder={(terminalIds) =>
                          reorderTerminals(worktree, [
                            ...terminalIds,
                            ...worktree.terminals
                              .map((terminal) => terminal.id)
                              .filter((id) => !terminalIds.includes(id))
                          ])
                        }
                        onDragMove={(terminal, clientX, clientY) =>
                          terminalLayoutDrag.update(terminal, clientX, clientY)
                        }
                        onDragEnd={(terminal, clientX, clientY) =>
                          terminalLayoutDrag.finish(terminal, clientX, clientY)
                        }
                        onDragCancel={() => terminalLayoutDrag.cancel()}
                      >
                        {(terminal, itemProps, handleProps) => {
                          const title = terminalDisplayTitle(
                            runtimeTitles.get(terminal.id),
                            terminal.name
                          )

                          const attention =
                            terminalAttention.get(terminal.id) ?? null

                          const needsAttention = attention !== null
                          const activity = terminalActivity.get(terminal.id)

                          const working =
                            activity?.state === 'working' && !needsAttention

                          const status = [
                            activity
                              ? terminalActivityLabel(activity)
                              : terminal.status,
                            needsAttention ? 'needs attention' : null
                          ]
                            .filter(Boolean)
                            .join(', ')

                          const serverIndex =
                            worktree.terminals.indexOf(terminal)

                          const shortcutIndex =
                            selectedWorktree?.id === worktree.id &&
                            serverIndex < 9
                              ? serverIndex + 1
                              : null

                          const terminalTree = terminalTrees.get(worktree.id)

                          const splitMember = terminalTree?.splitMembers.get(
                            terminal.id
                          )

                          const depth =
                            terminalTree?.depths.get(terminal.id) ?? 0

                          const childCount =
                            terminalTree?.childCounts.get(terminal.id) ?? 0

                          const childrenCollapsed = collapsedTerminalIds.has(
                            terminal.id
                          )

                          const runningChildren =
                            terminalTree?.runningDescendants.get(terminal.id) ??
                            0

                          return (
                            <SidebarMenuSubItem
                              key={terminal.id}
                              {...itemProps}
                              style={{
                                ...itemProps.style,
                                marginLeft: `${depth * 0.875}rem`
                              }}
                              className={cn(
                                'group/terminal relative min-w-0',
                                splitMember && 'terminal-split-tree-member',
                                splitMember === 'first' &&
                                  'terminal-split-tree-first',
                                splitMember === 'last' &&
                                  'terminal-split-tree-last'
                              )}
                            >
                              <ContextMenu>
                                <ContextMenuTrigger asChild>
                                  <SidebarMenuSubButton
                                    asChild
                                    isActive={
                                      selectedTerminalId === terminal.id
                                    }
                                  >
                                    <Button
                                      variant="ghost"
                                      type="button"
                                      className={cn(
                                        'terminal-row grid h-auto min-h-8 max-[700px]:h-auto w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)_2rem] gap-1 rounded-md px-2 py-1 text-left text-xs/4 font-normal min-[701px]:min-h-7 min-[701px]:grid-cols-[1rem_minmax(0,1fr)_1.75rem] min-[701px]:gap-1 min-[701px]:py-0 min-[701px]:text-xs/4',
                                        childCount > 0 &&
                                          'grid-cols-[1rem_minmax(0,1fr)_4.25rem] min-[701px]:grid-cols-[1rem_minmax(0,1fr)_3.75rem]',
                                        selectedTerminalId === terminal.id
                                          ? 'selected bg-accent-400/8! text-accent-50 active:bg-accent-400/14!'
                                          : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
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
                                      aria-keyshortcuts={[
                                        focusedSurface === 'terminal' &&
                                        shortcutIndex
                                          ? `Meta+${shortcutIndex}`
                                          : null,
                                        'Alt+Shift+ArrowUp',
                                        'Alt+Shift+ArrowDown'
                                      ]
                                        .filter(Boolean)
                                        .join(' ')}
                                      {...handleProps}
                                    >
                                      <TerminalStatusIcon
                                        program={
                                          terminalPrograms.get(terminal.id) ??
                                          null
                                        }
                                        activity={activity ?? null}
                                        attention={attention}
                                        exited={terminal.status === 'exited'}
                                        className="size-4! min-[701px]:size-3.5!"
                                      />
                                      <span
                                        className={cn(
                                          'truncate',
                                          working && 'text-accent-300',
                                          attention &&
                                            terminalAttentionColor(attention)
                                        )}
                                        aria-hidden="true"
                                      >
                                        {title}
                                      </span>
                                      <span aria-hidden="true" />
                                    </Button>
                                  </SidebarMenuSubButton>
                                </ContextMenuTrigger>
                                {childCount > 0 ? (
                                  <div className="absolute inset-y-0 right-8 z-10 flex items-center min-[701px]:right-6">
                                    <SidebarAction
                                      label={`${childrenCollapsed ? 'Show' : 'Hide'} ${childCount} ${childCount === 1 ? 'terminal' : 'terminals'} started by ${title}`}
                                      tooltipSide="right"
                                      tooltip={
                                        childrenCollapsed
                                          ? `Show started terminals${runningChildren ? ` — ${runningChildren} running` : ''}`
                                          : 'Hide started terminals'
                                      }
                                      className={cn(
                                        'w-auto gap-0.5 px-1 text-[0.6875rem] text-zinc-500 tabular-nums hover:bg-transparent hover:text-zinc-200 active:bg-transparent',
                                        childrenCollapsed &&
                                          runningChildren > 0 &&
                                          'text-accent-300'
                                      )}
                                      onClick={() =>
                                        toggleTerminalChildren(terminal.id)
                                      }
                                    >
                                      {childrenCollapsed ? (
                                        <ChevronRightIcon />
                                      ) : (
                                        <ChevronDownIcon />
                                      )}
                                      {childCount}
                                    </SidebarAction>
                                  </div>
                                ) : null}
                                <div className="absolute inset-y-0 right-0 z-10 flex items-center opacity-0 group-hover/terminal:opacity-100 group-focus-within/terminal:opacity-100 max-[700px]:opacity-100">
                                  <SidebarAction
                                    label={`Close ${title}`}
                                    tooltipSide="right"
                                    tooltip="Close terminal"
                                    className="text-zinc-500 hover:bg-transparent hover:text-zinc-200 active:bg-transparent"
                                    onClick={() => closeTerminal(terminal)}
                                  >
                                    <XMarkIcon />
                                  </SidebarAction>
                                </div>
                                <ContextMenuContent>
                                  <ContextMenuGroup>
                                    {splitMember ? (
                                      <ContextMenuItem
                                        onSelect={() =>
                                          terminalWorkspaceLayouts.update(
                                            worktree.id,
                                            worktree.terminals.map(
                                              (candidate) => candidate.id
                                            ),
                                            (layout) =>
                                              disconnectTerminalFromLayout(
                                                layout,
                                                terminal.id
                                              )
                                          )
                                        }
                                      >
                                        <LinkSlashIcon />
                                        Disconnect from split
                                      </ContextMenuItem>
                                    ) : null}
                                    <ContextMenuItem
                                      onSelect={() => copyText(terminal.id)}
                                    >
                                      <DocumentDuplicateIcon />
                                      Copy terminal ID
                                    </ContextMenuItem>
                                  </ContextMenuGroup>
                                  <ContextMenuSeparator />
                                  <ContextMenuGroup>
                                    <ContextMenuItem
                                      variant="destructive"
                                      onSelect={() => closeTerminal(terminal)}
                                    >
                                      <XMarkIcon />
                                      Close terminal
                                    </ContextMenuItem>
                                  </ContextMenuGroup>
                                </ContextMenuContent>
                              </ContextMenu>
                            </SidebarMenuSubItem>
                          )
                        }}
                      </ReorderableItems>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                ))}
                {!selectedWorktree ? (
                  <SidebarMenuItem className="min-w-0">
                    <SidebarMenuButton asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-h-8 max-[700px]:h-auto w-full justify-start gap-1 px-2 py-1 text-[0.8125rem]/4 font-normal min-[701px]:text-sm/5 text-zinc-500 hover:bg-white/5 hover:text-zinc-100 min-[701px]:min-h-8 min-[701px]:py-0.5"
                        aria-label="New app"
                        onClick={(event) =>
                          onOpenAppDialog(project, null, event.currentTarget)
                        }
                      >
                        <PlusIcon className="min-[701px]:size-3.5!" />
                        <span>New app</span>
                      </Button>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
                {pendingWorktrees
                  .filter((pending) => pending.projectId === project.id)
                  .map((pending) => (
                    <SidebarMenuItem key={pending.id} className="min-w-0">
                      <WorktreeShell
                        name={pending.pendingTitle ?? pending.typedName}
                        title={`Creating ${pending.typedName}`}
                        pending
                        icon={
                          <GitBranchIcon
                            className="worktree-progress-icon size-4 shrink-0 stroke-accent-400 stroke-[1.5] min-[701px]:size-3.5!"
                            aria-hidden="true"
                          />
                        }
                      />
                    </SidebarMenuItem>
                  ))}
                {project.kind === 'repository' ? (
                  <SidebarMenuItem className="min-w-0">
                    <SidebarMenuButton asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-h-8 max-[700px]:h-auto w-full justify-start gap-1 px-2 py-1 text-[0.8125rem]/4 font-normal min-[701px]:text-sm/5 text-zinc-500 hover:bg-white/5 hover:text-zinc-100 min-[701px]:min-h-8 min-[701px]:py-0.5"
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
                            ? `New tree — ${newWorktreeShortcut}`
                            : undefined
                        }
                        onClick={(event) =>
                          onOpenWorktreeDialog(project, event.currentTarget)
                        }
                      >
                        <PlusIcon className="min-[701px]:size-3.5!" />
                        <span>New tree</span>
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
                ) : null}
              </SidebarMenu>
            </div>
          ))}
      </div>
      {titleWorktree ? (
        <WorktreeTitleDialog
          worktree={titleWorktree}
          onClose={() => setTitleWorktree(null)}
        />
      ) : null}
    </nav>
  )
}
