import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { PlaywrightBrowser } from './playwright-browser'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()))
})

function runCli(cli: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (data) => (output += String(data)))
    child.stderr.on('data', (data) => (output += String(data)))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(output)
      } else {
        reject(
          new Error(
            `${args.join(' ')}: ${output || `Playwright Agent CLI exited with ${code}`}`
          )
        )
      }
    })
  })
}

it('streams and shares one History API page with the pinned Agent CLI', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><title>Start</title>
      <button onclick="history.pushState({}, '', '/next'); document.title = 'Next'">Next route</button>
      <button onclick="history.replaceState({}, '', '/replaced'); document.title = 'Replaced'">Replace route</button>
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
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-playwright-browser-')
  )
  const panelId = `real-${process.pid}`
  const states: Array<{ url: string; title: string }> = []
  const popups: string[] = []
  let frames = 0
  const browser = new PlaywrightBrowser(
    cachePath,
    workspace,
    'Real browser test',
    panelId,
    'worktree-real',
    {
      state: (state) => states.push({ url: state.url, title: state.title }),
      frame: () => frames++,
      popup: (url) => popups.push(url),
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
    await fs.rm(workspace, { recursive: true, force: true })
  })
  await browser.launch()
  await browser.setScreencasting(true)
  // SAFETY: The server is listening on an ephemeral TCP port.
  const address = server.address() as AddressInfo
  await browser.command({
    type: 'navigate',
    url: `http://127.0.0.1:${address.port}/`
  })

  const require = createRequire(import.meta.url)
  const cli = path.join(
    path.dirname(require.resolve('@playwright/cli/package.json')),
    'playwright-cli.js'
  )
  const name = `treeport-${panelId}`
  await runCli(cli, workspace, ['attach', name, '--session', name])
  cleanup.push(async () => {
    await runCli(cli, workspace, [`-s=${name}`, 'detach']).catch(
      () => undefined
    )
  })
  const snapshot = await runCli(cli, workspace, [`-s=${name}`, 'snapshot'])
  expect(snapshot).toContain('button "Next route"')
  const reference = /button "Next route" \[ref=([^\]]+)\]/.exec(snapshot)?.[1]
  expect(reference).toBeTruthy()
  await runCli(cli, workspace, [`-s=${name}`, 'click', reference!])

  await expect
    .poll(() => states.at(-1))
    .toMatchObject({
      url: `http://127.0.0.1:${address.port}/next`,
      title: 'Next'
    })

  const replacedSnapshot = await runCli(cli, workspace, [
    `-s=${name}`,
    'snapshot'
  ])
  const replaceReference = /button "Replace route" \[ref=([^\]]+)\]/.exec(
    replacedSnapshot
  )?.[1]
  expect(replaceReference).toBeTruthy()
  await runCli(cli, workspace, [`-s=${name}`, 'click', replaceReference!])
  await expect
    .poll(() => states.at(-1))
    .toMatchObject({
      url: `http://127.0.0.1:${address.port}/replaced`,
      title: 'Replaced'
    })

  await browser.command({ type: 'back' })
  await expect
    .poll(() => states.at(-1)?.url)
    .toBe(`http://127.0.0.1:${address.port}/`)
  await browser.command({ type: 'forward' })
  await expect
    .poll(() => states.at(-1)?.url)
    .toBe(`http://127.0.0.1:${address.port}/replaced`)
  await browser.command({ type: 'reload' })
  await expect
    .poll(() => states.at(-1)?.url)
    .toBe(`http://127.0.0.1:${address.port}/replaced`)
  await browser.command({
    type: 'navigate',
    url: `http://127.0.0.1:${address.port}/popup-source`
  })
  await expect
    .poll(() => popups.at(-1))
    .toBe(`http://127.0.0.1:${address.port}/popup`)
  await expect.poll(() => frames).toBeGreaterThan(0)
  await expect(
    runCli(cli, workspace, [`-s=${name}`, 'console'])
  ).resolves.toContain('Total messages:')
  await expect(
    runCli(cli, workspace, [`-s=${name}`, 'requests'])
  ).resolves.toContain('static requests')
  await expect(
    runCli(cli, workspace, [`-s=${name}`, 'screenshot'])
  ).resolves.toMatch(/\.png/u)
})
