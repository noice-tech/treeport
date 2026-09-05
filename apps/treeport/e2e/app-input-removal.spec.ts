import { expect, test } from '@playwright/test'
import { mockApp } from './support/mock-app'
import {
  openWorktreeContextMenu,
  requestTerminalControl,
  waitForTerminalControl
} from './support/interactions'
test.describe('desktop terminal input and removal', () => {
  test('uses trusted local file paths and uploads files without one', async ({
    page
  }) => {
    const directPaths = {
      'shot one.png': '/Users/example/Desktop/shot one.png',
      "notes '$draft.txt": "/Users/example/Desktop/notes '$draft.txt"
    }
    const mocked = await mockApp(page, [], {
      desktopBridge: true,
      desktopFilePaths: directPaths
    })
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[?2004h'
        })
      })
      window.__wsSent = []
      window.__delayTakeControl = true
      window.__pasteTerminalFile = () => {
        const textarea = document.querySelector('.xterm-helper-textarea')!
        const clipboard = new DataTransfer()
        clipboard.items.add(
          new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot one.png', {
            type: 'image/png'
          })
        )
        clipboard.items.add(
          new File(['draft'], "notes '$draft.txt", { type: 'text/plain' })
        )
        const event = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: clipboard })
        return {
          files: clipboard.files.length,
          prevented: !textarea.dispatchEvent(event)
        }
      }
    })

    const pasteWhileViewing = await page.evaluate(() =>
      window.__pasteTerminalFile()
    )
    expect(pasteWhileViewing).toEqual({ files: 2, prevented: true })
    await expect(page.getByRole('alert')).toContainText(
      'Couldn’t paste file: taking control; try again in a moment'
    )
    expect(mocked.fileUploadRequests()).toBe(0)

    await page.evaluate(() => window.__releaseTakeControl())
    await waitForTerminalControl(page)
    const paste = await page.evaluate(() => window.__pasteTerminalFile())
    expect(paste).toEqual({ files: 2, prevented: true })
    expect(mocked.fileUploadRequests()).toBe(0)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
            .join('')
        )
      )
      .toContain(
        "\u001b[200~'/Users/example/Desktop/shot one.png' '/Users/example/Desktop/notes '\\''$draft.txt'\u001b[201~"
      )

    const drop = await page
      .locator('.xterm-screen')
      .evaluate((terminalHost) => {
        const transfer = new DataTransfer()
        transfer.items.add(
          new File(['hello'], 'notes.txt', { type: 'text/plain' })
        )
        const dragoverPrevented = !terminalHost.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
          })
        )
        const dropPrevented = !terminalHost.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
          })
        )
        return { dragoverPrevented, dropPrevented }
      })
    expect(drop).toEqual({
      dragoverPrevented: true,
      dropPrevented: true
    })

    await expect.poll(mocked.fileUploadRequests).toBe(1)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
            .join('')
        )
      )
      .toContain('/tmp/treeport-upload-1.txt')
  })

  test('keeps browser scrolling and selection local while forwarding application wheel events', async ({
    page
  }) => {
    await mockApp(page, [], {
      keyboardPlatform: 'MacIntel',
      desktopBridge: true
    })
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await requestTerminalControl(page)
    const textarea = page.locator('.xterm-helper-textarea')
    await textarea.focus()
    await page.evaluate(() => {
      window.__wsSent = []
    })
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Meta+ArrowLeft')
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.press('Alt+ArrowLeft')
    await page.keyboard.press('Alt+ArrowRight')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
        )
      )
      .toEqual(['\u001b[13;2u', '\u001b[H', '\u001b[F', '\u001bb', '\u001bf'])

    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: Array.from(
            { length: 120 },
            (_, index) => `local-history-${index}\r\n`
          ).join('')
        })
      })
      window.__wsSent = []
    })
    const screen = page.locator('.xterm-screen')
    await screen.hover()
    await page.mouse.wheel(0, -600)
    await expect(screen).not.toContainText('local-history-119')
    expect(
      await page.evaluate(() =>
        window.__wsSent.filter((message: any) => message.type === 'input')
      )
    ).toEqual([])

    const bounds = await screen.boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.move(bounds!.x + 10, bounds!.y + 10)
    await page.mouse.down()
    await page.mouse.move(bounds!.x + 120, bounds!.y + 10, { steps: 5 })
    await page.mouse.up()
    expect(
      await page.evaluate(() =>
        window.__wsSent.filter((message: any) => message.type === 'input')
      )
    ).toEqual([])

    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 3,
          data: '\u001b[?1000h\u001b[?1006h'
        })
      })
      window.__wsSent = []
    })
    await screen.dispatchEvent('wheel', { deltaY: -120 })
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent.some(
            (message: any) =>
              message.type === 'input' &&
              String(message.data).includes('\u001b[<')
          )
        )
      )
      .toBe(true)
  })

  test('shows cleanup progress, retries failure, and permits an explicit skip', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.setRemovePreview({
      cleanup: {
        commands: ['Drop database', 'Remove cache'],
        available: true,
        unavailableReason: null
      }
    })
    const menu = await openWorktreeContextMenu(page, 'topic')
    await menu.getByRole('menuitem', { name: 'Remove tree…' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Remove tree' })
    await expect(dialog.getByText('Drop database')).toBeVisible()
    await dialog.getByRole('button', { name: 'Remove tree' }).click()
    await expect.poll(() => mocked.removeRequests()).toBe(1)

    mocked.setRemovalCleanup('running', [
      {
        name: 'Drop database',
        status: 'completed',
        stdout: 'Database removed\n',
        stderr: '',
        exitCode: 0,
        error: null,
        outputTruncated: false
      },
      {
        name: 'Remove cache',
        status: 'running',
        stdout: '',
        stderr: '',
        exitCode: null,
        error: null,
        outputTruncated: false
      }
    ])
    await expect(page.getByText('Database removed')).toBeVisible()
    await expect(
      page.getByText('Running cleanup command: Remove cache')
    ).toBeVisible()

    mocked.setRemovalCleanup(
      'failed',
      [
        {
          name: 'Drop database',
          status: 'completed',
          stdout: 'Database removed\n',
          stderr: '',
          exitCode: 0,
          error: null,
          outputTruncated: false
        },
        {
          name: 'Remove cache',
          status: 'failed',
          stdout: '',
          stderr: 'Cache is in use\n',
          exitCode: 1,
          error: 'exit 1',
          outputTruncated: false
        }
      ],
      'Project cleanup command “Remove cache” failed. Git kept the tree.'
    )
    await expect(
      page.getByText('Project cleanup failed. Git kept the tree.')
    ).toBeVisible()
    await expect(page.getByText('Cache is in use')).toBeVisible()
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(
      page.getByRole('alertdialog', { name: 'Remove tree' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Remove tree' }).click()
    await expect.poll(() => mocked.removeRequests()).toBe(2)
    mocked.setRemovalCleanup(
      'failed',
      [
        {
          name: 'Drop database',
          status: 'failed',
          stdout: '',
          stderr: 'Legacy tree has no isolated database\n',
          exitCode: 1,
          error: 'exit 1',
          outputTruncated: false
        },
        {
          name: 'Remove cache',
          status: 'pending',
          stdout: '',
          stderr: '',
          exitCode: null,
          error: null,
          outputTruncated: false
        }
      ],
      'Project cleanup command “Drop database” failed. Git kept the tree.'
    )
    await expect(
      page.getByText(
        'Removing without cleanup can leave project resources behind.'
      )
    ).toBeVisible()
    await page.getByRole('button', { name: 'Remove without cleanup' }).click()
    await expect.poll(() => mocked.removeRequests()).toBe(3)
    expect(mocked.removeRequestBodies().at(-1)).toMatchObject({
      confirmDestructive: true,
      skipCleanup: true
    })
    mocked.completeRemoval()
    await expect(
      page.getByText('Treeport skipped project cleanup and removed the tree.')
    ).toBeVisible()
  })

  test('retries a stale clean preview without a dialog or repeated requests', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.setRemovePreviewDelay(200)
    mocked.staleNextRemoveWithPreview({
      confirmationToken: 'c'.repeat(64)
    })
    const releaseRemove = mocked.delayNextRemove()
    const menu = await openWorktreeContextMenu(page, 'topic')
    const removeItem = menu.getByRole('menuitem', {
      name: 'Remove tree…'
    })
    await removeItem.evaluate((item: HTMLElement) => {
      item.click()
      item.click()
    })

    await expect(page.getByText('Preparing removal…')).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'topic, removing' })
    ).toBeVisible()
    await expect.poll(() => mocked.removePreviewRequests()).toBe(2)
    await expect(page.getByText('Removing…')).toHaveCount(0)
    await expect.poll(() => mocked.removeRequests()).toBe(2)
    await expect(
      page.getByRole('heading', { name: 'Remove tree' })
    ).toHaveCount(0)
    expect(mocked.removeRequestBodies()).toEqual([
      {
        confirmationToken: 'a'.repeat(64),
        confirmDestructive: false
      },
      {
        confirmationToken: 'c'.repeat(64),
        confirmDestructive: false
      }
    ])
    releaseRemove()
  })

  test('refreshes a stale clean preview and requires confirmation when it becomes dirty', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.staleNextRemoveWithPreview({
      dirty: {
        dirty: true,
        staged: 0,
        unstaged: 0,
        untracked: 1,
        conflicts: 0,
        total: 1
      },
      forceRequired: true,
      warnings: ['1 untracked file(s) will be lost'],
      confirmationToken: 'c'.repeat(64)
    })
    const menu = await openWorktreeContextMenu(page, 'topic')
    await menu.getByRole('menuitem', { name: 'Remove tree…' }).click()

    await expect(
      page.getByRole('heading', { name: 'Remove tree' })
    ).toBeVisible()
    await expect(
      page.getByText('1 untracked file(s) will be lost')
    ).toBeVisible()
    expect(mocked.removeRequests()).toBe(1)
    const secondRemove = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/remove')
    )
    await page.getByRole('button', { name: 'Remove anyway' }).click()
    expect((await secondRemove).postDataJSON()).toEqual({
      confirmationToken: 'c'.repeat(64),
      confirmDestructive: true
    })
    await expect.poll(() => mocked.removeRequests()).toBe(2)
  })

  test('restores durable removal progress after refresh and hides the Git-removed worktree', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    const menu = await openWorktreeContextMenu(page, 'topic')
    await menu.getByRole('menuitem', { name: 'Remove tree…' }).click()
    await expect.poll(() => mocked.removeRequests()).toBe(1)

    const removingMenu = await openWorktreeContextMenu(page, 'topic')
    await removingMenu
      .getByRole('menuitem', { name: 'View removal progress' })
      .click()
    await expect(
      page.getByRole('alertdialog', { name: 'Remove topic' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Close' }).click()

    await page.reload()
    const restoredMenu = await openWorktreeContextMenu(page, 'topic')
    await restoredMenu
      .getByRole('menuitem', { name: 'View removal progress' })
      .click()
    await expect(
      page.getByRole('alertdialog', { name: 'Remove topic' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Close' }).click()

    mocked.completeRemoval()
    const removedRefresh = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/projects'
    )
    await page.evaluate(() => window.__eventSource.emit('worktree.removed'))
    await removedRefresh
    await expect(
      page.getByRole('button', { name: 'topic', exact: true })
    ).toHaveCount(0)
    await expect(page).toHaveURL(/wt_main/)
  })
})
