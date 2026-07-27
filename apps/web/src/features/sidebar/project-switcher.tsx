import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowPathIcon,
  CheckIcon,
  ChevronUpDownIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import type { ProjectRecord } from '@treeport/shared'
import { apiClient } from '../../api'
import { TerminalStatusIcon } from '../../components/terminal-status-icon'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import { SidebarMenuButton, useSidebar } from '../../components/ui/sidebar'
import { cn } from '../../lib/utils'
import { recentProjectsQueryOptions } from '../../project-metadata'
import { terminalProgressLabel } from '../../terminal-session'
import { useTerminalNavigationMetadata } from '../../terminal-runtime-metadata-react'
import { notifyError } from '../notifications/error-notifications'
import { SidebarAction } from './sidebar-action'
import { useProjectSwitcher } from './workspace-shell'

export interface ProjectSwitcherProps {
  projects: ProjectRecord[]
  activeProject: ProjectRecord | null
  closingProjectId: string | null
  onSelectProject: (project: ProjectRecord) => void
  onProjectOpened: (project: ProjectRecord) => Promise<void>
  onRequestProjectClose: (project: ProjectRecord) => void
  onOpenProjectDialog: (trigger: HTMLElement) => void
}

export function ProjectSwitcherShortcut({ blocked }: { blocked: boolean }) {
  const usesMacKeyboard = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const { isMobile, setOpenMobile } = useSidebar()
  const projectSwitcher = useProjectSwitcher()

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const modifierPressed = usesMacKeyboard
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey
      if (
        event.isComposing ||
        event.key.toLocaleLowerCase() !== 'p' ||
        !event.shiftKey ||
        event.altKey ||
        !modifierPressed ||
        blocked
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      if (isMobile) {
        setOpenMobile(true)
        window.requestAnimationFrame(() => projectSwitcher.setOpen(true))
      } else {
        projectSwitcher.setOpen(true)
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [blocked, isMobile, projectSwitcher.setOpen, setOpenMobile])

  return null
}

export function ProjectSwitcher({
  projects,
  activeProject,
  closingProjectId,
  onSelectProject: selectProject,
  onProjectOpened,
  onRequestProjectClose: requestProjectClose,
  onOpenProjectDialog
}: ProjectSwitcherProps) {
  const usesMacKeyboard = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const { isMobile } = useSidebar()
  const projectSwitcher = useProjectSwitcher()
  const { attention: bellAttention, progress: terminalProgress } =
    useTerminalNavigationMetadata()
  const [projectSearch, setProjectSearch] = useState('')
  const [highlightedProjectId, setHighlightedProjectId] = useState<
    string | null
  >(null)
  const recentProjectsQuery = useQuery({
    ...recentProjectsQueryOptions,
    enabled: projectSwitcher.open
  })
  const reopenProject = useMutation({
    mutationFn: (project: { id: string }) => apiClient.openProject(project.id),
    onSuccess: onProjectOpened,
    onError: notifyError
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
  const recentProjects = (recentProjectsQuery.data ?? []).filter(
    (project) => !openProjectIds.has(project.id)
  )
  const filteredRecentProjects = recentProjects.filter(
    (project) =>
      !normalizedProjectSearch ||
      project.name.toLocaleLowerCase().includes(normalizedProjectSearch) ||
      project.repositoryPath
        .toLocaleLowerCase()
        .includes(normalizedProjectSearch)
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
      open={projectSwitcher.open}
      onOpenChange={(open) => {
        projectSwitcher.setOpen(open)
        setHighlightedProjectId(null)
        setProjectSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <SidebarMenuButton
          ref={projectSwitcher.triggerRef}
          type="button"
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
        </SidebarMenuButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        portalled={!isMobile}
        className="w-[min(17rem,calc(100vw-1rem))] p-1"
        onOpenAutoFocus={(event) => {
          if (isMobile) {
            event.preventDefault()
          }
        }}
        onCloseAutoFocus={(event) => {
          if (projectSwitcher.dismissedIntoTerminalRef.current) {
            event.preventDefault()
            projectSwitcher.dismissedIntoTerminalRef.current = false
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
                            <TerminalStatusIcon
                              working={
                                progress.state !== 'paused' &&
                                progress.state !== 'error'
                              }
                              className={cn(
                                'size-4 shrink-0 stroke-cyan-300',
                                progress.state === 'error' && 'stroke-rose-300',
                                progress.state === 'paused' &&
                                  'stroke-amber-300'
                              )}
                              title={terminalProgressLabel(progress)}
                            />
                          ) : null}
                          {needsAttention ? (
                            <TerminalStatusIcon
                              working={false}
                              className="size-4 shrink-0 stroke-amber-300"
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
          {!recentProjectsQuery.isSuccess || recentProjects.length ? (
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
              {recentProjectsQuery.isSuccess &&
              filteredRecentProjects.length ? (
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
              {recentProjectsQuery.isSuccess &&
              !filteredRecentProjects.length ? (
                <p className="px-2 py-1 text-sm text-zinc-500">
                  No recent projects found.
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-0.5 h-8 w-full justify-start border-t border-white/8 py-1 text-sm font-normal text-zinc-500 hover:text-zinc-100"
          onClick={(event) => {
            projectSwitcher.setOpen(false)
            onOpenProjectDialog(
              projectSwitcher.triggerRef.current ?? event.currentTarget
            )
          }}
        >
          <PlusIcon /> Open project…
        </Button>
      </PopoverContent>
    </Popover>
  )
}
