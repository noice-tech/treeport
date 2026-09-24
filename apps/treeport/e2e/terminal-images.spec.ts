import { expect, test } from '@playwright/test'
import xtermHeadless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { TerminalImages } from '../src/terminal-runtime/images'
import { mockApp } from './support/mock-app'
import { requestTerminalControl } from './support/interactions'

test('Pi image redraws and host snapshots survive a fresh browser attachment', async ({
  page
}) => {
  await mockApp(page)
  await requestTerminalControl(page)
  const dimensions = await page.evaluate(() => ({
    cols: window.__lastWs.cols,
    rows: window.__lastWs.rows
  }))
  const terminal = new xtermHeadless.Terminal({
    ...dimensions,
    allowProposedApi: true
  })
  const images = new TerminalImages(true)
  const serializer = new SerializeAddon()
  // SAFETY: These addons implement the shared headless terminal boundary.
  terminal.loadAddon(images as never)
  // SAFETY: SerializeAddon supports both pinned xterm implementations.
  terminal.loadAddon(serializer as never)
  const cellSize = await page.evaluate(
    () =>
      window.__wsSent?.filter((item) => item.type === 'query_authority').at(-1)
        ?.cellSize
  )
  if (cellSize) {
    images.setCellSize(cellSize)
  }

  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const context = canvas.getContext('2d')!
    context.fillStyle = '#ff0000'
    context.fillRect(0, 0, 32, 32)
    return canvas.toDataURL().split(',')[1]
  })
  const pixels = () =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '.xterm-image-layer-top'
      )
      if (!canvas) {
        return 0
      }

      const data = canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height).data
      let red = 0
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i]! > 200 &&
          data[i + 1]! < 50 &&
          data[i + 2]! < 50 &&
          data[i + 3]! > 200
        ) {
          red++
        }
      }
      return red
    })
  let sequence = 1
  const write = async (data: string) => {
    await new Promise<void>((resolve) => terminal.write(data, resolve))
    await page.evaluate(
      ({ data, sequence }) => {
        window.__lastWs.receive('output', {
          streamId: window.__lastWs.streamId,
          sequence,
          data
        })
      },
      { data, sequence: ++sequence }
    )
  }
  await write(
    `\x1b[?1049h\x1b[3;5H\x1b_Ga=T,f=100,i=42,c=4,r=2,C=1,q=2;${png}\x1b\\`
  )
  await expect.poll(pixels).toBeGreaterThan(100)
  await page.clock.install()
  await write('\x1b[?2026h\x1b_Ga=d,d=a,q=2\x1b\\')
  await page.clock.runFor(1_100)
  // Image pixels, like text, stay painted until the new frame is complete.
  await expect.poll(pixels).toBeGreaterThan(100)
  await write('\x1b[?2026l')
  await expect.poll(pixels).toBe(0)
  await write('\x1b[5;7H\x1b_Ga=p,i=42,c=4,r=2,C=1,q=2\x1b\\')
  await expect.poll(pixels).toBeGreaterThan(100)
  const snapshot = serializer.serialize()
  const snapshotImages = await images.snapshot()
  expect(snapshotImages.images).toHaveLength(1)
  expect(snapshotImages.placements).toHaveLength(1)

  // A new xterm, not an in-memory cache: only the host snapshot can recover it.
  await page.reload()
  await requestTerminalControl(page)
  await page.evaluate(
    ({ snapshot, snapshotImages, dimensions }) => {
      const socket = window.__lastWs
      socket.receive('ready', {
        connectionId: 'reattached',
        streamId: socket.streamId,
        generation: socket.generation,
        controller: true,
        reset: 'full',
        ...dimensions,
        revision: socket.revision,
        snapshot,
        snapshotImages,
        synchronizedOutput: true
      })
    },
    { snapshot, snapshotImages, dimensions }
  )
  // A mid-frame snapshot uses xterm's render buffer, not a hidden DOM subtree.
  await expect(page.locator('.terminal-session-host')).toHaveCSS('opacity', '1')
  await page.evaluate(() => {
    const socket = window.__lastWs
    socket.receive('output', {
      streamId: socket.streamId,
      sequence: 1,
      data: '\x1b_Ga=d,d=a,q=2\x1b\\\x1b[7;9H\x1b_Ga=p,i=42,c=4,r=2,C=1,q=2\x1b\\\x1b[?2026l'
    })
  })
  await expect(page.locator('.terminal-session-host')).toHaveCSS('opacity', '1')
  await expect.poll(pixels).toBeGreaterThan(100)
  terminal.dispose()
})

