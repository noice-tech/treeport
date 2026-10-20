import type { BrowserClipboard } from './browser-clipboard.js'
import * as Schema from 'effect/Schema'

export const browserVideoSettingsSchema = Schema.Struct({
  captureScale: Schema.Number.pipe(Schema.between(0.5, 1)),
  frameRate: Schema.Int.pipe(Schema.between(1, 60)),
  maxBitrate: Schema.Int.pipe(Schema.between(250_000, 48_000_000))
})
export type BrowserVideoSettings = Schema.Schema.Type<
  typeof browserVideoSettingsSchema
>

export const DEFAULT_BROWSER_VIDEO_SETTINGS: BrowserVideoSettings = {
  captureScale: 0.75,
  frameRate: 30,
  maxBitrate: 6_000_000
}

// Gathering before signaling keeps the authenticated protocol small: one offer
// and one answer, with no candidate queue that can outlive its attachment.
export function gatherBrowserIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const finish = (error: Error | null) => {
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', changed)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const changed = () => {
      if (peer.iceGatheringState === 'complete') {
        finish(null)
      }
    }
    const timer = setTimeout(
      () => finish(new Error('Browser video ICE gathering timed out.')),
      5_000
    )
    peer.addEventListener('icegatheringstatechange', changed)
    changed()
  })
}

