import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { PlaywrightBrowser, PlaywrightBrowserHost } from './playwright-browser'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()))
})

it('shares durable browser data across panels and browser runtime replacement', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><title>Start</title>
      <button onclick="history.pushState({}, '', '/next'); document.title = 'Next'">Next route</button>
      <button onclick="history.replaceState({}, '', '/replaced'); document.title = 'Replaced'">Replace route</button>
      <button onclick="window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = '' }">Protect close</button>
      <button onclick="localStorage.login = 'signed-in'; document.cookie = 'login=signed-in; Max-Age=3600; SameSite=Lax'; showLogin()">Save login</button>
      <output aria-label="Login state"></output>
      <script>
        function showLogin() {
          document.querySelector('output').textContent = (localStorage.login || 'signed-out') + ' ' + document.cookie
        }
        showLogin()
      </script>
      ${request.url === '/popup-source' ? "<script>open('/popup')</script>" : ''}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )

  let browserRevision = path.dirname(chromium.executablePath())
  while (!path.basename(browserRevision).startsWith('chromium-')) {
    const parent = path.dirname(browserRevision)
    if (parent === browserRevision) {
      throw new Error('Could not locate the Playwright browser cache')
    }

    browserRevision = parent
  }
  const cachePath = path.dirname(browserRevision)
  await expect(PlaywrightBrowser.status(cachePath)).resolves.toMatchObject({
    installed: true,
    browserRevision: path.basename(browserRevision),
    channel: 'chromium',
    launchReady: true,
    launchError: null
  })
  expect(
    (await fs.readdir(cachePath)).filter((entry) =>
      entry.startsWith('.launch-status-')
    )
  ).toEqual([])

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-playwright-browser-')
  )
  const profilePath = path.join(root, 'browser-profile')
  await Promise.all(
    ['panel-one', 'panel-two', 'replacement-panel'].map((directory) =>
      fs.mkdir(path.join(root, directory))
    )
  )
  const host = new PlaywrightBrowserHost(cachePath, profilePath)
  const states: Array<{ url: string; title: string }> = []
  const popups: string[] = []
  let frames = 0
  const browser = new PlaywrightBrowser(host, path.join(root, 'panel-one'), {
    state: (state) => states.push({ url: state.url, title: state.title }),
    frame: () => frames++,
    popup: (url) => popups.push(url),
    navigationError: (message) => {
      throw new Error(message)
    },
    crashed: (message) => {
      throw new Error(message)
    }
  })
  const secondBrowser = new PlaywrightBrowser(
    host,
    path.join(root, 'panel-two'),
    {
      state: () => undefined,
      frame: () => undefined,
      popup: () => undefined,
      navigationError: (message) => {
        throw new Error(message)
      },
      crashed: (message) => {
        throw new Error(message)
      }
    }
  )
  cleanup.push(async () => {
    await browser.close()
    await secondBrowser.close()
    await host.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  await Promise.all([browser.launch(), secondBrowser.launch()])
  await browser.setScreencasting(true)
  // SAFETY: The server is listening on an ephemeral TCP port.
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  await browser.command({ type: 'navigate', url: `${origin}/` })

  const snapshot = await browser.agentCommand({ command: 'snapshot', args: [] })
  expect(snapshot).toContain('button "Next route"')
  const reference = /button "Next route" \[ref=([^\]]+)\]/.exec(snapshot)?.[1]
  expect(reference).toBeTruthy()
  await browser.agentCommand({ command: 'click', args: [reference!] })
  await expect
    .poll(() => states.at(-1))
    .toMatchObject({
      url: `${origin}/next`,
      title: 'Next'
    })

  const replacedSnapshot = await browser.agentCommand({
    command: 'snapshot',
    args: []
  })
  const replaceReference = /button "Replace route" \[ref=([^\]]+)\]/.exec(
    replacedSnapshot
  )?.[1]
  expect(replaceReference).toBeTruthy()
  await browser.agentCommand({ command: 'click', args: [replaceReference!] })
  await expect
    .poll(() => states.at(-1))
    .toMatchObject({
      url: `${origin}/replaced`,
      title: 'Replaced'
    })

  await browser.command({ type: 'back' })
  await expect.poll(() => states.at(-1)?.url).toBe(`${origin}/`)
  await browser.command({ type: 'forward' })
  await expect.poll(() => states.at(-1)?.url).toBe(`${origin}/replaced`)
  await browser.command({ type: 'reload' })
  await expect.poll(() => states.at(-1)?.url).toBe(`${origin}/replaced`)
  await browser.command({ type: 'navigate', url: `${origin}/popup-source` })
  await expect.poll(() => popups.at(-1)).toBe(`${origin}/popup`)
  await expect.poll(() => frames).toBeGreaterThan(0)
  await expect(
    browser.agentCommand({ command: 'requests', args: [] })
  ).resolves.toContain(`GET ${origin}/popup-source`)
  await expect(
    browser.agentCommand({ command: 'screenshot', args: [] })
  ).resolves.toMatch(/\.png/u)

  await browser.command({ type: 'navigate', url: `${origin}/` })
  const loginSnapshot = await browser.agentCommand({
    command: 'snapshot',
    args: []
  })
  const loginReference = /button "Save login" \[ref=([^\]]+)\]/.exec(
    loginSnapshot
  )?.[1]
  expect(loginReference).toBeTruthy()
  await browser.agentCommand({ command: 'click', args: [loginReference!] })

  await secondBrowser.command({ type: 'navigate', url: `${origin}/` })
  await expect(
    secondBrowser.agentCommand({ command: 'snapshot', args: [] })
  ).resolves.toContain('signed-in login=signed-in')

  const closeSnapshot = await browser.agentCommand({
    command: 'snapshot',
    args: []
  })
  const closeReference = /button "Protect close" \[ref=([^\]]+)\]/.exec(
    closeSnapshot
  )?.[1]
  expect(closeReference).toBeTruthy()
  await browser.agentCommand({ command: 'click', args: [closeReference!] })
  await expect(browser.requestClose(false)).resolves.toBe(false)
  await expect(browser.requestClose(true)).resolves.toBe(true)
  await browser.close()
  await secondBrowser.close()
  expect(host.started).toBe(false)

  const replacementHost = new PlaywrightBrowserHost(cachePath, profilePath)
  const replacementBrowser = new PlaywrightBrowser(
    replacementHost,
    path.join(root, 'replacement-panel'),
    {
      state: () => undefined,
      frame: () => undefined,
      popup: () => undefined,
      navigationError: (message) => {
        throw new Error(message)
      },
      crashed: (message) => {
        throw new Error(message)
      }
    }
  )
  await replacementBrowser.launch()
  await replacementBrowser.command({ type: 'navigate', url: `${origin}/` })
  await expect(
    replacementBrowser.agentCommand({ command: 'snapshot', args: [] })
  ).resolves.toContain('signed-in login=signed-in')
  await replacementBrowser.close()
  await replacementHost.close()
})
