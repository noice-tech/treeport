import type {
  BrowserClientMessage,
  BrowserServerMessage
} from '#protocol/browser'
import {
  connectBrowserApp,
  type BrowserVideoConnection,
  type BrowserAppSocketFactory
} from './browser-session-client'
import { BrowserVideoReceiver } from './browser-video-receiver'

// EXTERNAL: Browsers start an AudioContext only after one of these events
// grants the page user activation.
const grantsUserActivation = (message: BrowserClientMessage) =>
  (message.type === 'pointer' && message.phase !== 'move') ||
  (message.type === 'key' && message.phase === 'down') ||
  (message.type === 'touch' && message.phase === 'end')

export interface RemoteBrowserConnection extends BrowserVideoConnection {
  stats(): ReturnType<BrowserVideoReceiver['stats']>
  setMuted(muted: boolean): void
}

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
  let barrier = 0
  let ordered = true
  let pressed = false
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

      if (grantsUserActivation(message)) {
        receiver.resumeAudio()
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
    setMuted: (muted) => receiver.setMuted(muted),
    dispose: () => {
      clearInterval(sampler)
      receiver.dispose()
      connection.dispose()
    }
  }
}
