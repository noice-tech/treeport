import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

async function waitForGuest(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
  origin: string
): Promise<void> {
  await expect
    .poll(() =>
      electronApp.evaluate(
        ({ webContents }, expectedOrigin) =>
          webContents
            .getAllWebContents()
            .some((contents) => contents.getURL().startsWith(expectedOrigin)),
        origin
      )
    )
    .toBe(true)
}

test('connects the desktop shell, preserves native behavior, and restores renderer state', async () => {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-electron-')
  )
  let healthAvailable = true
  let hostname = 'desktop-test'
  const server = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      if (!healthAvailable) {
        response.statusCode = 503
        response.end()
        return
      }

      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          ok: true,
          version: '0.1.0',
          protocolVersion: 2,
          hostname
        })
      )
      return
    }

    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html>
      <body data-command="none">Treeport desktop test</body>
      <script>
        window.treeportDesktop.onCommand((command) => {
          document.body.dataset.command = command
        })
      </script>`)
  })
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a port')
    }

    const origin = `http://127.0.0.1:${address.port}`

    electronApp = await electron.launch({
      args: [`--user-data-dir=${userData}`, '.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TREEPORT_DESKTOP_E2E: '1',
        TREEPORT_DESKTOP_USER_DATA: '',
        TREEPORT_DESKTOP_URL: origin
      }
    })

    let selector = await electronApp.firstWindow()
    await expect(
      selector.getByRole('button', {
        name: 'Connected computer: This computer'
      })
    ).toBeVisible()
    await waitForGuest(electronApp, origin)
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, expectedOrigin) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
          return guest?.executeJavaScript('document.body.textContent')
        }, origin)
      )
      .toContain('Treeport desktop test')

    const preferences = await electronApp.evaluate(
      ({ webContents }, expectedOrigin) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(expectedOrigin))
          ?.getLastWebPreferences(),
      origin
    )
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    })

    await electronApp.evaluate(({ shell }) => {
      const scope = globalThis as typeof globalThis & {
        __openedTreeportFilePaths?: string[]
      }
      scope.__openedTreeportFilePaths = []
      shell.openPath = async (filePath) => {
        scope.__openedTreeportFilePaths!.push(filePath)
        return ''
      }
    })
    const filePath = path.join(userData, 'résumé draft.txt')
    expect(
      await electronApp.evaluate(
        async ({ webContents }, input) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(input.origin))
          return guest?.executeJavaScript(
            `window.treeportDesktop.openFileUrl(${JSON.stringify(input.url)})`
          )
        },
        { origin, url: pathToFileURL(filePath).href }
      )
    ).toBe('opened')
    expect(
      await electronApp.evaluate(
        ({ webContents }, expectedOrigin) =>
          webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
            ?.executeJavaScript(
              "window.treeportDesktop.openFileUrl('file:relative.txt')"
            ),
        origin
      )
    ).toBe('rejected')
    expect(
      await electronApp.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __openedTreeportFilePaths?: string[]
            }
          ).__openedTreeportFilePaths
      )
    ).toEqual([filePath])

    expect(
      await electronApp.evaluate(
        ({ session, webContents }, expectedOrigin) =>
          webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
            ?.session === session.fromPartition('persist:treeport-desktop'),
        origin
      )
    ).toBe(true)

    const accelerators = await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      return {
        newWorktree: menu?.getMenuItemById('new-worktree')?.accelerator,
        newTerminal: menu?.getMenuItemById('new-terminal')?.accelerator,
        newTerminalMenu:
          menu?.getMenuItemById('new-terminal-menu')?.accelerator,
        closeTerminal: menu?.getMenuItemById('close-terminal')?.accelerator
      }
    })
    expect(accelerators).toEqual({
      newWorktree: 'CommandOrControl+N',
      newTerminal: 'CommandOrControl+T',
      newTerminalMenu: 'CommandOrControl+Shift+T',
      closeTerminal: 'CommandOrControl+W'
    })

    const commandModifier = process.platform === 'darwin' ? 'meta' : 'control'
    for (const [key, command, shift] of [
      ['N', 'new-worktree', false],
      ['T', 'new-terminal', false],
      ['T', 'new-terminal-menu', true],
      ['W', 'close-terminal', false]
    ] as const) {
      await electronApp.evaluate(
        ({ webContents }, input) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(input.origin))
          const modifiers = input.shift
            ? [input.modifier, 'shift']
            : [input.modifier]
          guest?.sendInputEvent({
            type: 'keyDown',
            keyCode: input.key,
            modifiers
          })
          guest?.sendInputEvent({
            type: 'keyUp',
            keyCode: input.key,
            modifiers
          })
        },
        { origin, key, modifier: commandModifier, shift }
      )
      await expect
        .poll(() =>
          electronApp!.evaluate(
            ({ webContents }, input) => {
              const guest = webContents
                .getAllWebContents()
                .find((contents) => contents.getURL().startsWith(input.origin))
              return guest?.executeJavaScript('document.body.dataset.command')
            },
            { origin }
          )
        )
        .toBe(command)
    }
    expect(
      await electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
      )
    ).toBe(1)

    await electronApp.evaluate(({ webContents }, expectedOrigin) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(expectedOrigin))
      return guest?.executeJavaScript(
        `localStorage.setItem('treeport-last-workspace-route', '/projects/project-1/worktrees/worktree-1/terminals/terminal-1')`
      )
    }, origin)
    await electronApp.close()
    electronApp = await electron.launch({
      args: [`--user-data-dir=${userData}`, '.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TREEPORT_DESKTOP_E2E: '1',
        TREEPORT_DESKTOP_USER_DATA: '',
        TREEPORT_DESKTOP_URL: origin
      }
    })
    selector = await electronApp.firstWindow()
    await waitForGuest(electronApp, origin)
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, expectedOrigin) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
          return guest?.executeJavaScript(
            `localStorage.getItem('treeport-last-workspace-route')`
          )
        }, origin)
      )
      .toBe('/projects/project-1/worktrees/worktree-1/terminals/terminal-1')

    await electronApp.evaluate(() => {
      const filesystem = process.getBuiltinModule('node:fs/promises')
      const originalRename = filesystem.rename.bind(filesystem)
      const scope = globalThis as typeof globalThis & {
        __treeportRenameStarted?: boolean
        __releaseTreeportRename?: () => void
        __restoreTreeportRename?: () => void
      }
      let delayNextRename = true
      filesystem.rename = async (oldPath, newPath) => {
        if (delayNextRename) {
          delayNextRename = false
          scope.__treeportRenameStarted = true
          await new Promise<void>((resolve) => {
            scope.__releaseTreeportRename = resolve
          })
        }

        await originalRename(oldPath, newPath)
      }
      scope.__restoreTreeportRename = () => {
        filesystem.rename = originalRename
      }
    })
    hostname = 'hostname-persisting'
    await selector.evaluate(() => window.treeportShell.retryConnection())
    await expect
      .poll(() =>
        electronApp!.evaluate(() =>
          Boolean(
            (
              globalThis as typeof globalThis & {
                __treeportRenameStarted?: boolean
              }
            ).__treeportRenameStarted
          )
        )
      )
      .toBe(true)

    healthAvailable = false
    await selector.evaluate(() => window.treeportShell.retryConnection())
    const unavailableHeading = selector.getByRole('heading', {
      name: 'Treeport isn’t available on this computer'
    })
    await expect(unavailableHeading).toBeVisible({ timeout: 8_000 })
    await electronApp.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __releaseTreeportRename?: () => void
        __restoreTreeportRename?: () => void
      }
      scope.__releaseTreeportRename?.()
      scope.__restoreTreeportRename?.()
    })
    await expect(unavailableHeading).toBeVisible()
  } finally {
    await electronApp?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(userData, { recursive: true, force: true })
  }
})

