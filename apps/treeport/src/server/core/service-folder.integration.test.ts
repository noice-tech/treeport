import fs from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { DomainError } from './domain'
import { openDatabase } from './database'
import { GhAdapter } from './gh'
import { GitAdapter } from './git'
import { TreeportService } from './service'
import {
  databases,
  fixture,
  persistedProject,
  persistedProjectMetadata,
  persistedProjectOpen,
  services
} from './service.integration-fixture'
import { TerminalHostDouble } from './service.integration-fixture'

describe('ordinary folder projects', () => {
  it('registers, uses, reopens, moves, and removes a folder without Git operations', async () => {
    const { root, main, runner, service, database, config } = await fixture()
    const folder = path.join(main, 'notes folder')
    await fs.mkdir(folder)
    runner.headExists = false

    const canonicalFolder = await fs.realpath(folder)
    const browsed = await service.browseDirectory(folder)
    expect(browsed.project).toEqual({
      state: 'valid',
      kind: 'folder',
      path: canonicalFolder
    })
    expect(browsed.repository.state).toBe('not-repository')

    const registered = await service.registerProject(folder)
    expect(registered).toMatchObject({
      name: 'notes folder',
      kind: 'folder',
      rootPath: canonicalFolder,
      repositoryPath: canonicalFolder,
      mainWorktreePath: canonicalFolder,
      defaultBranch: '',
      availability: { state: 'available', message: null },
      worktrees: [
        {
          name: 'notes folder',
          path: canonicalFolder,
          kind: 'folder',
          head: '',
          branch: null,
          dirty: null,
          terminals: [{ name: 'Shell', status: 'running' }]
        }
      ]
    })
    expect(
      runner.calls.filter(
        (call) =>
          call.cwd === folder &&
          !(
            call.args[0] === 'rev-parse' && call.args[1] === '--show-toplevel'
          ) &&
          call.executable === 'git'
      )
    ).toEqual([])

    const openedEvents: unknown[] = []
    const unsubscribe = service.events.subscribe((event) =>
      openedEvents.push(event)
    )
    await service.requestWorkspaceOpen(
      registered.worktrees[0]!.id,
      'term_source'
    )
    unsubscribe()
    expect(openedEvents).toEqual([
      expect.objectContaining({
        type: 'workspace.open_requested',
        data: {
          worktreeId: registered.worktrees[0]!.id,
          sourceTerminalId: 'term_source'
        }
      })
    ])

    const terminalId = registered.worktrees[0]!.terminals[0]!.id
    await database.db.run(sql`
      UPDATE projects
      SET repository_device = 'previous-boot-device',
          repository_inode = 'previous-boot-inode'
      WHERE id = ${registered.id}
    `)
    database.close()
    databases.splice(databases.indexOf(database), 1)
    const reopenedDatabase = await openDatabase(config.databasePath)
    databases.push(reopenedDatabase)
    const restartedService = new TreeportService({
      config,
      database: reopenedDatabase,
      runner,
      git: new GitAdapter(runner),
      terminalHost: new TerminalHostDouble(runner),
      gh: new GhAdapter(runner)
    })
    services.push(restartedService)
    await restartedService.initialize()
    const restarted = await restartedService.getProjectSnapshot(registered.id)
    expect(restarted).toMatchObject({
      availability: { state: 'available', message: null },
      worktrees: [
        {
          terminals: [
            expect.objectContaining({ id: terminalId, name: 'Shell' })
          ]
        }
      ]
    })
    const restartedFolderStat = await fs.stat(folder, { bigint: true })
    expect(
      await persistedProjectMetadata(reopenedDatabase, registered.id)
    ).toMatchObject({
      device: restartedFolderStat.dev.toString(),
      inode: restartedFolderStat.ino.toString()
    })

    await expect(
      restartedService.beginCreateWorktree(registered.id, 'topic', 'default')
    ).rejects.toMatchObject({
      code: 'PROJECT_HAS_NO_GIT_REPOSITORY'
    } satisfies Partial<DomainError>)

    await restartedService.closeProject(registered.id)
    expect(await persistedProjectOpen(reopenedDatabase, registered.id)).toBe(
      false
    )
    expect(await restartedService.listRecentProjects()).toEqual([
      expect.objectContaining({
        id: registered.id,
        kind: 'folder',
        rootPath: canonicalFolder
      })
    ])

    const reopened = await restartedService.openProject(registered.id)
    expect(reopened.worktrees[0]?.terminals).toEqual([
      expect.objectContaining({ name: 'Shell', status: 'running' })
    ])
    await restartedService.closeProject(registered.id)

    const movedFolder = path.join(root, 'renamed notes')
    await fs.rename(folder, movedFolder)
    await fs.mkdir(folder)
    await expect(
      restartedService.registerProject(folder)
    ).rejects.toMatchObject({
      code: 'PROJECT_PATH_CONFLICT'
    } satisfies Partial<DomainError>)
    await fs.rmdir(folder)

    const moved = await restartedService.registerProject(movedFolder)
    expect(moved).toMatchObject({
      id: registered.id,
      name: 'renamed notes',
      kind: 'folder',
      rootPath: await fs.realpath(movedFolder),
      worktrees: [
        {
          id: registered.worktrees[0]?.id,
          name: 'renamed notes',
          path: await fs.realpath(movedFolder),
          kind: 'folder'
        }
      ]
    })

    await restartedService.deleteProject(moved.id)
    expect(await persistedProject(reopenedDatabase, moved.id)).toBeNull()
    expect((await fs.stat(movedFolder)).isDirectory()).toBe(true)
  })
})