for (const focusElsewhere of [false, true]) {
  test(`long image redraws ${focusElsewhere ? 'do not steal focus' : 'preserve focus and keyboard input'}`, async ({
    page
  }) => {
    await mockApp(page)
    await requestTerminalControl(page)
    const input = page.locator('.xterm-helper-textarea')
    const host = page.locator('.terminal-session-host')
    const scrollbar = host.locator('.xterm-scrollbar.xterm-vertical')
    const screen = host.locator('.xterm-screen')
    await expect(input).toBeFocused()
    await page.evaluate(() =>
      window.__lastWs.receive('output', {
        streamId: window.__lastWs.streamId,
        sequence: 2,
        data: 'previous history\r\n'.repeat(100) + 'PREVIOUS SCREEN'
      })
    )
    const rows = page.locator('.xterm-rows')
    await expect(rows).toContainText('PREVIOUS SCREEN')
    await expect(scrollbar).toHaveCSS('visibility', 'visible')
    await page.clock.install()
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 32
      const context = canvas.getContext('2d')!
      context.fillStyle = '#ff0000'
      context.fillRect(0, 0, 32, 32)
      window.__lastWs.receive('output', {
        streamId: window.__lastWs.streamId,
        sequence: 3,
        data:
          '\x1b[?2026h' +
          'historical output\r\n'.repeat(1000) +
          `\x1b_Ga=T,f=100,i=42,c=4,r=2,C=1,q=2;${canvas.toDataURL().split(',')[1]}\x1b\\`
      })
    })
    await expect(host).toHaveCSS('opacity', '1')
    // Outlast xterm's native one-second timeout: keep the last screen painted,
    // not a blank terminal and not the partially rebuilt history.
    await page.clock.runFor(1_100)
    await expect(host).toHaveCSS('opacity', '1')
    await expect(rows).toContainText('PREVIOUS SCREEN')
    await expect(rows).not.toContainText('historical output')
    await expect(scrollbar).toHaveCSS('visibility', 'hidden')
    // Neither xterm's viewport nor application mouse reporting may receive
    // scrolling against the frozen frame. Touch must not queue a later jump.
    const suppressed = await screen.evaluate((element) => {
      const touch = new Touch({
        identifier: 1,
        target: element,
        clientX: 20,
        clientY: 100
      })
      return [
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -500
        }),
        new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [touch]
        }),
        new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [touch]
        }),
        new TouchEvent('touchend', { bubbles: true, cancelable: true })
      ].map((event) => {
        let reachedXterm = false
        const received = () => {
          reachedXterm = true
        }
        element.addEventListener(event.type, received)
        element.dispatchEvent(event)
        element.removeEventListener(event.type, received)
        return { prevented: event.defaultPrevented, reachedXterm }
      })
    })
    expect(suppressed).toEqual(
      Array(4).fill({ prevented: true, reachedXterm: false })
    )
    await screen.hover()
    await page.mouse.wheel(0, -500)
    await page.clock.runFor(100)
    await expect(rows).toContainText('PREVIOUS SCREEN')
    await expect(input).toBeFocused()
    await page.keyboard.type('q')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__wsSent?.some(
            (event) => event.type === 'input' && event.data === 'q'
          )
        )
      )
      .toBe(true)

    if (focusElsewhere) {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.id = 'outside-terminal'
        document.body.append(button)
        button.focus()
      })
    }

    await page.evaluate(() =>
      window.__lastWs.receive('output', {
        streamId: window.__lastWs.streamId,
        sequence: 4,
        data: '\r\nCURRENT SCREEN\x1b[?2026l'
      })
    )
    await expect(host).toHaveCSS('opacity', '1')
    await expect(page.locator('.xterm-rows')).toContainText('CURRENT SCREEN')
    await expect(scrollbar).toHaveCSS('visibility', 'visible')
    await expect(
      focusElsewhere ? page.locator('#outside-terminal') : input
    ).toBeFocused()

    if (!focusElsewhere) {
      // Scrolling resumes after commit, with no input or focus regression.
      await screen.hover()
      await page.mouse.wheel(0, -500)
      await expect(rows).not.toContainText('CURRENT SCREEN')
      await page.mouse.wheel(0, 50_000)
      await expect(rows).toContainText('CURRENT SCREEN')
      // A missing frame terminator must not leave the last screen frozen forever.
      await page.evaluate(() =>
        window.__lastWs.receive('output', {
          streamId: window.__lastWs.streamId,
          sequence: 5,
          data: '\x1b[?2026h\r\nSTALLED FRAME'
        })
      )
      await page.clock.runFor(4_000)
      await expect(rows).not.toContainText('STALLED FRAME')
      await expect(scrollbar).toHaveCSS('visibility', 'hidden')
      await page.clock.runFor(1_100)
      await expect(rows).toContainText('STALLED FRAME')
      await expect(scrollbar).toHaveCSS('visibility', 'visible')
      await page.mouse.wheel(0, -500)
      await expect(rows).not.toContainText('STALLED FRAME')
      await expect(input).toBeFocused()
    }
  })
}
