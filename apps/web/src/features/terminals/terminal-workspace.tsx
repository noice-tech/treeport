import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type {
  ProjectRecord,
  TerminalPreset,
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import { apiClient } from '../../api'
import { projectsQueryKey } from '../../project-metadata'
import { terminalSessions } from '../../terminal-session'
import { TerminalView } from '../../terminal-view'
import { terminalTarget, worktreeTarget } from '../../workspace-navigation'
import { useWorkspaceNavigate } from '../../workspace-router-navigation'

export function TerminalWorkspace({
  projects,
  selectedProject,
  selectedWorktree,
  selectedTerminal,
  loading,
  presets,
  presetsLoading,
  presetsError,
  foregroundProcesses,
  runtimeTitles,
  modalOpen,
  projectSwitcherOpen,
  isMobile,
  drawerOpen,
  setDrawerOpen,
  setError,
  onSelectTerminal,
  onManagePresets
}: {
  projects: ProjectRecord[]
  selectedProject: ProjectRecord | null
  selectedWorktree: WorktreeRecord | null
  selectedTerminal: TerminalRecord | null
  loading: boolean
  presets: TerminalPreset[]
  presetsLoading: boolean
  presetsError: boolean
  foregroundProcesses: ReadonlySet<string>
  runtimeTitles: ReadonlyMap<string, string>
  modalOpen: boolean
  projectSwitcherOpen: boolean
  isMobile: boolean
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  setError: (value: string | null) => void
  onSelectTerminal: (terminal: TerminalRecord) => void
  onManagePresets: (trigger?: HTMLElement | null) => void
}) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigateToWorkspace = useWorkspaceNavigate()
  const createTerminalGuardRef = useRef(false)
  const closeTerminalGuardRef = useRef(false)
  const selectedTerminalId = selectedTerminal?.id ?? null
  const mutationsDisabled =
    Boolean(selectedWorktree?.prunable) ||
    selectedWorktree?.status !== 'active' ||
    selectedProject?.availability.state === 'unavailable'
  const showError = (value: unknown) =>
    setError(value instanceof Error ? value.message : String(value))

  const createTerminal = useMutation({
    mutationFn: ({
      worktreeId,
      name,
      argv,
      returnToShell,
      initialSize
    }: {
      worktreeId: string
      name: string
      argv?: string[]
      returnToShell?: boolean
      initialSize?: TerminalSize
    }) =>
      apiClient.createTerminal(
        worktreeId,
        name,
        argv,
        returnToShell,
        initialSize
      ),
    onSuccess: async (terminal) => {
      const project = projects.find((candidate) =>
        candidate.worktrees.some(
          (worktree) => worktree.id === terminal.worktreeId
        )
      )
      const worktree = project?.worktrees.find(
        (candidate) => candidate.id === terminal.worktreeId
      )
      if (!project || !worktree) {
        await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
        return
      }

      const replacesEmptyWorktree =
        location.pathname === worktreeTarget(project.id, worktree.id).pathname
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
        current?.map((candidateProject) => ({
          ...candidateProject,
          worktrees: candidateProject.worktrees.map((candidateWorktree) =>
            candidateWorktree.id === worktree.id
              ? {
                  ...candidateWorktree,
                  terminals: [
                    ...candidateWorktree.terminals.filter(
                      (candidate) => candidate.id !== terminal.id
                    ),
                    terminal
                  ]
                }
              : candidateWorktree
          )
        }))
      )
      await navigateToWorkspace(
        terminalTarget(project.id, worktree.id, terminal.id),
        replacesEmptyWorktree
      )
      setDrawerOpen(false)
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onError: async (error) => {
      showError(error)
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onSettled: () => {
      createTerminalGuardRef.current = false
    }
  })

  const closeTerminal = useMutation({
    mutationFn: (terminal: TerminalRecord) =>
      apiClient.deleteTerminal(terminal.id),
    onSuccess: async (_, closedTerminal) => {
      if (
        selectedTerminalId === closedTerminal.id &&
        selectedProject &&
        selectedWorktree
      ) {
        const closedIndex = selectedWorktree.terminals.findIndex(
          (terminal) => terminal.id === closedTerminal.id
        )
        const nextTerminal =
          selectedWorktree.terminals[closedIndex + 1] ??
          selectedWorktree.terminals[closedIndex - 1] ??
          null
        await navigateToWorkspace(
          nextTerminal
            ? terminalTarget(
                selectedProject.id,
                selectedWorktree.id,
                nextTerminal.id
              )
            : worktreeTarget(selectedProject.id, selectedWorktree.id),
          true
        )
      }

      terminalSessions.forget(closedTerminal.id)
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
        current?.map((project) => ({
          ...project,
          worktrees: project.worktrees.map((worktree) => ({
            ...worktree,
            terminals: worktree.terminals.filter(
              (terminal) => terminal.id !== closedTerminal.id
            )
          }))
        }))
      )
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onError: showError,
    onSettled: () => {
      closeTerminalGuardRef.current = false
    }
  })

  const createTerminalInSelectedWorktree = (input: {
    name: string
    argv?: string[]
    returnToShell?: boolean
  }) => {
    if (
      !selectedWorktree ||
      mutationsDisabled ||
      createTerminal.isPending ||
      createTerminalGuardRef.current
    ) {
      return
    }

    createTerminalGuardRef.current = true
    const initialSize = selectedTerminal
      ? terminalSessions.getInitialSize(selectedTerminal.id)
      : null
    createTerminal.mutate({
      worktreeId: selectedWorktree.id,
      name: input.name,
      ...(input.argv ? { argv: [...input.argv] } : {}),
      ...(input.returnToShell ? { returnToShell: true } : {}),
      ...(initialSize ? { initialSize } : {})
    })
  }

  const requestCloseTerminal = (terminal: TerminalRecord) => {
    if (
      closeTerminal.isPending ||
      closeTerminalGuardRef.current ||
      selectedWorktree?.terminals.length === 1
    ) {
      return
    }

    if (
      foregroundProcesses.has(terminal.id) &&
      !window.confirm(
        `Close terminal “${
          runtimeTitles.get(terminal.id) || terminal.name
        }”? Its foreground process will be terminated.`
      )
    ) {
      return
    }

    closeTerminalGuardRef.current = true
    closeTerminal.mutate(terminal)
  }

  useEffect(() => {
    const desktopBridge = window.treeportDesktop ?? window.taskttyDesktop
    if (!desktopBridge) {
      return
    }

    return desktopBridge.onCommand((command) => {
      if (
        command === 'new-worktree' ||
        modalOpen ||
        projectSwitcherOpen ||
        (isMobile && drawerOpen)
      ) {
        return
      }

      if (command === 'new-terminal') {
        createTerminalInSelectedWorktree({ name: 'Shell' })
      } else if (selectedTerminal) {
        requestCloseTerminal(selectedTerminal)
      }
    })
  }, [
    closeTerminal.isPending,
    createTerminal.isPending,
    drawerOpen,
    foregroundProcesses,
    isMobile,
    modalOpen,
    projectSwitcherOpen,
    runtimeTitles,
    selectedTerminal,
    selectedWorktree,
    mutationsDisabled
  ])

  return (
    <TerminalView
      worktree={selectedWorktree}
      terminal={selectedTerminal}
      loading={loading}
      autoFocusBlocked={
        modalOpen || projectSwitcherOpen || (isMobile && drawerOpen)
      }
      presets={presets}
      presetsLoading={presetsLoading}
      presetsError={presetsError}
      onSelectTerminal={onSelectTerminal}
      onCreateTerminal={createTerminalInSelectedWorktree}
      onManagePresets={onManagePresets}
      creatingTerminal={
        createTerminal.isPending &&
        createTerminal.variables?.worktreeId === selectedWorktree?.id
      }
      mutationsDisabled={mutationsDisabled}
      onCloseTerminal={requestCloseTerminal}
      closingTerminalId={
        closeTerminal.isPending ? closeTerminal.variables?.id : null
      }
      onStatusChange={() =>
        void queryClient.invalidateQueries({ queryKey: projectsQueryKey })
      }
    />
  )
}
