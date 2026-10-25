import type { TerminalRecord } from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import { DomainError } from '../../domain'

interface State {
  readonly terminals: Map<string, TerminalRecord>
  readonly removingTerminalIds: Map<string, string>
  readonly terminalClosePolicies: Map<string, 'success' | 'exit'>
  readonly terminalIdsByWorktree: Map<string, Set<string>>
}

interface InventoryChange {
  readonly updatedTerminalIds: string[]
  readonly removedTerminalIds: string[]
}

const emptyState = (): State => ({
  terminals: new Map(),
  removingTerminalIds: new Map(),
  terminalClosePolicies: new Map(),
  terminalIdsByWorktree: new Map()
})

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

        terminalClosePolicies: Ref.get(state).pipe(
          Effect.map((current) => new Map(current.terminalClosePolicies))
        ),

        updateClosePolicies: (
          terminals: ReadonlyArray<{
            readonly terminalId: string
            readonly closeOnSuccess: boolean
            readonly closeOnExit: boolean
          }>
        ) =>
          Ref.update(state, (current) => {
            const terminalClosePolicies = new Map(current.terminalClosePolicies)

            for (const terminal of terminals) {
              if (terminal.closeOnExit || terminal.closeOnSuccess) {
                terminalClosePolicies.set(
                  terminal.terminalId,
                  terminal.closeOnExit ? 'exit' : 'success'
                )
              } else {
                terminalClosePolicies.delete(terminal.terminalId)
              }
            }

            return { ...current, terminalClosePolicies }
          }),

        reconcileInventory: (
          worktreeId: string,
          terminals: readonly TerminalRecord[]
        ): Effect.Effect<InventoryChange> =>
          Ref.modify(state, (current) => {
            const cachedTerminals = new Map(current.terminals)
            const terminalIdsByWorktree = new Map(current.terminalIdsByWorktree)
            const terminalClosePolicies = new Map(current.terminalClosePolicies)
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
                terminalClosePolicies.delete(terminalId)
                removedTerminalIds.push(terminalId)
              }
            }

            terminalIdsByWorktree.set(worktreeId, currentIds)

            return [
              { updatedTerminalIds, removedTerminalIds },
              {
                terminals: cachedTerminals,
                removingTerminalIds: current.removingTerminalIds,
                terminalClosePolicies,
                terminalIdsByWorktree
              }
            ]
          }),

        recordTerminal: (
          terminal: TerminalRecord,
          closePolicy: 'success' | 'exit' | null
        ) =>
          Ref.update(state, (current) => {
            const terminals = new Map(current.terminals)
            terminals.set(terminal.id, terminal)
            const terminalClosePolicies = new Map(current.terminalClosePolicies)

            if (closePolicy) {
              terminalClosePolicies.set(terminal.id, closePolicy)
            } else {
              terminalClosePolicies.delete(terminal.id)
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
              terminalClosePolicies,
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
            const terminalClosePolicies = new Map(current.terminalClosePolicies)
            terminalClosePolicies.delete(terminalId)
            const terminalIdsByWorktree = new Map(current.terminalIdsByWorktree)

            const terminalIds = new Set(
              terminalIdsByWorktree.get(worktreeId) ?? []
            )

            terminalIds.delete(terminalId)
            terminalIdsByWorktree.set(worktreeId, terminalIds)

            return {
              terminals,
              removingTerminalIds: current.removingTerminalIds,
              terminalClosePolicies,
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
            const terminalClosePolicies = new Map(current.terminalClosePolicies)

            for (const terminalId of terminalIds) {
              terminals.delete(terminalId)
              terminalClosePolicies.delete(terminalId)
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
                terminalClosePolicies,
                terminalIdsByWorktree
              }
            ]
          })
      }
    })
  }
) {}
