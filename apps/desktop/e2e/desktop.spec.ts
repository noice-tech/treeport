import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, chromium, expect, test } from '@playwright/test'
import { Server as SocketServer, type Socket } from 'socket.io'
import {
  BROWSER_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION
} from '@treeport/shared'
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

interface PlaywrightAiPage {
  ariaSnapshot(options: { mode: 'ai' }): Promise<string>
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

interface BrowserOwnerControl {
  generation: number
  request(
    controller: 'agent' | 'other' | 'none',
    retainPaint: boolean
  ): Promise<boolean>
}

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

test('controls the local Browser through its exact bridge while another workspace is selected', async () => {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-electron-browser-')
  )
  const project = projectFixture()
  let applicationDocumentRequests = 0
  let popupRequests = 0
  let ownerTakeControlRequests = 0
  let websocketRequests = 0
  let browserIndex = 0
  let slowBrowserResponse = false
  const ownerTickets = new Map<string, { panelId: string; challenge: string }>()
  const ownerEndpoints = new Map<string, string>()
  const ownerReadyUrls = new Map<string, string>()
  const ownerControls = new Map<string, BrowserOwnerControl>()
  const ownerSockets = new Map<string, Socket>()
  const ownerConnectionCounts = new Map<string, number>()
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/health') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          ok: true,
          version: '0.1.0',
          protocolVersion: DESKTOP_PROTOCOL_VERSION,
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

    const ownerTicketMatch = url.pathname.match(
      /^\/api\/panels\/([^/]+)\/browser-owner-ticket$/
    )
    if (ownerTicketMatch && request.method === 'POST') {
      const ticket = crypto.randomBytes(32).toString('base64url')
      const challenge = crypto.randomBytes(32).toString('base64url')
      ownerTickets.set(ticket, {
        panelId: ownerTicketMatch[1]!,
        challenge
      })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ticket, challenge }))
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

    if (url.pathname === '/site/next') {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html>
        <title>Browser next</title>
        <form>
          <label>Name <input aria-label="Name"></label>
          <button type="submit">Submit</button>
        </form>
        <output></output>
        <output id="key"></output>
        <script>
          sessionStorage.nextLoads = String(Number(sessionStorage.nextLoads || 0) + 1)
          document.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault()
            document.querySelector('output').textContent = document.querySelector('input').value
          })
          addEventListener('keydown', (event) => {
            document.querySelector('#key').textContent = event.key
          })
        </script>`)
      return
    }

    if (url.pathname === '/site/profile') {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html>
        <title>Shared profile</title>
        <main>Login: <output></output></main>
        <script>document.querySelector('output').textContent = localStorage.login || 'signed-out'</script>`)
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
        <a id="next" href="/site/next" style="position:fixed;z-index:2;top:110px;left:0;width:100px;height:100px">Next page</a>
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
  server.on('upgrade', () => {
    websocketRequests += 1
  })
  const sockets = new SocketServer(server, {
    path: '/api/socket.io/',
    transports: ['websocket'],
    serveClient: false
  })
  const events = sockets.of('/events')
  sockets.of('/browser-owners').on('connection', (socket) => {
    const auth = z
      .strictObject({
        ticket: z.string(),
        protocolVersion: z.literal(BROWSER_PROTOCOL_VERSION),
        endpoint: z.string().url(),
        challenge: z.string()
      })
      .safeParse(socket.handshake.auth)
    const ticket = auth.success ? ownerTickets.get(auth.data.ticket) : null
    if (!auth.success || !ticket || ticket.challenge !== auth.data.challenge) {
      socket.disconnect(true)
      return
    }

    ownerTickets.delete(auth.data.ticket)
    ownerEndpoints.set(ticket.panelId, auth.data.endpoint)
    const panel = project.worktrees[0]!.panels.find(
      (candidate) => candidate.id === ticket.panelId
    )!
    let revision = -1
    const generation = 1
    const pendingControlRequests = new Map<
      string,
      (accepted: boolean) => void
    >()
    const ownerControl: BrowserOwnerControl = {
      generation,
      request(controller, retainPaint) {
        const requestId = crypto.randomUUID()
        return new Promise<boolean>((resolve) => {
          pendingControlRequests.set(requestId, resolve)
          socket.emit('ownerMessage', {
            type: 'runtimeControl',
            generation,
            requestId,
            controller,
            retainPaint
          })
        })
      }
    }
    ownerControls.set(panel.id, ownerControl)
    ownerSockets.set(panel.id, socket)
    ownerConnectionCounts.set(
      panel.id,
      (ownerConnectionCounts.get(panel.id) ?? 0) + 1
    )
    socket.on('disconnect', () => {
      if (ownerControls.get(panel.id) === ownerControl) {
        ownerControls.delete(panel.id)
      }

      if (ownerSockets.get(panel.id) === socket) {
        ownerSockets.delete(panel.id)
      }

      for (const resolve of pendingControlRequests.values()) {
        resolve(false)
      }
      pendingControlRequests.clear()
    })
    socket.emit('ownerMessage', {
      type: 'claimGranted',
      panelId: panel.id,
      generation,
      resumed: false,
      state: {
        url: panel.url,
        title: panel.title === 'Browser' ? '' : panel.title,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        viewport: { width: 0, height: 0 }
      }
    })
    socket.on('ownerMessage', (message) => {
      const value = z
        .object({ type: z.string(), generation: z.number() })
        .passthrough()
        .safeParse(message)
      if (!value.success || value.data.generation !== generation) {
        return
      }

      if (value.data.type === 'runtimeControlResult') {
        const result = z
          .object({ requestId: z.string(), accepted: z.boolean() })
          .parse(value.data)
        pendingControlRequests.get(result.requestId)?.(result.accepted)
        pendingControlRequests.delete(result.requestId)
      } else if (value.data.type === 'ready' || value.data.type === 'state') {
        const state = z
          .object({
            revision: z.number().int(),
            state: z.object({ url: z.string(), title: z.string() })
          })
          .parse(value.data)
        if (state.revision > revision) {
          revision = state.revision
          Object.assign(panel, state.state, { updatedAt: '2026-01-02' })
          if (value.data.type === 'ready') {
            ownerReadyUrls.set(panel.id, state.state.url)
          }
        }
      } else if (value.data.type === 'popup') {
        popupRequests += 1
      } else if (value.data.type === 'takeControl') {
        ownerTakeControlRequests += 1
      }
    })
  })
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = serverPort(server.address())
    const origin = `http://127.0.0.1:${port}`
    const browserPanelId = 'panel_browser_1'
    project.worktrees[0]!.panels.push({
      id: browserPanelId,
      kind: 'browser',
      worktreeId: 'wt_main',
      title: '127.0.0.1',
      url: `${origin}/site/start`,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    })
    browserIndex = 1
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
    await window.getByRole('button', { name: 'Toggle side panel' }).click()
    const browserTab = window.getByRole('tab', { name: /, Browser$/ })
    await browserTab.click()

    const address = window.getByRole('textbox', { name: 'Application URL' })
    await expect(address).toHaveValue(`${origin}/site/start`)
    await expect
      .poll(() => ownerReadyUrls.get(browserPanelId))
      .toBe(`${origin}/site/start`)
    await expect(
      window.getByRole('tab', { name: 'Browser start, Browser' })
    ).toBeVisible()
    const sidePanelToggle = window.getByRole('button', {
      name: 'Toggle side panel'
    })
    await sidePanelToggle.click()
    await expect(browserTab).not.toBeVisible()
    await sidePanelToggle.click()
    await expect(browserTab).toBeVisible()
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

    const endpoint = await expect
      .poll(() => ownerEndpoints.get(browserPanelId))
      .not.toBeUndefined()
      .then(() => ownerEndpoints.get(browserPanelId)!)
    const connectedBrowser = await chromium.connectOverCDP(endpoint)
    try {
      const visiblePage = connectedBrowser.contexts()[0]!.pages()[0]!
      await visiblePage.locator('#hit').focus()
      await visiblePage.keyboard.press(
        process.platform === 'darwin' ? 'Meta+L' : 'Control+L'
      )
      await expect(address).toBeFocused()
      await expect(address).toHaveJSProperty('selectionStart', 0)
      await expect(address).toHaveJSProperty(
        'selectionEnd',
        `${origin}/site/start`.length
      )

      await address.fill(`${origin}/site/next`)
      await address.press('Enter')
      await expect(address).not.toBeFocused()
      await expect.poll(() => visiblePage.url()).toBe(`${origin}/site/next`)
      await expect
        .poll(() => visiblePage.evaluate(() => document.hasFocus()))
        .toBe(true)
      await window.keyboard.press('x')
      await expect
        .poll(() => visiblePage.locator('#key').textContent())
        .toBe('x')
      await visiblePage.goBack()
      await expect.poll(() => visiblePage.url()).toBe(`${origin}/site/start`)
      await expect(address).toHaveValue(`${origin}/site/start`)

      // SAFETY: Playwright 1.61 implements its CLI reference snapshot through this internal mode.
      const snapshotPage = visiblePage as PlaywrightAiPage
      const snapshot = await snapshotPage.ariaSnapshot({ mode: 'ai' })
      const targetRef = snapshot.match(
        /button "Browser target" \[ref=([^\]]+)\]/
      )?.[1]
      const nextRef = snapshot.match(/link "Next page" \[ref=([^\]]+)\]/)?.[1]
      if (!targetRef || !nextRef) {
        throw new Error(`Browser target refs were missing:\n${snapshot}`)
      }

      await visiblePage.locator(`aria-ref=${targetRef}`).click()
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

      await visiblePage.locator(`aria-ref=${nextRef}`).click()
      await expect
        .poll(() =>
          electronApp!.evaluate(({ webContents }) =>
            webContents
              .getAllWebContents()
              .find((contents) => contents.getType() === 'webview')
              ?.getURL()
          )
        )
        .toBe(`${origin}/site/next`)
      await expect(address).toHaveValue(`${origin}/site/next`)
      const nextSnapshot = await snapshotPage.ariaSnapshot({ mode: 'ai' })
      const inputRef = nextSnapshot.match(
        /textbox "Name" \[ref=([^\]]+)\]/
      )?.[1]
      if (!inputRef) {
        throw new Error(`Name ref was missing:\n${nextSnapshot}`)
      }

      await visiblePage.locator(`aria-ref=${inputRef}`).fill('Treeport')
      await visiblePage.keyboard.press('Enter')
      await expect
        .poll(() =>
          electronApp!.evaluate(({ webContents }) => {
            const browser = webContents
              .getAllWebContents()
              .find((contents) => contents.getType() === 'webview')
            return browser?.executeJavaScript(
              `document.querySelector('output')?.textContent`
            )
          })
        )
        .toBe('Treeport')
      expect((await visiblePage.screenshot()).byteLength).toBeGreaterThan(0)
      const nextPageLoads = await visiblePage.evaluate(
        () => sessionStorage.nextLoads
      )
      await window.getByRole('button', { name: /^Shell/ }).click()
      await expect(window).toHaveURL(/\/terminals\/term_shell$/)
      const ownerControl = ownerControls.get(browserPanelId)
      if (!ownerControl) {
        throw new Error('The local Browser owner control was not ready.')
      }

      expect(ownerControl.generation).toBe(1)
      expect(await ownerControl.request('agent', true)).toBe(true)
      const screencast = await connectedBrowser
        .contexts()[0]!
        .newCDPSession(visiblePage)
      const framePromise = new Promise<{
        data: string
        sessionId: number
        metadata: { deviceWidth: number; deviceHeight: number }
      }>((resolve) => screencast.once('Page.screencastFrame', resolve))
      await screencast.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 75,
        everyNthFrame: 1
      })
      const frame = await framePromise
      expect(Buffer.from(frame.data, 'base64').byteLength).toBeGreaterThan(0)
      expect(frame.metadata.deviceWidth).toBeGreaterThan(0)
      expect(frame.metadata.deviceHeight).toBeGreaterThan(0)
      await screencast.send('Page.screencastFrameAck', {
        sessionId: frame.sessionId
      })
      await screencast.send('Page.stopScreencast')
      await screencast.detach()

      let controlReleased = false
      try {
        const backgroundSnapshot = await snapshotPage.ariaSnapshot({
          mode: 'ai'
        })
        const backgroundInputRef = backgroundSnapshot.match(
          /textbox "Name".*\[ref=([^\]]+)\]/
        )?.[1]
        const backgroundSubmitRef = backgroundSnapshot.match(
          /button "Submit".*\[ref=([^\]]+)\]/
        )?.[1]
        if (!backgroundInputRef || !backgroundSubmitRef) {
          throw new Error(
            `Background form refs were missing:\n${backgroundSnapshot}`
          )
        }

        await visiblePage
          .locator(`aria-ref=${backgroundInputRef}`)
          .fill('Background')
        await visiblePage.locator(`aria-ref=${backgroundSubmitRef}`).click()
        await expect
          .poll(() => visiblePage.locator('output').first().textContent())
          .toBe('Background')
        await visiblePage.keyboard.press('Escape')
        await expect
          .poll(() => visiblePage.locator('#key').textContent())
          .toBe('Escape')
        expect((await visiblePage.screenshot()).byteLength).toBeGreaterThan(0)
        await expect(window).toHaveURL(/\/terminals\/term_shell$/)
      } finally {
        controlReleased = await ownerControl.request('none', false)
      }
      expect(controlReleased).toBe(true)

      await browserTab.click()
      await expect
        .poll(() => visiblePage.locator('output').first().textContent())
        .toBe('Background')
      expect(await ownerControl.request('other', true)).toBe(true)
      await window
        .getByRole('button', { name: 'Take control of Browser' })
        .click()
      await expect.poll(() => ownerTakeControlRequests).toBe(1)
      expect(await ownerControl.request('none', false)).toBe(true)
      await expect(
        window.getByRole('button', { name: 'Take control of Browser' })
      ).not.toBeVisible()
      expect(await visiblePage.evaluate(() => sessionStorage.nextLoads)).toBe(
        nextPageLoads
      )
      await visiblePage.goBack()
      await expect.poll(() => visiblePage.url()).toBe(`${origin}/site/start`)
      await expect(address).toHaveValue(`${origin}/site/start`)
      await visiblePage.goForward()
      await expect.poll(() => visiblePage.url()).toBe(`${origin}/site/next`)
      await expect(address).toHaveValue(`${origin}/site/next`)
      await visiblePage.reload()
      await expect.poll(() => visiblePage.title()).toBe('Browser next')
      await visiblePage.goto(`${origin}/site/start`)
      await expect(address).toHaveValue(`${origin}/site/start`)
      const runtimeBeforeReconnect = await visiblePage.evaluate(() => ({
        loads: sessionStorage.loads,
        href: location.href
      }))
      ownerSockets.get(browserPanelId)?.disconnect(true)
      await expect.poll(() => ownerConnectionCounts.get(browserPanelId)).toBe(2)
      await expect
        .poll(() =>
          electronApp!.evaluate(({ webContents }) => {
            const browser = webContents
              .getAllWebContents()
              .find((contents) => contents.getType() === 'webview')
            return browser?.executeJavaScript(`({
              loads: sessionStorage.loads,
              href: location.href
            })`)
          })
        )
        .toEqual(runtimeBeforeReconnect)
      await expect(address).toHaveValue(`${origin}/site/start`)
    } finally {
      await connectedBrowser.close()
    }

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
      const scope = window as typeof window & {
        __browserFocuses?: string[]
        __browserPopups?: unknown[]
      }
      scope.__browserFocuses = []
      scope.__browserPopups = []
      window.treeportDesktop?.onBrowserFocus((panelId) => {
        scope.__browserFocuses?.push(panelId)
      })
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

    await window.getByRole('button', { name: /^Shell/ }).click()
    await expect(window.locator('.xterm-helper-textarea')).toBeFocused()
    events.emit('product_event', {
      id: crypto.randomUUID(),
      type: 'panel.open_requested',
      at: new Date().toISOString(),
      data: {
        worktreeId: 'wt_main',
        panelId: browserPanelId,
        panel: project.worktrees[0]!.panels.find(
          (candidate) => candidate.id === browserPanelId
        )!,
        sourceTerminalId: 'term_shell',
        sourcePanelId: null
      }
    })
    await expect(window).toHaveURL(/\/panels\/panel_browser_1$/)
    await expect(window.locator('.xterm-helper-textarea')).toBeFocused()
    await window.mouse.click(webviewBounds.x + 20, webviewBounds.y + 20)
    await expect
      .poll(() =>
        window.evaluate(() => {
          // SAFETY: The test installed this cross-process probe above.
          const scope = window as typeof window & {
            __browserFocuses?: string[]
          }
          return scope.__browserFocuses ?? []
        })
      )
      .toContain('panel_browser_1')
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
        'select-tab-1'
      )
    })
    await expect(window).toHaveURL(/\/panels\/panel_browser_1$/)

    await window.getByRole('button', { name: 'New panel in main tree' }).click()
    const newPanel = window.getByRole('dialog', { name: 'New panel' })
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
    ).toEqual({ hits: '1', loads: '5' })
    await window.keyboard.press('Escape')
    await expect(newPanel).not.toBeVisible()
    await window.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    )
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
      .toBe('2')

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
    await browserTab.click()
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
    ).toBe('5')

    await window.getByRole('button', { name: 'New panel in main tree' }).click()
    await window
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Browser, hosted browser' })
      .click()
    await expect(window).toHaveURL(/\/panels\/panel_browser_2$/)
    await expect(address).toHaveValue('')
    await expect
      .poll(() => ownerReadyUrls.get('panel_browser_2'))
      .toBe('about:blank')
    await address.fill(`${origin}/site/profile`)
    await address.press('Enter')
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
          return browser?.executeJavaScript(`(() => {
            localStorage.login = 'panel-two'
            document.cookie = 'login=panel-two; Max-Age=3600; SameSite=Lax'
            document.querySelector('output').textContent = localStorage.login
            return { login: localStorage.login, cookie: document.cookie }
          })()`)
        }, `${origin}/site/profile`)
      )
      .toEqual({ login: 'panel-two', cookie: 'login=panel-two' })

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
          `${origin}/site/profile`
        )
      )
      .toBe(false)

    await window.getByRole('tab', { name: /, Browser$/ }).click()
    await address.fill(`${origin}/site/profile`)
    await address.press('Enter')
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
            `({ login: localStorage.login, cookie: document.cookie })`
          )
        }, `${origin}/site/profile`)
      )
      .toEqual({ login: 'panel-two', cookie: 'login=panel-two' })

    await expect
      .poll(
        () =>
          project.worktrees[0]!.panels.find(
            (panel) => panel.id === browserPanelId
          )?.url
      )
      .toBe(`${origin}/site/profile`)
    await electronApp.close()
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
    const restartedWindow = await electronApp.firstWindow()
    await restartedWindow.getByRole('tab', { name: /, Browser$/ }).click()
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
            `({ login: localStorage.login, cookie: document.cookie })`
          )
        }, `${origin}/site/profile`)
      )
      .toEqual({ login: 'panel-two', cookie: 'login=panel-two' })
  } finally {
    await electronApp?.close().catch(() => undefined)
    sockets.close()
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
