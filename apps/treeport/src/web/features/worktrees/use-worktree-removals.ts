import { useEffect, useMemo, useState } from 'react'
import {
  useQueries,
  useQuery,
  useQueryClient,
  type Query
} from '@tanstack/react-query'
import type { RemoveOperationRecord } from '@treeport/shared'
import { parseResponse, rpc } from '../../api'

// Track accepted operations independently of the project snapshot: a refresh or
// a delayed projects response must not bring a removing tree back into navigation.
export function useWorktreeRemovals() {
  const queryClient = useQueryClient()
  const activeQuery = useQuery({
    queryKey: ['worktree-removals'],
    queryFn: async () =>
      (
        await parseResponse(
          rpc.api.operations.$get({ query: { kind: 'remove' } })
        )
      ).operations.filter(
        (operation): operation is RemoveOperationRecord =>
          operation.kind === 'remove'
      ),
    refetchInterval: 2_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true
  })
  const [tracked, setTracked] = useState<RemoveOperationRecord[]>([])
  const operationsById = new Map(
    tracked.map((operation) => [operation.id, operation])
  )
  for (const operation of activeQuery.data ?? []) {
    operationsById.set(operation.id, operation)
  }
  const discovered = [...operationsById.values()]
  useEffect(() => {
    setTracked((current) => {
      const additions = discovered.filter(
        (operation) => !current.some((item) => item.id === operation.id)
      )
      return additions.length ? [...current, ...additions] : current
    })
  }, [discovered])
  const operations = useQueries({
    queries: discovered.map((operation) => ({
      queryKey: ['operation', operation.id],
      queryFn: async () => {
        const latest = (
          await parseResponse(
            rpc.api.operations[':operationId'].$get({
              param: { operationId: operation.id }
            })
          )
        ).operation
        if (latest.kind !== 'remove') {
          throw new Error('Tree removal returned an unexpected operation')
        }

        return latest
      },
      initialData: operation,
      refetchInterval: (query: Query<RemoveOperationRecord>) =>
        query.state.data?.status === 'pending' ||
        query.state.data?.status === 'running'
          ? 500
          : false
    })),
    combine: (results) =>
      results.flatMap((result) => (result.data ? [result.data] : []))
  })
  // Keep completed removals hidden too, until stale project snapshots catch up.
  const hiddenWorktreeIds = useMemo(
    () =>
      new Set(
        operations.flatMap((operation) =>
          operation.status !== 'failed' && operation.request.preview
            ? [operation.request.preview.worktreeId]
            : []
        )
      ),
    [operations]
  )

  return {
    operations,
    hiddenWorktreeIds,
    ready: !activeQuery.isPending,
    trackRemoval: (operation: RemoveOperationRecord) => {
      queryClient.setQueryData(['operation', operation.id], operation)
      setTracked((current) => [...current, operation])
    }
  }
}
