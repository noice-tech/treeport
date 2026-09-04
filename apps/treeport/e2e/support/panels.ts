import path from 'node:path'
import type { Page } from '@playwright/test'
import type {
  JsonValue,
  ProjectRecord,
  WebPanelDefinition
} from '@treeport/shared'
import { buildPanel } from './panel-build'
import type { MockAppOptions } from './types'

export async function createPanelMock(
  page: Page,
  state: ProjectRecord,
  options: MockAppOptions
) {
  const reviewPanelBuild = options.realReviewPanel
    ? await buildPanel(
        path.resolve(
          process.cwd(),
          'packages/web-panel-review/web-panels/review'
        ),
        'review.tsx'
      )
    : null
  const filesPanelBuild = options.realFilesPanel
    ? await buildPanel(
        path.resolve(
          process.cwd(),
          'packages/web-panel-files/web-panels/files'
        ),
        'files.tsx'
      )
    : null

  let webPanelCreations = 0
  let browserPanelCreations = 0
  let browserInstallRequests = 0
  let browserInstallGate: Promise<void> | null = null
  let releaseBrowserInstall: (() => void) | null = null
  let webPanelHasStorage = false
  const webPanelStorage = new Map<string, Map<string, JsonValue>>()
  let treeFileRevision = 1
  const treeFiles = new Map([
    [
      'src/app.ts',
      {
        content: 'export const value = 1\n',
        revision: `revision-${treeFileRevision}`
      }
    ],
    ['README.md', { content: '# Example\n', revision: 'revision-readme' }]
  ])
  const treeFileWrites: Array<{
    path: string
    content: string
    expectedRevision: string
  }> = []
  const webPanelDefinitions: WebPanelDefinition[] = [
    {
      id: 'project:review',
      title: 'Review',
      icon: null,
      source: { type: 'project' as const },
      permissions: [],
      permissionsGranted: true,
      sandbox: { allowSameOrigin: false }
    },
    ...(options.realFilesPanel
      ? [
          {
            id: 'package:files:web-panel:files',
            title: 'Files',
            icon: null,
            source: {
              type: 'package' as const,
              packageId: 'local:files',
              source: 'packages/web-panel-files',
              scope: 'global' as const
            },
            permissions: ['tree-files' as const],
            permissionsGranted: false,
            sandbox: { allowSameOrigin: false }
          }
        ]
      : [])
  ]

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    const panelAssetMatch = /^\/api\/web-panels\/([^/]+)\/assets\/(.+)$/.exec(
      pathname
    )
    if (panelAssetMatch && route.request().method() === 'GET') {
      const panel = state.worktrees
        .flatMap((worktree) => worktree.panels)
        .find((candidate) => candidate.id === panelAssetMatch[1])
      const build =
        panel?.kind === 'web' && panel.definitionId === 'project:review'
          ? reviewPanelBuild
          : panel?.kind === 'web' &&
              panel.definitionId === 'package:files:web-panel:files'
            ? filesPanelBuild
            : null
      const asset =
        build?.assets.get(panelAssetMatch[2]!) ??
        build?.assets.get(`assets/${panelAssetMatch[2]!}`)
      if (asset) {
        await route.fulfill(asset)
        return
      }
    }

    if (
      /^\/api\/panels\/[^/]+\/files$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({
        json: { paths: [...treeFiles.keys()].sort(), truncated: false }
      })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/files\/search$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      const body: { query: string } = route.request().postDataJSON()
      const expression = new RegExp(
        body.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'iu'
      )
      const files: Array<{
        path: string
        matches: Array<{
          lineNumber: number
          column: number
          length: number
          preview: string
          previewStart: number
          lineLength: number
        }>
      }> = []
      for (const [filePath, file] of [...treeFiles.entries()].sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)
      )) {
        const matches = []
        const lines = file.content.split(/\r\n|\r|\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!
          const match = expression.exec(line)
          if (!match) {
            continue
          }

          matches.push({
            lineNumber: index + 1,
            column: match.index,
            length: match[0].length,
            preview: line,
            previewStart: 0,
            lineLength: line.length
          })
        }
        if (matches.length > 0) {
          files.push({ path: filePath, matches })
        }
      }

      await route.fulfill({ json: { files, truncated: false } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/files\/read$/.test(pathname) &&
      route.request().method() === 'POST'
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

      await route.fulfill({
        json: {
          path: body.path,
          content: file.content,
          revision: file.revision
        }
      })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/files$/.test(pathname) &&
      route.request().method() === 'PUT'
    ) {
      const body: {
        path: string
        content: string
        expectedRevision: string
      } = route.request().postDataJSON()
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

      treeFileRevision += 1
      const revision = `revision-${treeFileRevision}`
      treeFiles.set(body.path, { content: body.content, revision })
      await route.fulfill({ json: { path: body.path, revision } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/network\/listeners$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({
        json: {
          discovery: {
            supported: true,
            message: null,
            listeners: [
              {
                pid: 42,
                command: 'vite',
                host: '127.0.0.1',
                port: 5173,
                terminalId: 'term_topic'
              }
            ]
          }
        }
      })
      return
    }

    if (
      /^\/api\/web-panels\/[^/]+\/assets\/$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      const panelId = pathname.split('/')[3]!
      const panel = state.worktrees
        .flatMap((worktree) => worktree.panels)
        .find((candidate) => candidate.id === panelId)
      const build =
        panel?.kind === 'web' && panel.definitionId === 'project:review'
          ? reviewPanelBuild
          : panel?.kind === 'web' &&
              panel.definitionId === 'package:files:web-panel:files'
            ? filesPanelBuild
            : null
      if (build) {
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="UTF-8"><style>${build.css}</style></head><body>
              <div id="root"></div>
              <script type="module">${build.script.replaceAll(
                '</script',
                '<\\/script'
              )}</script>
            </body></html>`
        })
        return
      }

      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><h1>Web panel</h1></body></html>'
      })
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/web-panel-definitions$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { definitions: webPanelDefinitions } })
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/web-panel-definitions\/[^/]+\/permission-grant$/.test(
        pathname
      ) &&
      route.request().method() === 'PUT'
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
      /^\/api\/terminals\/[^/]+\/browser-panels\/open$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      const terminalId = pathname.split('/')[3]!
      const body: { url: string } = route.request().postDataJSON()
      const worktree = state.worktrees.find((candidate) =>
        candidate.terminals.some((terminal) => terminal.id === terminalId)
      )!
      const url = new URL(body.url).href
      const panel = {
        id: `browser_panel_${++browserPanelCreations}`,
        kind: 'browser' as const,
        worktreeId: worktree.id,
        title: new URL(url).host,
        url,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      worktree.panels.push(panel)
      await route.fulfill({ status: 201, json: { panel } })
      await page.evaluate(
        ({ worktreeId, panel, sourceTerminalId }) =>
          window.__eventSource.emit(
            'panel.open_requested',
            JSON.stringify({
              worktreeId,
              panelId: panel.id,
              panel,
              sourceTerminalId,
              sourcePanelId: null
            })
          ),
        {
          worktreeId: worktree.id,
          panel,
          sourceTerminalId: terminalId
        }
      )
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/browser-panels$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      const worktreeId = pathname.split('/')[3]!
      const body: { url?: string } = route.request().postDataJSON()
      const url = body.url ? new URL(body.url).href : 'about:blank'
      const panel = {
        id: `browser_panel_${++browserPanelCreations}`,
        kind: 'browser' as const,
        worktreeId,
        title: url === 'about:blank' ? 'Browser' : new URL(url).host,
        url,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      state.worktrees
        .find((candidate) => candidate.id === worktreeId)!
        .panels.push(panel)
      await route.fulfill({ status: 201, json: { panel } })
      return
    }

    if (
      /^\/api\/worktrees\/[^/]+\/panels\/open$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      const worktreeId = pathname.split('/')[3]!
      const body: {
        definitionId: string
        input?: { url?: string; title?: string } | null
        launchCwd?: string | null
      } = route.request().postDataJSON()
      const worktree = state.worktrees.find(
        (candidate) => candidate.id === worktreeId
      )!
      const existingPanel = worktree.panels.findLast(
        (candidate) =>
          candidate.kind === 'web' &&
          candidate.definitionId === body.definitionId
      )
      const definition = webPanelDefinitions.find(
        (candidate) => candidate.id === body.definitionId
      )!
      const panel = existingPanel ?? {
        id: `panel_${++webPanelCreations}`,
        kind: 'web' as const,
        worktreeId,
        definitionId: body.definitionId,
        title: definition.title,
        launch: {
          input: body.input ?? null,
          cwd: body.launchCwd ?? null
        },
        permissions: definition.permissions,
        sandbox: definition.sandbox,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      if (!existingPanel) {
        worktree.panels.push(panel)
      }

      await route.fulfill({
        json: {
          panel,
          created: !existingPanel,
          reused: Boolean(existingPanel)
        }
      })
      return
    }

    if (
      pathname === '/api/browser/install' &&
      route.request().method() === 'POST'
    ) {
      browserInstallRequests += 1
      await browserInstallGate
      browserInstallGate = null
      releaseBrowserInstall = null
      await route.fulfill({ json: { message: 'Chromium installed.' } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/browser-ticket$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      await route.fulfill(
        options.hostedBrowser
          ? { json: { ticket: crypto.randomUUID() } }
          : {
              status: 503,
              json: {
                error: {
                  code: 'BROWSER_UNAVAILABLE',
                  message: 'Hosted browser fixture is unavailable'
                }
              }
            }
      )
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/diff$/.test(pathname) &&
      route.request().method() === 'GET' &&
      options.realReviewPanel
    ) {
      await route.fulfill({
        json: {
          diff: {
            baseRef: 'origin/trunk',
            baseCommit: 'base',
            headCommit: 'head',
            generatedAt: '2026-01-01T00:00:00.000Z',
            unified: [
              'diff --git a/src/branch.ts b/src/branch.ts',
              'index 1111111..2222222 100644',
              '--- a/src/branch.ts',
              '+++ b/src/branch.ts',
              '@@ -1 +1 @@',
              '-branch before',
              '+branch after',
              'diff --git a/src/shared.ts b/src/shared.ts',
              'index 1111111..2222222 100644',
              '--- a/src/shared.ts',
              '+++ b/src/shared.ts',
              '@@ -1 +1 @@',
              '-shared before',
              '+shared after',
              'diff --git a/src/partial.ts b/src/partial.ts',
              'index 1111111..2222222 100644',
              '--- a/src/partial.ts',
              '+++ b/src/partial.ts',
              '@@ -1 +1 @@',
              '-partial before',
              '+partial after',
              'diff --git a/new file.txt b/new file.txt',
              'new file mode 100644',
              'index 0000000..3333333',
              '--- /dev/null',
              '+++ b/new file.txt',
              '@@ -0,0 +1 @@',
              '+untracked',
              ''
            ].join('\n'),
            changeSets: {
              branch: ['src/branch.ts', 'src/shared.ts'],
              staged: ['src/partial.ts'],
              unstaged: ['src/partial.ts', 'src/shared.ts'],
              untracked: ['new file.txt']
            }
          }
        }
      })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/context$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      const panelId = pathname.split('/')[3]!
      const worktree = state.worktrees.find((candidate) =>
        candidate.panels.some((panel) => panel.id === panelId)
      )!
      const panel = worktree.panels.find(
        (candidate) => candidate.id === panelId
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
              defaultBranch: state.defaultBranch
            },
            worktree: {
              id: worktree.id,
              name: worktree.name,
              branch: worktree.branch,
              head: worktree.head
            }
          }
        }
      })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/launch$/.test(pathname) &&
      route.request().method() === 'PUT'
    ) {
      const panelId = pathname.split('/')[3]!
      const body: {
        input: { url?: string; title?: string } | null
        launchCwd: string | null
      } = route.request().postDataJSON()
      const panel = state.worktrees
        .flatMap((worktree) => worktree.panels)
        .find((candidate) => candidate.id === panelId)!

      panel.launch = { input: body.input, cwd: body.launchCwd }
      panel.updatedAt = new Date(
        Date.parse(panel.updatedAt) + 1_000
      ).toISOString()
      await route.fulfill({ json: { panel } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/storage\/get$/.test(pathname) &&
      route.request().method() === 'POST'
    ) {
      const panelId = pathname.split('/')[3]!
      const body: { key: string } = route.request().postDataJSON()
      await route.fulfill({
        json: { value: webPanelStorage.get(panelId)?.get(body.key) }
      })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/storage$/.test(pathname) &&
      route.request().method() === 'PUT'
    ) {
      const panelId = pathname.split('/')[3]!
      const body: { key: string; value: JsonValue } = route
        .request()
        .postDataJSON()
      const storage =
        webPanelStorage.get(panelId) ?? new Map<string, JsonValue>()
      storage.set(body.key, body.value)
      webPanelStorage.set(panelId, storage)
      webPanelHasStorage = true
      await route.fulfill({ json: { ok: true } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/storage$/.test(pathname) &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({ json: { hasData: webPanelHasStorage } })
      return
    }

    if (
      /^\/api\/panels\/[^/]+$/.test(pathname) &&
      route.request().method() === 'DELETE'
    ) {
      const panelId = pathname.split('/').at(-1)
      const panel = state.worktrees
        .flatMap((worktree) => worktree.panels)
        .find((candidate) => candidate.id === panelId)
      if (
        panel?.kind === 'browser' &&
        options.browserBeforeUnload &&
        url.searchParams.get('force') !== 'true'
      ) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'BROWSER_BEFORE_UNLOAD',
              message: 'Changes you made may not be saved.'
            }
          }
        })
        return
      }

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
    browserInstallRequests: () => browserInstallRequests,
    delayNextBrowserInstall: () => {
      browserInstallGate = new Promise<void>((resolve) => {
        releaseBrowserInstall = resolve
      })
      return () => releaseBrowserInstall?.()
    },
    setWebPanelHasStorage: (value: boolean) => {
      webPanelHasStorage = value
    },
    setWebPanelStorage: (panelId: string, key: string, value: JsonValue) => {
      const storage =
        webPanelStorage.get(panelId) ?? new Map<string, JsonValue>()
      storage.set(key, value)
      webPanelStorage.set(panelId, storage)
      webPanelHasStorage = true
    },
    getWebPanelStorage: (panelId: string, key: string) =>
      webPanelStorage.get(panelId)?.get(key),
    getTreeFile: (filePath: string) => treeFiles.get(filePath),
    setTreeFile: (filePath: string, content: string) => {
      treeFileRevision += 1
      treeFiles.set(filePath, {
        content,
        revision: `revision-${treeFileRevision}`
      })
    },
    treeFileWrites: () => [...treeFileWrites]
  }
}
