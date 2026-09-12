import fs from 'node:fs/promises'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'
import { SpawnCommandRunner } from './command'
import { fixture } from './service.integration-fixture'
import { CommandPort } from './services/infrastructure/ports'

describe('tree cleanup completion', () => {
  it.each([0, 1])(
    'releases the project queue after a real cleanup command exits %i',
    async (exitCode) => {
      const { main, service } = await fixture()
      await fs.mkdir(path.join(main, '.treeport'))
      await fs.writeFile(
        path.join(main, '.treeport', 'setup.json'),
        JSON.stringify({
          version: 1,
          commands: [],
          cleanup: [
            {
              name: 'Cleanup',
              argv: [
                process.execPath,
                '-e',
                `process.stderr.write('cleanup diagnostic'); process.exitCode = ${exitCode}`
              ],
              timeout: '1s'
            }
          ]
        })
      )
      const project = await service.registerProject(main)
      const { worktree } = await service.createWorktree(
        project.id,
        'cleanup-target',
        'default'
      )
      const preview = await service.removePreview(worktree.id)
      // The normal fixture runner bridges through Promise APIs, which resets
      // Effect interruption state and hides masked cleanup-command deadlocks.
      const removal = await service.runEffect(
        service.worktrees
          .beginRemove(worktree.id, {
            confirmationToken: preview.confirmationToken,
            confirmDestructive: preview.warnings.length > 0
          })
          .pipe(Effect.provideService(CommandPort, new SpawnCommandRunner()))
      )
      await vi.waitFor(
        async () => {
          expect((await service.getOperation(removal.id)).status).toBe(
            exitCode === 0 ? 'completed' : 'failed'
          )
        },
        { timeout: 3_000 }
      )

      if (exitCode !== 0) {
        expect(await service.getOperation(removal.id)).toMatchObject({
          error: expect.stringContaining(
            'cleanup diagnostic. Git kept the tree.'
          ),
          request: {
            cleanupCommands: {
              status: 'failed',
              commands: [
                expect.objectContaining({ exitCode, status: 'failed' })
              ]
            }
          }
        })
        await expect(fs.stat(worktree.path)).resolves.toBeDefined()
      }

      const creation = await service.beginCreateWorktree(
        project.id,
        'after-cleanup',
        'default'
      )
      await vi.waitFor(async () => {
        expect((await service.getOperation(creation.id)).status).toBe(
          'completed'
        )
      })

      if (exitCode !== 0) {
        // A failed cleanup must release the tree lock too, allowing an
        // explicitly confirmed retry without rerunning the failed hook.
        const retryPreview = await service.removePreview(worktree.id)
        const retry = await service.beginRemove(worktree.id, {
          confirmationToken: retryPreview.confirmationToken,
          confirmDestructive: true,
          skipCleanup: true
        })
        await vi.waitFor(async () => {
          expect((await service.getOperation(retry.id)).status).toBe(
            'completed'
          )
        })
      }
    }
  )
})
