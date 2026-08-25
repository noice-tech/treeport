import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { z } from 'zod'

function serverPort<Address>(address: Address): number {
  const parsed = z.object({ port: z.number().int() }).safeParse(address)
  if (!parsed.success) {
    throw new Error('Test server did not expose a port')
  }

  return parsed.data.port
}

function workspaceLink(url: string): string {
  const link = new URL('treeport://open')
  link.searchParams.set('url', url)
  return link.href
}

interface BrowserPanelFixture {
  id: string
  kind: 'browser'
  worktreeId: string
  title: string
  url: string
  createdAt: string
  updatedAt: string
}

const browserStateSchema = z.object({ url: z.string(), title: z.string() })

function projectFixture() {
  const panels: BrowserPanelFixture[] = []
  return {
    id: 'proj_1',
    name: 'example',
    kind: 'repository',
    rootPath: '/repo',
    repositoryPath: '/repo',
    mainWorktreePath: '/repo',
    defaultBranch: 'trunk',
    color: null,
    availability: { state: 'available', message: null },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    worktrees: [
      {
        id: 'wt_main',
        projectId: 'proj_1',
        name: 'main tree',
        path: '/repo',
        head: 'aaaaaaaa',
        branch: 'trunk',
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        kind: 'main',
        tmuxSocketName: 'treeport-wt-main',
        managedWrapperPath: null,
        pr: {
          state: 'no_pr',
          number: null,
          url: null,
          baseBranch: null,
          headBranch: null,
          mergedAt: null,
          refreshedAt: null
        },
        dirty: {
          dirty: false,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicts: 0,
          total: 0
        },
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        panels,
        terminals: [
          {
            id: 'term_shell',
            worktreeId: 'wt_main',
            name: 'Shell',
            tmuxSessionName: 'treeport-term-shell',
            argv: ['/bin/zsh', '-l'],
            shellCommand: null,
            interactiveShell: true,
            status: 'running',
            exitCode: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01'
          }
        ]
      }
    ]
  }
}

