import type { Page } from '@playwright/test'
import type { TerminalRuntimeMetadata } from '@treeport/shared'
import { installDesktopBridge, installKeyboardPlatform } from './desktop'
import { createAppMock } from './apps'
import { createPresetMock } from './presets'
import { createProjectMock } from './projects'
import { installMockSockets, type TerminalMock } from './sockets'
import { createTerminalMock } from './terminals'
import type { MockAppOptions } from './types'
import { createUpdateMock } from './updates'
import { createWorktreeMock } from './worktrees'

type MockApp = {
  terminal: TerminalMock
  emitProjectEvent: Awaited<
    ReturnType<typeof installMockSockets>
  >['emitProjectEvent']
} & Omit<Awaited<ReturnType<typeof createProjectMock>>, 'state'> &
  Awaited<ReturnType<typeof createUpdateMock>> &
  Awaited<ReturnType<typeof createWorktreeMock>> &
  Awaited<ReturnType<typeof createTerminalMock>>

export async function mockApp(
  page: Page,
  initialTerminalMetadata: TerminalRuntimeMetadata[] = [],
  options: MockAppOptions = {}
): Promise<MockApp> {
  if (options.keyboardPlatform) {
    await installKeyboardPlatform(page, options.keyboardPlatform)
  }

  if (options.desktopBridge) {
    await installDesktopBridge(page, options.desktopFilePaths ?? {})
  }

  const sockets = await installMockSockets(page, initialTerminalMetadata)

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
  await createPresetMock(page, options)
  const worktrees = await createWorktreeMock(page, state)
  const terminals = await createTerminalMock(page, state)
  await createAppMock(page)

  await page.goto(options.initialPath ?? '/')
  return {
    ...sockets,
    ...projects,
    ...updates,
    ...worktrees,
    ...terminals
  }
}
