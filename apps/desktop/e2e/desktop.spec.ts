import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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

async function waitForGuest(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
  origin: string
): Promise<void> {
  await expect
    .poll(
      () =>
        electronApp.evaluate(
          ({ webContents }, expectedOrigin) =>
            webContents
              .getAllWebContents()
              .some((contents) => contents.getURL().startsWith(expectedOrigin)),
          origin
        ),
      { timeout: 15_000 }
    )
    .toBe(true)
}

test('connects the desktop shell, preserves native behavior, and restores renderer state', async () => {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-electron-')
  )
  const sourceFilePath = path.join(userData, "résumé '$draft.txt")
  await fs.writeFile(sourceFilePath, 'local source')
  let healthAvailable = true
  let hostname = 'desktop-test'
  const recoveryServer = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html>
      <title>Native Browser recovered</title>
      <body>Native Browser recovered</body>`)
  })
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
    if (request.url === '/native-browser-start') {
      response.end(`<!doctype html>
        <title>Native Browser start</title>
        <body>Native Browser start</body>`)
      return
    }

    if (request.url === '/native-browser-protected') {
      response.end(`<!doctype html>
        <title>Native Browser protected</title>
        <body>Native Browser protected</body>`)
      return
    }

    if (request.url === '/native-browser-popup') {
      response.end(`<!doctype html>
        <title>Native Browser popup</title>
        <body>Native Browser popup</body>`)
      return
    }

    response.end(`<!doctype html>
      <body data-command="none">
        Treeport desktop test
        <input id="source-file" type="file">
        <a href="https://example.test/docs" target="_blank" rel="noopener noreferrer">Open docs</a>
      </body>
      <script>
        window.treeportDesktop.onCommand((command) => {
          document.body.dataset.command = command
        })
      </script>`)
  })
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = serverPort(server.address())
    const origin = `http://127.0.0.1:${port}`
    const workspaceUrl = `${origin}/projects/project-1/worktrees/worktree-1`
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )

    electronApp = await electron.launch({
      args: [`--user-data-dir=${userData}`, '.', workspaceLink(workspaceUrl)],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TREEPORT_DESKTOP_E2E: '1',
        TREEPORT_DESKTOP_E2E_UPDATE_READY: '1',
        TREEPORT_DESKTOP_USER_DATA: '',
        TREEPORT_DESKTOP_URL: origin
      }
    })

    let selector = await electronApp.firstWindow()
    const installUpdate = selector.getByRole('button', {
      name: 'Update & restart'
    })
    await expect(installUpdate).toBeVisible()
    await installUpdate.click()
    await expect(installUpdate).not.toBeVisible()
    await expect(selector.getByRole('button', { name: 'Back' })).toBeDisabled()
    await expect(
      selector.getByRole('button', { name: 'Forward' })
    ).toBeDisabled()
    await expect(
      selector.getByRole('heading', {
        name: 'Treeport isn’t available on this computer'
      })
    ).toBeVisible({ timeout: 8_000 })
    await expect(
      selector.getByText(
        'Start Treeport. The desktop app will reconnect automatically.'
      )
    ).toBeVisible()
    await new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', resolve)
    )
    await expect(
      selector.getByRole('button', {
        name: 'Connected computer: This computer'
      })
    ).toBeVisible({ timeout: 8_000 })
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

    await expect
      .poll(() =>
        electronApp!.evaluate(
          ({ webContents }, targetUrl) =>
            webContents
              .getAllWebContents()
              .some((contents) => contents.getURL() === targetUrl),
          workspaceUrl
        )
      )
      .toBe(true)

    const nativePanelId = 'panel_native_browser'
    const nativeStartUrl = `${origin}/native-browser-start`
    const nativeProtectedUrl = `${origin}/native-browser-protected`
    await electronApp.evaluate(
      async ({ webContents }, input) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === input.workspaceUrl)
        if (!guest) {
          throw new Error('Treeport guest was not found')
        }

        await guest.executeJavaScript(`
          window.__nativeBrowserPopups = []
          window.treeportDesktop.onBrowserPopup((popup) => {
            window.__nativeBrowserPopups.push(popup)
          })
          window.treeportDesktop.openBrowser(
            ${JSON.stringify(input.panelId)},
            ${JSON.stringify(input.startUrl)}
          ).then(() => {
            window.treeportDesktop.setBrowserBounds(
              ${JSON.stringify(input.panelId)},
              { x: 280, y: 48, width: 900, height: 600 }
            )
            window.treeportDesktop.setBrowserVisible(
              ${JSON.stringify(input.panelId)},
              true
            )
          })
        `)
      },
      {
        workspaceUrl,
        panelId: nativePanelId,
        startUrl: nativeStartUrl
      }
    )
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, targetUrl) => {
          const browser = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === targetUrl)
          return browser?.executeJavaScript('document.body.textContent')
        }, nativeStartUrl)
      )
      .toContain('Native Browser start')

    await electronApp.evaluate(
      ({ webContents }, input) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === input.workspaceUrl)
        return guest?.executeJavaScript(`
          window.treeportDesktop.sendBrowserCommand(
            ${JSON.stringify(input.panelId)},
            { type: 'navigate', url: ${JSON.stringify(input.protectedUrl)} }
          )
        `)
      },
      {
        workspaceUrl,
        panelId: nativePanelId,
        protectedUrl: nativeProtectedUrl
      }
    )
    await expect
      .poll(() =>
        electronApp!.evaluate(
          ({ webContents }, targetUrl) =>
            webContents
              .getAllWebContents()
              .some((contents) => contents.getURL() === targetUrl),
          nativeProtectedUrl
        )
      )
      .toBe(true)
    await electronApp.evaluate(({ webContents }, targetUrl) => {
      const browser = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === targetUrl)
      return browser?.executeJavaScript(`window.open('/native-browser-popup')`)
    }, nativeProtectedUrl)
    await expect
      .poll(() =>
        electronApp!.evaluate(
          ({ webContents }, input) => {
            const guest = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL() === input.workspaceUrl)
            return guest?.executeJavaScript(
              `window.__nativeBrowserPopups.some((popup) => popup.panelId === ${JSON.stringify(input.panelId)} && popup.url === ${JSON.stringify(input.popupUrl)})`
            )
          },
          {
            workspaceUrl,
            panelId: nativePanelId,
            popupUrl: `${origin}/native-browser-popup`
          }
        )
      )
      .toBe(true)

    await new Promise<void>((resolve) =>
      recoveryServer.listen(0, '127.0.0.1', resolve)
    )
    const recoveryPort = serverPort(recoveryServer.address())
    const recoveryUrl = `http://127.0.0.1:${recoveryPort}/`
    await new Promise<void>((resolve) => recoveryServer.close(() => resolve()))
    await electronApp.evaluate(
      ({ webContents }, input) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === input.workspaceUrl)
        return guest?.executeJavaScript(`
          window.treeportDesktop.sendBrowserCommand(
            ${JSON.stringify(input.panelId)},
            { type: 'navigate', url: ${JSON.stringify(input.recoveryUrl)} }
          )
        `)
      },
      {
        workspaceUrl,
        panelId: nativePanelId,
        recoveryUrl
      }
    )
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, targetUrl) => {
          const browser = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === targetUrl)
          return browser?.executeJavaScript(`({
            heading: document.querySelector('h1')?.textContent,
            code: document.querySelector('code')?.textContent,
            reload: document.querySelector('button')?.textContent
          })`)
        }, recoveryUrl)
      )
      .toEqual({
        heading: 'This site cannot be reached',
        code: 'ERR_CONNECTION_REFUSED',
        reload: 'Reload'
      })

    await new Promise<void>((resolve) =>
      recoveryServer.listen(recoveryPort, '127.0.0.1', resolve)
    )
    await electronApp.evaluate(({ webContents }, targetUrl) => {
      const browser = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === targetUrl)
      return browser?.executeJavaScript(
        `document.querySelector('button')?.click()`
      )
    }, recoveryUrl)
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, targetUrl) => {
          const browser = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === targetUrl)
          return browser?.executeJavaScript('document.body.textContent')
        }, recoveryUrl)
      )
      .toContain('Native Browser recovered')

    expect(
      await electronApp.evaluate(
        async ({ webContents }, input) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === input.workspaceUrl)
          return guest?.executeJavaScript(
            `window.treeportDesktop.requestBrowserClose(${JSON.stringify(input.panelId)}, false)`
          )
        },
        { workspaceUrl, panelId: nativePanelId }
      )
    ).toBe(true)
    await expect
      .poll(() =>
        electronApp!.evaluate(
          ({ webContents }, targetUrl) =>
            webContents
              .getAllWebContents()
              .some((contents) => contents.getURL() === targetUrl),
          recoveryUrl
        )
      )
      .toBe(false)

    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await electronApp.evaluate(({ webContents }, expectedOrigin) => {
      webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(expectedOrigin))
        ?.reload()
    }, origin)
    await expect(
      selector.getByRole('heading', {
        name: 'Treeport isn’t available on this computer'
      })
    ).toBeVisible({ timeout: 8_000 })
    await expect(selector.getByRole('button', { name: 'Back' })).toBeDisabled()
    await expect(
      selector.getByRole('button', { name: 'Forward' })
    ).toBeDisabled()
    await new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', resolve)
    )
    await selector.evaluate(() => window.treeportShell.retryConnection())
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, expectedOrigin) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
          return guest
            ?.executeJavaScript('document.body.textContent')
            .catch(() => null)
        }, origin)
      )
      .toContain('Treeport desktop test')
    const backButton = selector.getByRole('button', { name: 'Back' })
    const forwardButton = selector.getByRole('button', { name: 'Forward' })
    await expect(backButton).toBeDisabled()
    await expect(forwardButton).toBeDisabled()

    const terminalPath =
      '/projects/project-1/worktrees/worktree-1/terminals/terminal-1'
    const panelPath = '/projects/project-1/worktrees/worktree-1/panels/panel-1'
    const alternateProjectPath = '/projects/project-2'
    await electronApp.evaluate(
      ({ webContents }, input) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(input.origin))
        return guest?.executeJavaScript(`
          history.pushState({}, '', ${JSON.stringify(input.terminalPath)})
          history.pushState({}, '', ${JSON.stringify(input.panelPath)})
        `)
      },
      { origin, terminalPath, panelPath }
    )
    await expect(backButton).toBeEnabled()
    await expect(forwardButton).toBeDisabled()

    await backButton.click()
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, expectedOrigin) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
          return guest?.executeJavaScript('location.pathname')
        }, origin)
      )
      .toBe(terminalPath)
    await expect(backButton).toBeEnabled()
    await expect(forwardButton).toBeEnabled()

    await forwardButton.click()
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, expectedOrigin) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
          return guest?.executeJavaScript('location.pathname')
        }, origin)
      )
      .toBe(panelPath)

    await backButton.click()
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, expectedOrigin) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
          return guest?.executeJavaScript('location.pathname')
        }, origin)
      )
      .toBe(terminalPath)
    await electronApp.evaluate(
      ({ webContents }, input) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(input.origin))
        return guest?.executeJavaScript(
          `history.pushState({}, '', ${JSON.stringify(input.path)})`
        )
      },
      { origin, path: alternateProjectPath }
    )
    await expect(backButton).toBeEnabled()
    await expect(forwardButton).toBeDisabled()

    if (process.platform === 'darwin') {
      for (const [key, expectedPath] of [
        ['[', terminalPath],
        [']', alternateProjectPath]
      ] as const) {
        await electronApp.evaluate(
          ({ webContents }, input) => {
            const guest = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL().startsWith(input.origin))
            guest?.sendInputEvent({
              type: 'keyDown',
              keyCode: input.key,
              modifiers: ['meta']
            })
            guest?.sendInputEvent({
              type: 'keyUp',
              keyCode: input.key,
              modifiers: ['meta']
            })
          },
          { origin, key }
        )
        await expect
          .poll(() =>
            electronApp!.evaluate(({ webContents }, expectedOrigin) => {
              const guest = webContents
                .getAllWebContents()
                .find((contents) =>
                  contents.getURL().startsWith(expectedOrigin)
                )
              return guest?.executeJavaScript('location.pathname')
            }, origin)
          )
          .toBe(expectedPath)
      }
    }

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

    await electronApp.evaluate(
      async ({ webContents }, input) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(input.origin))
        if (!guest) {
          throw new Error('Guest web contents were not found')
        }

        guest.debugger.attach('1.3')
        const document = await guest.debugger.sendCommand('DOM.getDocument')
        const sourceInput = await guest.debugger.sendCommand(
          'DOM.querySelector',
          {
            nodeId: document.root.nodeId,
            selector: '#source-file'
          }
        )
        await guest.debugger.sendCommand('DOM.setFileInputFiles', {
          files: [input.filePath],
          nodeId: sourceInput.nodeId
        })
        guest.debugger.detach()
      },
      { origin, filePath: sourceFilePath }
    )
    expect(
      await electronApp.evaluate(async ({ webContents }, expectedOrigin) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(expectedOrigin))
        return guest?.executeJavaScript(
          'window.treeportDesktop.getPathForFile(document.querySelector("#source-file").files[0])'
        )
      }, origin)
    ).toBe(sourceFilePath)
    expect(
      await electronApp.evaluate(async ({ webContents }, expectedOrigin) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(expectedOrigin))
        return guest?.executeJavaScript(
          'window.treeportDesktop.getPathForFile(new File(["synthetic"], "synthetic.txt"))'
        )
      }, origin)
    ).toBeNull()

    await electronApp.evaluate(({ webContents }, expectedOrigin) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(expectedOrigin))
      return guest?.executeJavaScript(`
        window.__terminalSelectionReleased = false
        window.treeportDesktop.onTerminalSelectionRelease(() => {
          window.__terminalSelectionReleased = true
        })
        window.treeportDesktop.setTerminalSelectionActive(true)
      `)
    }, origin)
    const shellWidth = await selector.evaluate(() => window.innerWidth)
    await selector.mouse.move(shellWidth / 2, 100)
    await selector.mouse.down()
    await selector.mouse.move(shellWidth - 100, 16)
    await selector.mouse.move(shellWidth + 100, -50)
    await selector.mouse.up()
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, expectedOrigin) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
          return guest?.executeJavaScript('window.__terminalSelectionReleased')
        }, origin)
      )
      .toBe(true)
    await selector.keyboard.press('Escape')

    await electronApp.evaluate(({ shell }) => {
      // SAFETY: The test fixture provides the asserted contract used here.
      const scope = globalThis as typeof globalThis & {
        __openedTreeportFilePaths?: string[]
        __openedTreeportExternalUrls?: string[]
      }
      scope.__openedTreeportFilePaths = []
      scope.__openedTreeportExternalUrls = []
      shell.openPath = async (filePath) => {
        scope.__openedTreeportFilePaths!.push(filePath)
        return ''
      }
      shell.openExternal = async (url) => {
        scope.__openedTreeportExternalUrls!.push(url)
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
          // SAFETY: The test fixture provides the asserted contract used here.
          (
            globalThis as typeof globalThis & {
              __openedTreeportFilePaths?: string[]
            }
          ).__openedTreeportFilePaths
      )
    ).toEqual([filePath])

    await electronApp.evaluate(({ webContents }, expectedOrigin) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(expectedOrigin))
      return guest?.executeJavaScript(`document.querySelector('a')?.click()`)
    }, origin)
    await expect
      .poll(() =>
        electronApp!.evaluate(
          () =>
            // SAFETY: The test fixture provides the asserted contract used here.
            (
              globalThis as typeof globalThis & {
                __openedTreeportExternalUrls?: string[]
              }
            ).__openedTreeportExternalUrls
        )
      )
      .toEqual(['https://example.test/docs'])

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
        newTreeLabel: menu?.getMenuItemById('new-worktree')?.label,
        newTerminal: menu?.getMenuItemById('new-terminal')?.accelerator,
        newPanel: menu?.getMenuItemById('new-panel')?.accelerator,
        newPanelLabel: menu?.getMenuItemById('new-panel')?.label,
        closePanel: menu?.getMenuItemById('close-panel')?.accelerator,
        closePanelLabel: menu?.getMenuItemById('close-panel')?.label,
        back: menu?.getMenuItemById('navigate-back')?.accelerator ?? null,
        backEnabled: menu?.getMenuItemById('navigate-back')?.enabled,
        forward: menu?.getMenuItemById('navigate-forward')?.accelerator ?? null,
        forwardEnabled: menu?.getMenuItemById('navigate-forward')?.enabled
      }
    })
    expect(accelerators).toEqual({
      newWorktree: 'CommandOrControl+N',
      newTreeLabel: 'New tree…',
      newTerminal: 'CommandOrControl+T',
      newPanel: 'CommandOrControl+Shift+T',
      newPanelLabel: 'New Panel…',
      closePanel: 'CommandOrControl+W',
      closePanelLabel: 'Close Panel',
      back: process.platform === 'darwin' ? 'Command+[' : null,
      backEnabled: true,
      forward: process.platform === 'darwin' ? 'Command+]' : null,
      forwardEnabled: false
    })

    const commandModifier = process.platform === 'darwin' ? 'meta' : 'control'
    for (const [key, command, shift] of [
      ['N', 'new-worktree', false],
      ['T', 'new-terminal', false],
      ['T', 'new-panel', true],
      ['W', 'close-panel', false]
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
    await expect(selector.getByRole('button', { name: 'Back' })).toBeDisabled()
    await expect(
      selector.getByRole('button', { name: 'Forward' })
    ).toBeDisabled()

    await electronApp.evaluate(() => {
      const filesystem = process.getBuiltinModule('node:fs/promises')
      const originalRename = filesystem.rename.bind(filesystem)
      // SAFETY: The test fixture provides the asserted contract used here.
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
            // SAFETY: The test fixture provides the asserted contract used here.
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
      // SAFETY: The test fixture provides the asserted contract used here.
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
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => recoveryServer.close(() => resolve()))
    ])
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
      const content = request.url?.includes('/worktrees/worktree-1')
        ? `${label} worktree`
        : `${label} workspace`
      response.end(`<body>${content}</body>`)
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
    const firstPort = serverPort(firstServer.address())
    const secondPort = serverPort(secondServer.address())
    const firstOrigin = `http://127.0.0.1:${firstPort}`
    const secondOrigin = `http://127.0.0.1:${secondPort}`

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

    await selector
      .getByRole('button', { name: 'Connected computer: This computer' })
      .click()
    await selector.getByRole('menuitemradio', { name: /Work VPS/ }).click()
    await waitForGuest(electronApp, secondOrigin)

    const linkedWorkspaceUrl = `${firstOrigin}/projects/project-1/worktrees/worktree-1`
    await electronApp.evaluate(
      ({ app }, deepLink) =>
        // SAFETY: The test fixture provides the asserted contract used here.
        app.emit('open-url', { preventDefault() {} } as never, deepLink),
      workspaceLink(linkedWorkspaceUrl)
    )
    await expect(
      selector.getByRole('button', {
        name: 'Connected computer: This computer'
      })
    ).toBeVisible()
    await expect
      .poll(() =>
        electronApp!.evaluate(({ webContents }, expectedOrigin) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(expectedOrigin))
          return guest?.executeJavaScript('document.body.textContent')
        }, firstOrigin)
      )
      .toContain('first-computer worktree')
    expect(
      await electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
      )
    ).toBe(1)
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
    const desktopVersion = await electronApp.evaluate(({ app }) =>
      app.getVersion()
    )
    await expect(
      window.getByText(`Desktop ${desktopVersion} · Treeport 0.0.1`)
    ).toBeVisible()
    expect(applicationRequests).toBe(0)
  } finally {
    await electronApp?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(userData, { recursive: true, force: true })
  }
})
