import type { Page } from '@playwright/test'
import type { TerminalPreset } from '@treeport/shared'
import type { MockAppOptions } from './types'

export async function createPresetMock(page: Page, options: MockAppOptions) {
  const terminalPresets: TerminalPreset[] = [
    {
      id: 'preset_hunk',
      name: 'Hunk',
      executable: 'npx',
      args: ['--yes', 'hunkdiff@0.17.3', 'diff', 'HEAD', '--watch'],
      closeOnSuccess: false,
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

    if (pathname === '/api/tree-context-fields') {
      await route.fulfill({
        json: { fields: options.treeContextFields ?? [], diagnostics: [] }
      })
      return
    }

    if (pathname === '/api/terminal-preset-definitions') {
      await route.fulfill({
        json: {
          definitions: terminalPresets.map((preset) => ({
            id: preset.id,
            name: preset.name,
            executable: preset.executable,
            args: preset.args,
            shellCommand: null,
            cwd: null,
            env: {},
            closeOnSuccess: preset.closeOnSuccess,
            source: { type: 'user' }
          })),
          diagnostics: []
        }
      })
      return
    }

    if (pathname === '/api/terminal-presets') {
      await route.fulfill({ json: { presets: terminalPresets } })
      return
    }

    await route.fallback()
  })
}
