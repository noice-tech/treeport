import type { TerminalAttentionReason } from '@treeport/shared'
import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import type { DatabaseError, DatabaseService } from './database.ts'
import { terminalAttentionStates } from './database-schema.ts'

export interface TerminalAttentionState {
  terminalId: string
  worktreeId: string
  sequence: number
  occurredAt: string
  reason: TerminalAttentionReason
  unread: boolean
}

export interface TerminalAttentionStateStore {
  load(): Effect.Effect<TerminalAttentionState[], DatabaseError>
  upsert(state: TerminalAttentionState): Effect.Effect<void, DatabaseError>
  markRead(
    terminalId: string,
    sequence: number
  ): Effect.Effect<void, DatabaseError>
  delete(terminalId: string): Effect.Effect<void, DatabaseError>
}

export class DatabaseTerminalAttentionStateStore implements TerminalAttentionStateStore {
  private readonly database: DatabaseService

  constructor(database: DatabaseService) {
    this.database = database
  }

  load(): Effect.Effect<TerminalAttentionState[], DatabaseError> {
    return this.database
      .execute('terminalAttentionState.load', (db) =>
        db.select().from(terminalAttentionStates)
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            terminalId: row.terminalId,
            worktreeId: row.worktreeId,
            sequence: row.sequence,
            occurredAt: row.occurredAt,
            reason: row.reason,
            unread: Boolean(row.unread)
          }))
        )
      )
  }

  upsert(state: TerminalAttentionState): Effect.Effect<void, DatabaseError> {
    return this.database
      .execute('terminalAttentionState.upsert', (db) =>
        db
          .insert(terminalAttentionStates)
          .values({
            terminalId: state.terminalId,
            worktreeId: state.worktreeId,
            sequence: state.sequence,
            occurredAt: state.occurredAt,
            reason: state.reason,
            unread: state.unread ? 1 : 0
          })
          .onConflictDoUpdate({
            target: terminalAttentionStates.terminalId,
            set: {
              worktreeId: state.worktreeId,
              sequence: state.sequence,
              occurredAt: state.occurredAt,
              reason: state.reason,
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
    return this.database.execute(
      'terminalAttentionState.markRead',
      async (db) => {
        const updated = await db
          .update(terminalAttentionStates)
          .set({ unread: 0 })
          .where(
            and(
              eq(terminalAttentionStates.terminalId, terminalId),
              eq(terminalAttentionStates.sequence, sequence)
            )
          )
          .returning({ terminalId: terminalAttentionStates.terminalId })

        if (updated.length === 0) {
          throw new Error(
            `Terminal attention state ${terminalId} sequence ${sequence} was not found`
          )
        }
      }
    )
  }

  delete(terminalId: string): Effect.Effect<void, DatabaseError> {
    return this.database
      .execute('terminalAttentionState.delete', (db) =>
        db
          .delete(terminalAttentionStates)
          .where(eq(terminalAttentionStates.terminalId, terminalId))
      )
      .pipe(Effect.asVoid)
  }
}
