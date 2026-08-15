import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  beginFromPreview,
  fixture,
  persistedProject,
  persistedProjectOpen,
  waitForOperation
} from './service.integration-fixture'

describe('TreeportService with injected command adapters', () => {
  it('creates terminals in active worktrees and queues removal while headless setup is running', async () => {
    const { main, runner, service } = await fixture()
    await fs.mkdir(path.join(main, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({
        version: 1,
        commands: [
          {
            name: 'held setup',
            argv: ['hold-setup']
          }
        ]
      })
    )
    const project = await service.registerProject(main)
    let releaseSetup!: () => void
    runner.setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })

    let creationSettled = false
    const creating = service
      .createWorktree(project.id, 'setup-locked', 'default')
      .finally(() => {
        creationSettled = true
      })
    await vi.waitFor(() =>
      expect(
        runner.calls.some((call) => call.executable === 'hold-setup')
      ).toBe(true)
    )
    const setupProject = await service.getProject(project.id)
    const linked = setupProject.worktrees.find(
      (worktree) => worktree.name === 'setup-locked'
    )!
    const mainWorktree = setupProject.worktrees.find(
      (worktree) => worktree.kind === 'main'
    )!
    const terminalOutcome = await service
      .createTerminal(mainWorktree.id, 'Created during setup', ['pi'])
      .then(
        (terminal) => ({ terminal, error: null }),
        (error) => ({ terminal: null, error })
      )
    expect(creationSettled).toBe(false)

    const preview = await service.removePreview(linked.id)
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
    await Promise.resolve()
    expect(removalSettled).toBe(false)

    releaseSetup()
    await expect(creating).resolves.toMatchObject({
      worktree: { id: linked.id }
    })
    runner.setupGate = null
    await expect(removing).resolves.toMatchObject({
      error: { code: 'REMOVE_PREVIEW_STALE' }
    })
    expect(await service.getWorktree(linked.id)).toMatchObject({
      id: linked.id
    })
    expect(terminalOutcome).toMatchObject({
      terminal: {
        worktreeId: mainWorktree.id,
        name: 'Created during setup',
        argv: ['pi']
      },
      error: null
    })
  })

  it("does not release another mutation's project lock after path registration is refused", async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    let releaseAdd!: () => void
    runner.worktreeAddGate = new Promise<void>((resolve) => {
      releaseAdd = resolve
    })
    const creating = service.createWorktree(project.id, 'lock-owner', 'default')
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'add'
        )
      ).toBe(true)
    )

    await expect(service.registerProject(main)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })

    releaseAdd()
    await expect(creating).resolves.toMatchObject({
      worktree: { name: 'lock-owner' }
    })
    runner.worktreeAddGate = null
  })

  it('serializes project deletion against worktree and terminal creation', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)

    let releaseAdd!: () => void
    runner.worktreeAddGate = new Promise<void>((resolve) => {
      releaseAdd = resolve
    })
    const creatingWorktree = service.createWorktree(
      project.id,
      'concurrent',
      'default'
    )
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'add'
        )
      ).toBe(true)
    )
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    releaseAdd()
    const linked = (await creatingWorktree).worktree
    runner.worktreeAddGate = null
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_HAS_WORKTREES'
    })
    await waitForOperation(
      service,
      (await beginFromPreview(service, linked.id)).id
    )

    const mainWorktree = (await service.getProject(project.id)).worktrees[0]!
    runner.calls.length = 0
    let releaseTerminal!: () => void
    runner.tmuxCreateGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve
    })
    const creatingTerminal = service.createTerminal(
      mainWorktree.id,
      'Concurrent',
      ['pi']
    )
    await vi.waitFor(() =>
      expect(
        runner.calls.some((call) => call.args.includes('new-session'))
      ).toBe(true)
    )
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    releaseTerminal()
    await creatingTerminal
    runner.tmuxCreateGate = null
    await expect(service.deleteProject(project.id)).resolves.toBeUndefined()
  })

  it('closes every project worktree and provisions terminals when reopening', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    await service.createTerminal(mainWorktree.id, 'Main terminal', ['pi'])
    const linkedResult = await service.createWorktree(
      project.id,
      'close-all',
      'default',
      { name: 'Linked terminal', argv: ['pi'] }
    )
    const linked = linkedResult.worktree
    expect(runner.sessions.size).toBe(3)

    await service.closeProject(project.id)

    expect(await service.listProjects()).toEqual([])
    expect(await service.listRecentProjects()).toEqual([
      expect.objectContaining({
        id: project.id,
        repositoryPath: project.repositoryPath
      })
    ])
    expect(runner.sessions.size).toBe(0)
    expect(
      (await persistedProject(service.database, project.id))?.worktrees.map(
        ({ id }) => id
      )
    ).toEqual(expect.arrayContaining([mainWorktree.id, linked.id]))

    const reopened = await service.openProject(project.id)
    expect(reopened.id).toBe(project.id)
    expect(reopened.worktrees.map(({ id }) => id)).toEqual(
      expect.arrayContaining([mainWorktree.id, linked.id])
    )
    expect(
      reopened.worktrees.flatMap(({ terminals }) => terminals)
    ).toHaveLength(2)
    expect(
      reopened.worktrees.every(
        (worktree) =>
          worktree.terminals.length === 1 &&
          worktree.terminals[0]?.name === 'Shell'
      )
    ).toBe(true)
    expect(await service.listRecentProjects()).toEqual([])

    await service.closeProject(project.id)
    const pathReopened = await service.registerProject(main)
    expect(pathReopened.id).toBe(project.id)
    await expect(
      persistedProjectOpen(service.database, project.id)
    ).resolves.toBe(true)
  })

  it('keeps a project open after partial terminal shutdown and retries the close', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    const mainTerminal = await service.createTerminal(
      mainWorktree.id,
      'Main terminal',
      ['pi']
    )
    const linkedResult = await service.createWorktree(
      project.id,
      'partial-close',
      'default',
      { name: 'Linked terminal', argv: ['pi'] }
    )
    const linked = linkedResult.worktree
    runner.tmuxKillFailureSockets.add(linked.tmuxSocketName)
    const removed: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'terminal.removed') {
        removed.push(String(event.data.terminalId))
      }
    })

    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CLOSE_FAILED',
      details: {
        failedWorktreeIds: [linked.id],
        terminalsMayHaveStopped: true
      }
    })
    await expect(
      persistedProjectOpen(service.database, project.id)
    ).resolves.toBe(true)
    expect(removed).toContain(mainTerminal.id)
    expect(runner.sessions.size).toBe(1)
    expect(
      (await service.listProjects())[0]!.worktrees.flatMap(
        ({ terminals }) => terminals
      )
    ).toHaveLength(2)

    runner.tmuxKillFailureSockets.clear()
    await expect(service.closeProject(project.id)).resolves.toBeUndefined()
    unsubscribe()
    await expect(
      persistedProjectOpen(service.database, project.id)
    ).resolves.toBe(false)
    expect(runner.sessions.size).toBe(0)
  })

  it('reports a final persistence failure after clearing stopped terminals', async () => {
    const { main, runner, service, database } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    const terminal = await service.createTerminal(
      mainWorktree.id,
      'Persistence failure',
      ['pi']
    )
    await database.db.run(sql`
      CREATE TRIGGER fail_project_close
      BEFORE UPDATE OF is_open ON projects
      WHEN NEW.is_open = 0
      BEGIN
        SELECT RAISE(FAIL, 'database write failed');
      END
    `)
    const events: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      events.push(
        `${event.type}:${'terminalId' in event.data ? event.data.terminalId : ''}`
      )
    })

    await expect(service.closeProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CLOSE_FAILED',
      details: {
        failedWorktreeIds: [],
        terminalsMayHaveStopped: true
      }
    })
    unsubscribe()
    await expect(persistedProjectOpen(database, project.id)).resolves.toBe(true)
    expect(runner.sessions.size).toBe(0)
    expect(events).toContain(`terminal.removed:${terminal.id}`)
    expect(events.some((event) => event.startsWith('project.updated'))).toBe(
      false
    )
  })

  it('waits for in-flight observation before closing a project', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    let releaseObservation!: () => void
    runner.worktreeListGate = new Promise<void>((resolve) => {
      releaseObservation = resolve
    })
    runner.calls.length = 0
    const snapshot = service.listProjects()
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
        )
      ).toBe(true)
    )

    let closed = false
    const closing = service.closeProject(project.id).then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(closed).toBe(false)
    releaseObservation()
    await snapshot
    await closing
    runner.worktreeListGate = null
    expect(await service.listProjects()).toEqual([])
  })

  it('does not let an in-flight terminal poll repopulate state after close', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const terminal = await service.createTerminal(
      project.worktrees[0]!.id,
      'Polled terminal',
      ['pi']
    )
    let releasePoll!: () => void
    runner.calls.length = 0
    runner.tmuxStateGate = new Promise<void>((resolve) => {
      releasePoll = resolve
    })
    const removed: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'terminal.removed') {
        removed.push(String(event.data.terminalId))
      }
    })
    const polling = service.refreshTerminalStatus(terminal.id, false)
    await vi.waitFor(() =>
      expect(
        runner.calls.some(
          (call) =>
            call.args.includes('list-panes') && !call.args.includes('-a')
        )
      ).toBe(true)
    )

    await service.closeProject(project.id)
    releasePoll()
    await expect(polling).rejects.toMatchObject({
      code: expect.stringMatching(/PROJECT_CLOSED|TERMINAL_NOT_FOUND/)
    })
    runner.tmuxStateGate = null
    unsubscribe()
    expect(removed.filter((terminalId) => terminalId === terminal.id)).toEqual([
      terminal.id
    ])
    expect(await service.listProjects()).toEqual([])
  })

  it('keeps a closed registration closed when path-based reopen fails', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    await service.closeProject(project.id)
    const recentBefore = (await service.listRecentProjects())[0]!
    runner.listWorktreesFails = true

    await expect(service.registerProject(main)).rejects.toThrow(
      'repository unavailable'
    )
    await expect(
      persistedProjectOpen(service.database, project.id)
    ).resolves.toBe(false)
    expect(await service.listRecentProjects()).toEqual([recentBefore])
    expect(await service.listProjects()).toEqual([])
  })

  it('rejects closed mutations and manages an unavailable registration through deletion', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    await service.closeProject(project.id)

    await expect(service.resolveProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_CLOSED'
    })
    await expect(
      service.createWorktree(project.id, 'closed', 'default')
    ).rejects.toMatchObject({ code: 'PROJECT_CLOSED' })
    await expect(
      service.createTerminal(mainWorktree.id, 'Closed', ['pi'])
    ).rejects.toMatchObject({ code: 'PROJECT_CLOSED' })
    await expect(
      service.updateProjectColor(project.id, 'violet')
    ).rejects.toMatchObject({ code: 'PROJECT_CLOSED' })

    runner.listWorktreesFails = true
    const reopened = await service.openProject(project.id)
    expect(reopened.availability.state).toBe('unavailable')
    await expect(
      persistedProjectOpen(service.database, project.id)
    ).resolves.toBe(true)

    runner.calls.length = 0
    await service.closeProject(project.id)
    await expect(
      persistedProjectOpen(service.database, project.id)
    ).resolves.toBe(false)
    expect(
      runner.calls.some(
        (call) => call.args[0] === 'worktree' && call.args[1] === 'list'
      )
    ).toBe(false)

    runner.listWorktreesFails = false
    await service.deleteProject(project.id)
    expect(await persistedProject(service.database, project.id)).toBeNull()
    expect(await service.listRecentProjects()).toEqual([])
  })

  it('refuses main and locked worktrees', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    expect(
      (await service.removePreview(project.worktrees[0]!.id)).eligible
    ).toBe(false)
    const linked = (
      await service.createWorktree(project.id, 'locked', 'default')
    ).worktree
    runner.worktrees.find((item) => item.path === linked.path)!.locked = true
    await service.refreshProject(project.id)
    const preview = await service.removePreview(linked.id)
    expect(preview.eligible).toBe(false)
    expect(preview.reasons.join(' ')).toMatch(/locked/i)
  })
})
