import { expect, test } from '@playwright/test'
import type { presentBrowserVideo as PresentBrowserVideo } from '../src/web/browser-video-presentation'

for (const workerFails of [false, true]) {
  test.describe(`video presentation with ${workerFails ? 'a failed worker' : 'the real worker'}`, () => {
    if (workerFails) {
      test.beforeEach(async ({ page }) => {
        // Exercise a real worker loading error, not a simulated callback.
        await page.route('**/browser-video-presentation.worker.ts*', (route) =>
          route.fulfill({
            contentType: 'text/javascript',
            body: 'throw new Error("Intentional worker failure")'
          })
        )
      })
    }

    test('shows changed remote frames and resumes after presentation restarts', async ({
      page
    }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/video-check', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<video autoplay muted playsinline></video>'
        })
      )
      await page.goto('/video-check')
      const fixture = await page.evaluateHandle(async () => {
        const moduleUrl = '/src/web/browser-video-presentation.ts'
        const {
          presentBrowserVideo
        }: { presentBrowserVideo: typeof PresentBrowserVideo } = await import(
          moduleUrl
        )
        const video = document.querySelector('video')!
        const source = document.createElement('canvas')
        source.width = 64
        source.height = 64
        const context = source.getContext('2d')!
        let color = '#e02020'
        const draw = () => {
          context.fillStyle = color
          context.fillRect(0, 0, source.width, source.height)
        }
        draw()
        // Keep producing frames during negotiation and restart; no fixed sleeps
        // or external network are needed to observe the requested image.
        const timer = setInterval(draw, 33)
        const stream = source.captureStream(30)
        const sender = new RTCPeerConnection({ iceServers: [] })
        const receiver = new RTCPeerConnection({ iceServers: [] })
        sender.onicecandidate = ({ candidate }) => {
          if (candidate) {
            void receiver.addIceCandidate(candidate)
          }
        }
        receiver.onicecandidate = ({ candidate }) => {
          if (candidate) {
            void sender.addIceCandidate(candidate)
          }
        }
        const incoming = new Promise<MediaStreamTrack>((resolve) => {
          receiver.ontrack = ({ track }) => resolve(track)
        })
        sender.addTrack(stream.getVideoTracks()[0]!, stream)
        await sender.setLocalDescription(await sender.createOffer())
        await receiver.setRemoteDescription(sender.localDescription!)
        await receiver.setLocalDescription(await receiver.createAnswer())
        await sender.setRemoteDescription(receiver.localDescription!)
        const track = await incoming
        const failures: string[] = []
        let stop = presentBrowserVideo(video, track, (error) => {
          failures.push(String(error))
        })
        return {
          failures,
          change(next: string) {
            color = next
            draw()
          },
          stop() {
            // SAFETY: presentBrowserVideo assigns a MediaStream to this video.
            const output = (video.srcObject as MediaStream).getVideoTracks()[0]!
            stop()
            video.srcObject = null
            return { output: output.readyState, received: track.readyState }
          },
          start() {
            stop = presentBrowserVideo(video, track, (error) => {
              failures.push(String(error))
            })
          },
          close() {
            stop()
            video.srcObject = null
            clearInterval(timer)
            sender.close()
            receiver.close()
            stream.getTracks().forEach((sourceTrack) => sourceTrack.stop())
          }
        }
      })
      const expectColor = async (rgb: number[]) => {
        await expect
          .poll(
            () =>
              page
                .locator('video')
                .evaluate((video: HTMLVideoElement, expected) => {
                  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                    return 255
                  }

                  const canvas = document.createElement('canvas')
                  canvas.width = canvas.height = 1
                  const context = canvas.getContext('2d')!
                  context.drawImage(video, 0, 0, 1, 1)
                  const pixels = context.getImageData(0, 0, 1, 1).data
                  return Math.max(
                    ...expected.map((value, index) =>
                      Math.abs(pixels[index]! - value)
                    )
                  )
                }, rgb),
            { message: `Video should show RGB ${rgb.join(', ')}` }
          )
          // Allow codec/color-conversion rounding, not a different source image.
          .toBeLessThan(12)
      }
      try {
        await expectColor([224, 32, 32])
        await fixture.evaluate((state) => state.change('#20e020'))
        await expectColor([32, 224, 32])
        expect(await fixture.evaluate((state) => state.stop())).toEqual({
          output: workerFails ? 'live' : 'ended',
          received: 'live'
        })
        await fixture.evaluate((state) => {
          state.change('#2020e0')
          state.start()
        })
        await expectColor([32, 32, 224])
        await fixture.evaluate((state) => state.change('#e0e020'))
        await expectColor([224, 224, 32])
        expect(await fixture.evaluate((state) => state.failures)).toEqual([])
        expect(errors).toEqual([])
      } finally {
        await fixture.evaluate((state) => state.close())
      }
    })
  })
}
