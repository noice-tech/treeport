// EXTERNAL: Keep WebRTC's decoder and native video rendering, but do not accumulate
// Chromium's remote-stream smoothing delay between sparse screen updates.
export function presentBrowserVideo(
  video: HTMLVideoElement,
  track: MediaStreamTrack,
  failed: (cause: unknown) => void
): () => void {
  // SAFETY: Optional Chromium constructors are checked before use; standard
  // browser declarations omit these experimental APIs.
  const { MediaStreamTrackProcessor, MediaStreamTrackGenerator } =
    globalThis as typeof globalThis & {
      MediaStreamTrackProcessor?: new (options: {
        track: MediaStreamTrack
        maxBufferSize: number
      }) => { readable: ReadableStream<VideoFrame> }
      MediaStreamTrackGenerator?: new (options: {
        kind: 'video'
      }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> }
    }

  let worker: Worker | null = null
  let input: MediaStreamTrack | null = null
  let output: MediaStreamTrack | null = null
  let stopped = false

  const stopFrames = () => {
    worker?.terminate()
    worker = null
    input?.stop()
    input = null
    output?.stop()
    output = null
  }

  const play = (presentation: MediaStreamTrack) => {
    const stream = new MediaStream([presentation])
    video.srcObject = stream
    void video.play().catch((cause) => {
      if (!stopped && video.srcObject === stream) {
        failed(cause)
      }
    })
  }

  const native = () => {
    if (stopped) {
      return
    }

    stopFrames()
    play(track)
  }

  if (MediaStreamTrackProcessor && MediaStreamTrackGenerator) {
    try {
      worker = new Worker(
        new URL('./browser-video-presentation.worker.ts', import.meta.url),
        { type: 'module' }
      )
      input = track.clone()
      const generated = new MediaStreamTrackGenerator({ kind: 'video' })
      output = generated

      const { readable } = new MediaStreamTrackProcessor({
        track: input,
        maxBufferSize: 1
      })

      worker.onmessage = native
      worker.onerror = (event) => {
        event.preventDefault()
        native()
      }

      worker.postMessage({ readable, writable: generated.writable }, [
        readable,
        generated.writable
      ])
      play(generated)
    } catch {
      native()
    }
  } else {
    native()
  }

  return () => {
    stopped = true
    stopFrames()
  }
}
