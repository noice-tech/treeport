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
      <body data-bell-action="none" data-bell-fallback="none" data-bell-native="none" data-command="none">TaskTTY desktop test</body>
      <script>
        window.taskttyDesktop.onCommand((command) => {
          document.body.dataset.command = command
        })
        window.taskttyDesktop.onBellNotificationFallback((notification) => {
          document.body.dataset.bellFallback = JSON.stringify(notification)
        })
        window.taskttyDesktop.onBellNotificationNative((notification) => {
          document.body.dataset.bellNative = JSON.stringify(notification)
        })
        window.taskttyDesktop.onBellNotificationAction((action) => {
          document.body.dataset.bellAction = JSON.stringify(action)
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
    expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(false)
    await electronApp.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0]?.focus()
    })
    await window.bringToFront()
    await expect(window.locator('body')).toHaveAttribute('data-command', 'none')
    expect(
      await window.evaluate(() => ({
        show: typeof window.taskttyDesktop.showBellNotification,
        clear: typeof window.taskttyDesktop.clearBellNotification,
        fallback: typeof window.taskttyDesktop.onBellNotificationFallback,
        native: typeof window.taskttyDesktop.onBellNotificationNative,
        actions: typeof window.taskttyDesktop.onBellNotificationAction
      }))
    ).toEqual({
      show: 'function',
      clear: 'function',
      fallback: 'function',
      native: 'function',
      actions: 'function'
    })
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'bell-notification:action',
        { type: 'dismiss', terminalId: '', sequence: 0 }
      )
    })
    await expect(window.locator('body')).toHaveAttribute(
      'data-bell-action',
      'none'
    )
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'bell-notification:action',
        { type: 'view', terminalId: 'term_one', sequence: 7 }
      )
    })
    await expect(window.locator('body')).toHaveAttribute(
      'data-bell-action',
      JSON.stringify({ type: 'view', terminalId: 'term_one', sequence: 7 })
    )
    await electronApp.evaluate(({ BrowserWindow }) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents
      webContents?.send('bell-notification:fallback', {
        terminalId: '',
        sequence: 0
      })
      webContents?.send('bell-notification:fallback', {
        terminalId: 'term_extra',
        sequence: 4,
        extra: true
      })
    })
    await expect(window.locator('body')).toHaveAttribute(
      'data-bell-fallback',
      'none'
    )
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'bell-notification:fallback',
        { terminalId: 'term_valid', sequence: 4 }
      )
    })
    await expect(window.locator('body')).toHaveAttribute(
      'data-bell-fallback',
      JSON.stringify({ terminalId: 'term_valid', sequence: 4 })
    )
    await window.evaluate(() =>
      window.taskttyDesktop.showBellNotification({
        terminalId: 'term_dev',
        sequence: 8,
        title: 'Development terminal',
        projectName: 'TaskTTY',
        worktreeName: 'notifications'
      })
    )
    await expect(window.locator('body')).toHaveAttribute(
      'data-bell-fallback',
      JSON.stringify({ terminalId: 'term_dev', sequence: 8 })
    )
    await window.evaluate(() => {
      window.taskttyDesktop.showBellNotification({
        terminalId: 'term_dev',
        sequence: 7,
        title: 'Stale terminal',
        projectName: 'TaskTTY',
        worktreeName: 'notifications'
      })
      window.taskttyDesktop.clearBellNotification({
        terminalId: 'term_dev',
        sequence: 8
      })
    })
    await expect(window.locator('body')).toHaveAttribute(
      'data-bell-fallback',
      JSON.stringify({ terminalId: 'term_dev', sequence: 8 })
    )
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