// Runs only in a Treeport-owned, isolated capture document, never in a website.
// Chromium owns encoding, congestion control, retransmission and keyframes. No
// pixels or encoded media cross the debugger, daemon, or application WebSocket.
async function captureBrowserVideo(
  source: () => Promise<string>,
  width: number,
  height: number,
  failed: (message: string) => void,
  initialSettings: BrowserVideoSettings
) {
  let settings = initialSettings
  const peers = new Map<string, RTCPeerConnection>()
  let track: MediaStreamTrack | null = null
  let size = { width: 0, height: 0 }
  let stopped = false
  let pending = Promise.resolve()
  // Only source replacement and sender attachment share this short queue.
  // ICE gathering must not hold up resize or disposal.
  const serialize = (operation: () => Promise<void>) => {
    const result = pending.then(operation)
    pending = result.catch(() => undefined)
    return result
  }
  const closePeer = (id: string) => {
    peers.get(id)?.close()
    peers.delete(id)
  }
  const stop = () => {
    stopped = true
    for (const peer of peers.values()) {
      peer.close()
    }
    peers.clear()
    track?.stop()
    track = null
  }
  const configureSender = async (
    sender: RTCRtpSender,
    settings: BrowserVideoSettings
  ) => {
    const parameters = sender.getParameters()
    // A peer may still be negotiating while its source is replaced.
    if (parameters.encodings.length === 0) {
      return
    }

    parameters.degradationPreference = 'maintain-framerate'
    for (const encoding of parameters.encodings) {
      // Ceilings, not fixed rates: Chromium still owns congestion adaptation.
      encoding.maxBitrate = settings.maxBitrate
      encoding.maxFramerate = settings.frameRate
    }
    await sender.setParameters(parameters)
  }
  const resize = (
    width: number,
    height: number,
    nextSettings: BrowserVideoSettings = settings
  ): Promise<void> =>
    serialize(async () => {
      if (stopped) {
        throw new Error('Browser video capture is stopped.')
      }

      if (
        track &&
        size.width === width &&
        size.height === height &&
        settings.captureScale === nextSettings.captureScale &&
        settings.frameRate === nextSettings.frameRate
      ) {
        if (settings.maxBitrate !== nextSettings.maxBitrate) {
          for (const [id, peer] of peers) {
            for (const sender of peer.getSenders()) {
              await configureSender(sender, nextSettings).catch((error) => {
                // Closing one viewer must not interrupt the other viewers.
                if (peers.get(id) === peer && !stopped) {
                  throw error
                }
              })
            }
          }
        }

        settings = nextSettings
        return
      }

      // Cap acquisition itself, not just the sender's post-capture output.
      const { captureScale, frameRate } = nextSettings

      // Round output dimensions to even pixels for H.264. Keep `size` in CSS
      // viewport coordinates; scaling must not change layout or input mapping.
      const captureWidth = Math.max(
        2,
        Math.round((width * captureScale) / 2) * 2
      )
      const captureHeight = Math.max(
        2,
        Math.round((height * captureScale) / 2) * 2
      )

      // Release the old source before requesting another single-use tab token.
      // Keeping a 4K source and resizing its track still incurs 4K copy-out.
      // Reopen at the scaled size instead; replaceTrack preserves each peer.
      const previous = track
      track = null
      previous?.stop()
      const sourceId = await source()
      if (stopped) {
        throw new Error('Browser video capture is stopped.')
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // SAFETY: Only the isolated helper can obtain this exact-tab source.
          ...({
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: sourceId,
              maxWidth: captureWidth,
              maxHeight: captureHeight,
              maxFrameRate: frameRate
            }
          } as MediaTrackConstraints)
        }
      })
      const next = stream.getVideoTracks()[0]!
      await (async () => {
        await next.applyConstraints({
          width: { exact: captureWidth },
          height: { exact: captureHeight },
          frameRate: { max: frameRate }
        })
        if (stopped) {
          throw new Error('Browser video capture is stopped.')
        }

        next.contentHint = 'motion'
        next.addEventListener('ended', () => {
          if (!stopped && track === next) {
            stop()
            failed('Browser video capture ended. Reconnect to restart it.')
          }
        })
        for (const [id, peer] of peers) {
          for (const sender of peer.getSenders()) {
            await sender
              .replaceTrack(next)
              .then(() => configureSender(sender, nextSettings))
              .catch((error) => {
                // A viewer may leave while a source replacement is in flight.
                if (peers.get(id) === peer && !stopped) {
                  throw error
                }
              })
          }
        }
        if (stopped || next.readyState === 'ended') {
          throw new Error('Browser video capture is stopped.')
        }

        track = next
        size = { width, height }
        settings = nextSettings
      })().catch((error) => {
        stream.getTracks().forEach((track) => track.stop())
        throw error
      })
    })

  await resize(width, height)
  return {
    stop,
    closePeer,
    resize,
    async negotiate(id: string, sdp: string): Promise<string> {
      if (stopped) {
        throw new Error('Browser video capture is stopped.')
      }

      closePeer(id)
      if (peers.size >= 8) {
        throw new Error('Browser video has too many viewers.')
      }

      // This is a send-only video service, not an audio/input/data-channel
      // endpoint. Viewer input remains on Treeport's authorized control path.
      const media = sdp.split(/\r?\n/).filter((line) => line.startsWith('m='))
      if (media.length !== 1 || !media[0]!.startsWith('m=video ')) {
        throw new Error('Browser video requires one video track.')
      }

      const peer = new RTCPeerConnection({ iceServers: [] })
      peers.set(id, peer)
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' && peers.get(id) === peer) {
          closePeer(id)
        }
      }
      try {
        await peer.setRemoteDescription({ type: 'offer', sdp })
        const transceiver = peer.getTransceivers()[0]!
        transceiver.direction = 'sendonly'
        await serialize(async () => {
          if (stopped || !track || peers.get(id) !== peer) {
            throw new Error('Browser video negotiation was superseded.')
          }

          await transceiver.sender.replaceTrack(track)
        })
        await peer.setLocalDescription(await peer.createAnswer())
        await serialize(() => configureSender(transceiver.sender, settings))
        await gatherBrowserIce(peer)
        if (stopped || peers.get(id) !== peer) {
          throw new Error('Browser video negotiation was superseded.')
        }

        return peer.localDescription!.sdp
      } catch (error) {
        if (peers.get(id) === peer) {
          closePeer(id)
        }

        throw error
      }
    }
  }
}

export const BROWSER_VIDEO_CAPTURE_SOURCE = `(() => {
  const gatherBrowserIce = ${gatherBrowserIce.toString()};
  return ${captureBrowserVideo.toString()};
})()`

export interface BrowserNativeCdpSession {
  send(method: 'Treeport.copy'): Promise<BrowserClipboard | null>
  send(
    method: 'Treeport.startVideo',
    params: { width: number; height: number; settings: BrowserVideoSettings }
  ): Promise<void>
  send(
    method: 'Treeport.negotiateVideo',
    params: { peerId: string; sdp: string }
  ): Promise<{ sdp: string }>
  send(
    method: 'Treeport.closeVideoPeer',
    params: { peerId: string }
  ): Promise<void>
  send(method: 'Treeport.stopVideo'): Promise<void>
  on(
    event: 'Treeport.videoError',
    listener: (message: { message: string }) => void
  ): void
}
