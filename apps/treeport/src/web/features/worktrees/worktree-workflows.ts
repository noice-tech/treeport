import { useEffect, useRef, useState } from 'react'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient
} from '@tanstack/react-query'
import type {
  OperationRecord,
  ProjectRecord,
  RemoveOperationRecord,
  RemovePreview,
  TerminalSize,
  TreeContextValues,
  WorktreeRecord
} from '@treeport/shared'
import { parseResponse, rpc } from '../../api'
import { errorDetails } from '../../error-message'
import { projectsQueryKey } from '../../project-metadata'
import { terminalSessions } from '../../terminal-session'
import { notifyError } from '../notifications/error-notifications'

export type RemovalStage = 'checking' | 'removing'

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
    initialTitle?: string
    argv?: string[]
    returnToShell?: boolean
    initialSize?: TerminalSize
  }
  sourceWorktreeId?: string
  treeContext?: TreeContextValues
}

interface TrackedCreation {
  id: string
  projectId: string
  typedName: string
  owned: boolean
}

export function useWorktreeWorkflows({
  projects,
  setDrawerOpen,
  onWorktreeSubmitted,
  onRemovalNeedsConfirmation,
  onRemovalProgress,
  onRemovalCompleted,
  selectedTerminalId
}: {
  projects: ProjectRecord[]
  setDrawerOpen: (open: boolean) => void
  onWorktreeSubmitted: () => void
  onRemovalNeedsConfirmation: (
    worktree: WorktreeRecord,
    preview: RemovePreview,
    trigger?: HTMLElement,
    skipCleanup?: boolean
  ) => void
  onRemovalProgress: (
    worktree: WorktreeRecord,
    preview: RemovePreview,
    operation: RemoveOperationRecord,
    open: boolean
  ) => void
  onRemovalCompleted: (worktreeId: string) => void
  selectedTerminalId: string | null
}) {
  const queryClient = useQueryClient()
  const creationsQuery = useQuery({
    queryKey: ['worktree-creations'],
    queryFn: async () =>
      (
        await parseResponse(
          rpc.api.operations.$get({ query: { kind: 'create' } })
        )
      ).operations,
    refetchInterval: 2_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
  const removalsQuery = useQuery({
    queryKey: ['worktree-removals'],
    queryFn: async () =>
      (
        await parseResponse(
          rpc.api.operations.$get({ query: { kind: 'remove' } })
        )
      ).operations,
    refetchInterval: 2_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
  const [trackedCreations, setTrackedCreations] = useState<TrackedCreation[]>(
    []
  )
  const serverPendingWorktrees: PendingWorktreeCreation[] = (
    creationsQuery.data ?? []
  ).flatMap((operation) => {
    if (operation.kind !== 'create') {
      return []
    }

    const name = operation.request.name
    return operation.projectId
      ? [{ id: operation.id, projectId: operation.projectId, typedName: name }]
      : []
  })
  useEffect(() => {
    setTrackedCreations((current) => {
      const additions = serverPendingWorktrees.filter(
        (pending) => !current.some((creation) => creation.id === pending.id)
      )
      return additions.length === 0
        ? current
        : [
            ...current,
            ...additions.map((creation) => ({ ...creation, owned: false }))
          ]
    })
  }, [serverPendingWorktrees])
  const handledCreationsRef = useRef(new Set<string>())
  const focusedCreationsRef = useRef(new Set<string>())
  const trackedCreationQueries = useQueries({
    queries: trackedCreations.map((creation) => ({
      queryKey: ['operation', creation.id] as const,
      queryFn: async () =>
        (
          await parseResponse(
            rpc.api.operations[':operationId'].$get({
              param: { operationId: creation.id }
            })
          )
        ).operation,
      refetchInterval: 500
    }))
  })
  const materializedCreationIds = new Set(
    trackedCreationQueries.flatMap((query) => {
      const operation = query.data
      if (operation?.status !== 'completed' || operation.kind !== 'create') {
        return []
      }

      const worktreeId = operation.result?.worktreeId ?? operation.worktreeId
      return worktreeId &&
        projects.some((project) =>
          project.worktrees.some((worktree) => worktree.id === worktreeId)
        )
        ? [operation.id]
        : []
    })
  )
  const visibleServerPendingWorktrees = serverPendingWorktrees.filter(
    (pending) => !materializedCreationIds.has(pending.id)
  )
  const serverPendingIds = new Set(
    visibleServerPendingWorktrees.map((pending) => pending.id)
  )
  const pendingWorktrees = [
    ...visibleServerPendingWorktrees,
    ...trackedCreations
      .filter(
        (creation) =>
          !serverPendingIds.has(creation.id) &&
          !materializedCreationIds.has(creation.id)
      )
      .map(({ id, projectId, typedName }) => ({ id, projectId, typedName }))
  ]
  const [localPendingRemovals, setLocalPendingRemovals] = useState<
    Record<string, RemovalStage>
  >({})
  const pendingRemovals = (removalsQuery.data ?? []).reduce<
    Record<string, RemovalStage>
  >(
    (current, operation) => {
      if (operation.kind === 'remove' && operation.request.preview) {
        current[operation.request.preview.worktreeId] = 'removing'
      }

      return current
    },
    { ...localPendingRemovals }
  )
  const removalGuardsRef = useRef(new Set<string>())

  const createWorktree = useMutation({
    mutationFn: (request: WorktreeCreationRequest) => {
      const json = {
        name: request.typedName,
        base: request.base,
        initialTerminal: request.initialTerminal
      }
      if (request.sourceWorktreeId) {
        Object.assign(json, { sourceWorktreeId: request.sourceWorktreeId })
      }

      if (request.treeContext && Object.keys(request.treeContext).length > 0) {
        Object.assign(json, { context: request.treeContext })
      }

      return parseResponse(
        rpc.api.projects[':projectId']['worktree-operations'].$post({
          param: { projectId: request.projectId },
          json
        })
      ).then((result) => result.operation)
    },
    onSuccess: (operation, request) => {
      const name =
        operation.kind === 'create' ? operation.request.name : request.typedName
      setTrackedCreations((current) => {
        const tracked = current.find((creation) => creation.id === operation.id)
        return tracked
          ? current.map((creation) =>
              creation.id === operation.id
                ? { ...creation, typedName: name, owned: true }
                : creation
            )
          : [
              ...current,
              {
                id: operation.id,
                projectId: request.projectId,
                typedName: name,
                owned: true
              }
            ]
      })
      void queryClient.invalidateQueries({ queryKey: ['worktree-creations'] })
    },
    onError: (mutationError, request) => {
      setDrawerOpen(false)
      notifyError(mutationError, {
        operation: `create tree “${request.typedName}”`
      })
    }
  })

  useEffect(() => {
    for (const pending of pendingWorktrees) {
      if (
        trackedCreations.some(
          (creation) => creation.id === pending.id && creation.owned
        ) &&
        !focusedCreationsRef.current.has(pending.id)
      ) {
        focusedCreationsRef.current.add(pending.id)
        window.requestAnimationFrame(() => {
          document.getElementById(`pending-worktree-${pending.id}`)?.focus()
        })
      }
    }
  }, [pendingWorktrees, trackedCreations])

  useEffect(() => {
    trackedCreationQueries.forEach((query, index) => {
      const operation = query.data
      const tracked = trackedCreations[index]
      if (
        !operation ||
        operation.kind !== 'create' ||
        !tracked ||
        (operation.status !== 'completed' && operation.status !== 'failed')
      ) {
        return
      }

      if (!tracked.owned) {
        if (
          operation.status === 'failed' ||
          materializedCreationIds.has(operation.id)
        ) {
          setTrackedCreations((current) =>
            current.filter((creation) => creation.id !== operation.id)
          )
        }

        return
      }

      if (handledCreationsRef.current.has(operation.id)) {
        return
      }

      handledCreationsRef.current.add(operation.id)

      void (async () => {
        await queryClient.invalidateQueries({
          queryKey: ['worktree-creations']
        })
        if (operation.status === 'failed') {
          notifyError(operation.error ?? 'Tree creation failed', {
            operation: `create tree “${tracked.typedName}”`
          })
        } else {
          await queryClient.invalidateQueries({ queryKey: projectsQueryKey })
          const projects = (await parseResponse(rpc.api.projects.$get()))
            .projects
          queryClient.setQueryData(projectsQueryKey, projects)
          const result = operation.result
          setDrawerOpen(false)

          if (result?.setupError) {
            notifyError(result.setupError, {
              operation: `start setup for newly created tree “${tracked.typedName}”`
            })
          } else if (result?.terminalError) {
            notifyError(result.terminalError, {
              operation: `start a terminal for newly created tree “${tracked.typedName}”`
            })
          }
        }

        setTrackedCreations((current) =>
          current.filter((creation) => creation.id !== operation.id)
        )
      })()
    })
  }, [
    materializedCreationIds,
    queryClient,
    setDrawerOpen,
    trackedCreationQueries,
    trackedCreations
  ])

  const submitWorktreeCreation = (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    initialTerminal: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ) => {
    const initialSize = selectedTerminalId
      ? terminalSessions.getInitialSize(selectedTerminalId)
      : null
    const pendingInitialTerminal: WorktreeCreationRequest['initialTerminal'] = {
      name: initialTerminal.name
    }
    if (initialTerminal.initialTitle) {
      pendingInitialTerminal.initialTitle = initialTerminal.initialTitle
    }

    if (initialTerminal.argv) {
      pendingInitialTerminal.argv = [...initialTerminal.argv]
    }

    if (initialTerminal.returnToShell) {
      pendingInitialTerminal.returnToShell = true
    }

    if (initialSize) {
      pendingInitialTerminal.initialSize = initialSize
    }

    const pending: WorktreeCreationRequest = {
      projectId: project.id,
      typedName: name,
      base,
      initialTerminal: pendingInitialTerminal
    }
    if (sourceWorktreeId) {
      pending.sourceWorktreeId = sourceWorktreeId
    }

    if (treeContext && Object.keys(treeContext).length > 0) {
      pending.treeContext = treeContext
    }

    onWorktreeSubmitted()
    createWorktree.mutate(pending)
  }

  const setRemovalStage = (worktreeId: string, stage: RemovalStage) =>
    setLocalPendingRemovals((current) => ({
      ...current,
      [worktreeId]: stage
    }))

  const releaseRemoval = (worktreeId: string) => {
    removalGuardsRef.current.delete(worktreeId)
    setLocalPendingRemovals((current) => {
      if (!(worktreeId in current)) {
        return current
      }

      const next = { ...current }
      delete next[worktreeId]
      return next
    })
  }

  const submitRemoval = async (
    worktree: WorktreeRecord,
    preview: RemovePreview,
    confirmDestructive: boolean,
    staleRetriesRemaining: number,
    skipCleanup = false
  ): Promise<void> => {
    setRemovalStage(worktree.id, 'removing')
    try {
      const acceptedOperation = (
        await parseResponse(
          rpc.api.worktrees[':worktreeId'].remove.$post({
            param: { worktreeId: worktree.id },
            json: {
              confirmationToken: preview.confirmationToken,
              confirmDestructive,
              skipCleanup
            }
          })
        )
      ).operation
      if (acceptedOperation.kind !== 'remove') {
        throw new Error('Tree removal returned an unexpected operation')
      }

      let operation: RemoveOperationRecord = acceptedOperation

      onRemovalProgress(
        worktree,
        preview,
        operation,
        preview.cleanup.commands.length > 0
      )
      await queryClient.invalidateQueries({
        queryKey: ['worktree-removals']
      })
      while (operation.status === 'pending' || operation.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 500))
        const latest: OperationRecord = (
          await parseResponse(
            rpc.api.operations[':operationId'].$get({
              param: { operationId: operation.id }
            })
          )
        ).operation
        if (latest.kind !== 'remove') {
          throw new Error('Tree removal returned an unexpected operation')
        }

        operation = latest
        onRemovalProgress(worktree, preview, operation, false)
      }

      await queryClient.invalidateQueries({
        queryKey: ['worktree-removals']
      })
      releaseRemoval(worktree.id)
      if (operation.status === 'failed') {
        onRemovalProgress(
          worktree,
          preview,
          operation,
          preview.cleanup.commands.length === 0
        )
        return
      }

      onRemovalCompleted(worktree.id)
      void queryClient.invalidateQueries(
        { queryKey: projectsQueryKey },
        { cancelRefetch: false }
      )
    } catch (error) {
      if (
        errorDetails(error).code === 'REMOVE_PREVIEW_STALE' &&
        staleRetriesRemaining > 0
      ) {
        setRemovalStage(worktree.id, 'checking')
        try {
          const freshPreview = (
            await parseResponse(
              rpc.api.worktrees[':worktreeId']['remove-preview'].$get({
                param: { worktreeId: worktree.id }
              })
            )
          ).preview
          if (freshPreview.eligible && freshPreview.warnings.length === 0) {
            await submitRemoval(
              worktree,
              freshPreview,
              skipCleanup,
              staleRetriesRemaining - 1,
              skipCleanup
            )
            return
          }

          releaseRemoval(worktree.id)
          onRemovalNeedsConfirmation(
            worktree,
            freshPreview,
            undefined,
            skipCleanup
          )
          return
        } catch (refreshError) {
          releaseRemoval(worktree.id)
          notifyError(refreshError, {
            operation: `refresh removal details for tree “${worktree.name}”`
          })
          return
        }
      }

      releaseRemoval(worktree.id)
      notifyError(error, { operation: `remove tree “${worktree.name}”` })
    }
  }

  const prepareRemoval = async (
    worktree: WorktreeRecord,
    trigger: HTMLElement
  ): Promise<void> => {
    if (
      removalGuardsRef.current.has(worktree.id) ||
      Boolean(pendingRemovals[worktree.id])
    ) {
      return
    }

    removalGuardsRef.current.add(worktree.id)
    setRemovalStage(worktree.id, 'checking')
    try {
      const preview = (
        await parseResponse(
          rpc.api.worktrees[':worktreeId']['remove-preview'].$get({
            param: { worktreeId: worktree.id }
          })
        )
      ).preview
      if (
        preview.eligible &&
        preview.warnings.length === 0 &&
        preview.cleanup.commands.length === 0
      ) {
        await submitRemoval(worktree, preview, false, 1)
        return
      }

      releaseRemoval(worktree.id)
      onRemovalNeedsConfirmation(worktree, preview, trigger)
    } catch (error) {
      releaseRemoval(worktree.id)
      notifyError(error, {
        operation: `check whether tree “${worktree.name}” can be removed`
      })
    }
  }

  const confirmRemoval = (worktree: WorktreeRecord, preview: RemovePreview) => {
    if (removalGuardsRef.current.has(worktree.id)) {
      return
    }

    removalGuardsRef.current.add(worktree.id)
    void submitRemoval(worktree, preview, preview.warnings.length > 0, 1)
  }

  const removeWithoutCleanup = (
    worktree: WorktreeRecord,
    preview: RemovePreview
  ) => {
    if (removalGuardsRef.current.has(worktree.id)) {
      return
    }

    removalGuardsRef.current.add(worktree.id)
    void submitRemoval(worktree, preview, true, 1, true)
  }

  const viewRemoval = (worktree: WorktreeRecord) => {
    const operation = (removalsQuery.data ?? []).find(
      (candidate): candidate is RemoveOperationRecord =>
        candidate.kind === 'remove' &&
        candidate.request.preview?.worktreeId === worktree.id
    )
    if (operation?.request.preview) {
      onRemovalProgress(worktree, operation.request.preview, operation, true)
    }
  }

  const retryRemoval = async (worktree: WorktreeRecord): Promise<void> => {
    if (removalGuardsRef.current.has(worktree.id)) {
      return
    }

    removalGuardsRef.current.add(worktree.id)
    setRemovalStage(worktree.id, 'checking')
    try {
      const preview = (
        await parseResponse(
          rpc.api.worktrees[':worktreeId']['remove-preview'].$get({
            param: { worktreeId: worktree.id }
          })
        )
      ).preview
      releaseRemoval(worktree.id)
      onRemovalNeedsConfirmation(worktree, preview)
    } catch (error) {
      releaseRemoval(worktree.id)
      notifyError(error, {
        operation: `retry removal for tree “${worktree.name}”`
      })
    }
  }

  return {
    pendingWorktrees,
    pendingRemovals,
    submitWorktreeCreation,
    prepareRemoval,
    confirmRemoval,
    removeWithoutCleanup,
    viewRemoval,
    retryRemoval
  }
}