test('loads the packaged app and keeps a local Browser under desktop dialogs', async () => {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-electron-browser-')
  )
  const project = projectFixture()
  let applicationDocumentRequests = 0
  let popupRequests = 0
  let websocketRequests = 0
  let browserIndex = 0
  let slowBrowserResponse = false
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/health') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          ok: true,
          version: '0.1.0',
          protocolVersion: 2,
          hostname: 'desktop-test'
        })
      )
      return
    }

    if (url.pathname === '/api/projects' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ projects: [project] }))
      return
    }

    if (url.pathname === '/api/terminal-presets') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ presets: [] }))
      return
    }

    if (url.pathname === '/api/terminal-preset-definitions') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ definitions: [], diagnostics: [] }))
      return
    }

    if (
      url.pathname === '/api/worktrees/wt_main/web-panel-definitions' &&
      request.method === 'GET'
    ) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ definitions: [] }))
      return
    }

    if (
      url.pathname === '/api/worktrees/wt_main/browser-panels' &&
      request.method === 'POST'
    ) {
      const panel = {
        id: `panel_browser_${++browserIndex}`,
        kind: 'browser',
        worktreeId: 'wt_main',
        title: 'Browser',
        url: 'about:blank',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
      project.worktrees[0]!.panels.push(panel)
      response.statusCode = 201
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ panel }))
      return
    }

    const stateMatch = url.pathname.match(
      /^\/api\/panels\/([^/]+)\/browser-state$/
    )
    if (stateMatch && request.method === 'PUT') {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk))
      }
      const state = browserStateSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString())
      )
      const panel = project.worktrees[0]!.panels.find(
        (candidate) => candidate.id === stateMatch[1]
      )!
      Object.assign(panel, state, { updatedAt: '2026-01-02' })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ panel }))
      return
    }

    if (
      /^\/api\/panels\/[^/]+\/browser-popups$/.test(url.pathname) &&
      request.method === 'POST'
    ) {
      popupRequests += 1
      response.statusCode = 201
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ panel: project.worktrees[0]!.panels[0] }))
      return
    }

    const deleteMatch = url.pathname.match(/^\/api\/panels\/([^/]+)$/)
    if (deleteMatch && request.method === 'DELETE') {
      project.worktrees[0]!.panels = project.worktrees[0]!.panels.filter(
        (panel) => panel.id !== deleteMatch[1]
      )
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/site/start') {
      if (slowBrowserResponse) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html>
        <title>Browser start</title>
        <button id="hit" style="position:fixed;inset:0;width:100%;height:100%">Browser target</button>
        <a id="popup" href="/site/popup" target="_blank" style="position:fixed;z-index:2;top:0;left:0;width:100px;height:100px">Open popup</a>
        <output id="size" style="position:fixed;z-index:3;right:0;top:0"></output>
        <script>
          sessionStorage.loads = String(Number(sessionStorage.loads || 0) + 1)
          sessionStorage.hits = sessionStorage.hits || '0'
          document.querySelector('#hit').addEventListener('click', () => {
            sessionStorage.hits = String(Number(sessionStorage.hits) + 1)
          })
          const reportSize = () => {
            document.querySelector('#size').textContent = innerWidth < 900 ? 'Compact page' : 'Wide page'
          }
          addEventListener('resize', reportSize)
          reportSize()
        </script>`)
      return
    }

    if (url.pathname.startsWith('/projects/')) {
      applicationDocumentRequests += 1
    }

    response.statusCode = 404
    response.end('Not found')
  })
  server.on('upgrade', (_request, socket) => {
    websocketRequests += 1
    socket.destroy()
  })
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = serverPort(server.address())
    const origin = `http://127.0.0.1:${port}`
    const workspaceUrl = `${origin}/projects/proj_1/worktrees/wt_main`
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )

    electronApp = await electron.launch({
      args: [`--user-data-dir=${userData}`, '.', workspaceLink(workspaceUrl)],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TREEPORT_DESKTOP_E2E: '1',
        TREEPORT_DESKTOP_USER_DATA: '',
        TREEPORT_DESKTOP_URL: origin
      }
    })
    const window = await electronApp.firstWindow()
    await expect(
      window.getByRole('heading', {
        name: 'Treeport isn’t available on this computer'
      })
    ).toBeVisible({ timeout: 8_000 })

    await new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', resolve)
    )
    await expect(
      window.getByRole('button', { name: 'Connected computer: This computer' })
    ).toBeVisible({ timeout: 8_000 })
    await expect(
      window.getByRole('button', { name: /^main tree/ })
    ).toBeVisible()
    expect(applicationDocumentRequests).toBe(0)
    await expect.poll(() => websocketRequests).toBeGreaterThan(0)

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'desktop-command',
        'new-panel'
      )
    })
    const newPanel = window.getByRole('dialog', { name: 'New panel' })
    await expect(newPanel).toBeVisible()
    await newPanel
      .getByRole('button', { name: 'Browser, hosted browser' })
      .click()
    const address = window.getByRole('textbox', { name: 'Application URL' })
    await expect(address).toBeFocused()
    await address.fill(`${origin}/site/start`)
    await address.press('Enter')

    await expect
      .poll(() =>
        electronApp!.evaluate(
          ({ webContents }, targetUrl) =>
            webContents
              .getAllWebContents()
              .find(
                (contents) =>
                  contents.getType() === 'webview' &&
                  contents.getURL() === targetUrl
              )
              ?.executeJavaScript('document.body.textContent'),
          `${origin}/site/start`
        )
      )
      .toContain('Browser target')
    expect(
      await electronApp.evaluate(({ webContents }, targetUrl) => {
        const browser = webContents
          .getAllWebContents()
          .find(
            (contents) =>
              contents.getType() === 'webview' &&
              contents.getURL() === targetUrl
          )
        return browser?.getLastWebPreferences()
      }, `${origin}/site/start`)
    ).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    })

    slowBrowserResponse = true
    await window.getByRole('button', { name: 'Reload application' }).click()
    await expect(
      window.getByRole('button', { name: 'Stop loading' })
    ).toBeVisible()
    await expect(
      window.getByRole('button', { name: 'Reload application' })
    ).toBeVisible()
    slowBrowserResponse = false

    await window.evaluate(() => {
      // SAFETY: The test installs this cross-process probe on its own window.
      const scope = window as typeof window & { __browserPopups?: unknown[] }
      scope.__browserPopups = []
      window.treeportDesktop?.onBrowserPopup((popup) => {
        scope.__browserPopups?.push(popup)
      })
    })
    const webviewBounds = await window
      .locator('webview[aria-label="Browser page"]')
      .boundingBox()
    if (!webviewBounds) {
      throw new Error('Browser page did not expose bounds')
    }

    await window.mouse.click(webviewBounds.x + 20, webviewBounds.y + 20)
    await expect
      .poll(() =>
        window.evaluate(() => {
          // SAFETY: The test installed this cross-process probe above.
          const scope = window as typeof window & {
            __browserPopups?: unknown[]
          }
          return scope.__browserPopups?.length ?? 0
        })
      )
      .toBe(1)
    await expect.poll(() => popupRequests).toBe(1)

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'desktop-command',
        'new-panel'
      )
    })
    await expect(newPanel).toBeVisible()
    await window.mouse.click(
      webviewBounds.x + webviewBounds.width - 16,
      webviewBounds.y + webviewBounds.height - 16
    )
    expect(
      await electronApp.evaluate(({ webContents }, targetUrl) => {
        const browser = webContents
          .getAllWebContents()
          .find(
            (contents) =>
              contents.getType() === 'webview' &&
              contents.getURL() === targetUrl
          )
        return browser?.executeJavaScript(
          `({ hits: sessionStorage.hits, loads: sessionStorage.loads })`
        )
      }, `${origin}/site/start`)
    ).toEqual({ hits: '0', loads: '2' })
    await window.keyboard.press('Escape')
    await expect(newPanel).not.toBeVisible()
    await window.mouse.click(
      webviewBounds.x + webviewBounds.width - 16,
      webviewBounds.y + webviewBounds.height - 16
    )
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, targetUrl) => {
          const browser = webContents
            .getAllWebContents()
            .find(
              (contents) =>
                contents.getType() === 'webview' &&
                contents.getURL() === targetUrl
            )
          return browser?.executeJavaScript('sessionStorage.hits')
        }, `${origin}/site/start`)
      )
      .toBe('1')

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 720)
    })
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, targetUrl) => {
          const browser = webContents
            .getAllWebContents()
            .find(
              (contents) =>
                contents.getType() === 'webview' &&
                contents.getURL() === targetUrl
            )
          return browser?.executeJavaScript(
            `document.querySelector('#size')?.textContent`
          )
        }, `${origin}/site/start`)
      )
      .toBe('Compact page')

    await window.getByRole('button', { name: /^Shell/ }).click()
    await window.getByRole('button', { name: /^Browser(?:,|$)/ }).click()
    expect(
      await electronApp.evaluate(({ webContents }, targetUrl) => {
        const browser = webContents
          .getAllWebContents()
          .find(
            (contents) =>
              contents.getType() === 'webview' &&
              contents.getURL() === targetUrl
          )
        return browser?.executeJavaScript('sessionStorage.loads')
      }, `${origin}/site/start`)
    ).toBe('2')

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'desktop-command',
        'close-panel'
      )
    })
    await expect
      .poll(() =>
        electronApp!.evaluate(
          ({ webContents }, targetUrl) =>
            webContents
              .getAllWebContents()
              .some(
                (contents) =>
                  contents.getType() === 'webview' &&
                  contents.getURL() === targetUrl
              ),
          `${origin}/site/start`
        )
      )
      .toBe(false)
  } finally {
    await electronApp?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(userData, { recursive: true, force: true })
  }
})

test('shows an incompatible computer without requesting backend application HTML', async () => {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-electron-incompatible-')
  )
  let applicationRequests = 0
  const server = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          ok: true,
          version: '0.0.1',
          protocolVersion: 1,
          hostname: 'old-treeport'
        })
      )
      return
    }

    applicationRequests += 1
    response.end('<body>Old Treeport</body>')
  })
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = serverPort(server.address())
    electronApp = await electron.launch({
      args: [`--user-data-dir=${userData}`, '.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TREEPORT_DESKTOP_E2E: '1',
        TREEPORT_DESKTOP_USER_DATA: '',
        TREEPORT_DESKTOP_URL: `http://127.0.0.1:${port}`
      }
    })
    const window = await electronApp.firstWindow()

    await expect(
      window.getByRole('heading', {
        name: 'This Treeport version is incompatible'
      })
    ).toBeVisible()
    expect(applicationRequests).toBe(0)
  } finally {
    await electronApp?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(userData, { recursive: true, force: true })
  }
})
