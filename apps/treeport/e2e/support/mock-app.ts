import type { Page } from '@playwright/test'
import type { TerminalRuntimeMetadata } from '@treeport/shared'
import { installDesktopBridge, installKeyboardPlatform } from './desktop'
import { createPanelMock } from './panels'
import { createPresetMock } from './presets'
import { createProjectMock } from './projects'
import { installMockSockets } from './sockets'
import { createTerminalMock } from './terminals'
import type { MockAppOptions } from './types'
import { createUpdateMock } from './updates'
import { createWorktreeMock } from './worktrees'

export async function mockApp(
  page: Page,
  initialTerminalMetadata: TerminalRuntimeMetadata[] = [],
  options: MockAppOptions = {}
) {
  if (options.keyboardPlatform) {
    await installKeyboardPlatform(page, options.keyboardPlatform)
  }

  if (options.desktopBridge) {
    await installDesktopBridge(page, options.desktopFilePaths ?? {})
  }

  await installMockSockets(page, initialTerminalMetadata, options)

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    await route.fulfill({
      status: 501,
      json: {
        error: {
          code: 'UNHANDLED_E2E_API',
          message: `${route.request().method()} ${pathname}`
        }
      }
    })
  })

  await page.route('**/api/presence', (route) =>
    route.fulfill({
      json: {
        identity: {
          source: 'local',
          login: null,
          name: null,
          profilePicture: null
        }
      }
    })
  )

  const { state, ...projects } = await createProjectMock(page, options)
  const updates = await createUpdateMock(page, options)
  const presets = await createPresetMock(page, options)
  const worktrees = await createWorktreeMock(page, state)
  const terminals = await createTerminalMock(page, state)
  const panels = await createPanelMock(page, state, options)

  await page.goto(options.initialPath ?? '/')
  return {
    ...projects,
    ...updates,
    ...presets,
    ...worktrees,
    ...terminals,
    ...panels
  }
}
