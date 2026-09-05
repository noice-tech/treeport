import path from 'node:path'
import type { Page } from '@playwright/test'
import type { ProjectRecord, WebPanelDefinition } from '@treeport/shared'
import { buildPanel } from './panel-build'
import type { MockAppOptions } from './types'

export async function createPanelMock(
  page: Page,
  state: ProjectRecord,
  options: MockAppOptions
) {
  const filesPanelBuild = options.realFilesPanel
    ? await buildPanel(
        path.resolve(
          process.cwd(),
          'packages/web-panel-files/web-panels/files'
        ),
        'files.tsx'
      )
    : null
  const webPanelDefinitions: WebPanelDefinition[] = options.realFilesPanel
    ? [
        {
          id: 'package:files:web-panel:files',
          title: 'Files',
          icon: null,
          source: {
            type: 'package',
            packageId: 'local:files',
            source: 'packages/web-panel-files',
            scope: 'global'
          },
          permissions: ['tree-files'],
          permissionsGranted: false,
          sandbox: { allowSameOrigin: false }
        }
      ]
    : []
  let treeFileRevision = 1
  const treeFiles = new Map([
    [
      'src/app.ts',
      { content: 'export const value = 1\n', revision: 'revision-1' }
    ],
    ['README.md', { content: '# Example\n', revision: 'revision-readme' }]
  ])
  const treeFileWrites: Array<{
    path: string
    content: string
    expectedRevision: string
  }> = []

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    const method = route.request().method()
    const panelAssetMatch = /^\/api\/web-panels\/[^/]+\/assets\/(.*)$/.exec(
      pathname
    )
    if (panelAssetMatch && method === 'GET' && filesPanelBuild) {
      if (!panelAssetMatch[1]) {
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="UTF-8"><style>${filesPanelBuild.css}</style></head><body>
            <div id="root"></div>
            <script type="module">${filesPanelBuild.script.replaceAll('</script', '<\\/script')}</script>
          </body></html>`
        })
        return
      }

      const asset =
        filesPanelBuild.assets.get(panelAssetMatch[1]) ??
        filesPanelBuild.assets.get(`assets/${panelAssetMatch[1]}`)
      if (asset) {
        await route.fulfill(asset)
        return
      }
    }

    if (/^\/api\/panels\/[^/]+\/files$/.test(pathname) && method === 'GET') {
      await route.fulfill({
        json: { paths: [...treeFiles.keys()].sort(), truncated: false }
      })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/files\/read$/.test(pathname) &&
      method === 'POST'
    ) {
      const body: { path: string } = route.request().postDataJSON()
      const file = treeFiles.get(body.path)
      if (!file) {
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: 'TREE_FILE_NOT_FOUND',
              message: 'The selected file does not exist'
            }
          }
        })
        return
      }

      await route.fulfill({ json: { path: body.path, ...file } })
      return
    }

    if (/^\/api\/panels\/[^/]+\/files$/.test(pathname) && method === 'PUT') {
      const body: { path: string; content: string; expectedRevision: string } =
        route.request().postDataJSON()
      treeFileWrites.push(body)
      const file = treeFiles.get(body.path)
      if (!file || file.revision !== body.expectedRevision) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'TREE_FILE_CHANGED',
              message:
                'The file changed after it was opened. Reload it before saving.'
            }
          }
        })
        return
      }

      const revision = `revision-${++treeFileRevision}`
      treeFiles.set(body.path, { content: body.content, revision })
      await route.fulfill({ json: { path: body.path, revision } })
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/web-panel-definitions$/.test(pathname) &&
      method === 'GET'
    ) {
      await route.fulfill({ json: { definitions: webPanelDefinitions } })
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/web-panel-definitions\/[^/]+\/permission-grant$/.test(
        pathname
      ) &&
      method === 'PUT'
    ) {
      const definitionId = decodeURIComponent(pathname.split('/')[5]!)
      const definition = webPanelDefinitions.find(
        (candidate) => candidate.id === definitionId
      )!
      definition.permissionsGranted = true
      await route.fulfill({ json: { definition } })
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/panels\/open$/.test(pathname) &&
      method === 'POST'
    ) {
      const worktreeId = pathname.split('/')[3]!
      const body: { definitionId: string } = route.request().postDataJSON()
      const worktree = state.worktrees.find(
        (candidate) => candidate.id === worktreeId
      )!
      const definition = webPanelDefinitions.find(
        (candidate) => candidate.id === body.definitionId
      )!
      const panel = {
        id: 'panel_1',
        kind: 'web' as const,
        worktreeId,
        definitionId: definition.id,
        title: definition.title,
        launch: { input: null, cwd: null },
        permissions: definition.permissions,
        sandbox: definition.sandbox,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      worktree.panels.push(panel)
      await route.fulfill({ json: { panel, created: true, reused: false } })
      return
    }

    if (/^\/api\/panels\/[^/]+\/context$/.test(pathname) && method === 'GET') {
      const panelId = pathname.split('/')[3]!
      const worktree = state.worktrees.find((candidate) =>
        candidate.panels.some((panel) => panel.id === panelId)
      )!
      const panel = worktree.panels.find(
        (candidate) => candidate.id === panelId && candidate.kind === 'web'
      )!
      await route.fulfill({
        json: {
          context: {
            apiVersion: 1,
            panel,
            launch: panel.launch,
            project: {
              id: state.id,
              name: state.name,
              kind: state.kind,
              defaultBranch: state.defaultBranch
            },
            worktree: {
              id: worktree.id,
              name: worktree.name,
              kind: worktree.kind,
              branch: worktree.branch,
              head: worktree.head
            }
          }
        }
      })
      return
    }

    if (/^\/api\/panels\/[^/]+\/storage$/.test(pathname) && method === 'GET') {
      await route.fulfill({ json: { hasData: false } })
      return
    }

    if (/^\/api\/panels\/[^/]+$/.test(pathname) && method === 'DELETE') {
      const panelId = pathname.split('/').at(-1)
      for (const worktree of state.worktrees) {
        worktree.panels = worktree.panels.filter(
          (panel) => panel.id !== panelId
        )
      }
      await route.fulfill({ json: { ok: true } })
      return
    }

    await route.fallback()
  })

  return {
    getTreeFile: (filePath: string) => treeFiles.get(filePath),
    setTreeFile: (filePath: string, content: string) => {
      treeFiles.set(filePath, {
        content,
        revision: `revision-${++treeFileRevision}`
      })
    },
    treeFileWrites: () => [...treeFileWrites]
  }
}
