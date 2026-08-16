import { expect, test } from '@playwright/test'
import {
  mockApp,
  openWorktreeContextMenu,
  requestTerminalControl,
  waitForTerminalControl
} from './app-fixture'
import {
  TERMINAL_SCROLL_EXIT_SEQUENCE,
  TERMINAL_SELECTION_CLEAR_SEQUENCE,
  TERMINAL_SELECTION_START_SEQUENCE
} from '@treeport/shared'

test.describe('desktop terminal input and removal', () => {
  test('reconciles remote preset edits and deletion', async ({ page }) => {
    await page.clock.install()
    const mocked = await mockApp(page)
    await page.getByRole('button', { name: /^New panel/ }).click()
    await page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Manage global presets' })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Global terminal presets' })
    await dialog.getByRole('button', { name: /^Hunk/ }).click()
    await dialog.getByLabel('Name').fill('Unsaved local name')
    mocked.terminalPresets[0] = {
      ...mocked.terminalPresets[0]!,
      name: 'Remote Hunk',
      updatedAt: '2026-02-01T00:00:00.000Z'
    }
    await page.clock.fastForward(5_000)
    await expect(dialog.getByLabel('Name')).toHaveValue('Remote Hunk')
    await expect(dialog.getByRole('status')).toContainText(
      'latest saved values were loaded'
    )
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()

    await page.getByRole('button', { name: 'New worktree' }).click()
    await page.getByLabel('Initial terminal').selectOption({
      label:
        'Remote Hunk — Global — npx --yes hunkdiff@0.17.3 diff HEAD --watch'
    })
    mocked.terminalPresets.splice(0)
    await page.clock.fastForward(5_000)
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'selected preset cannot be used' })
    ).toBeVisible()
    await expect(page.getByLabel('Initial terminal')).toHaveValue('shell')
    await page
      .getByRole('dialog', { name: 'Create worktree' })
      .getByRole('button', { name: 'Close', exact: true })
      .click()
  })
  test('uploads pasted and dropped files and pastes their server paths', async ({
    page
  }) => {
    const mocked = await mockApp(page)
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
          new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
            type: 'image/png'
          })
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
    expect(pasteWhileViewing).toEqual({ files: 1, prevented: true })
    await expect(page.getByRole('alert')).toContainText(
      'Couldn’t paste file: taking control; try again in a moment'
    )
    expect(mocked.fileUploadRequests()).toBe(0)

    await page.evaluate(() => window.__releaseTakeControl())
    await waitForTerminalControl(page)
    const paste = await page.evaluate(() => window.__pasteTerminalFile())
    expect(paste).toEqual({ files: 1, prevented: true })
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
      .toContain('\u001b[200~/tmp/treeport-upload-1.png\u001b[201~')

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

    await expect.poll(mocked.fileUploadRequests).toBe(2)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
            .join('')
        )
      )
      .toContain('/tmp/treeport-upload-2.txt')
  })

  test('selects, autoscrolls beyond the viewport, and forwards application wheel events', async ({
    page
  }) => {
    await mockApp(page, [], {
      keyboardPlatform: 'MacIntel',
      desktopBridge: true
    })
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await requestTerminalControl(page)
    await page.locator('.xterm-helper-textarea').focus()
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
      window.__wsSent = []
      window.__openedTerminalLinks = []
      window.open = (...args) => {
        window.__openedTerminalLinks.push(args)
        return null
      }
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[2J\u001b[Hhttps://example.test/select-me\r\n\u001b[?1000h\u001b[?1006h'
        })
      })
      window.__wsSent = []
    })
    const screen = page.locator('.xterm-screen')
    const bounds = await screen.boundingBox()
    expect(bounds).not.toBeNull()
    const columns = await page.evaluate(() => window.__lastWs.cols)
    const cellWidth = bounds!.width / columns
    await page.mouse.move(bounds!.x + cellWidth * 1.25, bounds!.y + 8)
    await page.keyboard.down('Alt')
    await page.mouse.down()
    await page.mouse.move(bounds!.x + cellWidth * 5.75, bounds!.y + 8, {
      steps: 5
    })
    await page.mouse.up()
    await page.keyboard.up('Alt')

    const inViewportSelection = 'https://example.test/select-me'
    await page.evaluate((encoded) => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 3,
          data: `\u001b]52;c;${encoded}\u0007`
        })
      })
    }, Buffer.from(inViewportSelection, 'utf8').toString('base64'))
    const copied = await page
      .locator('.xterm-helper-textarea')
      .evaluate((textarea) => {
        const clipboard = new DataTransfer()
        textarea.dispatchEvent(
          new ClipboardEvent('copy', {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard
          })
        )
        return clipboard.getData('text/plain')
      })
    expect(copied).toContain('example.tes')
    expect(await page.evaluate(() => window.__openedTerminalLinks)).toEqual([])
    const sent = await page.evaluate(() => window.__wsSent)
    const inViewportSelectionInput = sent
      .filter((message: any) => message.type === 'input')
      .map((message: any) => String(message.data))
    expect(inViewportSelectionInput.join('')).toContain(
      TERMINAL_SELECTION_START_SEQUENCE
    )
    const selectionStartInput = inViewportSelectionInput.find((data: string) =>
      data.includes(TERMINAL_SELECTION_START_SEQUENCE)
    )
    expect(selectionStartInput).toContain(
      `${TERMINAL_SELECTION_START_SEQUENCE}\u001b[<0;2;`
    )
    expect(selectionStartInput).toContain('M\u001b[<32;2;')
    expect(inViewportSelectionInput.at(-1)).toContain('\u001b[<32;7;')
    expect(inViewportSelectionInput.at(-1)).toContain('\u001b[<0;')
    expect(inViewportSelectionInput.at(-1)).toMatch(/m$/)

    await page.evaluate(() => {
      window.__wsSent = []
    })
    await page.mouse.move(
      bounds!.x + bounds!.width / 2,
      bounds!.y + bounds!.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y - 30)
    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'history',
          viewing: true
        })
      })
    })
    await expect(
      page.getByText('Selection is active', { exact: true })
    ).toBeVisible()
    await page.waitForTimeout(160)
    await page.mouse.up()

    const selectionInput = await page.evaluate(() =>
      window.__wsSent
        .filter((message: any) => message.type === 'input')
        .map((message: any) => String(message.data))
    )
    expect(selectionInput.join('')).toContain(TERMINAL_SELECTION_START_SEQUENCE)
    expect(
      selectionInput.filter((data: string) => data.includes('\u001b[<32;'))
        .length
    ).toBeGreaterThan(1)
    expect(selectionInput.at(-1)).toContain('\u001b[<0;')
    expect(selectionInput.at(-1)).toMatch(/m$/)
    const reportsAtRelease = selectionInput.filter((data: string) =>
      data.includes('\u001b[<32;')
    ).length
    await page.waitForTimeout(160)
    expect(
      await page.evaluate(
        () =>
          window.__wsSent.filter(
            (message: any) =>
              message.type === 'input' &&
              String(message.data).includes('\u001b[<32;')
          ).length
      )
    ).toBe(reportsAtRelease)

    const tmuxSelection = 'history-17\nhistory-18\nselection-☃'
    const encodedSelection = Buffer.from(tmuxSelection, 'utf8').toString(
      'base64'
    )
    await page.evaluate((encoded) => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 4,
          data: `\u001b]52;c;${encoded}\u0007`
        })
      })
    }, encodedSelection)
    const autoscrolledCopy = await page
      .locator('.xterm-helper-textarea')
      .evaluate((textarea) => {
        const clipboard = new DataTransfer()
        textarea.dispatchEvent(
          new ClipboardEvent('copy', {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard
          })
        )
        return clipboard.getData('text/plain')
      })
    expect(autoscrolledCopy).toBe(tmuxSelection)

    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'history',
          viewing: true
        })
      })
      window.__wsSent = []
    })
    await expect(
      page.getByText('Selection is active', { exact: true })
    ).toBeVisible()
    await expect(
      page.getByText('New output is continuing off-screen')
    ).toBeVisible()
    await page.getByRole('button', { name: 'Clear' }).click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
        )
      )
      .toEqual([
        `${TERMINAL_SCROLL_EXIT_SEQUENCE}${TERMINAL_SELECTION_CLEAR_SEQUENCE}`
      ])
    await expect(
      page.getByText('Selection is active', { exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByText('Scrolled back in tmux', { exact: true })
    ).toHaveCount(0)
    const selectionAfterClear = await page
      .locator('.xterm-helper-textarea')
      .evaluate((textarea) => {
        const clipboard = new DataTransfer()
        textarea.dispatchEvent(
          new ClipboardEvent('copy', {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard
          })
        )
        return clipboard.getData('text/plain')
      })
    expect(selectionAfterClear).toBe('')

    await page.evaluate(() => {
      window.__wsSent = []
    })
    await screen.hover()
    await page.mouse.wheel(0, -120)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => String(message.data))
        )
      )
      .toEqual([expect.stringContaining('\u001b[<64;')])
    await page.mouse.wheel(0, 120)
    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'history',
          viewing: true
        })
      })
    })
    await page.waitForTimeout(50)
    await page.evaluate(() => {
      window.__wsSent = []
    })
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('x')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => String(message.data))
        )
      )
      .toEqual([`${TERMINAL_SCROLL_EXIT_SEQUENCE}x`])
    const selectionAfterInput = await page
      .locator('.xterm-helper-textarea')
      .evaluate((textarea) => {
        const clipboard = new DataTransfer()
        textarea.dispatchEvent(
          new ClipboardEvent('copy', {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard
          })
        )
        return clipboard.getData('text/plain')
      })
    expect(selectionAfterInput).toBe('')

    await page.evaluate(() => {
      window.__wsSent = []
    })
    await page.mouse.move(bounds!.x + bounds!.width / 4, bounds!.y + 8)
    await page.mouse.down()
    await page.mouse.move(
      bounds!.x + bounds!.width / 4,
      bounds!.y + bounds!.height + 30
    )
    await page.waitForTimeout(160)
    await page.evaluate(() => {
      window.__dispatchTerminalSelectionRelease()
    })
    await page.waitForTimeout(160)
    const downwardSelectionInput = await page.evaluate(() =>
      window.__wsSent
        .filter((message: any) => message.type === 'input')
        .map((message: any) => String(message.data))
    )
    await page.waitForTimeout(160)
    const inputCountAfterRelease = await page.evaluate(
      () =>
        window.__wsSent.filter((message: any) => message.type === 'input')
          .length
    )
    expect(inputCountAfterRelease).toBe(downwardSelectionInput.length)
    await page.mouse.up()
    const downwardRows = downwardSelectionInput.flatMap((data: string) =>
      data
        .split('\u001b[<32;')
        .slice(1)
        .map((report) => Number(report.split('M', 1)[0]?.split(';')[1]))
    )
    expect(downwardRows.length).toBeGreaterThan(2)
    expect(downwardRows[0]).toBe(1)
    expect(Math.min(...downwardRows.slice(1))).toBeGreaterThan(1)
    expect(downwardSelectionInput.at(-1)).toContain('\u001b[<0;')
    expect(downwardSelectionInput.at(-1)).toMatch(/m$/)

    await page.evaluate(() => {
      window.__wsSent = []
    })
    await page.mouse.move(
      bounds!.x + bounds!.width / 4,
      bounds!.y + bounds!.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(bounds!.x + bounds!.width / 4, bounds!.y - 30)
    await page.waitForTimeout(100)
    await page.mouse.move(bounds!.x + bounds!.width + 30, bounds!.y - 30)
    const dragReports = () =>
      page.evaluate(
        () =>
          window.__wsSent.filter(
            (message: any) =>
              message.type === 'input' &&
              String(message.data).includes('\u001b[<32;')
          ).length
      )
    const reportsAfterLeavingSide = await dragReports()
    expect(
      await page.evaluate(() =>
        window.__wsSent.some(
          (message: any) =>
            message.type === 'input' &&
            String(message.data).endsWith('\u001b[F')
        )
      )
    ).toBe(true)
    await page.waitForTimeout(160)
    expect(await dragReports()).toBe(reportsAfterLeavingSide)
    await page.mouse.up()

    await page.reload()
    await expect(page.locator('.xterm')).toBeVisible()
    await requestTerminalControl(page)

    await page.locator('.xterm-helper-textarea').focus()
    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[?1000h\u001b[?1006h'
        })
      })
      window.__wsSent = []
    })
    await page.locator('.xterm-screen').dispatchEvent('wheel', { deltaY: -120 })
    await expect
      .poll(() => page.evaluate(() => window.__wsSent))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: expect.stringMatching(/input|binary/)
          })
        ])
      )
    const wheelSent = await page.evaluate(() => window.__wsSent)
    expect(wheelSent.some((message: any) => message.data === '\u001b[A')).toBe(
      false
    )
    expect(
      wheelSent.some((message: any) =>
        String(message.data).includes('\u001b[<')
      )
    ).toBe(true)

    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('q')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__wsSent
              .filter((message: any) => message.type === 'input')
              .at(-1)?.data
        )
      )
      .toBe(`${TERMINAL_SCROLL_EXIT_SEQUENCE}q`)
  })

  test('uses one removal action, live preview state, and places New worktree last', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    await expect(
      page
        .getByRole('list')
        .filter({ hasText: 'New worktree' })
        .getByRole('listitem')
        .last()
    ).toContainText('New worktree')

    mocked.setRemovePreview({
      branch: null,
      detached: true,
      head: 'cccccccc',
      detachedHeadReachable: false,
      warnings: ['Detached commits may become unreachable after removal'],
      confirmationToken: 'b'.repeat(64)
    })
    const menu = await openWorktreeContextMenu(page, 'topic')
    await menu.getByRole('menuitem', { name: 'Remove worktree…' }).click()
    await expect(
      page.getByRole('alertdialog', { name: 'Remove worktree' })
    ).toBeVisible()
    await expect(
      page.getByText('/worktrees/topic', { exact: true })
    ).toBeVisible()
    await expect(page.getByText('Detached at cccccccc')).toBeVisible()
    await expect(page.getByText('Pi', { exact: true }).last()).toBeVisible()
    const removeRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/remove')
    )
    await page.getByRole('button', { name: 'Remove anyway' }).click()
    expect((await removeRequest).postDataJSON()).toEqual({
      confirmationToken: 'b'.repeat(64),
      confirmDestructive: true
    })
  })

  test('removes a clean worktree without a dialog and blocks repeated requests', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.setRemovePreviewDelay(200)
    const releaseRemove = mocked.delayNextRemove()
    const menu = await openWorktreeContextMenu(page, 'topic')
    const removeItem = menu.getByRole('menuitem', {
      name: 'Remove worktree…'
    })
    await removeItem.evaluate((item: HTMLElement) => {
      item.click()
      item.click()
    })

    await expect(page.getByText('Preparing removal…')).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'topic, removing' })
    ).toBeVisible()
    await expect.poll(() => mocked.removePreviewRequests()).toBe(1)
    await expect(page.getByText('Removing…')).toHaveCount(0)
    await expect.poll(() => mocked.removeRequests()).toBe(1)
    await expect(
      page.getByRole('heading', { name: 'Remove worktree' })
    ).toHaveCount(0)
    expect(mocked.removeRequestBodies()).toEqual([
      {
        confirmationToken: 'a'.repeat(64),
        confirmDestructive: false
      }
    ])
    releaseRemove()
  })

  test('retries one stale clean preview without opening a dialog', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    mocked.staleNextRemoveWithPreview({
      confirmationToken: 'c'.repeat(64)
    })
    const menu = await openWorktreeContextMenu(page, 'topic')
    await menu.getByRole('menuitem', { name: 'Remove worktree…' }).click()

    await expect.poll(() => mocked.removeRequests()).toBe(2)
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
    await expect(
      page.getByRole('heading', { name: 'Remove worktree' })
    ).toHaveCount(0)
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
    await menu.getByRole('menuitem', { name: 'Remove worktree…' }).click()

    await expect(
      page.getByRole('heading', { name: 'Remove worktree' })
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
    await menu.getByRole('menuitem', { name: 'Remove worktree…' }).click()
    await expect.poll(() => mocked.removeRequests()).toBe(1)

    const removingMenu = await openWorktreeContextMenu(page, 'topic')
    await expect(
      removingMenu.getByRole('menuitem', { name: 'Removal in progress' })
    ).toBeDisabled()
    await page.keyboard.press('Escape')

    await page.reload()
    const restoredMenu = await openWorktreeContextMenu(page, 'topic')
    await expect(
      restoredMenu.getByRole('menuitem', { name: 'Removal in progress' })
    ).toBeDisabled()
    await page.keyboard.press('Escape')

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
