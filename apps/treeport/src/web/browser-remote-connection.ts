import type { BrowserServerMessage } from '@treeport/shared'
import {
  connectBrowserApp,
  type BrowserVideoConnection,
  type BrowserAppSocketFactory
} from './browser-session-client'
import { BrowserVideoReceiver } from './browser-video-receiver'

export interface RemoteBrowserConnection extends BrowserVideoConnection {
  stats(): ReturnType<BrowserVideoReceiver['stats']>
}

// The workspace owns a connection, not independent signaling and media objects.
// Visibility and disposal always reach both halves in the same order.
export function connectRemoteBrowser(
  appId: string,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  handlers: {
    message(message: BrowserServerMessage): void
    failed(message: string): void
    statusChanged(message: string): void
    presented(): void
  },
  socketFactory?: BrowserAppSocketFactory
): RemoteBrowserConnection {
  // Wheels take the media socket, which the daemon never handles, so a busy
  // daemon cannot stall scrolling. A barrier on the session socket keeps a
  // wheel from overtaking an earlier click or key. Hover moves need none:
  // each wheel carries its own position.
  let barrier = 0
  let ordered = true
  let pressed = false
  // Hosted pages render at this display's refresh rate, so every streamed
  // frame is shown exactly once. The window can move between displays.
  let visible = false
  let refreshRate = 0

  const sampleRefreshRate = () => {
    const times: number[] = []

    const step = (time: number) => {
      times.push(time)

      if (times.length <= 30) {
        requestAnimationFrame(step)

        return
      }

      // The median interval discounts skipped frames; the whole span gives
      // the precision to tell 59.94 Hz from 60 Hz.
      const gaps = times
        .slice(1)
        .map((value, index) => value - times[index]!)
        .sort((a, b) => a - b)

      const span = times.at(-1)! - times[0]!

      const hz =
        Math.round(((Math.round(span / gaps[15]!) * 1000) / span) * 100) / 100

      if (
        visible &&
        hz >= 24 &&
        hz <= 480 &&
        Math.abs(hz - refreshRate) > 0.5
      ) {
        refreshRate = hz
        connection.send({ type: 'refreshRate', hz })
      }
    }

    requestAnimationFrame(step)
  }

  const sampler = setInterval(() => {
    if (visible) {
      sampleRefreshRate()
    }
  }, 5_000)

  const receiver = new BrowserVideoReceiver(
    video,
    canvas,
    (message) => connection.send(message),
    handlers.failed,
    handlers.statusChanged,
    handlers.presented
  )

  const connection = connectBrowserApp(
    appId,
    false,
    {
      message: (message) => {
        if (message.type === 'ready') {
          handlers.statusChanged('Waiting for browser video…')
        }

        if (message.type === 'videoChannel') {
          ordered = false
          // A new attachment starts without a known rate.
          refreshRate = 0

          if (visible) {
            sampleRefreshRate()
          }
        }

        receiver.receive(message)

        if (
          message.type !== 'videoReady' &&
          message.type !== 'videoAnswer' &&
          message.type !== 'videoChannel' &&
          message.type !== 'webcodecsReady'
        ) {
          handlers.message(message)
        }
      }
    },
    socketFactory
  )

  return {
    configureVideo: (settings) => connection.configureVideo(settings),
    send: (message) => {
      if (message.type === 'wheel') {
        if (!ordered) {
          ordered = true
          connection.send({ type: 'inputBarrier', id: ++barrier })
        }

        if (receiver.wheel({ ...message, barrier })) {
          return
        }
      }

      if (message.type === 'pointer') {
        pressed =
          message.phase === 'down' || (pressed && message.phase !== 'up')
      }

      if (message.type !== 'pointer' || message.phase !== 'move' || pressed) {
        ordered = false
      }

      connection.send(message)
    },
    setVisible: (nextVisible) => {
      visible = nextVisible
      receiver.setVisible(nextVisible)
      connection.setVisible(nextVisible)

      if (nextVisible) {
        sampleRefreshRate()
      }
    },
    stats: () => receiver.stats(),
    dispose: () => {
      clearInterval(sampler)
      receiver.dispose()
      connection.dispose()
    }
  }
}
