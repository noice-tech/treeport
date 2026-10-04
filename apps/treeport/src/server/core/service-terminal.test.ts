import fs from 'node:fs/promises'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'
import { fixture } from './service.integration-fixture'
import { TerminalOperations } from './services/domain-services'
import { MutationLocks } from './services/infrastructure/mutation-locks'

describe('terminal operations', () => {
  it('creates terminals in existing trees while Git creates another tree', async () => {
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
    } finally {
      releaseCreation()
    }
    await vi.waitFor(async () =>
      expect((await service.getOperation(operation.id)).status).toBe(
        'completed'
      )
    )
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

  it('protects a terminal launch from project closure and deletion', async () => {
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
      await expect(service.closeProject(project.id)).rejects.toMatchObject({
        code: 'PROJECT_BUSY'
      })
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
    await fs.mkdir(path.join(main, '.treeport'))
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({
        commands: [{ name: 'Initialize', argv: ['initialize-tree'] }]
      })
    )
    const project = await service.registerProject(main)
    const mainTree = project.worktrees[0]!
    // Simulate a lost terminal host session while a project mutation is held.
    runner.sessions.delete(`${mainTree.id}/${mainTree.terminals[0]!.id}`)
    const attemptsBeforeEnsure = runner.terminalCreateAttempts
    await service.runEffect(
      Effect.gen(function* () {
        const locks = yield* MutationLocks
        const terminals = yield* TerminalOperations
        yield* Effect.acquireUseRelease(
          locks.acquire({ projectId: project.id }),
          () => terminals.ensureProjectTerminals(project.id),
          () => locks.release({ projectId: project.id })
        )
      })
    )
    expect(runner.terminalCreateAttempts).toBe(attemptsBeforeEnsure)
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
      // Snapshot auto-ensure must not take the tree lock or launch Shell,
      // even while the requested terminal is still starting.
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

  it('creates a terminal without waiting for a close inventory refresh', async () => {
    const { main, runner, service } = await fixture()
    const project = await service.registerProject(main)
    const worktree = project.worktrees[0]!
    const closingTerminal = await service.createTerminal(worktree.id, 'Closing')
    let releaseInventory!: () => void
    runner.terminalInventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve
    })

    const inventoryAttempts = runner.terminalInventoryAttempts
    const closing = service.deleteTerminal(closingTerminal.id)
    await vi.waitFor(() =>
      expect(runner.terminalInventoryAttempts).toBe(inventoryAttempts + 1)
    )
    try {
      await expect(
        service.createTerminal(worktree.id, 'Replacement')
      ).resolves.toMatchObject({ name: 'Replacement' })
    } finally {
      releaseInventory()
    }
    await closing
  })

  it('closes a terminal while another tree cleanup is running', async () => {
    const { main, runner, service } = await fixture()
    await fs.mkdir(path.join(main, '.treeport'))
    await fs.writeFile(
      path.join(main, '.treeport', 'setup.json'),
      JSON.stringify({
        commands: [],
        cleanup: [
          {
            name: 'Hold cleanup',
            argv: ['hold-setup'],
            timeout: '1m'
          }
        ]
      })
    )

    const project = await service.registerProject(main)
    const blockingWorktree = (
      await service.createWorktree(project.id, 'blocking-cleanup', 'default')
    ).worktree
    const targetWorktree = (
      await service.createWorktree(project.id, 'terminal-target', 'default')
    ).worktree
    const terminal = await service.createTerminal(targetWorktree.id, 'Extra')

    let releaseCleanup!: () => void
    runner.setupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
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
    } finally {
      releaseCleanup()
    }
    await vi.waitFor(async () =>
      expect((await service.getOperation(removal.id)).status).toBe('completed')
    )
  })
})
