import { expect, test } from '@playwright/test'
import xtermHeadless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { TerminalImages } from '../src/terminal-images'
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
  await write('\x1b_Ga=d,d=a,q=2\x1b\\')
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
        snapshotImages
      })
    },
    { snapshot, snapshotImages, dimensions }
  )
  await expect.poll(pixels).toBeGreaterThan(100)
  await page.evaluate(() => {
    const socket = window.__lastWs
    socket.receive('output', {
      streamId: socket.streamId,
      sequence: 1,
      data: '\x1b_Ga=d,d=a,q=2\x1b\\\x1b[7;9H\x1b_Ga=p,i=42,c=4,r=2,C=1,q=2\x1b\\'
    })
  })
  await expect.poll(pixels).toBeGreaterThan(100)
  terminal.dispose()
})
