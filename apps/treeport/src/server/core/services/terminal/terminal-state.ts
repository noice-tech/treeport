import type { TerminalRecord } from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import { DomainError } from '../../domain'

interface State {
  readonly terminals: Map<string, TerminalRecord>
  // Keep completed reservations until the tree is cleared: an inventory read
  // started before a kill may still report that terminal afterward.
  readonly removingTerminalIds: Map<string, string>
  readonly closeOnSuccessTerminalIds: Set<string>
  readonly terminalIdsByWorktree: Map<string, Set<string>>
}

interface InventoryChange {
  readonly updatedTerminalIds: string[]
  readonly removedTerminalIds: string[]
}

const emptyState = (): State => ({
  terminals: new Map(),
  removingTerminalIds: new Map(),
  closeOnSuccessTerminalIds: new Set(),
  terminalIdsByWorktree: new Map()
})

/** Application-scoped cache of terminal-host observations. */
export class TerminalState extends Effect.Service<TerminalState>()(
  'treeport/TerminalState',
  {
    scoped: Effect.gen(function* () {
      const state = yield* Ref.make(emptyState())
      yield* Effect.addFinalizer(() => Ref.set(state, emptyState()))

      return {
        terminal: (terminalId: string) =>
          Ref.get(state).pipe(
            Effect.map((current) => current.terminals.get(terminalId) ?? null)
          ),

        reserveRemoval: (terminalId: string, worktreeId: string) =>
          Ref.modify<State, DomainError<unknown> | null>(state, (current) => {
            if (
              !current.terminals.has(terminalId) ||
              current.removingTerminalIds.has(terminalId)
            ) {
              return [
                new DomainError(
                  'TERMINAL_NOT_FOUND',
                  'Terminal not found',
                  404
                ),
                current
              ] as const
            }

            // In-flight closes no longer count toward the last-terminal guard.
            const hasRemainingTerminal = [
              ...(current.terminalIdsByWorktree.get(worktreeId) ?? [])
            ].some(
              (id) =>
                id !== terminalId &&
                !current.removingTerminalIds.has(id) &&
                !current.closeOnSuccessTerminalIds.has(id)
            )
            if (!hasRemainingTerminal) {
              return [
                new DomainError(
                  'LAST_TERMINAL',
                  'Every open tree must keep at least one terminal',
                  409
                ),
                current
              ] as const
            }

            const removingTerminalIds = new Map(current.removingTerminalIds)
            removingTerminalIds.set(terminalId, worktreeId)
            return [null, { ...current, removingTerminalIds }] as const
          }).pipe(
            Effect.flatMap((error) =>
              error ? Effect.fail(error) : Effect.void
            )
          ),

        releaseRemoval: (terminalId: string) =>
          Ref.update(state, (current) => {
            const removingTerminalIds = new Map(current.removingTerminalIds)
            removingTerminalIds.delete(terminalId)
            return { ...current, removingTerminalIds }
          }),

        hasTerminal: (terminalId: string) =>
          Ref.get(state).pipe(
            Effect.map((current) => current.terminals.has(terminalId))
          ),

        trackedTerminalIds: (worktreeId: string) =>
          Ref.get(state).pipe(
            Effect.map(
              (current) =>
                new Set(current.terminalIdsByWorktree.get(worktreeId) ?? [])
            )
          ),

        closeOnSuccessTerminalIds: Ref.get(state).pipe(
          Effect.map((current) => new Set(current.closeOnSuccessTerminalIds))
        ),

        updateCloseOnSuccess: (
          terminals: ReadonlyArray<{
            readonly terminalId: string
            readonly closeOnSuccess: boolean
          }>
        ) =>
          Ref.update(state, (current) => {
            const closeOnSuccessTerminalIds = new Set(
              current.closeOnSuccessTerminalIds
            )
            for (const terminal of terminals) {
              if (terminal.closeOnSuccess) {
                closeOnSuccessTerminalIds.add(terminal.terminalId)
              } else {
                closeOnSuccessTerminalIds.delete(terminal.terminalId)
              }
            }
            return { ...current, closeOnSuccessTerminalIds }
          }),

        reconcileInventory: (
          worktreeId: string,
          terminals: readonly TerminalRecord[]
        ): Effect.Effect<InventoryChange> =>
          Ref.modify(state, (current) => {
            const cachedTerminals = new Map(current.terminals)
            const terminalIdsByWorktree = new Map(current.terminalIdsByWorktree)
            const closeOnSuccessTerminalIds = new Set(
              current.closeOnSuccessTerminalIds
            )
            const previousIds = terminalIdsByWorktree.get(worktreeId)
            const currentIds = new Set(terminals.map((terminal) => terminal.id))
            const updatedTerminalIds: string[] = []
            const removedTerminalIds: string[] = []

            for (const terminal of terminals) {
              const previous = cachedTerminals.get(terminal.id)
              cachedTerminals.set(terminal.id, terminal)
              if (
                previous &&
                (previous.status !== terminal.status ||
                  previous.exitCode !== terminal.exitCode ||
                  (previous.commandExitCode ?? null) !==
                    (terminal.commandExitCode ?? null))
              ) {
                updatedTerminalIds.push(terminal.id)
              }
            }
            for (const terminalId of previousIds ?? []) {
              if (!currentIds.has(terminalId)) {
                cachedTerminals.delete(terminalId)
                closeOnSuccessTerminalIds.delete(terminalId)
                removedTerminalIds.push(terminalId)
              }
            }
            terminalIdsByWorktree.set(worktreeId, currentIds)

            return [
              { updatedTerminalIds, removedTerminalIds },
              {
                terminals: cachedTerminals,
                removingTerminalIds: current.removingTerminalIds,
                closeOnSuccessTerminalIds,
                terminalIdsByWorktree
              }
            ]
          }),

        recordTerminal: (terminal: TerminalRecord, closeOnSuccess: boolean) =>
          Ref.update(state, (current) => {
            const terminals = new Map(current.terminals)
            terminals.set(terminal.id, terminal)
            const closeOnSuccessTerminalIds = new Set(
              current.closeOnSuccessTerminalIds
            )
            if (closeOnSuccess) {
              closeOnSuccessTerminalIds.add(terminal.id)
            } else {
              closeOnSuccessTerminalIds.delete(terminal.id)
            }

            const terminalIdsByWorktree = new Map(current.terminalIdsByWorktree)
            const terminalIds = new Set(
              terminalIdsByWorktree.get(terminal.worktreeId) ?? []
            )
            terminalIds.add(terminal.id)
            terminalIdsByWorktree.set(terminal.worktreeId, terminalIds)
            return {
              terminals,
              removingTerminalIds: current.removingTerminalIds,
              closeOnSuccessTerminalIds,
              terminalIdsByWorktree
            }
          }),

        updateTerminal: (terminal: TerminalRecord) =>
          Ref.update(state, (current) => {
            const terminals = new Map(current.terminals)
            terminals.set(terminal.id, terminal)
            return { ...current, terminals }
          }),

        removeTerminal: (terminalId: string, worktreeId: string) =>
          Ref.update(state, (current) => {
            const terminals = new Map(current.terminals)
            terminals.delete(terminalId)
            const closeOnSuccessTerminalIds = new Set(
              current.closeOnSuccessTerminalIds
            )
            closeOnSuccessTerminalIds.delete(terminalId)
            const terminalIdsByWorktree = new Map(current.terminalIdsByWorktree)
            const terminalIds = new Set(
              terminalIdsByWorktree.get(worktreeId) ?? []
            )
            terminalIds.delete(terminalId)
            terminalIdsByWorktree.set(worktreeId, terminalIds)
            return {
              terminals,
              removingTerminalIds: current.removingTerminalIds,
              closeOnSuccessTerminalIds,
              terminalIdsByWorktree
            }
          }),

        clearWorktree: (
          worktreeId: string,
          discoveredTerminalIds: Iterable<string> = []
        ) =>
          Ref.modify(state, (current) => {
            const terminalIds = new Set([
              ...(current.terminalIdsByWorktree.get(worktreeId) ?? []),
              ...discoveredTerminalIds
            ])
            const terminals = new Map(current.terminals)
            const closeOnSuccessTerminalIds = new Set(
              current.closeOnSuccessTerminalIds
            )
            for (const terminalId of terminalIds) {
              terminals.delete(terminalId)
              closeOnSuccessTerminalIds.delete(terminalId)
            }
            const terminalIdsByWorktree = new Map(current.terminalIdsByWorktree)
            terminalIdsByWorktree.delete(worktreeId)
            const removingTerminalIds = new Map(current.removingTerminalIds)
            for (const [terminalId, treeId] of removingTerminalIds) {
              if (treeId === worktreeId) {
                removingTerminalIds.delete(terminalId)
              }
            }
            return [
              [...terminalIds],
              {
                terminals,
                removingTerminalIds,
                closeOnSuccessTerminalIds,
                terminalIdsByWorktree
              }
            ]
          })
      }
    })
  }
) {}
