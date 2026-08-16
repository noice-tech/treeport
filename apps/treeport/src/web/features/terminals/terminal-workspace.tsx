import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type {
  ProjectRecord,
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { rpc } from '../../api'
import { useSidebar } from '../../components/ui/sidebar'
import { projectsQueryKey } from '../../project-metadata'
import { terminalSessions } from '../../terminal-session'
import { TerminalView } from '../../terminal-view'
import { terminalTarget, worktreeTarget } from '../../workspace-navigation'
import { useWorkspaceNavigate } from '../../workspace-router-navigation'
import { notifyError } from '../notifications/error-notifications'
import { useProjectSwitcher } from '../sidebar/workspace-shell'

export interface PendingTerminalCreation {
  id: string
  projectId: string
  worktreeId: string
  name: string
  originPath: string
}

export interface CreateTerminalInput {
  name: string
  argv?: string[]
  cwd?: string
  env?: Record<string, string>
  returnToShell?: boolean
  closeOnSuccess?: boolean
}

interface CreateTerminalMutationInput extends CreateTerminalInput {
  worktreeId: string
  initialSize?: TerminalSize
  pendingTerminal: PendingTerminalCreation
}

export function useTerminalWorkflows({
  projects,
  selectedWorktree,
  selectedTerminal
}: {
  projects: ProjectRecord[]
  selectedWorktree: WorktreeRecord | null
  selectedTerminal: TerminalRecord | null
}) {
  const queryClient = useQueryClient()
  const { closeMobileWithoutFocusRestore } = useSidebar()
  const location = useLocation()
  const navigateToWorkspace = useWorkspaceNavigate()
  const closingTerminalIdsRef = useRef(new Set<string>())
  const nextPendingTerminalIdRef = useRef(0)
  const selectedPendingTerminalIdRef = useRef<string | null>(null)
  const locationPathRef = useRef(location.pathname)
  const [pendingTerminals, setPendingTerminals] = useState<
    PendingTerminalCreation[]
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

  const createTerminal = useMutation({
    mutationFn: async ({
      worktreeId,
      name,
      argv,
      cwd,
      env,
      returnToShell,
      closeOnSuccess,
      initialSize
    }: CreateTerminalMutationInput) => {
      const json: CreateTerminalInput & { initialSize?: TerminalSize } = {
        name
      }
      if (argv) {
        json.argv = argv
      }

      if (cwd) {
        json.cwd = cwd
      }

      if (env) {
        json.env = env
      }

      if (returnToShell) {
        json.returnToShell = true
      }

      if (closeOnSuccess) {
        json.closeOnSuccess = true
      }

      if (initialSize) {
        json.initialSize = initialSize
      }

      const result = await parseResponse(
        rpc.api.worktrees[':worktreeId'].terminals.$post({
          param: { worktreeId },
          json
        })
      )
      return result.terminal
    },
    onSuccess: async (terminal, { pendingTerminal }) => {
      const pendingWasSelected =
        selectedPendingTerminalIdRef.current === pendingTerminal.id
      const shouldNavigate =
        pendingWasSelected &&
        locationPathRef.current === pendingTerminal.originPath
      setPendingTerminals((current) =>
        current.filter((candidate) => candidate.id !== pendingTerminal.id)
      )
      if (pendingWasSelected) {
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
      if (shouldNavigate) {
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

      notifyError(error, {
        operation: `create terminal “${pendingTerminal.name}”`
      })
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    }
  })

  const closeTerminal = useMutation({
    mutationFn: ({ terminal }: { terminal: TerminalRecord; index: number }) =>
      parseResponse(
        rpc.api.terminals[':terminalId'].$delete({
          param: { terminalId: terminal.id }
        })
      ),
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
      notifyError(error, {
        operation: `close terminal “${closed.terminal.name}”`
      })
    },
    onSettled: (_, __, closed) => {
      closingTerminalIdsRef.current.delete(closed.terminal.id)
    }
  })

  const createTerminalInWorktree = (
    project: ProjectRecord,
    worktree: WorktreeRecord,
    input: CreateTerminalInput
  ) => {
    const currentProject = projects.find(
      (candidate) => candidate.id === project.id
    )
    const currentWorktree = currentProject?.worktrees.find(
      (candidate) => candidate.id === worktree.id
    )
    if (
      !currentProject ||
      !currentWorktree ||
      currentProject.availability.state === 'unavailable' ||
      currentWorktree.prunable
    ) {
      return
    }

    const initialSize =
      selectedTerminal?.worktreeId === currentWorktree.id
        ? terminalSessions.getInitialSize(selectedTerminal.id)
        : null
    const pendingTerminal = {
      id: `pending-terminal-${++nextPendingTerminalIdRef.current}`,
      projectId: currentProject.id,
      worktreeId: currentWorktree.id,
      name: input.name,
      originPath: location.pathname
    }
    selectedPendingTerminalIdRef.current = pendingTerminal.id
    setPendingTerminals((current) => [...current, pendingTerminal])
    setSelectedPendingTerminalId(pendingTerminal.id)
    closeMobileWithoutFocusRestore()
    const mutation: CreateTerminalMutationInput = {
      worktreeId: currentWorktree.id,
      name: input.name,
      pendingTerminal
    }
    if (input.argv) {
      mutation.argv = [...input.argv]
    }

    if (input.cwd) {
      mutation.cwd = input.cwd
    }

    if (input.env) {
      mutation.env = { ...input.env }
    }

    if (input.returnToShell) {
      mutation.returnToShell = true
    }

    if (input.closeOnSuccess) {
      mutation.closeOnSuccess = true
    }

    if (initialSize) {
      mutation.initialSize = initialSize
    }

    createTerminal.mutate(mutation)
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

  return {
    pendingTerminals,
    selectedPendingTerminal,
    createTerminalInWorktree,
    requestCloseTerminal,
    clearPendingTerminalSelection: () => {
      selectedPendingTerminalIdRef.current = null
      setSelectedPendingTerminalId(null)
    },
    selectPendingTerminal: (terminalId: string) => {
      if (!pendingTerminals.some((terminal) => terminal.id === terminalId)) {
        return
      }

      selectedPendingTerminalIdRef.current = terminalId
      setSelectedPendingTerminalId(terminalId)
      closeMobileWithoutFocusRestore()
    }
  }
}

export function TerminalWorkspace({
  selectedWorktree,
  selectedTerminal,
  selectedPendingTerminal,
  pendingTerminals,
  loading,
  dialogOpen
}: {
  selectedWorktree: WorktreeRecord | null
  selectedTerminal: TerminalRecord | null
  selectedPendingTerminal: PendingTerminalCreation | undefined
  pendingTerminals: PendingTerminalCreation[]
  loading: boolean
  dialogOpen: boolean
}) {
  const queryClient = useQueryClient()
  const { isMobile, openMobile: drawerOpen } = useSidebar()
  const { open: projectSwitcherOpen } = useProjectSwitcher()

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
      onStatusChange={() =>
        void queryClient.invalidateQueries({ queryKey: projectsQueryKey })
      }
    />
  )
}
