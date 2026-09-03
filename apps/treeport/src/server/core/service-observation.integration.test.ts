import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from './database'
import { GhAdapter } from './gh'
import { GitAdapter } from './git'
import { TreeportService } from './service'
import { TerminalHostDouble } from './service.integration-fixture'
import {
  databases,
  fixture,
  integrationService,
  persistedProject,
  persistedProjectMetadata,
  persistedProjectOpen,
  persistedWorktree
} from './service.integration-fixture'

describe('TreeportService with injected command adapters', () => {
  it('shares overlapping project snapshot reconciliation', async () => {
    const { main, runner, service } = await fixture()
    await service.registerProject(main)
    runner.calls.length = 0
    let release!: () => void
    runner.statusGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = service.listProjects()
    const second = service.listProjects()
    await vi.waitFor(() =>
      expect(
        runner.calls.filter((call) => call.args[0] === 'status')
      ).toHaveLength(1)
    )
    release()
    await Promise.all([first, second])
    runner.statusGate = null
  })

  it('invalidates an in-flight project snapshot after a mutation', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    let release!: () => void
    runner.statusGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const stale = service.listProjects()
    await vi.waitFor(() =>
      expect(
        runner.calls.filter((call) => call.args[0] === 'status').length
      ).toBeGreaterThan(0)
    )
    await service.updateProjectColor(project.id, 'violet')
    const fresh = service.listProjects()
    expect(fresh).not.toBe(stale)
    release()

    await expect(fresh).resolves.toMatchObject([{ color: 'violet' }])
    await expect(stale).resolves.toMatchObject([{ color: 'violet' }])
    runner.statusGate = null
  })

  it('persists project colors and publishes an update', async () => {
    const { main, service } = await fixture()
    const project = await service.registerProject(main)
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) =>
      events.push(event.type)
    )

    expect((await service.updateProjectColor(project.id, 'violet')).color).toBe(
      'violet'
    )
    expect((await service.getProject(project.id)).color).toBe('violet')
    expect(
      (await service.updateProjectColor(project.id, null)).color
    ).toBeNull()

    unsubscribe()
    expect(events).toEqual(['project.updated', 'project.updated'])
  })

  it('provisions one shell terminal and keeps the last terminal', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = (await service.getProjectSnapshot(project.id))
      .worktrees[0]!
    const [terminal] = mainWorktree.terminals

    expect(terminal).toMatchObject({
      name: 'Shell',
      argv: ['/bin/zsh', '-l'],
      status: 'running'
    })
    await Promise.all([service.listProjects(), service.listProjects()])
    expect(runner.sessions.size).toBe(1)
    await expect(service.deleteTerminal(terminal!.id)).rejects.toMatchObject({
      code: 'LAST_TERMINAL'
    })

    const second = await service.createTerminal(mainWorktree.id, 'Second')
    await expect(service.deleteTerminal(second.id)).resolves.toBeUndefined()
    expect(
      (await service.getWorktreeSnapshot(mainWorktree.id)).terminals
    ).toEqual([expect.objectContaining({ id: terminal!.id })])
  })

  it('provisions a terminal for an externally discovered worktree', async () => {
    const { root, main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linkedPath = path.join(root, 'external linked')
    await fs.mkdir(linkedPath, { recursive: true })
    runner.worktrees.push({
      path: linkedPath,
      gitWorktreeKey: path.join(main, '.git', 'worktrees', 'external-linked'),
      head: 'external-head',
      branch: 'external-linked'
    })

    const refreshed = await service.getProjectSnapshot(project.id)
    const linked = refreshed.worktrees.find(
      (worktree) => worktree.kind === 'linked'
    )
    expect(linked?.terminals).toEqual([
      expect.objectContaining({ name: 'Shell', argv: ['/bin/zsh', '-l'] })
    ])
    expect(runner.sessions.size).toBe(2)
  })

  it('reports a project unavailable until terminal provisioning recovers', async () => {
    const { main, runner, service } = await fixture()
    runner.terminalCreateFails = true
    const unavailable = await service.registerProject(main)
    expect(unavailable.availability).toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('terminal create failed')
    })
    expect(unavailable.worktrees[0]?.terminals).toEqual([])
    await expect(
      persistedProjectOpen(service.database, unavailable.id)
    ).resolves.toBe(true)

    runner.terminalCreateFails = false
    const recovered = await service.getProjectSnapshot(unavailable.id)
    expect(recovered.availability.state).toBe('available')
    expect(recovered.worktrees[0]?.terminals).toHaveLength(1)
  })

  it('returns unavailable projects when terminal inventory fails', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    runner.terminalInventoryFails = true

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({
      state: 'unavailable',
      message: 'terminal inventory failed'
    })
    expect(unavailable.worktrees[0]?.terminals).toEqual([])

    runner.terminalInventoryFails = false
    const recovered = await service.getProjectSnapshot(project.id)
    expect(recovered.availability.state).toBe('available')
    expect(recovered.worktrees[0]?.terminals).toHaveLength(1)
  })

  it('keeps project closure serialized against terminal provisioning', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    runner.sessions.clear()
    runner.calls.length = 0
    let releaseInventory!: () => void
    runner.terminalInventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve
    })

    const inventoryAttempts = runner.terminalInventoryAttempts
    const refreshing = service.listProjects()
    await vi.waitFor(() =>
      expect(runner.terminalInventoryAttempts).toBeGreaterThan(
        inventoryAttempts
      )
    )
    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })

    releaseInventory()
    const [refreshed] = await refreshing
    runner.terminalInventoryGate = null
    expect(refreshed?.worktrees[0]?.terminals).toHaveLength(1)
  })

  it('publishes a terminal only after the host creates it', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    runner.calls.length = 0
    let releaseTerminal!: () => void
    runner.terminalCreateGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve
    })

    const createAttempts = runner.terminalCreateAttempts
    const creatingTerminal = service.createTerminal(mainWorktree.id, 'Starting')
    await vi.waitFor(() =>
      expect(runner.terminalCreateAttempts).toBe(createAttempts + 1)
    )
    const snapshot = await service.listProjects()
    expect(
      snapshot[0]?.worktrees[0]?.terminals.some(
        (terminal) => terminal.name === 'Starting'
      )
    ).toBe(false)

    releaseTerminal()
    const terminal = await creatingTerminal
    runner.terminalCreateGate = null
    expect(terminal.status).toBe('running')
    expect((await service.getTerminal(terminal.id)).status).toBe('running')
  })

  it('queues terminal creation behind an in-flight project mutation', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    let releaseTerminal!: () => void
    runner.terminalCreateGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve
    })

    const createAttempts = runner.terminalCreateAttempts
    const first = service.createTerminal(mainWorktree.id, 'First')
    await vi.waitFor(() =>
      expect(runner.terminalCreateAttempts).toBe(createAttempts + 1)
    )
    const second = service.createTerminal(mainWorktree.id, 'Second')
    await Promise.resolve()
    expect(runner.terminalCreateAttempts).toBe(createAttempts + 1)

    releaseTerminal()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ name: 'First' }),
      expect.objectContaining({ name: 'Second' })
    ])
    runner.terminalCreateGate = null
  })

  it('queues removal behind a terminal mutation before its lock is acquired', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(
        project.id,
        'remove-after-terminal',
        'default'
      )
    ).worktree
    const preview = await service.removePreview(linked.id)
    const createCallsBefore = runner.terminalCreateAttempts
    let releaseTerminal!: () => void
    runner.terminalCreateGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve
    })

    const creating = service.createTerminal(linked.id, 'First')
    let removalSettled = false
    const removing = service
      .beginRemove(linked.id, {
        confirmationToken: preview.confirmationToken,
        confirmDestructive: preview.warnings.length > 0
      })
      .then(
        (operation) => ({ operation, error: null }),
        (error) => ({ operation: null, error })
      )
      .finally(() => {
        removalSettled = true
      })
    await vi.waitFor(() =>
      expect(runner.terminalCreateAttempts).toBe(createCallsBefore + 1)
    )
    expect(removalSettled).toBe(false)

    releaseTerminal()
    await expect(creating).resolves.toMatchObject({ name: 'First' })
    await expect(removing).resolves.toMatchObject({
      error: { code: 'REMOVE_PREVIEW_STALE' }
    })
    runner.terminalCreateGate = null
  })

  it('derives status and disappearance events from host inventory', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const terminal = await service.createTerminal(
      project.worktrees[0]!.id,
      'Observed'
    )
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      events.push(event.type)
    })
    const sessionKey = `${project.worktrees[0]!.id}/${terminal.id}`
    const state = runner.sessions.get(sessionKey)!
    state.alive = false
    state.exitCode = 23

    await expect(
      service.refreshTerminalStatus(terminal.id)
    ).resolves.toMatchObject({
      status: 'exited',
      exitCode: 23
    })
    runner.sessions.delete(sessionKey)
    await expect(
      service.refreshTerminalStatus(terminal.id)
    ).rejects.toMatchObject({
      code: 'TERMINAL_NOT_FOUND'
    })
    unsubscribe()
    expect(events).toEqual(['terminal.updated', 'terminal.removed'])
  })

  it('removes successful one-off terminals and retains their failures', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    const successful = await service.createTerminal(
      worktree.id,
      'Open editor',
      ['code', '.'],
      { closeOnSuccess: true }
    )
    await expect(
      service.deleteTerminal(worktree.terminals[0]!.id)
    ).rejects.toMatchObject({ code: 'LAST_TERMINAL' })

    const successfulSessionKey = `${worktree.id}/${successful.id}`
    const successfulState = runner.sessions.get(successfulSessionKey)!
    successfulState.alive = false
    successfulState.exitCode = 0

    expect(
      (await service.getWorktreeSnapshot(worktree.id)).terminals.map(
        (terminal) => terminal.id
      )
    ).not.toContain(successful.id)
    expect(runner.sessions.has(successfulSessionKey)).toBe(false)
    await expect(
      service.refreshTerminalStatus(successful.id)
    ).rejects.toMatchObject({ code: 'TERMINAL_NOT_FOUND' })

    const failed = await service.createTerminal(
      worktree.id,
      'Open editor',
      ['code', '.'],
      { closeOnSuccess: true }
    )
    const failedState = runner.sessions.get(`${worktree.id}/${failed.id}`)!
    failedState.alive = false
    failedState.exitCode = 7

    await expect(
      service.refreshTerminalStatus(failed.id)
    ).resolves.toMatchObject({ status: 'exited', exitCode: 7 })
    expect(
      (await service.getWorktreeSnapshot(worktree.id)).terminals.map(
        (terminal) => terminal.id
      )
    ).toContain(failed.id)

    await service.deleteTerminal(failed.id)
    const retained = await service.createTerminal(
      worktree.id,
      'Only terminal',
      ['true'],
      { closeOnSuccess: true }
    )
    runner.sessions.delete(`${worktree.id}/${worktree.terminals[0]!.id}`)
    const updatedEvents: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'terminal.updated') {
        updatedEvents.push(String(event.data.terminalId))
      }
    })
    const retainedState = runner.sessions.get(`${worktree.id}/${retained.id}`)!
    retainedState.alive = false
    retainedState.exitCode = 0

    await expect(
      service.refreshTerminalStatus(retained.id)
    ).resolves.toMatchObject({
      status: 'exited',
      exitCode: 0
    })
    unsubscribe()
    expect(updatedEvents).toEqual([retained.id])
    expect(
      (await service.getWorktreeSnapshot(worktree.id)).terminals
    ).toContainEqual(
      expect.objectContaining({ id: retained.id, status: 'exited' })
    )
  })

  it('reports failed one-off cleanup at the project snapshot boundary', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    const terminal = await service.createTerminal(
      worktree.id,
      'Open editor',
      ['code', '.'],
      { closeOnSuccess: true }
    )
    const sessionKey = `${worktree.id}/${terminal.id}`
    const state = runner.sessions.get(sessionKey)!
    state.alive = false
    state.exitCode = 0
    runner.terminalKillFails = true

    await expect(service.getProjectSnapshot(project.id)).resolves.toMatchObject(
      {
        availability: {
          state: 'unavailable',
          message: 'terminal cleanup failed'
        }
      }
    )
    expect(runner.sessions.has(sessionKey)).toBe(true)
  })

  it('can refresh host status without observing Git', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const terminal = await service.createTerminal(
      project.worktrees[0]!.id,
      'Polled'
    )
    runner.calls.splice(0)
    const stateAttempts = runner.terminalStateAttempts

    await service.refreshTerminalStatus(terminal.id, false)
    await service.refreshTerminalStatus(terminal.id, false)
    expect(runner.terminalStateAttempts).toBe(stateAttempts + 2)
    expect(
      runner.calls.filter(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
      )
    ).toHaveLength(0)

    await service.refreshTerminalStatus(terminal.id)
    expect(
      runner.calls.filter(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
      ).length
    ).toBeGreaterThan(0)
  })

  it('preserves bindings and terminals when Git moves a linked worktree', async () => {
    const { root, main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'moving', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Moving terminal')
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'worktree.updated') {
        events.push(event.type)
      }
    })
    const live = runner.worktrees.find((item) => item.path === linked.path)!
    const movedPath = path.join(root, 'externally moved checkout')
    await fs.rename(linked.path, movedPath)
    live.path = movedPath

    await expect(
      service.refreshTerminalStatus(terminal.id)
    ).resolves.toMatchObject({ id: terminal.id })
    const moved = (await service.getProjectSnapshot(project.id)).worktrees.find(
      (worktree) => worktree.id === linked.id
    )!
    expect(moved).toMatchObject({
      id: linked.id,
      path: await fs.realpath(movedPath)
    })
    expect(moved.terminals.map((item) => item.id)).toContain(terminal.id)
    expect((await service.getWorktree(linked.id)).path).toBe(
      await fs.realpath(movedPath)
    )
    expect(events).toEqual(['worktree.updated'])
    unsubscribe()
  })

  it('recovers a renamed main checkout and preserves its bindings and terminals', async () => {
    const { root, main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const originalMain = project.worktrees.find(
      (worktree) => worktree.kind === 'main'
    )!
    const linked = (
      await service.createWorktree(project.id, 'main-rename-linked', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    const prunable = (
      await service.createWorktree(
        project.id,
        'missing-during-repair',
        'default'
      )
    ).worktree
    runner.worktrees.find(
      (worktree) => worktree.path === prunable.path
    )!.prunable = true
    await fs.rm(prunable.path, { recursive: true, force: true })
    const renamedMain = path.join(root, 'renamed main checkout')
    await fs.rename(main, renamedMain)
    runner.main = renamedMain
    runner.worktrees[0]!.path = renamedMain

    const recovered = await service.getProjectSnapshot(project.id)
    const recoveredMain = recovered.worktrees.find(
      (worktree) => worktree.kind === 'main'
    )!
    const recoveredLinked = recovered.worktrees.find(
      (worktree) => worktree.id === linked.id
    )!
    expect(recovered).toMatchObject({
      id: project.id,
      name: 'renamed main checkout',
      repositoryPath: await fs.realpath(renamedMain),
      mainWorktreePath: await fs.realpath(renamedMain),
      availability: { state: 'available', message: null }
    })
    expect(recoveredMain).toMatchObject({
      id: originalMain.id,
      path: await fs.realpath(renamedMain)
    })
    expect(recoveredLinked).toMatchObject({
      id: linked.id
    })
    expect(recoveredLinked.terminals.map((item) => item.id)).toContain(
      terminal.id
    )
    expect(
      recovered.worktrees.find((worktree) => worktree.id === prunable.id)
    ).toMatchObject({ id: prunable.id, prunable: true })
    expect(
      runner.calls.some(
        (call) =>
          call.args[0] === 'worktree' &&
          call.args[1] === 'repair' &&
          call.args.length === 2
      )
    ).toBe(true)
  })

  it('recovers a stopped-daemon main and linked-worktree rename', async () => {
    const { root, main, runner, service, database, config } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'restart-main-rename', 'default')
    ).worktree
    const terminal = await service.createTerminal(
      linked.id,
      'Preserved',
      undefined,
      { shellCommand: 'bun remotion' }
    )
    const linkedGitKey = runner.worktrees.find(
      (worktree) => worktree.path === linked.path
    )!.gitWorktreeKey
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const renamedMain = path.join(root, 'renamed while daemon stopped')
    const movedLinked = path.join(root, 'linked moved while daemon stopped')
    await fs.rename(main, renamedMain)
    await fs.rename(linked.path, movedLinked)
    runner.main = renamedMain
    runner.worktrees[0]!.path = renamedMain
    runner.worktrees.find(
      (worktree) => worktree.gitWorktreeKey === linkedGitKey
    )!.path = movedLinked

    const restartedDatabase = await openDatabase(config.databasePath)
    databases.push(restartedDatabase)
    const restarted = integrationService(
      new TreeportService({
        config,
        database: restartedDatabase,
        runner,
        git: new GitAdapter(runner),
        terminalHost: new TerminalHostDouble(runner),
        gh: new GhAdapter(runner)
      })
    )
    await restarted.runEffect(restarted.initialize())

    const recovered = await restarted.getProjectSnapshot(project.id)
    expect(recovered).toMatchObject({
      id: project.id,
      repositoryPath: await fs.realpath(renamedMain),
      availability: { state: 'available' }
    })
    expect(
      recovered.worktrees.find((worktree) => worktree.id === linked.id)
    ).toMatchObject({
      id: linked.id,
      path: await fs.realpath(movedLinked),
      terminals: expect.arrayContaining([
        expect.objectContaining({
          id: terminal.id,
          argv: ['/bin/zsh', '-lc', 'bun remotion'],
          shellCommand: 'bun remotion',
          interactiveShell: false
        })
      ])
    })
  })

  it('enrolls a legacy project after a remount without losing its bindings', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'legacy-remount', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    const identity = await persistedProjectMetadata(database, project.id)
    expect(identity).not.toBeNull()

    runner.repositoryIdentity = null
    await database.db.run(sql`
      UPDATE projects
      SET repository_identity=NULL,
          repository_device=${`${BigInt(identity!.device) + 1n}`}
      WHERE id=${project.id}
    `)

    const recovered = await service.getProjectSnapshot(project.id)
    expect(recovered).toMatchObject({
      id: project.id,
      repositoryPath: await fs.realpath(main),
      availability: { state: 'available' },
      worktrees: expect.arrayContaining([
        expect.objectContaining({
          id: linked.id,
          terminals: expect.arrayContaining([
            expect.objectContaining({ id: terminal.id })
          ])
        })
      ])
    })
    expect(await persistedProjectMetadata(database, project.id)).toMatchObject({
      identity: expect.any(String),
      device: identity!.device,
      inode: identity!.inode
    })
  })

  it('preserves metadata when Git repair fails during main rename recovery', async () => {
    const { root, main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'repair-failure', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    const renamedMain = path.join(root, 'repair failure rename')
    await fs.rename(main, renamedMain)
    runner.main = renamedMain
    runner.worktrees[0]!.path = renamedMain
    runner.worktreeRepairFails = true

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('worktree repair failed')
    })
    expect((await persistedProject(database, project.id))?.repositoryPath).toBe(
      project.repositoryPath
    )
    expect(await persistedWorktree(database, linked.id)).toMatchObject({
      path: linked.path
    })
    expect(
      [...runner.sessions.keys()].some((key) => key.endsWith(`/${terminal.id}`))
    ).toBe(true)
  })

  it('preserves an explicit project name equal to the original folder name', async () => {
    const { root, main, runner, service } = await fixture()
    const project = await service.registerProject(main, path.basename(main))
    const renamedMain = path.join(root, 'renamed custom checkout')
    await fs.rename(main, renamedMain)
    runner.main = renamedMain
    runner.worktrees[0]!.path = renamedMain

    await expect(service.getProjectSnapshot(project.id)).resolves.toMatchObject(
      {
        id: project.id,
        name: path.basename(main),
        repositoryPath: await fs.realpath(renamedMain),
        availability: { state: 'available' }
      }
    )
  })

  it('refuses to adopt a different repository placed at a registered path', async () => {
    const { root, main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const renamedMain = path.join(root, 'original repository renamed')
    await fs.rename(main, renamedMain)
    await fs.mkdir(main)
    runner.main = main
    runner.worktrees[0] = {
      path: main,
      gitWorktreeKey: path.join(main, '.git'),
      head: 'replacement-head',
      branch: 'trunk'
    }
    runner.repositoryIdentity = crypto.randomUUID()

    expect(await service.getProjectSnapshot(project.id)).toMatchObject({
      id: project.id,
      availability: {
        state: 'unavailable',
        message: expect.stringContaining('different repository')
      },
      worktrees: [expect.objectContaining({ id: project.worktrees[0]!.id })]
    })
    await expect(service.registerProject(main)).rejects.toMatchObject({
      code: 'PROJECT_PATH_CONFLICT',
      status: 409
    })
    expect(await persistedProject(database, project.id)).toMatchObject({
      id: project.id,
      repositoryPath: project.repositoryPath,
      mainWorktreePath: project.mainWorktreePath
    })
  })

  it('keeps an unknown-parent move unavailable until re-registration recovers it', async () => {
    const { root, main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const originalMain = project.worktrees.find(
      (worktree) => worktree.kind === 'main'
    )!
    const linked = (
      await service.createWorktree(project.id, 'reregister-linked', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    const destinationParent = path.join(root, 'elsewhere')
    const movedMain = path.join(destinationParent, 'moved repository')
    await fs.mkdir(destinationParent)
    await fs.rename(main, movedMain)
    await fs.mkdir(main)
    runner.main = movedMain
    runner.worktrees[0]!.path = movedMain
    runner.calls.length = 0

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable).toMatchObject({
      id: project.id,
      repositoryPath: project.repositoryPath,
      availability: { state: 'unavailable' }
    })
    expect((await persistedProject(database, project.id))?.repositoryPath).toBe(
      project.repositoryPath
    )
    expect(
      runner.calls.some(
        (call) =>
          call.cwd === main &&
          call.args[0] === 'worktree' &&
          call.args[1] === 'list'
      )
    ).toBe(false)
    expect(
      [...runner.sessions.keys()].some((key) => key.endsWith(`/${terminal.id}`))
    ).toBe(true)

    await fs.rm(main, { recursive: true })
    const recovered = await service.registerProject(movedMain)
    expect(recovered).toMatchObject({
      id: project.id,
      name: 'moved repository',
      repositoryPath: await fs.realpath(movedMain),
      mainWorktreePath: await fs.realpath(movedMain)
    })
    expect(
      recovered.worktrees.find((worktree) => worktree.kind === 'main')
    ).toMatchObject({ id: originalMain.id })
    expect(
      recovered.worktrees.find((worktree) => worktree.id === linked.id)
    ).toMatchObject({ id: linked.id })
  })

  it('retires externally removed worktrees only after a successful Git observation', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'external-removal', 'default')
    ).worktree
    await service.createTerminal(linked.id, 'Removed terminal')
    const index = runner.worktrees.findIndex(
      (worktree) => worktree.path === linked.path
    )
    runner.worktrees.splice(index, 1)
    await fs.rm(linked.path, { recursive: true, force: true })

    const refreshed = await service.getProjectSnapshot(project.id)
    expect(refreshed.worktrees.map((worktree) => worktree.id)).not.toContain(
      linked.id
    )
    expect(await persistedWorktree(database, linked.id)).toBeNull()
    expect(
      [...runner.sessions.keys()].some((key) => key.startsWith(`${linked.id}/`))
    ).toBe(false)
    const externalOperation = (await database.db.get<{ id: string }>(sql`
      SELECT id FROM operations WHERE kind='external_remove'
    `))!
    expect(await service.getOperation(externalOperation.id)).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({
        external: true,
        worktreeId: linked.id,
        path: linked.path
      })
    })
  })

  it('detects external removal through a direct terminal read', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'terminal-removal', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Direct read')
    runner.worktrees.splice(
      runner.worktrees.findIndex((worktree) => worktree.path === linked.path),
      1
    )
    await fs.rm(linked.path, { recursive: true, force: true })

    await expect(service.getTerminal(terminal.id)).rejects.toMatchObject({
      code: 'TERMINAL_NOT_FOUND'
    })
    expect(await persistedWorktree(database, linked.id)).toBeNull()
  })

  it('preserves bindings and history when external terminal shutdown fails', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'shutdown-failure', 'default')
    ).worktree
    await service.createTerminal(linked.id, 'Still running')
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      events.push(event.type)
    })
    runner.worktrees.splice(
      runner.worktrees.findIndex((worktree) => worktree.path === linked.path),
      1
    )
    await fs.rm(linked.path, { recursive: true, force: true })
    runner.terminalKillWorktreeFails = true

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('terminal host cleanup failed')
    })
    expect(await persistedWorktree(database, linked.id)).not.toBeNull()
    expect(
      (
        await database.db.get<{ count: number }>(sql`
          SELECT count(*) AS count FROM operations WHERE kind='external_remove'
        `)
      )?.count
    ).toBe(0)
    expect(events).not.toContain('worktree.removed')
    expect(events).not.toContain('terminal.removed')

    runner.terminalKillWorktreeFails = false
    await expect(service.getProjectSnapshot(project.id)).resolves.toMatchObject(
      { availability: { state: 'available' } }
    )
    expect(await persistedWorktree(database, linked.id)).toBeNull()
    unsubscribe()
  })

  it('commits successful external retirements before a later shutdown failure', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const first = (
      await service.createWorktree(project.id, 'removed-first', 'default')
    ).worktree
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = (
      await service.createWorktree(project.id, 'removed-second', 'default')
    ).worktree
    const firstTerminal = await service.createTerminal(first.id, 'First')
    const secondTerminal = await service.createTerminal(second.id, 'Second')
    const events: Array<{ type: string; worktreeId: unknown }> = []
    const unsubscribe = service.events.subscribe((event) => {
      if (
        event.type === 'terminal.removed' ||
        event.type === 'worktree.removed'
      ) {
        events.push({ type: event.type, worktreeId: event.data.worktreeId })
      }
    })
    runner.worktrees.splice(
      runner.worktrees.findIndex((worktree) => worktree.path === first.path),
      1
    )
    runner.worktrees.splice(
      runner.worktrees.findIndex((worktree) => worktree.path === second.path),
      1
    )
    await Promise.all([
      fs.rm(first.path, { recursive: true, force: true }),
      fs.rm(second.path, { recursive: true, force: true })
    ])
    runner.terminalKillFailureWorktrees.add(second.id)

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({ state: 'unavailable' })
    expect(await persistedWorktree(database, first.id)).toBeNull()
    expect(await persistedWorktree(database, second.id)).not.toBeNull()
    const externalOperations = await database.db.all<{
      result_json: string
    }>(sql`
      SELECT result_json FROM operations WHERE kind='external_remove'
    `)
    expect(
      externalOperations.map(({ result_json }) => JSON.parse(result_json))
    ).toEqual([
      expect.objectContaining({
        worktreeId: first.id,
        external: true,
        cleanup: {
          status: 'skipped',
          skippedReason: 'Git removed the tree outside Treeport'
        }
      })
    ])
    expect(events).toEqual([
      { type: 'terminal.removed', worktreeId: first.id },
      { type: 'terminal.removed', worktreeId: first.id },
      { type: 'worktree.removed', worktreeId: first.id }
    ])
    expect(
      [...runner.sessions.keys()].some((key) =>
        key.endsWith(`/${firstTerminal.id}`)
      )
    ).toBe(false)
    expect(
      [...runner.sessions.keys()].some((key) =>
        key.endsWith(`/${secondTerminal.id}`)
      )
    ).toBe(true)

    runner.terminalKillFailureWorktrees.delete(second.id)
    await service.getProjectSnapshot(project.id)
    expect(await persistedWorktree(database, second.id)).toBeNull()
    unsubscribe()
  })

  it('treats incomplete Git inventories as unavailable without retiring bindings', async () => {
    for (const keepLinked of [false, true]) {
      const { main, runner, service, database } = await fixture()
      const project = await service.registerProject(main)
      const linked = (
        await service.createWorktree(
          project.id,
          keepLinked ? 'missing-main' : 'empty-inventory',
          'default'
        )
      ).worktree
      await service.createTerminal(linked.id, 'Preserved')
      runner.worktrees.splice(
        0,
        runner.worktrees.length,
        ...(keepLinked
          ? runner.worktrees.filter((worktree) => worktree.path === linked.path)
          : [])
      )

      const unavailable = await service.getProjectSnapshot(project.id)
      expect(unavailable.availability).toMatchObject({
        state: 'unavailable',
        message: expect.stringContaining('inventory is incomplete')
      })
      expect(await persistedWorktree(database, linked.id)).not.toBeNull()
      expect(
        [...runner.sessions.keys()].some((key) =>
          key.startsWith(`${linked.id}/`)
        )
      ).toBe(true)
      expect(
        (
          await database.db.get<{ count: number }>(sql`
            SELECT count(*) AS count FROM operations WHERE kind='external_remove'
          `)
        )?.count
      ).toBe(0)
    }
  })

  it('serializes project observations so an older scan cannot win', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'serialized', 'default')
    ).worktree
    const live = runner.worktrees.find(
      (worktree) => worktree.path === linked.path
    )!
    let releaseObservation!: () => void
    runner.worktreeListGate = new Promise<void>((resolve) => {
      releaseObservation = resolve
    })
    const callsBefore = runner.calls.filter(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
    ).length
    const older = service.getProjectSnapshot(project.id)
    await vi.waitFor(() =>
      expect(
        runner.calls.filter(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
        ).length
      ).toBeGreaterThan(callsBefore)
    )
    live.head = 'newer-head'
    const newer = service.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      runner.calls.filter(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
      ).length
    ).toBe(callsBefore + 1)

    releaseObservation()
    await Promise.all([older, newer])
    runner.worktreeListGate = null
    expect((await service.getWorktree(linked.id)).head).toBe('newer-head')
  })

  it('keeps cached bindings and rejects mutations while Git is unavailable', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const linked = (
      await service.createWorktree(project.id, 'unavailable', 'default')
    ).worktree
    const terminal = await service.createTerminal(linked.id, 'Preserved')
    runner.listWorktreesFails = true

    const unavailable = await service.getProjectSnapshot(project.id)
    expect(unavailable.availability).toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('repository unavailable')
    })
    expect(unavailable.worktrees.map((worktree) => worktree.id)).toContain(
      linked.id
    )
    expect(await persistedWorktree(database, linked.id)).not.toBeNull()
    expect(
      [...runner.sessions.keys()].some((key) => key.endsWith(`/${terminal.id}`))
    ).toBe(true)
    await expect(
      service.createTerminal(linked.id, 'Blocked')
    ).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' })

    runner.listWorktreesFails = false
    await expect(service.getProjectSnapshot(project.id)).resolves.toMatchObject(
      { availability: { state: 'available', message: null } }
    )
  })
})
