/// <reference lib="webworker" />
import type {
  BrowserMediaWorkerCommand,
  BrowserMediaWorkerEvent
} from './browser-media-protocol'

// Decodes and paints hosted browser video off the main thread. React work,
// terminals or layout on the main thread cannot delay a decoded frame.
// SAFETY: This module is only loaded as a dedicated worker; the web project
// types `self` as a window.
const scope = Object(self) as DedicatedWorkerGlobalScope
const post = (event: BrowserMediaWorkerEvent) => scope.postMessage(event)
let canvas: OffscreenCanvas | null = null
let context: OffscreenCanvasRenderingContext2D | null = null
let decoder: VideoDecoder | null = null
let stream: {
  epoch: number
  codec: string
  width: number
  height: number
  sequence: number
  needsKey: boolean
  keyRequested: boolean
  presented: boolean
} | null = null
// Decoder output timestamps map back to the packet sequence they ACK.
const decoding = new Map<number, number>()
// Decoded frames wait for the next display refresh. Painting on decoder
// output lets network jitter put two frames into one refresh, so motion is
// uneven even when every frame arrives.
const queue: VideoFrame[] = []
let scheduled = false

const clear = () => {
  if (canvas && context) {
    context.clearRect(0, 0, canvas.width, canvas.height)
  }
}

const closeDecoder = () => {
  decoding.clear()
  for (const frame of queue.splice(0)) {
    frame.close()
  }

  if (decoder && decoder.state !== 'closed') {
    decoder.close()
  }

  decoder = null
}

const paint = () => {
  scheduled = false
  const current = stream
  if (!current || !context || !canvas || queue.length === 0) {
    return
  }

  // One frame per refresh, oldest first: a frame that arrives late plays on
  // the next refresh instead of displacing its successor. Older frames are
  // dropped so at most one waits, which bounds the added latency.
  for (const frame of queue.splice(0, Math.max(0, queue.length - 2))) {
    frame.close()
  }

  const frame = queue.shift()!
  context.drawImage(frame, 0, 0, canvas.width, canvas.height)
  frame.close()
  if (!current.presented) {
    current.presented = true
    post({ type: 'presented', epoch: current.epoch })
  }

  if (queue.length > 0) {
    scheduled = true
    scope.requestAnimationFrame(paint)
  }
}

// The worker owns the attachment's media socket: packets reach the decoder,
// and ACKs and wheel input reach the browser relay, without waiting on the
// page's main thread.
let media: {
  url: string
  token: string
  socket: WebSocket | null
  connected: boolean
  pending: string[]
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
} | null = null

const setConnected = (connected: boolean) => {
  if (media && media.connected !== connected) {
    media.connected = connected
    post({ type: 'media', connected })
  }
}

const sendMedia = (
  message:
    | { type: 'webcodecsAck'; epoch: number; sequence: number }
    | { type: 'webcodecsKeyframe'; epoch: number }
) => {
  const data = JSON.stringify(message)
  if (media?.connected && media.socket) {
    media.socket.send(data)
  } else if (media && media.pending.length < 16) {
    media.pending.push(data)
  }
}

const requestKey = () => {
  if (!stream || stream.keyRequested) {
    return
  }

  stream.needsKey = true
  stream.keyRequested = true
  sendMedia({ type: 'webcodecsKeyframe', epoch: stream.epoch })
}

const closeMedia = () => {
  setConnected(false)
  const current = media
  media = null
  if (current?.timer) {
    clearTimeout(current.timer)
  }

  current?.socket?.close()
}

const openMedia = () => {
  const current = media
  if (!current) {
    return
  }

  current.timer = null
  // Upgrades are authorized before the socket opens, so an open socket is a
  // connected one.
  const socket = new WebSocket(current.url, ['treeport-media', current.token])
  socket.binaryType = 'arraybuffer'
  current.socket = socket
  socket.onopen = () => {
    if (media !== current || current.socket !== socket) {
      return
    }

    current.attempts = 0
    for (const pending of current.pending.splice(0)) {
      socket.send(pending)
    }

    setConnected(true)
    // Packets sent while the previous socket was down are gone.
    if (stream && stream.sequence > 0) {
      stream.keyRequested = false
      requestKey()
    }
  }
  socket.onmessage = ({ data }: MessageEvent<ArrayBuffer | string>) => {
    if (media === current && current.socket === socket) {
      if (data instanceof ArrayBuffer) {
        receive(data)
      }
    }
  }
  socket.onclose = () => {
    if (media !== current || current.socket !== socket) {
      return
    }

    current.socket = null
    setConnected(false)
    // A rejected token belongs to an attachment that is gone, typically after
    // the session socket dropped; its replacement sends a new one.
    if (current.attempts >= 8) {
      closeMedia()
      return
    }

    current.timer = setTimeout(
      openMedia,
      Math.min(2_000, 100 * 2 ** current.attempts++)
    )
  }
}

