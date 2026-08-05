import { useEffect, useRef, useState } from 'react'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient
} from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type {
  ProjectRecord,
  RemovePreview,
  TerminalSize,
  WorktreeRecord
} from '@treeport/shared'
import { ApiError, apiClient } from '../../api'
import { projectsQueryKey } from '../../project-metadata'
import { terminalSessions } from '../../terminal-session'
import {
  projectTarget,
  terminalTarget,
  worktreeTarget
} from '../../workspace-navigation'
import { useWorkspaceNavigate } from '../../workspace-router-navigation'
import { notifyError } from '../notifications/error-notifications'

const MANUAL_CLEANUP_PREFIX = 'Manual cleanup required:'

export type RemovalStage = 'checking' | 'removing'

function needsManualCleanup(worktree: WorktreeRecord): boolean {
  return Boolean(worktree.cleanupError?.startsWith(MANUAL_CLEANUP_PREFIX))
}

export interface PendingWorktreeCreation {
  id: string
  projectId: string
  typedName: string
}

interface WorktreeCreationRequest {
  projectId: string
  typedName: string
  base: 'default' | 'current'
  initialTerminal: {
    name: string
    argv?: string[]
    returnToShell?: boolean
    initialSize?: TerminalSize
  }
  sourceWorktreeId?: string
}

interface OwnedCreation {
  id: string
  projectId: string
  replacesEmptyProject: boolean
}

