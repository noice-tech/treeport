import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fixture } from './service.integration-fixture'

describe('terminal operations', () => {
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
        version: 1,
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
