import { expect, test } from '@playwright/test'
import { mockApp } from './support/mock-app'
import { waitForTerminalControl } from './support/interactions'

test.describe('mobile terminal UI', () => {
  test('uses the mobile drawer and terminal controls end to end', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    await page.getByLabel('Open tree drawer').click()
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()

    {
      mocked.terminal.messages = []
    }
    await page.getByRole('button', { name: 'Esc' }).click()
    await waitForTerminalControl(page)
    await page.getByRole('button', { name: 'Esc' }).click()
    {
      const socket = mocked.terminal.connection
      socket.receive('output', {
        streamId: socket.streamId,
        sequence: 2,
        data: '\u001b[?1h'
      })
    }
    await page.getByRole('button', { name: 'Arrow up' }).click()
    await expect
      .poll(() => mocked.terminal.messages)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'input', data: '\u001b' }),
          expect.objectContaining({ type: 'input', data: '\u001bOA' })
        ])
      )

    await page.clock.install()
    // Exercise apps panel toggles while controlling the terminal, so a resize would
    // reach the process rather than being suppressed for a read-only viewer.
    await page.clock.runFor(250)
    const screen = page.locator('.xterm-screen')
    const screenBounds = await screen.boundingBox()
    expect(screenBounds).not.toBeNull()
    {
      mocked.terminal.messages = []
    }
    const appsPanelToggle = page.getByRole('button', {
      name: 'Toggle apps panel'
    })
    for (let cycle = 0; cycle < 2; cycle++) {
      await appsPanelToggle.click()
      await expect(
        page.getByRole('region', { name: 'topic apps panel' })
      ).toBeVisible()
      expect(await screen.boundingBox()).toEqual(screenBounds)
      // Observe long enough for a debounced resize to reach the socket.
      await page.clock.runFor(250)
      expect(await screen.boundingBox()).toEqual(screenBounds)
      await appsPanelToggle.click()
      await expect(
        page.getByRole('main', { name: 'topic terminal workspace' })
      ).toBeVisible()
      expect(await screen.boundingBox()).toEqual(screenBounds)
      await page.clock.runFor(250)
      expect(await screen.boundingBox()).toEqual(screenBounds)
    }
    expect(
      mocked.terminal.messages.filter((message) => message.type === 'resize')
    ).toEqual([])

    {
      mocked.terminal.messages = []
    }
    await page.getByRole('button', { name: 'More terminal actions' }).click()
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Upload', exact: true }).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({
      name: 'mobile-photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('photo')
    })
    await expect.poll(mocked.fileUploadRequests).toBe(1)
    await expect
      .poll(() =>
        mocked.terminal.messages
          .filter((message) => message.type === 'input')
          .map((message) => message.data)
          .join('')
      )
      .toContain('/tmp/treeport-upload-1.jpg')

    await page.setViewportSize({ width: 320, height: 700 })
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
    const alt = page.getByRole('button', { name: 'Alt', exact: true })
    const shift = page.getByRole('button', { name: 'Shift', exact: true })
    const tab = page.getByRole('button', { name: 'Tab', exact: true })
    {
      mocked.terminal.messages = []
    }
    await ctrl.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await page.keyboard.type('c')
    await alt.click()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await page.keyboard.type('x')
    await expect
      .poll(() =>
        mocked.terminal.messages
          .filter((message) => message.type === 'input')
          .map((message) => message.data)
      )
      .toEqual(['\u0003', '\u001bx'])

    await alt.click()
    await ctrl.click()
    {
      mocked.terminal.messages = []
    }
    await shift.click()
    await tab.scrollIntoViewIfNeeded()
    await tab.click()
    await expect
      .poll(() =>
        mocked.terminal.messages
          .filter((message) => message.type === 'input')
          .map((message) => message.data)
      )
      .toEqual(['\u001b[Z'])

    const esc = page.getByRole('button', { name: 'Esc', exact: true })
    await esc.focus()
    {
      mocked.terminal.messages = []
    }
    await esc.click()
    await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
    await expect
      .poll(() =>
        mocked.terminal.messages
          .filter((message) => message.type === 'input')
          .map((message) => message.data)
      )
      .toEqual(['\u001b'])

    await page.setViewportSize({ width: 412, height: 915 })
    const presetRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/worktrees/wt_topic/terminals'
    )
    await page.getByLabel('Open tree drawer').click()
    await page.getByRole('button', { name: /^New app/ }).click()
    await page
      .getByRole('dialog', { name: 'New app' })
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

  test('uses xterm-native one-finger scrolling across mouse modes', async ({
    page
  }) => {
    const mocked = await mockApp(page)
    await page.getByLabel('Open tree drawer').click()
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    {
      const socket = mocked.terminal.connection
      socket.receive('output', {
        streamId: socket.streamId,
        sequence: 2,
        data: Array.from(
          { length: 120 },
          (_, index) => `mobile-history-${index}\r\n`
        ).join('')
      })
      mocked.terminal.messages = []
    }
    const screen = page.locator('.xterm-screen')
    await expect(screen).toContainText('mobile-history-119')
    await page.clock.install()
    const bounds = await screen.boundingBox()
    const row = await page.locator('.xterm-rows > div').first().boundingBox()
    expect(bounds).not.toBeNull()
    expect(row).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const x = bounds!.x + bounds!.width / 2
    const startY = bounds!.y + row!.height * 2
    const positions = [0, 4, 8, 12].map((rows) => startY + row!.height * rows)

    // This spec runs only in the mobile-chromium project.
    {
      const selectionX = bounds!.x + bounds!.width / 100
      const selectionY = bounds!.y + row!.height / 2
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: selectionX, y: selectionY }]
      })
      await page.clock.runFor(500)
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: selectionX + row!.height * 4, y: selectionY }]
      })
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      })
      await expect
        .poll(() =>
          page.evaluate(() => window.getSelection()?.toString() ?? '')
        )
        .not.toBe('')
      await expect(page.getByLabel('Terminal text selection')).toHaveCount(0)
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
    }

    const firstRow = page.locator('.xterm-rows > div').first()
    const historyRowBeforeScroll = Number(
      (await firstRow.textContent())?.match(/mobile-history-(\d+)/)?.[1]
    )
    expect(Number.isFinite(historyRowBeforeScroll)).toBe(true)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: positions[0]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: positions[1]! }]
    })
    // Check while the finger is down, before xterm starts native inertia.
    await expect(firstRow).toContainText(
      `mobile-history-${historyRowBeforeScroll - 4}`
    )
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })
    await expect(screen).not.toContainText('mobile-history-119')
    await expect(page.getByText('Viewing', { exact: true })).toBeVisible()
    expect(
      mocked.terminal.messages.filter((message) => message.type === 'input')
    ).toEqual([])

    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: positions[0]! }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })
    await expect(page.locator('.xterm-helper-textarea')).toBeEditable()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await waitForTerminalControl(page)
    {
      const socket = mocked.terminal.connection
      socket.receive('output', {
        streamId: socket.streamId,
        sequence: 3,
        data: '\u001b[?1049h\u001b[?1000h\u001b[?1006h'
      })
      mocked.terminal.messages = []
    }
    await expect(page.locator('.xterm')).toHaveClass(/enable-mouse-events/)
    // Taking control refits the terminal, so use its current cell height.
    const mouseBounds = (await screen.boundingBox())!
    const mouseRow = (await firstRow.boundingBox())!
    const mouseStartY = mouseBounds.y + mouseRow.height * 2
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: mouseStartY }]
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      // Stay just beyond the row boundary to avoid CSS pixel rounding.
      touchPoints: [{ x, y: mouseStartY + mouseRow.height * 4.25 }]
    })
    await expect
      .poll(() =>
        mocked.terminal.messages
          .filter((message) => message.type === 'input')
          .reduce(
            (count: number, message) =>
              count + String(message.data).split('\u001b[<64;').length - 1,
            0
          )
      )
      .toBe(4)
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    })

    {
      const socket = mocked.terminal.connection
      socket.receive('output', {
        streamId: socket.streamId,
        sequence: 4,
        data: '\u001b[?1000l\u001b[?1049l'
      })
    }
    const inputMessagesBeforeModeChange = mocked.terminal.messages.filter(
      (message) => message.type === 'input'
    ).length

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

    expect(
      mocked.terminal.messages.filter((message) => message.type === 'input')
    ).toHaveLength(inputMessagesBeforeModeChange)

    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('q')
    await expect
      .poll(
        () =>
          mocked.terminal.messages
            .filter((message) => message.type === 'input')
            .at(-1)?.data
      )
      .toBe('q')

    {
      const selectionX = bounds!.x + bounds!.width / 100
      const selectionY = bounds!.y + row!.height / 2
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: selectionX, y: selectionY },
          { x: selectionX + 40, y: selectionY }
        ]
      })
      await page.clock.runFor(600)
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
        .poll(
          () =>
            mocked.terminal.messages
              .filter((message) => message.type === 'input')
              .at(-1)?.data
        )
        .toBe('pasted on iOS')
    }
  })
})
