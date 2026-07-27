import { useEffect, useRef, useState } from 'react'
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
import { TerminalView, type PendingTerminalTab } from '../../terminal-view'
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
  dialogOpen,
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
  dialogOpen: boolean
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
  const closingTerminalIdsRef = useRef(new Set<string>())
  const nextPendingTerminalIdRef = useRef(0)
  const selectedPendingTerminalIdRef = useRef<string | null>(null)
  const locationPathRef = useRef(location.pathname)
  const [pendingTerminals, setPendingTerminals] = useState<
    Array<
      PendingTerminalTab & {
        projectId: string
        worktreeId: string
        originPath: string
      }
    >
  >([])
  const [selectedPendingTerminalId, setSelectedPendingTerminalId] = useState<
    string | null
  >(null)
  locationPathRef.current = location.pathname
  const selectedPendingTerminal = pendingTerminals.find(
    (terminal) =>
      terminal.id === selectedPendingTerminalId &&
      terminal.worktreeId === selectedWorktree?.id
  )
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
      pendingTerminal: PendingTerminalTab & {
        projectId: string
        worktreeId: string
        originPath: string
      }
    }) =>
      apiClient.createTerminal(
        worktreeId,
        name,
        argv,
        returnToShell,
        initialSize
      ),
    onSuccess: async (terminal, { pendingTerminal }) => {
      const wasSelected =
        selectedPendingTerminalIdRef.current === pendingTerminal.id &&
        locationPathRef.current === pendingTerminal.originPath
      setPendingTerminals((current) =>
        current.filter((candidate) => candidate.id !== pendingTerminal.id)
      )
      if (wasSelected) {
        selectedPendingTerminalIdRef.current = null
        setSelectedPendingTerminalId(null)
      }

      const project = projects.find(
        (candidate) => candidate.id === pendingTerminal.projectId
      )
      const worktree = project?.worktrees.find(
        (candidate) => candidate.id === pendingTerminal.worktreeId
      )
      if (!project || !worktree) {
        await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
        return
      }

      const replacesEmptyWorktree =
        pendingTerminal.originPath ===
        worktreeTarget(project.id, worktree.id).pathname
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
      if (wasSelected) {
        await navigateToWorkspace(
          terminalTarget(project.id, worktree.id, terminal.id),
          replacesEmptyWorktree
        )
      }

      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onError: async (error, { pendingTerminal }) => {
      setPendingTerminals((current) =>
        current.filter((candidate) => candidate.id !== pendingTerminal.id)
      )
      if (selectedPendingTerminalIdRef.current === pendingTerminal.id) {
        selectedPendingTerminalIdRef.current = null
        setSelectedPendingTerminalId(null)
      }

      showError(error)
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    }
  })

  const closeTerminal = useMutation({
    mutationFn: ({ terminal }: { terminal: TerminalRecord; index: number }) =>
      apiClient.deleteTerminal(terminal.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onError: (error, closed) => {
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
        current?.map((project) => ({
          ...project,
          worktrees: project.worktrees.map((worktree) => {
            if (
              worktree.id !== closed.terminal.worktreeId ||
              worktree.terminals.some(
                (terminal) => terminal.id === closed.terminal.id
              )
            ) {
              return worktree
            }

            const terminals = [...worktree.terminals]
            terminals.splice(closed.index, 0, closed.terminal)
            return { ...worktree, terminals }
          })
        }))
      )
      showError(error)
    },
    onSettled: (_, __, closed) => {
      closingTerminalIdsRef.current.delete(closed.terminal.id)
    }
  })

  const createTerminalInSelectedWorktree = (input: {
    name: string
    argv?: string[]
    returnToShell?: boolean
  }) => {
    if (!selectedProject || !selectedWorktree || mutationsDisabled) {
      return
    }

    const initialSize = selectedTerminal
      ? terminalSessions.getInitialSize(selectedTerminal.id)
      : null
    const pendingTerminal = {
      id: `pending-terminal-${++nextPendingTerminalIdRef.current}`,
      projectId: selectedProject.id,
      worktreeId: selectedWorktree.id,
      name: input.name,
      originPath: location.pathname
    }
    selectedPendingTerminalIdRef.current = pendingTerminal.id
    setPendingTerminals((current) => [...current, pendingTerminal])
    setSelectedPendingTerminalId(pendingTerminal.id)
    setDrawerOpen(false)
    createTerminal.mutate({
      worktreeId: selectedWorktree.id,
      name: input.name,
      ...(input.argv ? { argv: [...input.argv] } : {}),
      ...(input.returnToShell ? { returnToShell: true } : {}),
      ...(initialSize ? { initialSize } : {}),
      pendingTerminal
    })
  }

  const requestCloseTerminal = (
    terminal: TerminalRecord,
    runtimeMetadata?: { title: string | null; hasForegroundProcess: boolean }
  ) => {
    const project = projects.find((candidate) =>
      candidate.worktrees.some(
        (worktree) => worktree.id === terminal.worktreeId
      )
    )
    const worktree = project?.worktrees.find(
      (candidate) => candidate.id === terminal.worktreeId
    )
    const remainingTerminals = worktree?.terminals.filter(
      (candidate) =>
        candidate.id !== terminal.id &&
        !closingTerminalIdsRef.current.has(candidate.id)
    )
    if (
      !project ||
      !worktree ||
      closingTerminalIdsRef.current.has(terminal.id) ||
      !remainingTerminals?.length
    ) {
      return
    }

    const title =
      runtimeMetadata?.title ??
      terminalSessions.getTitleSnapshot().get(terminal.id) ??
      terminal.name
    const hasForegroundProcess =
      runtimeMetadata?.hasForegroundProcess ??
      terminalSessions.getForegroundProcessSnapshot().has(terminal.id)
    if (
      hasForegroundProcess &&
      !window.confirm(
        `Close terminal “${title}”? Its foreground process will be terminated.`
      )
    ) {
      return
    }

    const index = worktree.terminals.findIndex(
      (candidate) => candidate.id === terminal.id
    )
    closingTerminalIdsRef.current.add(terminal.id)
    void queryClient.cancelQueries({ queryKey: projectsQueryKey })
    if (selectedTerminalId === terminal.id) {
      const nextTerminal =
        worktree.terminals
          .slice(index + 1)
          .find(
            (candidate) => !closingTerminalIdsRef.current.has(candidate.id)
          ) ??
        worktree.terminals
          .slice(0, index)
          .reverse()
          .find((candidate) => !closingTerminalIdsRef.current.has(candidate.id))
      if (nextTerminal) {
        void navigateToWorkspace(
          terminalTarget(project.id, worktree.id, nextTerminal.id),
          true
        )
      }
    }

    terminalSessions.forget(terminal.id)
    queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
      current?.map((candidateProject) => ({
        ...candidateProject,
        worktrees: candidateProject.worktrees.map((candidateWorktree) =>
          candidateWorktree.id === worktree.id
            ? {
                ...candidateWorktree,
                terminals: candidateWorktree.terminals.filter(
                  (candidate) => candidate.id !== terminal.id
                )
              }
            : candidateWorktree
        )
      }))
    )
    closeTerminal.mutate({ terminal, index })
  }

  useEffect(() => {
    const desktopBridge = window.treeportDesktop
    if (!desktopBridge) {
      return
    }

    return desktopBridge.onCommand((command) => {
      if (
        command === 'new-worktree' ||
        dialogOpen ||
        projectSwitcherOpen ||
        (isMobile && drawerOpen)
      ) {
        return
      }

      if (command === 'new-terminal') {
        createTerminalInSelectedWorktree({ name: 'Shell' })
      } else if (!selectedPendingTerminal && selectedTerminal) {
        requestCloseTerminal(selectedTerminal)
      }
    })
  }, [
    drawerOpen,
    isMobile,
    dialogOpen,
    projectSwitcherOpen,
    selectedPendingTerminal,
    selectedTerminal,
    selectedWorktree,
    mutationsDisabled
  ])

  return (
    <TerminalView
      worktree={selectedWorktree}
      terminal={selectedPendingTerminal ? null : selectedTerminal}
      pendingTerminals={pendingTerminals.filter(
        (terminal) => terminal.worktreeId === selectedWorktree?.id
      )}
      selectedPendingTerminalId={selectedPendingTerminal?.id ?? null}
      loading={loading}
      autoFocusBlocked={
        dialogOpen || projectSwitcherOpen || (isMobile && drawerOpen)
      }
      presets={presets}
      presetsLoading={presetsLoading}
      presetsError={presetsError}
      onSelectTerminal={(terminal) => {
        selectedPendingTerminalIdRef.current = null
        setSelectedPendingTerminalId(null)
        onSelectTerminal(terminal)
      }}
      onSelectPendingTerminal={(terminalId) => {
        selectedPendingTerminalIdRef.current = terminalId
        setSelectedPendingTerminalId(terminalId)
      }}
      onCreateTerminal={createTerminalInSelectedWorktree}
      onManagePresets={onManagePresets}
      mutationsDisabled={mutationsDisabled}
      onCloseTerminal={requestCloseTerminal}
      onStatusChange={() =>
        void queryClient.invalidateQueries({ queryKey: projectsQueryKey })
      }
    />
  )
}
