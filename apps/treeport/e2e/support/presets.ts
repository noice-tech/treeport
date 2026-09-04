import type { Page } from '@playwright/test'
import type { TerminalPreset } from '@treeport/shared'
import type { MockAppOptions } from './types'

export async function createPresetMock(page: Page, options: MockAppOptions) {
  const repositoryTerminalPresets = [
    ...(options.repositoryTerminalPresets ?? [])
  ]
  const repositoryPresetDiagnostics = [
    ...(options.repositoryPresetDiagnostics ?? [])
  ]
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
    const url = new URL(route.request().url())
    const pathname = url.pathname
    if (
      pathname === '/api/tree-context-fields' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({
        json: { fields: options.treeContextFields ?? [], diagnostics: [] }
      })
      return
    }

    if (
      pathname === '/api/terminal-preset-definitions' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({
        json: {
          definitions: [
            ...(url.searchParams.has('worktreeId') &&
            !url.searchParams.get('worktreeId')?.startsWith('second_')
              ? repositoryTerminalPresets
              : []),
            ...terminalPresets.map((preset) => ({
              id: preset.id,
              name: preset.name,
              executable: preset.executable,
              args: preset.args,
              shellCommand: null,
              cwd: null,
              env: {},
              closeOnSuccess: preset.closeOnSuccess,
              source: { type: 'user' as const }
            }))
          ],
          diagnostics:
            url.searchParams.has('worktreeId') &&
            !url.searchParams.get('worktreeId')?.startsWith('second_')
              ? repositoryPresetDiagnostics
              : []
        }
      })
      return
    }

    if (
      pathname === '/api/terminal-presets' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { presets: terminalPresets } })
      return
    }

    if (
      pathname === '/api/terminal-presets' &&
      route.request().method() === 'POST'
    ) {
      const body: Pick<
        TerminalPreset,
        'name' | 'executable' | 'args' | 'closeOnSuccess'
      > = route.request().postDataJSON()
      const preset: TerminalPreset = {
        id: `preset_${terminalPresets.length + 1}`,
        ...body,
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
      terminalPresets.push(preset)
      await route.fulfill({ status: 201, json: { preset } })
      return
    }

    if (
      pathname.startsWith('/api/terminal-presets/') &&
      route.request().method() === 'PATCH'
    ) {
      const presetId = pathname.split('/').at(-1)!
      const body: Pick<
        TerminalPreset,
        'name' | 'executable' | 'args' | 'closeOnSuccess'
      > & { expectedUpdatedAt: string } = route.request().postDataJSON()
      const { expectedUpdatedAt, ...input } = body
      const index = terminalPresets.findIndex(
        (preset) => preset.id === presetId
      )
      if (index < 0) {
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: 'TERMINAL_PRESET_NOT_FOUND',
              message: 'Terminal preset not found'
            }
          }
        })
        return
      }

      if (terminalPresets[index]!.updatedAt !== expectedUpdatedAt) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'TERMINAL_PRESET_CHANGED',
              message: 'Terminal preset changed'
            }
          }
        })
        return
      }

      const preset: TerminalPreset = {
        ...terminalPresets[index]!,
        ...input,
        updatedAt: '2026-01-03T00:00:00.000Z'
      }
      terminalPresets[index] = preset
      await route.fulfill({ json: { preset } })
      return
    }

    if (
      pathname.startsWith('/api/terminal-presets/') &&
      route.request().method() === 'DELETE'
    ) {
      const presetId = pathname.split('/').at(-1)!
      const body: { expectedUpdatedAt: string } = route.request().postDataJSON()
      const index = terminalPresets.findIndex(
        (preset) => preset.id === presetId
      )
      if (index < 0) {
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: 'TERMINAL_PRESET_NOT_FOUND',
              message: 'Terminal preset not found'
            }
          }
        })
        return
      }

      if (terminalPresets[index]!.updatedAt !== body.expectedUpdatedAt) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'TERMINAL_PRESET_CHANGED',
              message: 'Terminal preset changed'
            }
          }
        })
        return
      }

      terminalPresets.splice(index, 1)
      await route.fulfill({ json: { ok: true } })
      return
    }

    await route.fallback()
  })

  return {
    terminalPresets,
    repositoryTerminalPresets,
    repositoryPresetDiagnostics
  }
}
