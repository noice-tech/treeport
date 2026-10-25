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
      'Browser video requires the window track processor and VideoEncoder.'
    )
  }

  const { width, height } = track.getSettings()

  if (!width || !height) {
    throw new Error('Exact-tab capture did not report its dimensions.')
  }

  // H.264 level 4.2 covers 1080p60; larger captures need the macroblock
  // throughput of level 5.1 or 5.2 (up to the protocol's 3840×2160 limit).
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)

  const config: VideoEncoderConfig = {
    codec:
      macroblocks <= 8704
        ? 'avc1.42002a'
        : macroblocks * 60 <= 983040
          ? 'avc1.420033'
          : 'avc1.420034',
    width,
    height,
    // Text needs far more bits than camera video. Interactive pages are idle
    // most of the time, so a generous variable cap costs little on average.
    bitrate: Math.round(
      Math.min(40_000_000, Math.max(8_000_000, width * height * 120 * 0.1))
    ),
    framerate: 120,
    latencyMode: 'realtime',
    bitrateMode: 'variable',
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
      `Chromium cannot encode realtime ${width}×${height} AVC Annex-B, even with software fallback.`
    )
  }

  // Frames are pipelined: up to WINDOW encoded packets may await the viewer's
  // decode ACK. Capture keeps only the newest raw frame while the window is
  // full, so congestion lowers the frame rate instead of adding latency.
  const WINDOW = 4
  const MAX_SOCKET_BUFFER = 1024 * 1024
  const socket = new WebSocket(url)

  const reader = new MediaStreamTrackProcessor({
    track,
    maxBufferSize: 1
  }).readable.getReader()

  let encoder: VideoEncoder | null = null
  let stopped = false
  let latest: VideoFrame | null = null
  let latestEncoded = false
  let epoch = 0
  let sequence = 0
  let encoding = 0
  let acknowledged = 0
  let acknowledgedAt = 0
  let forceKey = false
  let refinements = 0
  let announced = false
  let started = performance.now()
  let captured = 0
  let dropped = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  let idle: ReturnType<typeof setTimeout> | null = null

  const reset = () => {
    epoch = 0
    sequence = 0
    encoding = 0
    acknowledged = 0
    announced = false

    for (const timer of [retry, idle]) {
      if (timer) {
        clearTimeout(timer)
      }
    }

    retry = null
    idle = null

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
    clearInterval(watchdog)
    reset()
    latest?.close()
    latest = null
    void reader.cancel().catch(() => undefined)
    track.stop()
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

  const encode = () => {
    if (
      stopped ||
      !epoch ||
      !encoder ||
      !latest ||
      latestEncoded ||
      encoding > 0 ||
      sequence - acknowledged >= WINDOW
    ) {
      return
    }

    if (socket.bufferedAmount > MAX_SOCKET_BUFFER) {
      retry ??= setTimeout(() => {
        retry = null
        encode()
      }, 4)

      return
    }

    if (latest.displayWidth !== width || latest.displayHeight !== height) {
      fail('Capture dimensions changed without restarting the video epoch.')

      return
    }

    const keyFrame = forceKey || sequence === 0
    forceKey = false
    latestEncoded = true
    encoding++
    encoder.encode(latest, { keyFrame })

    if (idle) {
      clearTimeout(idle)
    }

    // Realtime rate control spends few bits on fast motion. Once the page is
    // still, re-encode the same pixels so static text converges to full detail.
    idle = setTimeout(
      () => {
        idle = null

        if (latest && refinements < 2) {
          refinements++

          const copy = new VideoFrame(latest, {
            timestamp: latest.timestamp + refinements
          })

          latest.close()
          latest = copy
          latestEncoded = false
          encode()
        }
      },
      150 * (refinements + 1)
    )
  }

  // A lost or stalled viewer must not freeze capture forever. Treat
  // unacknowledged packets as lost and restart the GOP after a quiet period.
  const watchdog = setInterval(() => {
    if (
      epoch &&
      sequence > acknowledged &&
      performance.now() - acknowledgedAt > 3_000
    ) {
      acknowledged = sequence
      acknowledgedAt = performance.now()
      forceKey = true
      latestEncoded = false
      encode()
    }
  }, 1_000)

  track.addEventListener('ended', () => {
    if (!stopped) {
      fail('Exact-tab capture ended.')
    }
  })
  socket.onopen = () => socket.send(JSON.stringify({ token }))
  socket.onclose = stop
  socket.onerror = () => fail('Capture media socket failed.')
  socket.onmessage = ({ data }) => {
    const command = JSON.parse(data)

    if (command.type === 'stop') {
      reset()

      return
    }

    if (command.type === 'ack') {
      if (epoch && command.epoch === epoch) {
        acknowledged = Math.max(
          acknowledged,
          Math.min(command.sequence, sequence)
        )
        acknowledgedAt = performance.now()
        encode()
      }

      return
    }

    if (command.type === 'keyframe') {
      if (epoch && command.epoch === epoch) {
        // Packets in flight were discarded by the relay or viewer.
        acknowledged = sequence
        acknowledgedAt = performance.now()
        forceKey = true
        latestEncoded = false
        encode()
      }

      return
    }

    if (command.type !== 'start') {
      return
    }

    reset()
    epoch = command.epoch
    const generation = epoch
    captured = 0
    dropped = 0
    started = performance.now()
    acknowledgedAt = started
    forceKey = true
    encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (stopped || epoch !== generation) {
          return
        }

        encoding--

        if (chunk.byteLength > 4 * 1024 * 1024 - 17) {
          fail('Encoded packet exceeded the media lane limit.')

          return
        }

        if (!announced) {
          if (
            chunk.type !== 'key' ||
            !metadata?.decoderConfig ||
            metadata.decoderConfig.description
          ) {
            fail('Expected an initial Annex-B keyframe with decoder metadata.')

            return
          }

          announced = true
          socket.send(
            JSON.stringify({
              type: 'webcodecsReady',
              epoch,
              codec: metadata.decoderConfig.codec,
              width,
              height,
              hardwareSupported,
              encoderPreference: config.hardwareAcceleration,
              processor: 'window',
              encoderBackend: 'unknown'
            })
          )
        }

        // Header: epoch/sequence/timestamp/key.
        const packet = new Uint8Array(17 + chunk.byteLength)
        const header = new DataView(packet.buffer)
        header.setUint32(0, epoch)
        header.setUint32(4, ++sequence)
        header.setFloat64(8, chunk.timestamp)
        header.setUint8(16, chunk.type === 'key' ? 1 : 0)
        chunk.copyTo(packet.subarray(17))
        socket.send(packet)
        encode()
      },
      error: (error) => fail(error.message)
    })
    encoder.configure(config)
    // Static tabs may emit no new frame on a control handoff. The last raw
    // frame belongs to this exact tab only; encode a fresh IDR for the new epoch.
    latestEncoded = false
    encode()
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

      // The processor holds at most one raw frame, plus this replaceable
      // latest frame. Count only frames replaced before they were encoded.
      if (latest && !latestEncoded) {
        dropped++
      }

      latest?.close()
      latest = frame
      latestEncoded = false
      refinements = 0
      encode()
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
      inFlight: sequence - acknowledged,
      encodeQueueSize: encoder?.encodeQueueSize ?? 0,
      socketBufferedAmount: socket.bufferedAmount,
      retainedRawFrames: latest ? 1 : 0,
      captureSettings: track.getSettings(),
      hardwareSupported,
      encoderPreference: config.hardwareAcceleration,
      encoderBackend: 'unknown',
      elapsedMs: performance.now() - started
    })
  }
}
