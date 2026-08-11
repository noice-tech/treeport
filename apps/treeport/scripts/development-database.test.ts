import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openDatabase,
  type TreeportDatabase
} from '../src/server/core/database'
import {
  operations,
  projects,
  worktrees
} from '../src/server/core/database-schema'
import { cloneDevelopmentDatabase } from './development-database.mjs'

const directories: string[] = []
const databases: TreeportDatabase[] = []

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close())
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('development database snapshots', () => {
  it('copies live project data, isolates tmux sockets, and refreshes only when forced', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-development-database-#?%-')
    )
    directories.push(directory)
    const sourcePath = path.join(directory, 'source', 'treeport.db')
    const destinationPath = path.join(directory, 'destination', 'treeport.db')
    const source = await openDatabase(sourcePath)
    databases.push(source)
    await source.db.insert(projects).values({
      id: 'project',
      name: 'Main project',
      repositoryPath: '/repo',
      mainWorktreePath: '/repo',
      defaultBranch: 'main',
      repositoryDevice: '1',
      repositoryInode: '1',
      lastOpenedAt: '2026-01-01',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await source.db.insert(worktrees).values({
      id: 'worktree',
      projectId: 'project',
      path: '/repo',
      kind: 'main',
      tmuxSocketName: 'real-tmux-socket',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    await source.db.insert(operations).values({
      id: 'operation',
      kind: 'remove',
      projectId: 'project',
      worktreeId: 'worktree',
      status: 'pending',
      requestJson: '{}',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })

    await expect(
      cloneDevelopmentDatabase(sourcePath, destinationPath)
    ).resolves.toEqual({ copied: true })
    const snapshot = await openDatabase(destinationPath)
    expect(
      await snapshot.db
        .select()
        .from(projects)
        .where(eq(projects.id, 'project'))
        .then(([project]) => project)
    ).toMatchObject({ name: 'Main project', repositoryPath: '/repo' })
    const [snapshotWorktree] = await snapshot.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.projectId, 'project'))
    expect(snapshotWorktree).toMatchObject({
      path: '/repo',
      tmuxSocketName: expect.stringMatching(/^treeport-wt-[0-9a-f]{16}$/)
    })
    expect(snapshotWorktree!.tmuxSocketName).not.toBe('real-tmux-socket')
    expect(
      await snapshot.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM operations`
      )
    ).toEqual({ count: 0 })
    expect(
      await source.db
        .select()
        .from(worktrees)
        .where(eq(worktrees.projectId, 'project'))
        .then(([worktree]) => worktree)
    ).toMatchObject({ tmuxSocketName: 'real-tmux-socket' })
    expect(
      await source.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM operations`
      )
    ).toEqual({ count: 1 })
    snapshot.close()

    const adoptedPath = path.join(directory, 'adopted', 'treeport.db')
    await cloneDevelopmentDatabase(sourcePath, adoptedPath, {
      preserveTmuxSockets: true
    })
    const adopted = await openDatabase(adoptedPath)
    expect(
      await adopted.db
        .select({ tmuxSocketName: worktrees.tmuxSocketName })
        .from(worktrees)
        .where(eq(worktrees.projectId, 'project'))
        .then(([worktree]) => worktree?.tmuxSocketName)
    ).toBe('real-tmux-socket')
    adopted.close()

    await source.db
      .update(projects)
      .set({ name: 'Refreshed project' })
      .where(eq(projects.id, 'project'))
    await expect(
      cloneDevelopmentDatabase(sourcePath, destinationPath)
    ).resolves.toEqual({ copied: false, reason: 'existing-destination' })
    await expect(
      cloneDevelopmentDatabase(sourcePath, destinationPath, { force: true })
    ).resolves.toEqual({ copied: true })

    const refreshed = await openDatabase(destinationPath)
    expect(
      await refreshed.db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, 'project'))
        .then(([project]) => project?.name)
    ).toBe('Refreshed project')
    refreshed.close()
    expect((await fs.stat(destinationPath)).mode & 0o777).toBe(0o600)
    await expect(
      cloneDevelopmentDatabase(
        path.join(directory, 'missing.db'),
        path.join(directory, 'unused.db')
      )
    ).resolves.toEqual({ copied: false, reason: 'missing-source' })
  })
})
