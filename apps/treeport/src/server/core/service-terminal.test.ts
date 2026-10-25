import fs from 'node:fs/promises'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'
import { fixture } from './service.integration-fixture'
import { MutationLocks } from './services/infrastructure/mutation-locks'

describe('terminal operations', () => {
  it('publishes command completion without exiting or closing the fallback session', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const tree = project.worktrees[0]!
    const terminal = await service.createTerminal(tree.id, 'Command')
    const hosted = runner.sessions.get(`${tree.id}/${terminal.id}`)!
    hosted.closeOnSuccess = true
    const updates: string[] = []
    service.events.subscribe((event) => {
      if (event.type === 'terminal.updated') {
        updates.push(event.data.terminalId)
      }
    })
    hosted.commandExitCode = 0
    expect(
      await service.refreshTerminalStatus(terminal.id, false)
    ).toMatchObject({
      status: 'running',
      exitCode: null,
      commandExitCode: 0
    })
    expect(updates).toContain(terminal.id)
    expect(hosted.alive).toBe(true)
    expect(await service.getTerminal(terminal.id)).toMatchObject({
      status: 'running',
      commandExitCode: 0
    })
    hosted.alive = false
    hosted.exitCode = 3
    expect(
      await service.refreshTerminalStatus(terminal.id, false)
    ).toMatchObject({
      status: 'exited',
      exitCode: 3,
      commandExitCode: 0
    })
  })

  it('keeps terminals and accepted tree creation running across project visibility changes', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const mainTree = project.worktrees[0]!

    const linkedTree = (
      await service.createWorktree(project.id, 'existing-tree', 'default')
    ).worktree

    const sessionsBefore = [...runner.sessions.keys()]
    let releaseCreation!: () => void
    runner.worktreeAddGate = new Promise<void>((resolve) => {
      releaseCreation = resolve
    })

    const operation = await service.beginCreateWorktree(
      project.id,
      'blocking-tree',
      'default'
    )

    try {
      await vi.waitFor(async () => {
        expect(
          await service.runEffect(
            Effect.flatMap(MutationLocks, (locks) =>
              locks.isProjectLocked(project.id)
            )
          )
        ).toBe(true)
      })

      for (const tree of [mainTree, linkedTree]) {
        await expect(
          service.createTerminal(tree.id, 'During creation')
        ).resolves.toMatchObject({
          worktreeId: tree.id,
          name: 'During creation'
        })
      }

      expect((await service.getOperation(operation.id)).status).toBe('running')
      expect([...runner.sessions.keys()]).toEqual(
        expect.arrayContaining(sessionsBefore)
      )
      await expect(
        service.updateProjectColor(project.id, 'blue')
      ).resolves.toMatchObject({ color: 'blue' })
      await service.closeProject(project.id)
      expect(await service.listProjects()).toEqual([])
      await service.openProject(project.id)
      await service.beginCreateWorktree(project.id, 'queued-tree', 'default')
      await service.closeProject(project.id)
    } finally {
      releaseCreation()
    }

    await vi.waitFor(async () =>
      expect((await service.getOperation(operation.id)).status).toBe(
        'completed'
      )
    )
    await vi.waitFor(async () => {
      const operations = await service.listActiveOperations()
      expect(operations).toEqual([])
    })
    expect(await service.listProjects()).toEqual([])
    const reopened = await service.openProject(project.id)
    expect(reopened.worktrees.map((tree) => tree.name)).toEqual(
      expect.arrayContaining(['blocking-tree', 'queued-tree'])
    )

    for (const name of ['blocking-tree', 'queued-tree']) {
      const tree = reopened.worktrees.find((tree) => tree.name === name)!
      expect(
        tree.terminals.some((terminal) => terminal.name === 'Terminal')
      ).toBe(true)
    }

    await expect(
      service.createTerminal(mainTree.id, 'After creation')
    ).resolves.toMatchObject({ name: 'After creation' })
  })

  it.each(['project mutation', 'target tree'] as const)(
    'rejects terminal creation during a %s lock',
    async (kind) => {
      const { main, runner, service } = await fixture()
      const project = await service.registerProject(main)
      const tree = project.worktrees[0]!
      const attempts = runner.terminalCreateAttempts

      const request =
        kind === 'project mutation'
          ? { projectId: project.id }
          : { worktreeIds: [tree.id] }

      await service.runEffect(
        Effect.flatMap(MutationLocks, (locks) => locks.acquire(request))
      )

      try {
        await expect(
          service.createTerminal(tree.id, 'Blocked')
        ).rejects.toMatchObject({
          code: 'WORKTREE_BUSY'
        })
        expect(runner.terminalCreateAttempts).toBe(attempts)
      } finally {
        await service.runEffect(
          Effect.flatMap(MutationLocks, (locks) => locks.release(request))
        )
      }

      await expect(
        service.createTerminal(tree.id, 'Allowed')
      ).resolves.toMatchObject({
        name: 'Allowed'
      })
    }
  )

  it('allows project closure during a terminal launch but protects against deletion', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const tree = project.worktrees[0]!
    const attempts = runner.terminalCreateAttempts
    let releaseLaunch!: () => void
    runner.terminalCreateGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve
    })
    const launch = service.createTerminal(tree.id, 'Launching')

    try {
      await vi.waitFor(() =>
        expect(runner.terminalCreateAttempts).toBe(attempts + 1)
      )
      await expect(service.closeProject(project.id)).resolves.toBeUndefined()
      expect(await service.listProjects()).toEqual([])
      await expect(service.deleteProject(project.id)).rejects.toMatchObject({
        code: 'PROJECT_BUSY'
      })
    } finally {
      releaseLaunch()
    }

    await expect(launch).resolves.toMatchObject({ name: 'Launching' })
    await service.closeProject(project.id)
    await expect(
      service.createTerminal(tree.id, 'Closed')
    ).rejects.toMatchObject({
      code: 'PROJECT_CLOSED'
    })
  })

  it('keeps the requested terminal and setup when a snapshot observes a new tree', async () => {
    const { main, runner, service } = await fixture()
    const run = runner.run.bind(runner)
    vi.spyOn(runner, 'run').mockImplementation(async (request) => {
      const result = await run(request)

      if (request.args[0] === 'worktree' && request.args[1] === 'add') {
        // Simulate committed settings appearing during checkout, not a main
        // checkout's uncommitted configuration being copied into the new tree.
        const worktreePath = request.args.at(-2)!
        await fs.mkdir(path.join(worktreePath, '.treeport'))
        await fs.writeFile(
          path.join(worktreePath, '.treeport', 'settings.json'),
          JSON.stringify({
            setup: {
              commands: [{ name: 'Initialize', argv: ['initialize-tree'] }]
            }
          })
        )
      }

      return result
    })
    const project = await service.registerProject(main)
    const mainTree = project.worktrees[0]!
    await service.createTerminal(mainTree.id, 'Shell')
    const initialAttempts = runner.terminalCreateAttempts
    let releaseLaunch!: () => void
    runner.terminalCreateGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve
    })
    let snapshot: Promise<unknown> | null = null
    let reservedTreeId: string | null = null

    const unsubscribe = service.events.subscribe((event) => {
      if (event.type === 'worktree.created') {
        reservedTreeId = event.data.worktreeId
        snapshot = service.getProjectSnapshot(project.id)
      }
    })

    try {
      const operation = await service.beginCreateWorktree(
        project.id,
        'snapshot-race',
        'default',
        { name: 'pi', argv: ['pi'] }
      )

      await vi.waitFor(() => expect(snapshot).not.toBeNull())
      // The creation event precedes the terminal host call; wait for launch
      // to reach the gate before checking the concurrent snapshot.
      await vi.waitFor(() =>
        expect(runner.terminalCreateAttempts).toBe(initialAttempts + 1)
      )
      // A snapshot must not take the tree lock or launch another terminal
      // while the requested terminal is still starting.
      await expect(snapshot).resolves.toBeDefined()
      expect(reservedTreeId).not.toBeNull()
      await expect(
        service.createTerminal(reservedTreeId!, 'Cannot steal first launch')
      ).rejects.toMatchObject({ code: 'WORKTREE_BUSY' })
      expect(runner.terminalCreateAttempts).toBe(initialAttempts + 1)
      releaseLaunch()
      await vi.waitFor(async () => {
        expect((await service.getOperation(operation.id)).status).toBe(
          'completed'
        )
      })
      const completed = await service.getOperation(operation.id)
      expect(completed.result).toMatchObject({
        terminalError: null,
        setupError: null,
        terminalId: expect.any(String)
      })

      const inputs = [...runner.terminalCreateInputs.values()].filter(
        (input) => input.worktreeId === completed.worktreeId
      )

      expect(inputs.map((input) => input.name)).toEqual(['pi', 'Setup'])
      expect(inputs[1]?.setupTasks).toHaveLength(1)
    } finally {
      releaseLaunch()
      unsubscribe()
    }
  })

  it('creates and closes terminals without waiting for another close inventory refresh', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    const closingTerminal = await service.createTerminal(worktree.id, 'Closing')
    const anotherTerminal = await service.createTerminal(worktree.id, 'Another')
    let releaseInventory!: () => void
    runner.terminalInventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve
    })

    const inventoryAttempts = runner.terminalInventoryAttempts
    const closing = service.deleteTerminal(closingTerminal.id)
    const anotherClosing = service.deleteTerminal(anotherTerminal.id)
    await vi.waitFor(() =>
      expect(runner.terminalInventoryAttempts).toBe(inventoryAttempts + 2)
    )

    try {
      await expect(
        service.createTerminal(worktree.id, 'Replacement')
      ).resolves.toMatchObject({ name: 'Replacement' })
    } finally {
      releaseInventory()
    }

    await Promise.all([closing, anotherClosing])

    const remaining = (await service.getWorktreeSnapshot(worktree.id)).terminals
    await Promise.all(
      remaining.map((terminal) => service.deleteTerminal(terminal.id))
    )
    expect(
      (await service.getWorktreeSnapshot(worktree.id)).terminals
    ).toHaveLength(0)
  })

  it('allows terminal and project metadata changes while another tree is being removed', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)

    const blockingWorktree = (
      await service.createWorktree(project.id, 'blocking-cleanup', 'default')
    ).worktree

    await fs.mkdir(path.join(blockingWorktree.path, '.treeport'))
    await fs.writeFile(
      path.join(blockingWorktree.path, '.treeport', 'settings.json'),
      JSON.stringify({
        setup: {
          commands: [],
          cleanup: [
            {
              name: 'Hold cleanup',
              argv: ['hold-setup'],
              timeout: '1m'
            }
          ]
        }
      })
    )

    const targetWorktree = (
      await service.createWorktree(project.id, 'terminal-target', 'default')
    ).worktree

    const terminal = await service.createTerminal(targetWorktree.id, 'Extra')

    let releaseCleanup!: () => void
    runner.setupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    let releaseGitRemoval!: () => void
    runner.removeAfterDeregisterGates.set(
      blockingWorktree.path,
      new Promise<void>((resolve) => {
        releaseGitRemoval = resolve
      })
    )
    const preview = await service.removePreview(blockingWorktree.id)

    const removal = await service.beginRemove(blockingWorktree.id, {
      confirmationToken: preview.confirmationToken,
      confirmDestructive: preview.warnings.length > 0
    })

    try {
      await vi.waitFor(async () => {
        const operation = await service.getOperation(removal.id)
        expect(operation.kind).toBe('remove')

        if (operation.kind === 'remove') {
          expect(operation.request.cleanupCommands.status).toBe('running')
        }
      })
      await expect(service.deleteTerminal(terminal.id)).resolves.toBeUndefined()

      for (const phase of ['cleanup', 'git']) {
        if (phase === 'git') {
          releaseCleanup()
          await vi.waitFor(() =>
            expect(
              runner.worktrees.some(
                (tree) => tree.path === blockingWorktree.path
              )
            ).toBe(false)
          )
        }

        await expect(
          service.updateProjectColor(project.id, 'blue')
        ).resolves.toMatchObject({ color: 'blue' })
        await service.closeProject(project.id)
        expect(await service.listProjects()).toEqual([])
        expect(await service.listRecentProjects()).toEqual([
          expect.objectContaining({ id: project.id })
        ])
        await service.dismissRecentProject(project.id)
        expect(await service.listRecentProjects()).toEqual([])
        await service.openProject(project.id)
        await expect(service.deleteProject(project.id)).rejects.toMatchObject({
          code: 'PROJECT_BUSY'
        })
        expect((await service.getOperation(removal.id)).status).toBe('running')
      }

      await service.closeProject(project.id)
    } finally {
      releaseCleanup()
      releaseGitRemoval()
    }

    await vi.waitFor(async () =>
      expect((await service.getOperation(removal.id)).status).toBe('completed')
    )
    expect(await service.listProjects()).toEqual([])
    const reopened = await service.openProject(project.id)
    expect(
      reopened.worktrees.some((tree) => tree.id === blockingWorktree.id)
    ).toBe(false)
  })
})
