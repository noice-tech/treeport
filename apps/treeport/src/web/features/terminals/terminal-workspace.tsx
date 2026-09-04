import { useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type {
  ProjectRecord,
  TerminalRecord,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import { parseResponse, rpc } from '../../api'
import { useSidebar } from '../../components/ui/sidebar'
import {
  removeProjectTerminal,
  upsertProjectTerminal
} from '../../project-cache'
import { projectsQueryKey } from '../../project-metadata'
import { terminalSessions } from '../../terminal-session'
import { TerminalView } from '../../terminal-view'
import { terminalTarget, worktreeTarget } from '../../workspace-navigation'
import { useWorkspaceNavigate } from '../../workspace-router-navigation'
import { notifyError } from '../notifications/error-notifications'
import {
  browserTrace,
  forgetTerminalCorrelation,
  newBrowserCorrelationId,
  registerTerminalCorrelation
} from '../../agent-tracing'
import { useWorkspaceSurfaceFocus } from '../panels/workspace-surface-focus-context'
import { useProjectSwitcher } from '../sidebar/workspace-shell'

export interface CreateTerminalInput {
  name: string
  correlationId?: string
  initialTitle?: string
  argv?: string[]
  shellCommand?: string
  cwd?: string
  env?: Record<string, string>
  returnToShell?: boolean
  closeOnSuccess?: boolean
}

interface CreateTerminalMutationInput extends CreateTerminalInput {
  worktreeId: string
  initialSize?: TerminalSize
  sequence: number
  projectId: string
  originPath: string
  requestedAt: number
  correlationId: string
}

export function useTerminalWorkflows({
  projects,
  selectedTerminal
}: {
  projects: ProjectRecord[]
  selectedTerminal: TerminalRecord | null
}) {
  const queryClient = useQueryClient()
  const { closeMobileWithoutFocusRestore } = useSidebar()
  const location = useLocation()
  const navigateToWorkspace = useWorkspaceNavigate()
  const closingTerminalIdsRef = useRef(new Set<string>())
  const closeRequestTailRef = useRef(Promise.resolve())
  const nextCreateSequenceRef = useRef(0)
  const locationPathRef = useRef(location.pathname)
  locationPathRef.current = location.pathname
  const selectedTerminalId = selectedTerminal?.id ?? null

  const createTerminal = useMutation({
    mutationFn: async ({
      worktreeId,
      name,
      initialTitle,
      argv,
      shellCommand,
      cwd,
      env,
      returnToShell,
      closeOnSuccess,
      initialSize,
      correlationId,
      requestedAt
    }: CreateTerminalMutationInput) => {
      browserTrace('terminal.create.request.started', correlationId, {
        queueWaitMs: Number((performance.now() - requestedAt).toFixed(3)),
        worktreeId
      })
      const json: CreateTerminalInput & { initialSize?: TerminalSize } = {
        name
      }
      if (initialTitle) {
        json.initialTitle = initialTitle
      }

      if (argv) {
        json.argv = argv
      }

      if (shellCommand) {
        json.shellCommand = shellCommand
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
        rpc.api.worktrees[':worktreeId'].terminals.$post(
          {
            param: { worktreeId },
            json
          },
          { init: { headers: { 'x-request-id': correlationId } } }
        )
      )
      return result.terminal
    },
    onSuccess: async (terminal, request) => {
      registerTerminalCorrelation(terminal.id, request.correlationId)
      browserTrace('terminal.create.response.received', request.correlationId, {
        elapsedMs: Number((performance.now() - request.requestedAt).toFixed(3)),
        terminalId: terminal.id,
        worktreeId: request.worktreeId
      })
      let targetFound = false
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) => {
        const update = upsertProjectTerminal(
          current,
          request.worktreeId,
          terminal
        )
        targetFound = update.found
        return update.projects
      })
      browserTrace('terminal.create.cache.updated', request.correlationId, {
        targetFound,
        terminalId: terminal.id
      })
      if (!targetFound) {
        await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
        browserTrace('terminal.create.cache.refetched', request.correlationId, {
          terminalId: terminal.id
        })
        return
      }

      const project = projects.find(
        (candidate) => candidate.id === request.projectId
      )
      const worktree = project?.worktrees.find(
        (candidate) => candidate.id === request.worktreeId
      )
      const shouldNavigate =
        request.sequence === nextCreateSequenceRef.current &&
        locationPathRef.current === request.originPath
      if (project && worktree && shouldNavigate) {
        browserTrace(
          'terminal.create.navigation.started',
          request.correlationId,
          {
            terminalId: terminal.id
          }
        )
        await navigateToWorkspace(
          terminalTarget(project.id, worktree.id, terminal.id),
          request.originPath ===
            worktreeTarget(project.id, worktree.id).pathname
        )
        browserTrace(
          'terminal.create.navigation.finished',
          request.correlationId,
          {
            terminalId: terminal.id
          }
        )
      }
    },
    onError: (error, request) => {
      browserTrace('terminal.create.failed', request.correlationId, {
        elapsedMs: Number((performance.now() - request.requestedAt).toFixed(3)),
        worktreeId: request.worktreeId
      })
      notifyError(error, {
        operation: `create terminal “${request.name}”`
      })
    }
  })

  const closeTerminal = useMutation({
    mutationFn: ({
      terminal,
      correlationId,
      queuedAt
    }: {
      terminal: TerminalRecord
      index: number
      correlationId: string
      queuedAt: number
    }) => {
      // Keep rapid optimistic closes responsive without occupying every HTTP/1
      // connection while the server performs ordered process cleanup.
      const request = closeRequestTailRef.current.then(() => {
        browserTrace('terminal.remove.request.started', correlationId, {
          browserQueueWaitMs: Number((performance.now() - queuedAt).toFixed(3)),
          terminalId: terminal.id
        })
        return parseResponse(
          rpc.api.terminals[':terminalId'].$delete(
            { param: { terminalId: terminal.id } },
            { init: { headers: { 'x-request-id': correlationId } } }
          )
        )
      })
      closeRequestTailRef.current = request.then(
        () => undefined,
        () => undefined
      )
      return request
    },
    onError: (error, closed) => {
      browserTrace('terminal.remove.failed', closed.correlationId, {
        terminalId: closed.terminal.id
      })
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
    onSettled: (_, error, closed) => {
      browserTrace('terminal.remove.settled', closed.correlationId, {
        failed: error !== null,
        terminalId: closed.terminal.id
      })
      closingTerminalIdsRef.current.delete(closed.terminal.id)
      if (!error) {
        forgetTerminalCorrelation(closed.terminal.id)
      }
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
    const sequence = ++nextCreateSequenceRef.current
    const correlationId = input.correlationId ?? newBrowserCorrelationId()
    const requestedAt = performance.now()
    browserTrace('terminal.create.command.admitted', correlationId, {
      sequence,
      worktreeId: currentWorktree.id
    })
    closeMobileWithoutFocusRestore()
    const mutation: CreateTerminalMutationInput = {
      worktreeId: currentWorktree.id,
      name: input.name,
      sequence,
      projectId: currentProject.id,
      originPath: location.pathname,
      requestedAt,
      correlationId
    }
    if (input.initialTitle) {
      mutation.initialTitle = input.initialTitle
    }

    if (input.argv) {
      mutation.argv = [...input.argv]
    }

    if (input.shellCommand) {
      mutation.shellCommand = input.shellCommand
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
    const correlationId = newBrowserCorrelationId()
    const queuedAt = performance.now()
    browserTrace('terminal.remove.command.admitted', correlationId, {
      terminalId: terminal.id,
      worktreeId: terminal.worktreeId
    })
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
    queryClient.setQueryData<ProjectRecord[]>(
      projectsQueryKey,
      (current) =>
        removeProjectTerminal(current, worktree.id, terminal.id).projects
    )
    closeTerminal.mutate({ terminal, index, correlationId, queuedAt })
  }

  return {
    createTerminalInWorktree,
    requestCloseTerminal
  }
}

export function TerminalWorkspace({
  selectedWorktree,
  selectedTerminal,
  loading,
  dialogOpen
}: {
  selectedWorktree: WorktreeRecord | null
  selectedTerminal: TerminalRecord | null
  loading: boolean
  dialogOpen: boolean
}) {
  const queryClient = useQueryClient()
  const { focusedSurface } = useWorkspaceSurfaceFocus()
  const { isMobile, openMobile: drawerOpen } = useSidebar()
  const { open: projectSwitcherOpen } = useProjectSwitcher()

  return (
    <TerminalView
      worktree={selectedWorktree}
      terminal={selectedTerminal}
      loading={loading}
      autoFocusBlocked={
        focusedSurface === 'tool' ||
        dialogOpen ||
        projectSwitcherOpen ||
        (isMobile && drawerOpen)
      }
      onStatusChange={() =>
        void queryClient.invalidateQueries({ queryKey: projectsQueryKey })
      }
    />
  )
}
