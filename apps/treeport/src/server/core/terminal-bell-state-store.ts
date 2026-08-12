import { and, eq } from 'drizzle-orm'
import type { TreeportDatabase } from './database'
import { terminalBellStates } from './database-schema'

export interface TerminalBellState {
  terminalId: string
  worktreeId: string
  sequence: number
  occurredAt: string
  unread: boolean
}

export interface TerminalBellStateStore {
  load(): Promise<TerminalBellState[]>
  upsert(state: TerminalBellState): Promise<void>
  markRead(terminalId: string, sequence: number): Promise<void>
  delete(terminalId: string): Promise<void>
}

export class DatabaseTerminalBellStateStore implements TerminalBellStateStore {
  constructor(private readonly database: TreeportDatabase) {}

  async load(): Promise<TerminalBellState[]> {
    const rows = await this.database.db.select().from(terminalBellStates)
    return rows.map((row) => ({
      terminalId: row.terminalId,
      worktreeId: row.worktreeId,
      sequence: row.sequence,
      occurredAt: row.occurredAt,
      unread: Boolean(row.unread)
    }))
  }

  async upsert(state: TerminalBellState): Promise<void> {
    await this.database.db
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
  }

  async markRead(terminalId: string, sequence: number): Promise<void> {
    const updated = await this.database.db
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
  }

  async delete(terminalId: string): Promise<void> {
    await this.database.db
      .delete(terminalBellStates)
      .where(eq(terminalBellStates.terminalId, terminalId))
  }
}