const openDecoder = () => {
  const current = stream
  if (!current) {
    return
  }

  closeDecoder()
  const instance = new VideoDecoder({
    output: (frame) => {
      if (decoder !== instance || stream !== current || !context || !canvas) {
        frame.close()
        return
      }

      const sequence = decoding.get(frame.timestamp)
      decoding.delete(frame.timestamp)
      if (sequence !== undefined) {
        // ACK decoded packets: decoder throughput, not just the network,
        // bounds the sender's window.
        sendMedia({ type: 'webcodecsAck', epoch: current.epoch, sequence })
      }

      queue.push(frame)
      // Decoder buffers are pooled; a hidden page must not pin them all.
      while (queue.length > 4) {
        queue.shift()!.close()
      }

      if (!scheduled) {
        scheduled = true
        scope.requestAnimationFrame(paint)
      }
    },
    error: () => {
      if (decoder !== instance || stream !== current) {
        return
      }

      // Recover in place: a fresh decoder and IDR, never a reconnect.
      decoder = null
      current.keyRequested = false
      requestKey()
      openDecoder()
    }
  })
  instance.configure({
    codec: current.codec,
    codedWidth: current.width,
    codedHeight: current.height,
    optimizeForLatency: true,
    hardwareAcceleration: 'no-preference'
  })
  decoder = instance
}

scope.onmessage = ({ data }: MessageEvent<BrowserMediaWorkerCommand>) => {
  if (data.type === 'canvas') {
    canvas = data.canvas
    context = canvas.getContext('2d')
    return
  }

  if (data.type === 'configure') {
    closeDecoder()
    stream = {
      ...data.config,
      sequence: 0,
      needsKey: true,
      keyRequested: false,
      presented: false
    }
    if (
      canvas &&
      (canvas.width !== data.config.width ||
        canvas.height !== data.config.height)
    ) {
      canvas.width = data.config.width
      canvas.height = data.config.height
    }

    openDecoder()
    sendMedia({ type: 'webcodecsAck', epoch: data.config.epoch, sequence: 0 })
    return
  }

  if (data.type === 'connect') {
    if (media?.token === data.token) {
      return
    }

    closeMedia()
    media = {
      url: data.url,
      token: data.token,
      socket: null,
      connected: false,
      pending: [],
      attempts: 0,
      timer: null
    }
    openMedia()
    return
  }

  if (data.type === 'wheel') {
    if (media?.connected && media.socket) {
      media.socket.send(JSON.stringify(data.message))
    } else {
      post({ type: 'wheel', message: data.message })
    }

    return
  }

  closeDecoder()
  stream = null
  clear()
}

const receive = (data: ArrayBuffer) => {
  const current = stream
  const bytes = new Uint8Array(data)
  if (!current || !decoder || bytes.byteLength < 18) {
    return
  }

  const header = new DataView(data, 0, 17)
  if (header.getUint32(0) !== current.epoch) {
    return
  }

  const sequence = header.getUint32(4)
  const timestamp = Math.round(header.getFloat64(8))
  const key = header.getUint8(16) === 1
  if (sequence <= current.sequence) {
    return
  }

  // Deltas depend on every earlier packet. After a gap, skip until an IDR.
  if (!key && (current.needsKey || sequence !== current.sequence + 1)) {
    current.sequence = sequence
    requestKey()
    sendMedia({ type: 'webcodecsAck', epoch: current.epoch, sequence })
    return
  }

  if (key) {
    current.needsKey = false
    current.keyRequested = false
  }

  current.sequence = sequence
  decoding.set(timestamp, sequence)
  decoder.decode(
    new EncodedVideoChunk({
      type: key ? 'key' : 'delta',
      timestamp,
      data: bytes.subarray(17)
    })
  )
}
