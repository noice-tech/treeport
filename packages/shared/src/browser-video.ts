// This function runs only in a Treeport-owned capture document. Keep it self-contained:
// the daemon and Electron serialize it into their respective isolated renderers.
async function captureBrowserVideo(
  sourceId: string,
  width: number,
  height: number,
  publish: (message: string) => void
) {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- This checks browser API availability, not untrusted protocol input.
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser does not support native video encoding.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // Chromium's tab-source constraints are not part of the standard DOM types.
      // SAFETY: Both capture hosts obtain this ID for their exact authorized tab.
      ...({
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: sourceId,
          maxWidth: width,
          maxHeight: height,
          maxFrameRate: 30
        }
      } as MediaTrackConstraints)
    }
  })
  const track = stream.getVideoTracks()[0]!
  track.contentHint = 'detail'
  // SAFETY: Chromium exposes the track processor in its window context. Its
  // worker-only standard declaration is not included in TypeScript's DOM library.
  const Processor = (
    globalThis as typeof globalThis & {
      MediaStreamTrackProcessor: new (options: { track: MediaStreamTrack }) => {
        readable: ReadableStream<VideoFrame>
      }
    }
  ).MediaStreamTrackProcessor
  let stopped = false
  let lastFrame: VideoFrame | null = null
  let encodedWidth = 0
  let encodedHeight = 0
  let frames = 0
  let keyframe = true
  let outstanding = 0
  let lastTimestamp = 0
  const dimensions = new Map<number, { width: number; height: number }>()
  const reader = new Processor({ track }).readable.getReader()
  const fail = (error: Error) => {
    if (!stopped) {
      publish(
        JSON.stringify({ frame: null, error: error.message.slice(0, 4_096) })
      )
      stop()
    }
  }
  const encoder = new VideoEncoder({
    output(chunk) {
      if (stopped) {
        return
      }

      const size = dimensions.get(chunk.timestamp)
      dimensions.delete(chunk.timestamp)
      if (!size || chunk.byteLength > 8 * 1024 * 1024) {
        fail(new Error('Browser video frame exceeds the capture limit.'))
        return
      }

      const bytes = new Uint8Array(chunk.byteLength)
      chunk.copyTo(bytes)
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 16_384) {
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 16_384)
        )
      }
      publish(
        JSON.stringify({
          error: null,
          frame: {
            mimeType: 'video/vp8',
            keyframe: chunk.type === 'key',
            timestamp: chunk.timestamp,
            ...size,
            data: btoa(binary)
          }
        })
      )
    },
    error: fail
  })
  const encode = (frame: VideoFrame, force: boolean) => {
    if (stopped || encoder.encodeQueueSize >= 2 || outstanding >= 4) {
      keyframe = true
      return
    }

    if (
      encodedWidth !== frame.displayWidth ||
      encodedHeight !== frame.displayHeight
    ) {
      encodedWidth = frame.displayWidth
      encodedHeight = frame.displayHeight
      encoder.configure({
        codec: 'vp8',
        width: encodedWidth,
        height: encodedHeight,
        framerate: 30,
        bitrate: 3_000_000,
        latencyMode: 'realtime'
      })
      keyframe = true
    }

    lastTimestamp = Math.max(
      lastTimestamp + 1,
      Math.round(performance.now() * 1_000)
    )
    const input = new VideoFrame(frame, { timestamp: lastTimestamp })
    outstanding++
    dimensions.set(lastTimestamp, {
      width: encodedWidth,
      height: encodedHeight
    })
    encoder.encode(input, {
      keyFrame: force || keyframe || frames++ % 30 === 0
    })
    input.close()
    keyframe = false
  }
  const stop = () => {
    if (stopped) {
      return
    }

    stopped = true
    track.stop()
    void reader.cancel().catch(() => undefined)
    lastFrame?.close()
    lastFrame = null
    dimensions.clear()
    if (encoder.state !== 'closed') {
      encoder.close()
    }
  }
  track.addEventListener('ended', () =>
    fail(new Error('Browser video capture ended.'))
  )
  void (async () => {
    while (!stopped) {
      const { value: frame, done } = await reader.read()
      if (done) {
        break
      }

      lastFrame?.close()
      lastFrame = frame
      encode(frame, false)
    }
  })().catch(fail)
  return {
    stop,
    acknowledge() {
      outstanding = Math.max(0, outstanding - 1)
      if (keyframe && lastFrame && outstanding === 0) {
        encode(lastFrame, true)
      }
    },
    requestKeyframe() {
      keyframe = true
      if (lastFrame) {
        encode(lastFrame, true)
      }
    }
  }
}

export const BROWSER_VIDEO_CAPTURE_SOURCE = `(${captureBrowserVideo.toString()})`

// Only the private, exact-guest Electron bridge implements these commands.
export interface BrowserVideoCdpSession {
  send(
    method: 'Treeport.startVideo',
    params: { width: number; height: number }
  ): Promise<void>
  send(
    method: 'Treeport.stopVideo' | 'Treeport.requestVideoKeyframe'
  ): Promise<void>
  on(
    event: 'Treeport.videoFrame',
    listener: (message: { payload: string }) => void
  ): void
}
