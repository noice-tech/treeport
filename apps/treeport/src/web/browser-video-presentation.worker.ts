// Transfer the native decoded frames without reading pixels or re-encoding.
// Chromium moves the stream endpoints into this worker, away from UI work.
// The generator consumes and closes each VideoFrame after writing it.
self.onmessage = (
  event: MessageEvent<{
    readable: ReadableStream<VideoFrame>
    writable: WritableStream<VideoFrame>
  }>
) => {
  void event.data.readable.pipeTo(event.data.writable).catch(() => {
    self.postMessage('Native playback required')
  })
}
