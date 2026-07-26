import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TreeportDatabase } from '../src/core/database'
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
      path.join(os.tmpdir(), 'treeport-development-database-')
    )
    directories.push(directory)
    const sourcePath = path.join(directory, 'source', 'treeport.db')
    const destinationPath = path.join(directory, 'destination', 'treeport.db')
    const source = new TreeportDatabase(sourcePath)
    databases.push(source)
    source.connection
      .prepare(
        `INSERT INTO projects(
           id,name,repository_path,main_worktree_path,default_branch,color,
           repository_device,repository_inode,name_is_custom,is_open,last_opened_at,
           created_at,updated_at
         ) VALUES('project','Main project','/repo','/repo','main',NULL,
           '1','1',0,1,'2026-01-01','2026-01-01','2026-01-01')`
      )
      .run()
    source.connection
      .prepare(
        `INSERT INTO worktrees(
           id,project_id,path,kind,tmux_socket_name,status,cleanup_error,
           created_at,updated_at
         ) VALUES('worktree','project','/repo','main','real-tmux-socket',
           'cleanup_failed','real cleanup pending','2026-01-01','2026-01-01')`
      )
      .run()
    source.connection
      .prepare(
        `INSERT INTO operations(
           id,kind,project_id,worktree_id,status,request_json,created_at,updated_at
         ) VALUES('operation','remove','project','worktree','pending','{}',
           '2026-01-01','2026-01-01')`
      )
      .run()

    await expect(
      cloneDevelopmentDatabase(sourcePath, destinationPath)
    ).resolves.toEqual({ copied: true })
    const snapshot = new TreeportDatabase(destinationPath)
    expect(snapshot.project('project')).toMatchObject({
      name: 'Main project',
      repositoryPath: '/repo',
      worktrees: [
        expect.objectContaining({
          path: '/repo',
          status: 'active',
          cleanupError: null,
          tmuxSocketName: expect.stringMatching(/^treeport-wt-[0-9a-f]{16}$/)
        })
      ]
    })
    expect(snapshot.project('project')!.worktrees[0]!.tmuxSocketName).not.toBe(
      'real-tmux-socket'
    )
    expect(
      snapshot.connection
        .prepare('SELECT COUNT(*) AS count FROM operations')
        .get()
    ).toEqual({ count: 0 })
    expect(source.project('project')!.worktrees[0]).toMatchObject({
      status: 'cleanup_failed',
      cleanupError: 'real cleanup pending',
      tmuxSocketName: 'real-tmux-socket'
    })
    expect(
      source.connection
        .prepare('SELECT COUNT(*) AS count FROM operations')
        .get()
    ).toEqual({ count: 1 })
    snapshot.close()

    const adoptedPath = path.join(directory, 'adopted', 'treeport.db')
    await cloneDevelopmentDatabase(sourcePath, adoptedPath, {
      preserveTmuxSockets: true
    })
    const adopted = new TreeportDatabase(adoptedPath)
    expect(adopted.project('project')!.worktrees[0]!.tmuxSocketName).toBe(
      'real-tmux-socket'
    )
    adopted.close()

    source.connection
      .prepare(
        "UPDATE projects SET name = 'Refreshed project' WHERE id = 'project'"
      )
      .run()
    await expect(
      cloneDevelopmentDatabase(sourcePath, destinationPath)
    ).resolves.toEqual({ copied: false, reason: 'existing-destination' })
    await expect(
      cloneDevelopmentDatabase(sourcePath, destinationPath, { force: true })
    ).resolves.toEqual({ copied: true })

    const refreshed = new TreeportDatabase(destinationPath)
    expect(refreshed.project('project')!.name).toBe('Refreshed project')
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
