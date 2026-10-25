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