export function useWorktreeWorkflows({
  setDrawerOpen,
  onWorktreeSubmitted,
  onRemovalNeedsConfirmation,
  onRemovalCompleted,
  selectedTerminalId
}: {
  setDrawerOpen: (open: boolean) => void
  onWorktreeSubmitted: () => void
  onRemovalNeedsConfirmation: (
    worktree: WorktreeRecord,
    preview: RemovePreview,
    trigger?: HTMLElement
  ) => void
  onRemovalCompleted: (worktreeId: string) => void
  selectedTerminalId: string | null
}) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigateToWorkspace = useWorkspaceNavigate()
  const creationsQuery = useQuery({
    queryKey: ['worktree-creations'],
    queryFn: () => apiClient.activeWorktreeCreations(),
    refetchInterval: 2_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
  const pendingWorktrees: PendingWorktreeCreation[] = (
    creationsQuery.data ?? []
  ).flatMap((operation) => {
    const name = operation.request.name
    return operation.projectId && typeof name === 'string'
      ? [{ id: operation.id, projectId: operation.projectId, typedName: name }]
      : []
  })
  const [ownedCreations, setOwnedCreations] = useState<OwnedCreation[]>([])
  const handledCreationsRef = useRef(new Set<string>())
  const focusedCreationsRef = useRef(new Set<string>())
  const ownedCreationQueries = useQueries({
    queries: ownedCreations.map((creation) => ({
      queryKey: ['operation', creation.id] as const,
      queryFn: () => apiClient.operation(creation.id),
      refetchInterval: 500
    }))
  })
  const [pendingRemovals, setPendingRemovals] = useState<
    Record<string, RemovalStage>
  >({})
  const removalGuardsRef = useRef(new Set<string>())

  const createWorktree = useMutation({
    mutationFn: (request: WorktreeCreationRequest) =>
      apiClient.createWorktree(
        request.projectId,
        request.typedName,
        request.base,
        request.initialTerminal,
        request.sourceWorktreeId
      ),
    onSuccess: (operation, request) => {
      setOwnedCreations((current) => [
        ...current,
        {
          id: operation.id,
          projectId: request.projectId,
          replacesEmptyProject:
            location.pathname === projectTarget(request.projectId).pathname
        }
      ])
      void queryClient.invalidateQueries({ queryKey: ['worktree-creations'] })
    },
    onError: (mutationError) => {
      setDrawerOpen(false)
      notifyError(mutationError)
    }
  })

  useEffect(() => {
    for (const pending of pendingWorktrees) {
      if (
        ownedCreations.some((creation) => creation.id === pending.id) &&
        !focusedCreationsRef.current.has(pending.id)
      ) {
        focusedCreationsRef.current.add(pending.id)
        window.requestAnimationFrame(() => {
          document.getElementById(`pending-worktree-${pending.id}`)?.focus()
        })
      }
    }
  }, [ownedCreations, pendingWorktrees])

  useEffect(() => {
    ownedCreationQueries.forEach((query, index) => {
      const operation = query.data
      const owned = ownedCreations[index]
      if (
        !operation ||
        !owned ||
        (operation.status !== 'completed' && operation.status !== 'failed') ||
        handledCreationsRef.current.has(operation.id)
      ) {
        return
      }

      handledCreationsRef.current.add(operation.id)

      void (async () => {
        await queryClient.invalidateQueries({
          queryKey: ['worktree-creations']
        })
        if (operation.status === 'failed') {
          notifyError(operation.error ?? 'Worktree creation failed')
        } else {
          await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
          const projects = await apiClient.projects()
          queryClient.setQueryData(projectsQueryKey, projects)
          const result = operation.result
          const worktreeId =
            typeof result?.worktreeId === 'string'
              ? result.worktreeId
              : operation.worktreeId
          const terminalId =
            typeof result?.terminalId === 'string' ? result.terminalId : null
          const worktree = projects
            .find((project) => project.id === owned.projectId)
            ?.worktrees.find((item) => item.id === worktreeId)
          if (worktree) {
            const target = terminalId
              ? terminalTarget(owned.projectId, worktree.id, terminalId)
              : worktreeTarget(owned.projectId, worktree.id)
            await navigateToWorkspace(target, owned.replacesEmptyProject)
          }

          setDrawerOpen(false)

          if (typeof result?.setupError === 'string') {
            notifyError(
              `Worktree created, but setup could not start: ${result.setupError}`
            )
          } else if (typeof result?.terminalError === 'string') {
            notifyError(
              `Worktree created, but its terminal could not start: ${result.terminalError}`
            )
          }
        }

        setOwnedCreations((current) =>
          current.filter((creation) => creation.id !== operation.id)
        )
      })()
    })
  }, [
    navigateToWorkspace,
    ownedCreationQueries,
    ownedCreations,
    queryClient,
    setDrawerOpen
  ])

  const submitWorktreeCreation = (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    initialTerminal: {
      name: string
      argv?: string[]
      returnToShell?: boolean
    },
    sourceWorktreeId?: string
  ) => {
    const initialSize = selectedTerminalId
      ? terminalSessions.getInitialSize(selectedTerminalId)
      : null
    const pending: WorktreeCreationRequest = {
      projectId: project.id,
      typedName: name,
      base,
      initialTerminal: {
        name: initialTerminal.name,
        ...(initialTerminal.argv ? { argv: [...initialTerminal.argv] } : {}),
        ...(initialTerminal.returnToShell ? { returnToShell: true } : {}),
        ...(initialSize ? { initialSize } : {})
      },
      ...(sourceWorktreeId ? { sourceWorktreeId } : {})
    }
    onWorktreeSubmitted()
    createWorktree.mutate(pending)
  }

  const setRemovalStage = (worktreeId: string, stage: RemovalStage) =>
    setPendingRemovals((current) => ({ ...current, [worktreeId]: stage }))

  const releaseRemoval = (worktreeId: string) => {
    removalGuardsRef.current.delete(worktreeId)
    setPendingRemovals((current) => {
      if (!(worktreeId in current)) {
        return current
      }

      const next = { ...current }
      delete next[worktreeId]
      return next
    })
  }

  const markWorktreeCleaning = (worktreeId: string) =>
    queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
      current?.map((project) => ({
        ...project,
        worktrees: project.worktrees.map((worktree) =>
          worktree.id === worktreeId
            ? { ...worktree, status: 'cleaning', cleanupError: null }
            : worktree
        )
      }))
    )

  const submitRemoval = async (
    worktree: WorktreeRecord,
    preview: RemovePreview,
    confirmDestructive: boolean,
    staleRetriesRemaining: number
  ): Promise<void> => {
    setRemovalStage(worktree.id, 'removing')
    try {
      await apiClient.removeWorktree(worktree.id, preview, confirmDestructive)
      markWorktreeCleaning(worktree.id)
      releaseRemoval(worktree.id)
      onRemovalCompleted(worktree.id)
      void queryClient.invalidateQueries(
        { queryKey: projectsQueryKey },
        { cancelRefetch: false }
      )
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'REMOVE_PREVIEW_STALE' &&
        staleRetriesRemaining > 0
      ) {
        setRemovalStage(worktree.id, 'checking')
        try {
          const freshPreview = await apiClient.removePreview(worktree.id)
          if (freshPreview.eligible && freshPreview.warnings.length === 0) {
            await submitRemoval(
              worktree,
              freshPreview,
              false,
              staleRetriesRemaining - 1
            )
            return
          }

          releaseRemoval(worktree.id)
          onRemovalNeedsConfirmation(worktree, freshPreview)
          return
        } catch (refreshError) {
          releaseRemoval(worktree.id)
          notifyError(refreshError)
          return
        }
      }

      releaseRemoval(worktree.id)
      notifyError(error)
    }
  }

  const prepareRemoval = async (
    worktree: WorktreeRecord,
    trigger: HTMLElement
  ): Promise<void> => {
    if (
      removalGuardsRef.current.has(worktree.id) ||
      worktree.status === 'cleaning' ||
      needsManualCleanup(worktree)
    ) {
      return
    }

    removalGuardsRef.current.add(worktree.id)
    setRemovalStage(worktree.id, 'checking')
    try {
      const preview = await apiClient.removePreview(worktree.id)
      if (preview.eligible && preview.warnings.length === 0) {
        await submitRemoval(worktree, preview, false, 1)
        return
      }

      releaseRemoval(worktree.id)
      onRemovalNeedsConfirmation(worktree, preview, trigger)
    } catch (error) {
      releaseRemoval(worktree.id)
      notifyError(error)
    }
  }

  const confirmRemoval = (worktree: WorktreeRecord, preview: RemovePreview) => {
    if (removalGuardsRef.current.has(worktree.id)) {
      return
    }

    removalGuardsRef.current.add(worktree.id)
    void submitRemoval(worktree, preview, preview.warnings.length > 0, 1)
  }

  return {
    pendingWorktrees,
    pendingRemovals,
    submitWorktreeCreation,
    prepareRemoval,
    confirmRemoval
  }
}
