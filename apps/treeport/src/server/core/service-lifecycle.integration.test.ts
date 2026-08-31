import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProductEvent } from '@treeport/shared'
import { sql } from 'drizzle-orm'
import {
  beginFromPreview,
  fixture,
  persistedProject,
  persistedProjectOpen,
  waitForOperation
} from './service.integration-fixture'

describe('TreeportService with injected command adapters', () => {
  it('owns Browser through creation, restoration state, open requests, authorization, and deletion', async () => {
    const { main, service } = await fixture()
    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    const terminal = await service.createTerminal(worktree.id, 'Links', ['sh'])
    const events: ProductEvent[] = []
    const unsubscribe = service.events.subscribe((event) => events.push(event))

    const opened = await service.openBrowserPanel(
      worktree.id,
      'https://example.com/initial',
      terminal.id
    )
    expect(opened.panel).toMatchObject({
      kind: 'browser',
      worktreeId: worktree.id,
      title: 'example.com',
      url: 'https://example.com/initial'
    })
    await expect(
      service.authorizeBrowserPanel(opened.panel.id)
    ).resolves.toMatchObject({
      panel: { id: opened.panel.id, kind: 'browser' },
      worktreePath: worktree.path
    })

    const updated = await service.updateBrowserPanelState(opened.panel.id, {
      url: 'https://example.com/restored',
      title: 'Restored application'
    })
    expect(updated).toMatchObject({
      title: 'Restored application',
      url: 'https://example.com/restored'
    })
    expect(
      (await service.getWorktreeSnapshot(worktree.id)).panels.find(
        (panel) => panel.id === opened.panel.id
      )
    ).toMatchObject({
      kind: 'browser',
      title: 'Restored application',
      url: 'https://example.com/restored'
    })

    const terminalOpened = await service.openBrowserPanelFromTerminal(
      terminal.id,
      'http://localhost:4173/'
    )
    const popupOpened = await service.openBrowserPanelFromPanel(
      opened.panel.id,
      'https://example.com/popup'
    )
    expect(terminalOpened.panel.id).not.toBe(opened.panel.id)
    expect(popupOpened.panel.id).not.toBe(opened.panel.id)
    expect(
      events.filter((event) => event.type === 'panel.open_requested')
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            panelId: terminalOpened.panel.id,
            sourceTerminalId: terminal.id,
            sourcePanelId: null
          })
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            panelId: popupOpened.panel.id,
            sourceTerminalId: null,
            sourcePanelId: opened.panel.id
          })
        })
      ])
    )

    for (const invalidUrl of [
      'file:///tmp/private',
      'https://user:secret@example.com/'
    ]) {
      await expect(
        service.openBrowserPanel(worktree.id, invalidUrl)
      ).rejects.toMatchObject({ code: 'INVALID_BROWSER_URL' })
    }
    await service.deletePanel(opened.panel.id)
    await expect(
      service.getBrowserPanel(opened.panel.id)
    ).rejects.toMatchObject({ code: 'PANEL_NOT_FOUND' })
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'panel.created',
        'panel.updated',
        'panel.open_requested',
        'panel.removed'
      ])
    )
    unsubscribe()
  })

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
    runner.terminalCreateGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve
    })
    const createAttempts = runner.terminalCreateAttempts
    const creatingTerminal = service.createTerminal(
      mainWorktree.id,
      'Concurrent',
      ['pi']
    )
    await vi.waitFor(() =>
      expect(runner.terminalCreateAttempts).toBe(createAttempts + 1)
    )
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_BUSY'
    })
    releaseTerminal()
    await creatingTerminal
    runner.terminalCreateGate = null
    await expect(service.deleteProject(project.id)).resolves.toBeUndefined()
  })

  it('preserves project terminals while closed and reconnects when reopening', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainWorktree = project.worktrees[0]!
    await service.createTerminal(mainWorktree.id, 'Main terminal', ['pi'])
    const linked = (
      await service.createWorktree(project.id, 'close-all', 'default', {
        name: 'Linked terminal',
        argv: ['pi']
      })
    ).worktree
    const terminalIds = (
      await service.getProjectSnapshot(project.id)
    ).worktrees.flatMap((worktree) =>
      worktree.terminals.map((terminal) => terminal.id)
    )
    expect(terminalIds).toHaveLength(3)
    await expect(
      service.dismissRecentProject(project.id)
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_RECENT' })

    runner.terminalKillWorktreeFails = true
    await service.closeProject(project.id)

    expect(await service.listProjects()).toEqual([])
    expect(await service.listRecentProjects()).toEqual([
      expect.objectContaining({
        id: project.id,
        repositoryPath: project.repositoryPath
      })
    ])
    expect(runner.sessions.size).toBe(3)
    expect(
      (await persistedProject(service.database, project.id))?.worktrees.map(
        ({ id }) => id
      )
    ).toEqual(expect.arrayContaining([mainWorktree.id, linked.id]))

    await service.dismissRecentProject(project.id)
    expect(await service.listRecentProjects()).toEqual([])
    expect(runner.sessions.size).toBe(3)

    const reopened = await service.openProject(project.id)
    expect(reopened.id).toBe(project.id)
    expect(reopened.worktrees.map(({ id }) => id)).toEqual(
      expect.arrayContaining([mainWorktree.id, linked.id])
    )
    const reopenedTerminalIds = reopened.worktrees.flatMap((worktree) =>
      worktree.terminals.map((terminal) => terminal.id)
    )
    expect(reopenedTerminalIds).toHaveLength(terminalIds.length)
    expect(reopenedTerminalIds).toEqual(expect.arrayContaining(terminalIds))
    expect(await service.listRecentProjects()).toEqual([])

    await service.closeProject(project.id)
    expect(await service.listRecentProjects()).toEqual([
      expect.objectContaining({ id: project.id })
    ])
    const pathReopened = await service.registerProject(main)
    expect(pathReopened.id).toBe(project.id)
    await expect(
      persistedProjectOpen(service.database, project.id)
    ).resolves.toBe(true)
    runner.terminalKillWorktreeFails = false
  })

  it('leaves terminals running when project closure cannot be persisted', async () => {
    const { main, service, database } = await fixture()
    const project = await service.registerProject(main)
    const terminal = await service.createTerminal(
      project.worktrees[0]!.id,
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
    const removed: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'terminal.removed') {
        removed.push(String(event.data.terminalId))
      }
    })

    await expect(service.closeProject(project.id)).rejects.toThrow()
    unsubscribe()
    await expect(persistedProjectOpen(database, project.id)).resolves.toBe(true)
    await expect(
      service.refreshTerminalStatus(terminal.id, false)
    ).resolves.toMatchObject({ id: terminal.id, status: 'running' })
    expect(removed).toEqual([])
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

  it('rejects an in-flight terminal poll without removing the closed terminal', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const terminal = await service.createTerminal(
      project.worktrees[0]!.id,
      'Polled terminal',
      ['pi']
    )
    let releasePoll!: () => void
    runner.calls.length = 0
    runner.terminalStateGate = new Promise<void>((resolve) => {
      releasePoll = resolve
    })
    const removed: string[] = []
    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'terminal.removed') {
        removed.push(String(event.data.terminalId))
      }
    })
    const stateAttempts = runner.terminalStateAttempts
    const polling = service.refreshTerminalStatus(terminal.id, false)
    await vi.waitFor(() =>
      expect(runner.terminalStateAttempts).toBe(stateAttempts + 1)
    )

    await service.closeProject(project.id)
    releasePoll()
    await expect(polling).rejects.toMatchObject({ code: 'PROJECT_CLOSED' })
    runner.terminalStateGate = null
    unsubscribe()
    expect(removed).toEqual([])
    expect(await service.listProjects()).toEqual([])
    expect(
      (await service.openProject(project.id)).worktrees.flatMap((worktree) =>
        worktree.terminals.map((candidate) => candidate.id)
      )
    ).toContain(terminal.id)
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
