// Serialized into Treeport's isolated extension document, never a visited page.
// No pixels or encoded chunks travel through Playwright/CDP.
export async function captureChromiumWebCodecs(
  track: MediaStreamTrack,
  url: string,
  token: string
) {
  // SAFETY: Chromium's optional window track processor is capability-checked below.
  const { MediaStreamTrackProcessor } = globalThis as typeof globalThis & {
    MediaStreamTrackProcessor?: new (options: {
      track: MediaStreamTrack
      maxBufferSize: number
    }) => { readable: ReadableStream<VideoFrame> }
  }
  if (!MediaStreamTrackProcessor || !globalThis.VideoEncoder) {
    throw new Error(
      'WebCodecs PoC requires window track processor and VideoEncoder.'
    )
  }

  const config: VideoEncoderConfig = {
    codec: 'avc1.42002a',
    width: 1280,
    height: 800,
    bitrate: 8_000_000,
    framerate: 60,
    latencyMode: 'realtime',
    bitrateMode: 'constant',
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'annexb' }
  }
  const hardwareSupported =
    (await VideoEncoder.isConfigSupported(config)).supported === true
  if (!hardwareSupported) {
    config.hardwareAcceleration = 'no-preference'
  }

  if (!(await VideoEncoder.isConfigSupported(config)).supported) {
    throw new Error(
      'Chromium cannot encode realtime 1280×800 AVC Annex-B, even with software fallback.'
    )
  }

  const socket = new WebSocket(url)
  const reader = new MediaStreamTrackProcessor({
    track,
    maxBufferSize: 1
  }).readable.getReader()
  let encoder: VideoEncoder | null = null
  let stopped = false
  let latest: VideoFrame | null = null
  let epoch = 0
  let sequence = 0
  let pending = false
  let acknowledged = 0
  let lastEncodedTimestamp: number | null = null
  let started = performance.now()
  let encodedAt = 0
  let captured = 0
  let dropped = 0
  let lastKey = 0
  let announced = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const reset = () => {
    epoch = 0
    pending = false
    acknowledged = 0
    lastEncodedTimestamp = null
    if (timer) {
      clearTimeout(timer)
    }

    timer = null
    if (encoder?.state !== 'closed') {
      encoder?.close()
    }

    encoder = null
  }
  const stop = () => {
    if (stopped) {
      return
    }

    stopped = true
    reset()
    latest?.close()
    latest = null
    void reader.cancel().catch(() => undefined)
    socket.close()
  }
  const fail = (message: string) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({ type: 'error', message: message.slice(0, 512) })
      )
    }

    stop()
  }
  socket.onopen = () => socket.send(JSON.stringify({ token }))
  socket.onclose = stop
  socket.onerror = () => fail('Capture media socket failed.')
  socket.onmessage = ({ data }) => {
    void (async () => {
      const command = JSON.parse(data)
      if (command.type === 'stop') {
        reset()
        return
      }

      if (command.type === 'ack') {
        if (
          epoch &&
          pending &&
          command.epoch === epoch &&
          command.sequence === sequence &&
          sequence > acknowledged
        ) {
          // Sequence advances on encoder output, not submission. A duplicate
          // ACK must not release the next frame while it is still encoding.
          acknowledged = sequence
          pending = false
          if (timer) {
            clearTimeout(timer)
          }

          timer = null
          // Capture may have supplied a newer frame while this packet was
          // outstanding. Drain it now, even if the page has stopped painting.
          if (latest) {
            encode(latest)
          }
        }

        return
      }

      if (command.type !== 'start') {
        return
      }

      reset()
      epoch = command.epoch
      const generation = epoch
      sequence = 0
      captured = 0
      dropped = 0
      lastKey = 0
      started = performance.now()
      announced = false
      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          if (stopped || epoch !== generation) {
            return
          }

          if (
            !pending ||
            chunk.byteLength > 2 * 1024 * 1024 - 41 ||
            socket.bufferedAmount > 0
          ) {
            fail(
              'Encoded packet exceeded the bounded media lane. Reconnect for a fresh keyframe.'
            )
            return
          }

          if (!announced) {
            if (
              chunk.type !== 'key' ||
              !metadata?.decoderConfig ||
              metadata.decoderConfig.description
            ) {
              fail(
                'Expected an initial Annex-B keyframe with decoder metadata.'
              )
              return
            }

            announced = true
            socket.send(
              JSON.stringify({
                type: 'webcodecsReady',
                epoch,
                codec: metadata.decoderConfig.codec,
                width: 1280,
                height: 800,
                hardwareSupported,
                encoderPreference: config.hardwareAcceleration,
                processor: 'window',
                encoderBackend: 'unknown'
              })
            )
          }

          // Reference epoch/sequence/timestamp/key header, plus cumulative capture
          // counters and same-context timings. These are not cross-host latency.
          const packet = new Uint8Array(41 + chunk.byteLength)
          const header = new DataView(packet.buffer)
          header.setUint32(0, epoch)
          header.setUint32(4, ++sequence)
          header.setFloat64(8, chunk.timestamp)
          header.setUint8(16, chunk.type === 'key' ? 1 : 0)
          header.setUint32(17, captured)
          header.setUint32(21, dropped)
          header.setFloat64(25, performance.now() - encodedAt)
          header.setFloat64(33, performance.now() - started)
          chunk.copyTo(packet.subarray(41))
          socket.send(packet)
        },
        error: (error) => fail(error.message)
      })
      encoder.configure(config)
      // Static tabs may emit no new frame on a control handoff. The last raw
      // frame belongs to this exact tab only; encode a fresh IDR for the new epoch.
      if (latest) {
        encode(latest)
      }
    })().catch((error) => fail(String(error)))
  }
  const encode = (frame: VideoFrame) => {
    if (
      !epoch ||
      frame.timestamp === lastEncodedTimestamp ||
      pending ||
      !encoder ||
      encoder.encodeQueueSize > 0 ||
      socket.bufferedAmount > 0
    ) {
      return
    }

    if (frame.displayWidth !== 1280 || frame.displayHeight !== 800) {
      fail(
        'Capture dimensions changed; this PoC requires a fixed 1280×800 tab.'
      )
      return
    }

    pending = true
    lastEncodedTimestamp = frame.timestamp
    encodedAt = performance.now()
    const keyFrame = sequence === 0 || encodedAt - lastKey >= 2000
    if (keyFrame) {
      lastKey = encodedAt
    }

    timer = setTimeout(
      () => fail('Video presentation ACK timed out. Reconnect to recover.'),
      5000
    )
    encoder.encode(frame, { keyFrame })
  }
  const pump = async () => {
    while (!stopped) {
      const { value: frame, done } = await reader.read()
      if (done) {
        if (!stopped) {
          fail('Exact-tab capture ended.')
        }

        return
      }

      if (stopped) {
        frame.close()
        return
      }

      captured++
      // Processor holds at most one raw frame, plus this replaceable latest
      // frame. encode() retains no JS frame queue; one output waits for ACK.
      // Retention is not a drop: count only unencoded frames being replaced.
      if (latest && latest.timestamp !== lastEncodedTimestamp) {
        dropped++
      }

      latest?.close()
      latest = frame
      encode(frame)
    }
  }
  void pump().catch((error) => fail(String(error)))
  return {
    stop,
    // Privileged local diagnostics only; never return frames or encoded bytes.
    stats: () => ({
      epoch,
      sequence,
      captured,
      droppedRaw: dropped,
      pending,
      encodeQueueSize: encoder?.encodeQueueSize ?? 0,
      socketBufferedAmount: socket.bufferedAmount,
      retainedRawFrames: latest ? 1 : 0,
      captureSettings: track.getSettings(),
      hardwareSupported,
      encoderPreference: config.hardwareAcceleration,
      encoderBackend: 'unknown'
    })
  }
}
