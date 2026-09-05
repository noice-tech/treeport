import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type { BrowserFrame } from '@treeport/shared'
import { PlaywrightBrowserHost } from '../src/server/playwright-browser'
import { PlaywrightBrowserVideo } from '../src/server/browser-video'
import { BrowserVideoDecoder } from '../src/web/browser-video-decoder'

it('decodes native tab video through navigation, resize, static-page joins, and capture restart', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-native-video-')
  )
  let revision = path.dirname(chromium.executablePath())
  while (!path.basename(revision).startsWith('chromium-')) {
    const parent = path.dirname(revision)
    if (parent === revision) {
      throw new Error('Could not locate the Chromium cache.')
    }

    revision = parent
  }
  const host = new PlaywrightBrowserHost(
    path.dirname(revision),
    path.join(root, 'profile')
  )
  const viewerBrowser = await chromium.launch({
    channel: 'chromium',
    headless: true
  })
  const viewer = await viewerBrowser.newPage()
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(
      '<!doctype html><title>Native capture fixture</title><input aria-label="Message"><output></output><script>document.querySelector("input").oninput = e => document.querySelector("output").textContent = e.target.value;</script>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // SAFETY: The isolated fixture server is listening on an ephemeral port.
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const errors: string[] = []
  const frames: BrowserFrame[] = []
  let video: PlaywrightBrowserVideo | null = null
  let delivery = Promise.resolve()
  try {
    await viewer.goto(origin)
    // Serialize the real viewer decoder. It has no runtime dependencies outside
    // the standard browser APIs; the fixture supplies its protocol callbacks.
    await viewer.evaluate(`{
      const BrowserVideoDecoder = ${BrowserVideoDecoder.toString()};
      globalThis.videoResults = { decoded: 0, acks: [], errors: [], width: 0, height: 0 };
      globalThis.viewerDecoder = new BrowserVideoDecoder(frame => {
        videoResults.decoded++; videoResults.width = frame.displayWidth; videoResults.height = frame.displayHeight;
      }, message => { if (message.type === 'frameAck') videoResults.acks.push(message.sequence); },
      message => videoResults.errors.push(message));
    }`)
    const lease = await host.openPage()
    await lease.page.setViewportSize({ width: 640, height: 400 })
    await lease.page.goto(`${origin}/first`)
    video = new PlaywrightBrowserVideo(
      lease.context,
      lease.page,
      (value) => {
        const frame = { ...value, sequence: frames.length + 1 }
        frames.push(frame)
        delivery = delivery.then(() =>
          viewer.evaluate(
            `viewerDecoder.receive(${JSON.stringify({ ...frame, data: [...frame.data] })});`
          )
        )
      },
      (message) => errors.push(message)
    )
    // Restore the binary view after JSON transfer at the fixture boundary.
    await viewer.evaluate(`{
      const receive = viewerDecoder.receive.bind(viewerDecoder);
      viewerDecoder.receive = frame => receive({ ...frame, data: new Uint8Array(frame.data) });
    }`)
    await video.start(640, 400)
    await expect
      .poll(() => viewer.evaluate('videoResults.decoded'))
      .toBeGreaterThan(0)
    expect(frames[0]).toMatchObject({ keyframe: true, mimeType: 'video/vp8' })
    await lease.page
      .getByRole('textbox', { name: 'Message' })
      .fill('First page')
    const beforeNavigation = frames.length
    await lease.page.goto(`${origin}/second`)
    await lease.page
      .getByRole('textbox', { name: 'Message' })
      .fill('Second page')
    await expect.poll(() => frames.length).toBeGreaterThan(beforeNavigation)

    // A joining viewer needs a keyframe even when the tab no longer changes.
    const beforeRequest = frames.length
    await video.requestKeyframe()
    await expect
      .poll(() => frames.slice(beforeRequest).some((frame) => frame.keyframe))
      .toBe(true)
    await video.stop()
    await delivery
    const stoppedFrames = frames.length
    await lease.page
      .getByRole('textbox', { name: 'Message' })
      .fill('Changed while hidden')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(frames).toHaveLength(stoppedFrames)

    await lease.page.setViewportSize({ width: 800, height: 600 })
    await video.start(800, 600)
    await expect
      .poll(() =>
        viewer.evaluate(
          '({ width: videoResults.width, height: videoResults.height })'
        )
      )
      .toEqual({ width: 800, height: 600 })
    await video.stop()
    await delivery
    expect(await viewer.evaluate('videoResults.errors')).toEqual([])
    expect(await viewer.evaluate('videoResults.acks.length')).toBe(
      frames.length
    )
    expect(errors).toEqual([])
    expect(
      await lease.page.getByRole('textbox', { name: 'Message' }).inputValue()
    ).toBe('Changed while hidden')
  } finally {
    await video?.stop()
    await delivery.catch(() => undefined)
    await viewerBrowser.close()
    await host.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})
