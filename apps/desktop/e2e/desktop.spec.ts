import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

test('dispatches native commands and opens local file URLs', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'tasktty-electron-'))
  const server = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, version: 1 }))
      return
    }

    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html>
      <body data-command="none">TaskTTY desktop test</body>
      <script>
        window.taskttyDesktop.onCommand((command) => {
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

    electronApp = await electron.launch({
      args: [`--user-data-dir=${userData}`, '.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TASKTTY_DESKTOP_URL: `http://127.0.0.1:${address.port}`
      }
    })

    const window = await electronApp.firstWindow()
    await electronApp.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0]?.focus()
    })
    await window.bringToFront()
    await expect(window.locator('body')).toHaveAttribute('data-command', 'none')
    const preferences = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()
    )
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    })

    await electronApp.evaluate(({ shell }) => {
      const scope = globalThis as typeof globalThis & {
        __openedTaskTTYFilePaths?: string[]
      }
      scope.__openedTaskTTYFilePaths = []
      shell.openPath = async (filePath) => {
        scope.__openedTaskTTYFilePaths!.push(filePath)
        return ''
      }
    })
    const filePath = path.join(userData, 'résumé draft.txt')
    await expect(
      window.evaluate(
        (url) => (window as any).taskttyDesktop.openFileUrl(url),
        pathToFileURL(filePath).href
      )
    ).resolves.toBe(true)
    await expect(
      window.evaluate(() =>
        (window as any).taskttyDesktop.openFileUrl('file:relative.txt')
      )
    ).resolves.toBe(false)
    expect(
      await electronApp.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __openedTaskTTYFilePaths?: string[]
            }
          ).__openedTaskTTYFilePaths
      )
    ).toEqual([filePath])

    expect(
      await electronApp.evaluate(
        ({ BrowserWindow, session }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.session ===
          session.fromPartition('tasktty-desktop')
      )
    ).toBe(true)

    const accelerators = await electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      return {
        newWorktree: menu?.getMenuItemById('new-worktree')?.accelerator,
        newTerminal: menu?.getMenuItemById('new-terminal')?.accelerator,
        closeTerminal: menu?.getMenuItemById('close-terminal')?.accelerator
      }
    })
    expect(accelerators).toEqual({
      newWorktree: 'CommandOrControl+N',
      newTerminal: 'CommandOrControl+T',
      closeTerminal: 'CommandOrControl+W'
    })

    const commandModifier = process.platform === 'darwin' ? 'meta' : 'control'
    await electronApp.evaluate(
      ({ BrowserWindow }, input) => {
        const webContents = BrowserWindow.getAllWindows()[0]?.webContents
        webContents?.sendInputEvent({
          type: 'keyDown',
          keyCode: input.key,
          modifiers: [input.modifier]
        })
        webContents?.sendInputEvent({
          type: 'keyUp',
          keyCode: input.key,
          modifiers: [input.modifier]
        })
      },
      { key: 'N', modifier: commandModifier }
    )
    await expect(window.locator('body')).toHaveAttribute(
      'data-command',
      'new-worktree'
    )

    await electronApp.evaluate(
      ({ BrowserWindow }, input) => {
        const webContents = BrowserWindow.getAllWindows()[0]?.webContents
        webContents?.sendInputEvent({
          type: 'keyDown',
          keyCode: input.key,
          modifiers: [input.modifier]
        })
        webContents?.sendInputEvent({
          type: 'keyUp',
          keyCode: input.key,
          modifiers: [input.modifier]
        })
      },
      { key: 'T', modifier: commandModifier }
    )
    await expect(window.locator('body')).toHaveAttribute(
      'data-command',
      'new-terminal'
    )

    await electronApp.evaluate(
      ({ BrowserWindow }, input) => {
        const webContents = BrowserWindow.getAllWindows()[0]?.webContents
        webContents?.sendInputEvent({
          type: 'keyDown',
          keyCode: input.key,
          modifiers: [input.modifier]
        })
        webContents?.sendInputEvent({
          type: 'keyUp',
          keyCode: input.key,
          modifiers: [input.modifier]
        })
      },
      { key: 'W', modifier: commandModifier }
    )
    await expect(window.locator('body')).toHaveAttribute(
      'data-command',
      'close-terminal'
    )
    expect(electronApp.windows()).toHaveLength(1)
  } finally {
    await electronApp?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(userData, { recursive: true, force: true })
  }
})
