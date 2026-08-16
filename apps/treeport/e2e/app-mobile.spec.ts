import { expect, test } from '@playwright/test'
import { TERMINAL_SCROLL_EXIT_SEQUENCE } from '@treeport/shared'
import { mockApp, waitForTerminalControl } from './app-fixture'

test.describe('mobile terminal UI', () => {
  test('uses the mobile drawer and terminal controls end to end', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: 'background · /repo',
        progress: { state: 'normal', value: 42 },
        bell: {
          sequence: 3,
          at: '2026-01-01T00:02:00.000Z',
          unread: true
        }
      }
    ])
    const notifications = page.getByRole('button', {
      name: 'Notifications, 1 unread'
    })
    await expect(notifications).toBeVisible()
    await notifications.click()
    const notificationCenter = page.getByRole('dialog', {
      name: 'Notifications'
    })
    await expect(
      notificationCenter.getByText('background · /repo')
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(notifications).toBeVisible()

    const trigger = page.getByLabel('Open Tree drawer')
    await trigger.click()
    await expect(page.getByLabel('Close drawer')).toBeFocused()
    await expect(
      page.getByRole('button', { name: /background · \/repo.*42% complete/ })
    ).toBeVisible()
    await page.evaluate(() =>
      window.__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'background · /repo',
            progress: null,
            progressStartedAt: '2026-01-01T00:00:00.000Z',
            progressClearedAt: '2026-01-01T00:00:01.000Z',
            bell: {
              sequence: 3,
              at: '2026-01-01T00:02:00.000Z',
              unread: true
            }
          }
        })
      )
    )
    await expect(
      page.getByRole('button', { name: 'background · /repo, running' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page
      .getByRole('button', { name: /background · \/repo, running.*bell/ })
      .click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    await page.evaluate(() => {
      window.__wsSent = []
    })
    await page.getByRole('button', { name: 'Esc' }).click()
    await waitForTerminalControl(page)
    await page.getByRole('button', { name: 'Esc' }).click()
    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[?1h'
        })
      })
    })
    await page.getByRole('button', { name: 'Arrow up' }).click()
    await expect
      .poll(() => page.evaluate(() => window.__wsSent))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'input', data: '\u001b' }),
          expect.objectContaining({ type: 'input', data: '\u001bOA' })
        ])
      )

    await page.setViewportSize({ width: 320, height: 700 })
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
    const alt = page.getByRole('button', { name: 'Alt', exact: true })
    const shiftTab = page.getByRole('button', {
      name: 'Shift+Tab',
      exact: true
    })
    await page.evaluate(() => {
      window.__wsSent = []
    })
    await ctrl.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await page.keyboard.type('c')
    await alt.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await page.keyboard.type('x')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
        )
      )
      .toEqual(['\u0003', '\u001bx'])

    await alt.click()
    await ctrl.click()
    await page.evaluate(() => {
      window.__wsSent = []
    })
    await shiftTab.scrollIntoViewIfNeeded()
    await shiftTab.click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent
            .filter((message: any) => message.type === 'input')
            .map((message: any) => message.data)
        )
      )
      .toEqual(['\u001b[Z'])
    await page.setViewportSize({ width: 412, height: 915 })
    const presetRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByLabel('Open Tree drawer').click()
    await page.getByRole('button', { name: /^New panel/ }).click()
    await page
      .getByRole('dialog', { name: 'New panel' })
      .getByRole('button', { name: 'Hunk' })
      .click()
    expect((await presetRequest).postDataJSON()).toMatchObject({ name: 'Hunk' })
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()

    const shortcutModifier = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta' : 'Control'
    )
    await page.keyboard.press(`${shortcutModifier}+Shift+P`)
    await expect(page.getByLabel('Search projects')).toBeVisible()
    await expect(page.getByLabel('Search projects')).not.toBeFocused()
    const close = page.getByRole('button', { name: 'Close project example' })
    await expect(close).toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await close.click()
    await expect(
      page.getByRole('button', { name: 'Open project' })
    ).toBeVisible()
  })

  test('switches projects without opening the mobile keyboard', async ({
    page
  }) => {
    await mockApp(page, [], { includeSecondProject: true })
    const shortcutModifier = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta' : 'Control'
    )

    await page.keyboard.press(`${shortcutModifier}+Shift+P`)
    await page
      .getByRole('button', { name: 'another-project', exact: true })
      .click()

    await expect(page).toHaveURL(/\/projects\/proj_2\//)
    await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
  })

  test('keeps mobile modal and drawer flows coherent', async ({ page }) => {
    const mocked = await mockApp(page)
    await page.getByLabel('Open Tree drawer').click()
    const trigger = page.getByRole('button', { name: 'New Tree' })
    await trigger.click()
    await expect(
      page.getByRole('dialog', { name: 'Create Tree' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('heading', { name: 'Create Tree' })
    ).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Escape')

    await page.getByLabel('Open Tree drawer').click()
    await trigger.click()
    await page.clock.install()
    const submit = page.getByRole('button', { name: 'Create Tree' })
    const submitBox = await submit.boundingBox()
    expect(submitBox).not.toBeNull()
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          '/api/projects/proj_1/worktree-operations'
    )
    await page.getByLabel('Tree name').fill('touch submit')
    await page.touchscreen.tap(
      submitBox!.x + submitBox!.width / 2,
      submitBox!.y + submitBox!.height / 2
    )
    expect((await requestPromise).postDataJSON()).toMatchObject({
      name: 'touch submit'
    })
    await expect(
      page.getByRole('heading', { name: 'Create Tree' })
    ).toHaveCount(0)

    mocked.failNextCreate()
    await page.getByLabel('Open Tree drawer').click()
    await trigger.click()
    await page.getByLabel('Tree name').fill('mobile failure')
    await page.getByRole('button', { name: 'Create Tree' }).click()
    await expect(page.getByText('create failed')).toBeVisible()
  })

  test('scrolls tmux history with a one-finger swipe across mouse modes', async ({
    page
  }, testInfo) => {
    await mockApp(page)
    await page.getByLabel('Open Tree drawer').click()
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    const screen = page.locator('.xterm-screen')
    const bounds = await screen.boundingBox()
    const row = await page.locator('.xterm-rows > div').first().boundingBox()
    expect(bounds).not.toBeNull()
    expect(row).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const x = bounds!.x + bounds!.width / 2
    const startY = bounds!.y + row!.height * 2
    const positions = [0, 4, 8, 12].map((rows) => startY + row!.height * rows)

    if (testInfo.project.name === 'mobile-chromium') {
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write'])
      const selectionX = bounds!.x + bounds!.width / 100
      const selectionY = bounds!.y + row!.height / 2
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: selectionX, y: selectionY }]
      })
      await page.waitForTimeout(500)
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: selectionX + row!.height * 4, y: selectionY }]
      })
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      })
      const selectionActions = page.getByLabel('Terminal text selection')
      await expect(selectionActions).toBeVisible()
      await selectionActions.getByRole('button', { name: 'Copy' }).click()
      await expect(selectionActions).toBeVisible()
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .not.toBe('')
    }

    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: positions[0]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: positions[1]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })
    await page.waitForTimeout(100)
    expect(
      await page.evaluate(() => {
        const socket = window.__lastWs
        const state = JSON.parse(
          localStorage.getItem('__treeport_terminal_state__:term_pi') || '{}'
        )
        return state.controllerClientId === socket.clientId
      })
    ).toBe(false)
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()

    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: positions[0]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })
    await waitForTerminalControl(page)
    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[?1049h\u001b[?1000h\u001b[?1006h'
        })
      })
      window.__wsSent = []
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: positions[0]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: positions[1]! }]
    })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__wsSent.filter((message: any) =>
              String(message.data).includes('\u001b[<64;')
            ).length
        )
      )
      .toBe(1)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })

    await page.evaluate(() => {
      const socket = window.__lastWs
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 3,
          data: '\u001b[?1000l'
        })
      })
    })
    const inputMessagesBeforeModeChange = await page.evaluate(
      () =>
        window.__wsSent.filter((message: any) => message.type === 'input')
          .length
    )

    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: positions[2]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: positions[3]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })

    await expect
      .poll(() =>
        page.evaluate(
          (previousCount) =>
            window.__wsSent.filter((message: any) => message.type === 'input')
              .length > previousCount,
          inputMessagesBeforeModeChange
        )
      )
      .toBe(true)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent.some((message: any) => message.data === '\u001b[A')
        )
      )
      .toBe(true)

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

    if (testInfo.project.name === 'mobile-chromium') {
      const selectionX = bounds!.x + bounds!.width / 100
      const selectionY = bounds!.y + row!.height / 2
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: selectionX, y: selectionY },
          { x: selectionX + 40, y: selectionY }
        ]
      })
      await page.waitForTimeout(600)
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      })
      const pasteDialog = page.getByRole('dialog', {
        name: 'Paste into terminal'
      })
      await expect(pasteDialog).toBeVisible()
      await pasteDialog.getByLabel('Paste text here').evaluate((element) => {
        const clipboardData = new DataTransfer()
        clipboardData.setData('text/plain', 'pasted on iOS')
        element.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData
          })
        )
      })
      await expect(pasteDialog).toHaveCount(0)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__wsSent
                .filter((message: any) => message.type === 'input')
                .at(-1)?.data
          )
        )
        .toBe('pasted on iOS')
    }
  })
})
