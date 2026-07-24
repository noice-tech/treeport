import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type {
  ProjectRecord,
  RemovePreview,
  TerminalSize,
  WorktreeRecord
} from '@tasktty/shared'
import { ApiError, apiClient } from '../../api.js'
import type { ActionModalState, RemovalStage } from '../dialogs/action-modal.js'
import { projectsQueryKey } from '../../project-metadata.js'
import { terminalSessions } from '../../terminal-session.js'
import {
  projectTarget,
  terminalTarget,
  worktreeTarget
} from '../../workspace-navigation.js'
import { useWorkspaceNavigate } from '../../workspace-router-navigation.js'
import type { WorktreeDestination } from './worktree-form.js'

const MANUAL_CLEANUP_PREFIX = 'Manual cleanup required:'

function needsManualCleanup(worktree: WorktreeRecord): boolean {
  return Boolean(worktree.cleanupError?.startsWith(MANUAL_CLEANUP_PREFIX))
}

export interface PendingWorktreeCreation {
  id: string
  projectId: string
  typedName: string
  destinationPath: string
  base: 'default' | 'current'
  initialTerminal: {
    name: string
    argv?: string[]
    returnToShell?: boolean
    initialSize?: TerminalSize
  }
  sourceWorktreeId?: string
}

export function useWorktreeWorkflows({
  setDrawerOpen,
  setModal,
  openModal,
  setError,
  selectedTerminalId
}: {
  setDrawerOpen: (open: boolean) => void
  setModal: Dispatch<SetStateAction<ActionModalState>>
  openModal: (
    modal: Exclude<ActionModalState, null>,
    trigger?: HTMLElement
  ) => void
  setError: (value: string | null) => void
  selectedTerminalId: string | null
}) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigateToWorkspace = useWorkspaceNavigate()
  const [pendingWorktrees, setPendingWorktrees] = useState<
    PendingWorktreeCreation[]
  >([])
  const [pendingRemovals, setPendingRemovals] = useState<
    Record<string, RemovalStage>
  >({})
  const removalGuardsRef = useRef(new Set<string>())
  const showError = (value: unknown) =>
    setError(value instanceof Error ? value.message : String(value))

  const createWorktree = useMutation({
    mutationFn: (pending: PendingWorktreeCreation) =>
      apiClient.createWorktree(
        pending.projectId,
        pending.typedName,
        pending.base,
        pending.initialTerminal,
        pending.sourceWorktreeId
      ),
    onSuccess: async (result, pending) => {
      await queryClient.cancelQueries({ queryKey: projectsQueryKey })
      const worktree =
        result.terminal &&
        !result.worktree.terminals.some(
          (item) => item.id === result.terminal?.id
        )
          ? {
              ...result.worktree,
              terminals: [...result.worktree.terminals, result.terminal]
            }
          : result.worktree
      const replacesEmptyProject =
        location.pathname === projectTarget(pending.projectId).pathname
      queryClient.setQueryData<ProjectRecord[]>(projectsQueryKey, (current) =>
        current?.map((project) =>
          project.id === pending.projectId
            ? {
                ...project,
                worktrees: [
                  ...project.worktrees.filter(
                    (item) => item.id !== worktree.id
                  ),
                  worktree
                ]
              }
            : project
        )
      )
      const target = result.terminal
        ? terminalTarget(pending.projectId, worktree.id, result.terminal.id)
        : worktreeTarget(pending.projectId, worktree.id)
      await navigateToWorkspace(target, replacesEmptyProject)
      setDrawerOpen(false)

      setPendingWorktrees((current) =>
        current.filter((item) => item.id !== pending.id)
      )
      if (result.setupError) {
        setError(
          `Worktree created, but setup could not start: ${result.setupError}`
        )
      } else if (result.terminalError) {
        setError(
          `Worktree created, but its terminal could not start: ${result.terminalError}`
        )
      }

      await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
    },
    onError: (mutationError, pending) => {
      setPendingWorktrees((current) =>
        current.filter((item) => item.id !== pending.id)
      )
      setDrawerOpen(false)
      showError(mutationError)
    }
  })

  const submitWorktreeCreation = (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    destination: WorktreeDestination,
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
    const pending: PendingWorktreeCreation = {
      id: crypto.randomUUID(),
      projectId: project.id,
      typedName: name,
      destinationPath: destination.path,
      base,
      initialTerminal: {
        name: initialTerminal.name,
        ...(initialTerminal.argv ? { argv: [...initialTerminal.argv] } : {}),
        ...(initialTerminal.returnToShell ? { returnToShell: true } : {}),
        ...(initialSize ? { initialSize } : {})
      },
      ...(sourceWorktreeId ? { sourceWorktreeId } : {})
    }
    setPendingWorktrees((current) => [...current, pending])
    setModal(null)
    window.requestAnimationFrame(() => {
      document.getElementById(`pending-worktree-${pending.id}`)?.focus()
    })
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
      setModal((current) =>
        current?.type === 'remove' && current.worktree.id === worktree.id
          ? null
          : current
      )
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
          openModal({ type: 'remove', worktree, preview: freshPreview })
          return
        } catch (refreshError) {
          releaseRemoval(worktree.id)
          showError(refreshError)
          return
        }
      }

      releaseRemoval(worktree.id)
      showError(
        error instanceof ApiError && error.code === 'REMOVE_PREVIEW_STALE'
          ? new Error(
              'The worktree kept changing during removal. Review it and try again.'
            )
          : error
      )
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
      openModal({ type: 'remove', worktree, preview }, trigger)
    } catch (error) {
      releaseRemoval(worktree.id)
      showError(error)
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
