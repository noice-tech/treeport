import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import type { DatabaseError, DatabaseService } from './database'
import { terminalBellStates } from './database-schema'

export interface TerminalBellState {
  terminalId: string
  worktreeId: string
  sequence: number
  occurredAt: string
  unread: boolean
}

export interface TerminalBellStateStore {
  load(): Effect.Effect<TerminalBellState[], DatabaseError>
  upsert(state: TerminalBellState): Effect.Effect<void, DatabaseError>
  markRead(
    terminalId: string,
    sequence: number
  ): Effect.Effect<void, DatabaseError>
  delete(terminalId: string): Effect.Effect<void, DatabaseError>
}

export class DatabaseTerminalBellStateStore implements TerminalBellStateStore {
  constructor(private readonly database: DatabaseService) {}

  load(): Effect.Effect<TerminalBellState[], DatabaseError> {
    return this.database
      .execute('terminalBellState.load', (db) =>
        db.select().from(terminalBellStates)
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            terminalId: row.terminalId,
            worktreeId: row.worktreeId,
            sequence: row.sequence,
            occurredAt: row.occurredAt,
            unread: Boolean(row.unread)
          }))
        )
      )
  }

  upsert(state: TerminalBellState): Effect.Effect<void, DatabaseError> {
    return this.database
      .execute('terminalBellState.upsert', (db) =>
        db
          .insert(terminalBellStates)
          .values({
            terminalId: state.terminalId,
            worktreeId: state.worktreeId,
            sequence: state.sequence,
            occurredAt: state.occurredAt,
            unread: state.unread ? 1 : 0
          })
          .onConflictDoUpdate({
            target: terminalBellStates.terminalId,
            set: {
              worktreeId: state.worktreeId,
              sequence: state.sequence,
              occurredAt: state.occurredAt,
              unread: state.unread ? 1 : 0
            }
          })
      )
      .pipe(Effect.asVoid)
  }

  markRead(
    terminalId: string,
    sequence: number
  ): Effect.Effect<void, DatabaseError> {
    return this.database.execute('terminalBellState.markRead', async (db) => {
      const updated = await db
        .update(terminalBellStates)
        .set({ unread: 0 })
        .where(
          and(
            eq(terminalBellStates.terminalId, terminalId),
            eq(terminalBellStates.sequence, sequence)
          )
        )
        .returning({ terminalId: terminalBellStates.terminalId })

      if (updated.length === 0) {
        throw new Error(
          `Terminal bell state ${terminalId} sequence ${sequence} was not found`
        )
      }
    })
  }

  delete(terminalId: string): Effect.Effect<void, DatabaseError> {
    return this.database
      .execute('terminalBellState.delete', (db) =>
        db
          .delete(terminalBellStates)
          .where(eq(terminalBellStates.terminalId, terminalId))
      )
      .pipe(Effect.asVoid)
  }
}