test('adds, renames, and switches computers through the desktop-owned selector', async () => {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-electron-selector-')
  )
  const createServer = (label: string) =>
    http.createServer((request, response) => {
      if (request.url === '/api/health') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            ok: true,
            version: '0.1.0',
            protocolVersion: 2,
            hostname: label
          })
        )
        return
      }

      response.setHeader('content-type', 'text/html')
      response.end(`<body>${label} workspace</body>`)
    })
  const firstServer = createServer('first-computer')
  const secondServer = createServer('second-computer')
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null

  try {
    await Promise.all([
      new Promise<void>((resolve) =>
        firstServer.listen(0, '127.0.0.1', resolve)
      ),
      new Promise<void>((resolve) =>
        secondServer.listen(0, '127.0.0.1', resolve)
      )
    ])
    const firstAddress = firstServer.address()
    const secondAddress = secondServer.address()
    if (
      !firstAddress ||
      typeof firstAddress === 'string' ||
      !secondAddress ||
      typeof secondAddress === 'string'
    ) {
      throw new Error('Test servers did not expose ports')
    }

    const firstOrigin = `http://127.0.0.1:${firstAddress.port}`
    const secondOrigin = `http://127.0.0.1:${secondAddress.port}`

    electronApp = await electron.launch({
      args: [`--user-data-dir=${userData}`, '.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TREEPORT_DESKTOP_E2E: '1',
        TREEPORT_DESKTOP_USER_DATA: '',
        TREEPORT_DESKTOP_URL: firstOrigin
      }
    })
    const window = await electronApp.firstWindow()
    const selector = window
    await waitForGuest(electronApp, firstOrigin)

    const computerTrigger = selector.getByRole('button', {
      name: 'Connected computer: This computer'
    })
    await computerTrigger.click()
    await expect(selector.getByRole('menu')).toBeVisible()
    await computerTrigger.click()
    await expect(selector.getByRole('menu')).not.toBeVisible()
    await computerTrigger.click()
    await selector
      .getByRole('menuitem', { name: 'Connect to another computer…' })
      .click()
    const connect = window.getByRole('dialog', {
      name: 'Connect to another computer'
    })
    await expect(connect).toBeVisible()
    await connect.getByLabel('Computer URL').fill(`${secondOrigin}/project/1`)
    await connect.getByRole('button', { name: 'Connect' }).click()
    await waitForGuest(electronApp, secondOrigin)

    await selector
      .getByRole('button', { name: 'Connected computer: This computer' })
      .click()
    await expect(selector.getByRole('menu')).toBeVisible()
    await selector.getByRole('menuitem', { name: 'Manage computers…' }).click()
    const manage = window.getByRole('dialog', { name: 'Manage computers' })
    await expect(manage).toBeVisible()
    const secondForm = manage.getByRole('form', {
      name: `Edit This computer at ${secondOrigin}`
    })
    await expect(secondForm.getByLabel('URL')).toHaveValue(secondOrigin)
    await secondForm.getByLabel('Name').fill('Work VPS')
    await secondForm.getByRole('button', { name: 'Save' }).click()
    await expect(
      manage
        .getByRole('form', { name: `Edit Work VPS at ${secondOrigin}` })
        .getByLabel('Name')
    ).toHaveValue('Work VPS')
    await manage.getByRole('button', { name: 'Close' }).click()
    await expect(
      selector.getByRole('button', { name: 'Connected computer: Work VPS' })
    ).toBeVisible()

    await selector
      .getByRole('button', { name: 'Connected computer: Work VPS' })
      .click()
    await expect(selector.getByRole('menu')).toBeVisible()
    await selector
      .getByRole('menuitemradio', {
        name: new RegExp(firstOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      })
      .click()
    await waitForGuest(electronApp, firstOrigin)
    await expect(
      selector.getByRole('button', {
        name: 'Connected computer: This computer'
      })
    ).toBeVisible()
  } finally {
    await electronApp?.close().catch(() => undefined)
    await Promise.all([
      new Promise<void>((resolve) => firstServer.close(() => resolve())),
      new Promise<void>((resolve) => secondServer.close(() => resolve()))
    ])
    await fs.rm(userData, { recursive: true, force: true })
  }
})

test('keeps an incompatible computer in the shell without loading its web app', async () => {
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
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a port')
    }

    electronApp = await electron.launch({
      args: [`--user-data-dir=${userData}`, '.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TREEPORT_DESKTOP_E2E: '1',
        TREEPORT_DESKTOP_USER_DATA: '',
        TREEPORT_DESKTOP_URL: `http://127.0.0.1:${address.port}`
      }
    })
    const window = await electronApp.firstWindow()

    await expect(
      window.getByRole('heading', {
        name: 'This Treeport version is incompatible'
      })
    ).toBeVisible()
    await expect(
      window.getByText('Desktop 0.1.0 · Treeport 0.0.1')
    ).toBeVisible()
    expect(applicationRequests).toBe(0)
  } finally {
    await electronApp?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(userData, { recursive: true, force: true })
  }
})
