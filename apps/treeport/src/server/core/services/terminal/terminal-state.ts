import type { TerminalRecord } from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'

interface State {
  readonly terminals: Map<string, TerminalRecord>
  readonly closeOnSuccessTerminalIds: Set<string>
  readonly terminalIdsByWorktree: Map<string, Set<string>>
}

interface InventoryChange {
  readonly updatedTerminalIds: string[]
  readonly removedTerminalIds: string[]
}

const emptyState = (): State => ({
  terminals: new Map(),
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
                  previous.exitCode !== terminal.exitCode)
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
            return [
              [...terminalIds],
              {
                terminals,
                closeOnSuccessTerminalIds,
                terminalIdsByWorktree
              }
            ]
          })
      }
    })
  }
) {}
