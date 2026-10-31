import type { Page } from '@playwright/test'
import type { Launcher } from '#protocol/launcher'

export async function createLauncherMock(page: Page) {
  const launchers: Launcher[] = [
    {
      id: 'launcher_hunk',
      name: 'Hunk',
      executable: 'npx',
      args: ['--yes', 'hunkdiff@0.17.3', 'diff', 'HEAD', '--watch'],
      closeOnSuccess: false,
      treeTitle: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'launcher_pi',
      name: 'Pi',
      executable: 'pi',
      args: ['${prompt}'],
      closeOnSuccess: false,
      treeTitle: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ]

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname

    if (route.request().method() !== 'GET') {
      await route.fallback()

      return
    }

    if (pathname === '/api/launcher-definitions') {
      await route.fulfill({
        json: {
          definitions: launchers.map((launcher) => ({
            id: launcher.id,
            name: launcher.name,
            executable: launcher.executable,
            args: launcher.args,
            shellCommand: null,
            cwd: null,
            env: {},
            closeOnSuccess: launcher.closeOnSuccess,
            treeTitle: launcher.treeTitle,
            source: { type: 'user' }
          })),
          diagnostics: []
        }
      })

      return
    }

    if (pathname === '/api/launchers') {
      await route.fulfill({ json: { launchers: launchers } })

      return
    }

    await route.fallback()
  })
}
