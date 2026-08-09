import { expect, test } from '@playwright/test'
import { mockApp, terminalTextPoint } from './app-fixture'

test.describe('desktop terminal links and metadata', () => {
  test('opens detected web URLs on platform modifier-click', async ({
    page
  }) => {
    await mockApp(page, [], { keyboardPlatform: 'Linux x86_64' })
    expect(await page.evaluate(() => navigator.platform)).toBe('Linux x86_64')
    await page.evaluate(() => {
      ;(window as any).__openedTerminalLinks = []
      window.open = (...args) => {
        ;(window as any).__openedTerminalLinks.push(args)
        return null
      }
    })
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b[2J\u001b[Hhttp://example.test/help,\r\n'
        })
      })
    })

    const httpText = page
      .locator('.xterm-rows span')
      .filter({ hasText: 'http://example.test/help' })
      .last()
    await expect(httpText).toBeVisible()
    const httpPoint = await terminalTextPoint(httpText, { x: 16, y: 8 })
    // xterm 6 makes rendered rows ignore pointer events; links are hit-tested
    // from coordinates on the screen element instead.
    await page.mouse.move(httpPoint.x, httpPoint.y)
    await page.keyboard.down('Control')
    await page.mouse.click(httpPoint.x, httpPoint.y)
    await page.keyboard.up('Control')
    await expect
      .poll(() => page.evaluate(() => (window as any).__openedTerminalLinks))
      .toEqual([['http://example.test/help', '_blank', 'noopener,noreferrer']])
  })

  test('opens OSC 8 links in a new tab on Apple Cmd-click', async ({
    page
  }) => {
    await mockApp(page, [], { keyboardPlatform: 'MacIntel' })
    expect(await page.evaluate(() => navigator.platform)).toBe('MacIntel')
    await page.evaluate(() => {
      ;(window as any).__openedTerminalLink = null
      window.open = (...args) => {
        ;(window as any).__openedTerminalLink = args
        return null
      }
    })
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()
    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\x1b]8;;https://example.test/pr/123\x1b\\#123 ↗\x1b]8;;\x1b\\\r\n'
        })
      })
    })

    const linkedText = page
      .locator('.xterm-rows span')
      .filter({ hasText: '#123' })
      .last()
    await expect(linkedText).toBeVisible()
    const linkedPoint = await terminalTextPoint(linkedText, { x: 8, y: 8 })
    await page.keyboard.down('Meta')
    await page.mouse.click(linkedPoint.x, linkedPoint.y)
    await page.keyboard.up('Meta')
    await expect
      .poll(() => page.evaluate(() => (window as any).__openedTerminalLink))
      .toEqual(['https://example.test/pr/123', '_blank', 'noopener,noreferrer'])
  })

  test('synchronizes fallback, runtime, and cleared titles across the sidebar and terminal workspace', async ({
    page
  }) => {
    await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: null,
        hasForegroundProcess: true,
        progress: null,
        progressStartedAt: null,
        progressClearedAt: null,
        bell: null
      }
    ])
    await page.evaluate(() => ((window as any).__suppressInitialTitle = true))
    await page.getByRole('button', { name: 'Pi, running', exact: true }).click()

    await expect(
      page.getByRole('button', { name: 'Pi, running', exact: true })
    ).toBeVisible()
    await expect(page.getByRole('main', { name: 'Pi terminal' })).toBeVisible()

    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'title',
          title: 'runtime · /repo'
        })
      })
    })
    await expect(
      page.getByRole('button', {
        name: 'runtime · /repo, running',
        exact: true
      })
    ).toBeVisible()
    await expect(
      page.getByRole('main', { name: 'runtime · /repo terminal' })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Close runtime · /repo' })
    ).toBeDisabled()

    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({ version: 1, type: 'title', title: '' })
      })
    })
    await expect(
      page.getByRole('button', { name: 'Pi, running', exact: true })
    ).toBeVisible()
    await expect(page.getByRole('main', { name: 'Pi terminal' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close Pi' })).toBeDisabled()
  })

  test('reconciles terminal metadata in chronological order', async ({
    page
  }) => {
    const mocked = await mockApp(page, [
      {
        terminalId: 'term_pi',
        title: 'background · /repo',
        progress: { state: 'normal', value: 42 }
      }
    ])

    const background = page.getByRole('button', {
      name: /background · \/repo.*42% complete/
    })
    await expect(background).toBeVisible()
    expect(
      await page.evaluate(() =>
        ((window as any).__wsInstances || []).some((socket: { url: string }) =>
          socket.url.includes('term_pi')
        )
      )
    ).toBe(false)

    await page
      .getByRole('button', { name: /background · \/repo.*42% complete/ })
      .click()
    await page.evaluate(() =>
      (window as any).__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'background · /repo',
            progress: null,
            progressStartedAt: '2026-01-01T00:00:00.000Z',
            progressClearedAt: '2026-01-01T00:00:01.000Z',
            bell: null
          }
        })
      )
    )
    await expect(
      page.getByRole('button', { name: /42% complete/ })
    ).toHaveCount(0)

    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes('term_pi')
      )
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'progress',
          progress: { state: 'indeterminate', value: null }
        })
      })
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: 'output',
          streamId: socket.streamId,
          sequence: 2,
          data: '\u001b]9;4;3\u0007'
        })
      })
    })
    await expect(page.getByRole('button', { name: /working/ })).toHaveCount(0)

    await page.evaluate(() =>
      (window as any).__eventSource.emit(
        'terminal.metadata',
        JSON.stringify({
          data: {
            terminalId: 'term_pi',
            title: 'background · /repo',
            progress: { state: 'normal', value: 75 },
            progressStartedAt: '2026-01-01T00:00:02.000Z',
            progressClearedAt: '2026-01-01T00:00:01.000Z',
            bell: null
          }
        })
      )
    )
    await expect(
      page.getByRole('button', { name: /75% complete/ })
    ).toBeVisible()
    await expect(page.getByText('example')).toBeVisible()
    await expect(
      page.getByRole('button', { name: /background · \/repo.*75% complete/ })
    ).toBeVisible()
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(1)
    const before = mocked.projectRequests()
    await page.evaluate(() =>
      (window as any).__eventSource.emit(
        'connected',
        JSON.stringify({
          at: new Date().toISOString(),
          terminalMetadata: [
            {
              terminalId: 'term_pi',
              title: 'background · /repo',
              progress: null,
              progressStartedAt: '2026-01-01T00:00:00.000Z',
              progressClearedAt: '2026-01-01T00:00:01.000Z',
              bell: null
            }
          ]
        })
      )
    )
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(before)
    await expect(
      page.getByRole('button', { name: /background · \/repo.*75% complete/ })
    ).toHaveCount(0)
  })
})
