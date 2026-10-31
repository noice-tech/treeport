import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  parseBrowserMediaClientMessage,
  parseBrowserServerMessage,
  type BrowserMediaClientMessage
} from '@treeport/shared'
import type {
  BrowserRelayCommand,
  BrowserRelayEvent
} from './browser-relay-client.ts'

type Wheel = Extract<BrowserMediaClientMessage, { type: 'wheel' }>

interface Stream {
  id: string
  server: WebSocketServer
  capture: WebSocket | null
  cdp: WebSocket
  session: string | null
  input: string | null
  calls: Map<
    number,
    { resolve(result: CdpResult): void; reject(error: Error): void }
  >
  nextCall: number
  viewer: {
    attachment: string
    epoch: number
    early: Uint8Array[]
    ready: boolean
    awaitingKey: boolean
  } | null
  wheels: { attachment: string; message: Wheel; arrived: number }[]
  inFlight: number[]
  congested: boolean
  preparing: boolean
  dispatchedAt: number
  scale: number | null
  scaledAt: number
  timer: ReturnType<typeof setTimeout> | null
}

interface CdpResult {
  sessionId?: string
  cssVisualViewport?: { scale: number }
}

const WHEEL_SPACING_MS = 1000 / 120

const WHEEL_BEHIND_MS = 1000 / 30

const GESTURE_GAP_MS = 250

const BARRIER_TIMEOUT_MS = 1_000
const MAX_MEDIA_BUFFER = 2 * 1024 * 1024
const AUDIO_PACKET = 2

const streams = new Map<string, Stream>()

const pointers = new Map<
  string,
  {
    socket: Socket
    raised: string | null
    scrolledAt: number
    x: number
    y: number
  }
>()

const media = new Map<string, WebSocket>()
const barriers = new Map<string, number>()
const cursors = new Map<string, { x: number; y: number }>()

const mediaServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 64 * 1024,
  handleProtocols: () => 'treeport-media'
})

const emit = (event: BrowserRelayEvent) => process.send?.(event)

process.on('disconnect', () => process.exit(0))

// EXTERNAL: A motion event of Xorg's inputtest driver protocol
// (xf86-input-inputtest-protocol.h). Axes 0 and 1 are the pointer position,
// 2 and 3 the horizontal and vertical scroll in pixels.
const pointerEvent = (absolute: boolean, axes: [number, number][]) => {
  const event = Buffer.alloc(1056)
  event.writeUInt32LE(event.byteLength, 0)
  event.writeUInt32LE(2, 4)
  event.writeUInt32LE(absolute ? 1 : 0, 8)
  let mask = 0

  for (const [axis, value] of axes) {
    mask |= 1 << axis
    event.writeDoubleLE(value, 32 + axis * 8)
  }

  event.writeUInt8(mask, 20)

  return event
}

const pointer = (path: string) => {
  const existing = pointers.get(path)

  if (existing && !existing.socket.destroyed) {
    return existing
  }

  const socket = connect(path)
  const version = Buffer.alloc(12)
  version.writeUInt32LE(version.byteLength, 0)
  version.writeUInt16LE(1, 8)
  version.writeUInt16LE(1, 10)
  socket.write(version)
  socket.resume()
  socket.on('error', () => socket.destroy())
  const created = { socket, raised: null, scrolledAt: 0, x: -1, y: -1 }
  pointers.set(path, created)

  return created
}

/* eslint-disable-next-line anti-slop/no-unknown-returns -- Raw WebSocket text is parsed before Effect Schema validates it. */
const parse = (data: RawData): unknown | null => {
  try {
    return JSON.parse(data.toString())
  } catch {
    return null
  }
}

const call = (
  stream: Stream,
  method: string,
  params: Record<string, string | number | boolean>
): Promise<CdpResult> => {
  if (stream.cdp.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('The page debugger disconnected.'))
  }

  const id = ++stream.nextCall

  return new Promise<CdpResult>((resolve, reject) => {
    stream.calls.set(id, { resolve, reject })
    stream.cdp.send(
      JSON.stringify({
        id,
        method,
        params,
        sessionId: stream.session ?? undefined
      })
    )
  })
}

const viewerStream = (attachment: string) =>
  [...streams.values()].find(
    (stream) => stream.viewer?.attachment === attachment
  ) ?? null

const fail = (stream: Stream, message: string) => {
  if (streams.get(stream.id) === stream) {
    close(stream)
    emit({ type: 'failed', stream: stream.id, message })
  }
}

const close = (stream: Stream) => {
  if (streams.get(stream.id) !== stream) {
    return
  }

  streams.delete(stream.id)

  if (stream.timer) {
    clearTimeout(stream.timer)
  }

  for (const client of stream.server.clients) {
    client.terminate()
  }

  stream.server.close()
  stream.cdp.close()
}

const forward = (
  stream: Stream,
  viewer: NonNullable<Stream['viewer']>,
  packet: Uint8Array,
  key: boolean
) => {
  if (viewer.awaitingKey && !key) {
    return
  }

  viewer.awaitingKey = false
  const socket = media.get(viewer.attachment)

  if (
    socket?.readyState === WebSocket.OPEN &&
    socket.bufferedAmount < MAX_MEDIA_BUFFER
  ) {
    socket.send(packet)

    return
  }

  viewer.awaitingKey = true
  stream.capture?.send(
    JSON.stringify({ type: 'keyframe', epoch: viewer.epoch })
  )
}

const cursor = (attachment: string, x: number, y: number) => {
  const pending = cursors.get(attachment)

  if (pending) {
    pending.x = x
    pending.y = y

    return
  }

  const latest = { x, y }
  cursors.set(attachment, latest)
  emit({ type: 'cursor', attachment, x, y })
  setTimeout(() => {
    cursors.delete(attachment)

    if (latest.x !== x || latest.y !== y) {
      emit({ type: 'cursor', attachment, x: latest.x, y: latest.y })
    }
  }, 100)
}

const dispatch = (
  stream: Stream,
  wheel: Stream['wheels'][number],
  deltaX: number,
  deltaY: number
) => {
  const scale = stream.scale ?? 1
  const dispatchedAt = performance.now()
  stream.dispatchedAt = dispatchedAt
  stream.inFlight.push(dispatchedAt)
  void call(stream, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: wheel.message.x / scale,
    y: wheel.message.y / scale,
    deltaX,
    deltaY,
    modifiers: wheel.message.modifiers
  })
    .catch(() => undefined)
    .finally(() => {
      stream.inFlight.splice(stream.inFlight.indexOf(dispatchedAt), 1)
      pump(stream)
    })

  // EXTERNAL: CDP multiplies coordinates by the pinch scale. Only a pinch (Ctrl) changes
  // it between events, so other wheels use a recent value instead of waiting.
  if (stream.dispatchedAt - stream.scaledAt > 250) {
    stream.scaledAt = stream.dispatchedAt
    void call(stream, 'Page.getLayoutMetrics', {}).then(
      (result) => {
        stream.scale = result.cssVisualViewport?.scale ?? stream.scale
      },
      () => undefined
    )
  }

  cursor(wheel.attachment, wheel.message.x, wheel.message.y)
}

const pump = (stream: Stream) => {
  if (stream.timer) {
    clearTimeout(stream.timer)
    stream.timer = null
  }

  while (stream.wheels.length > 0 && !stream.preparing) {
    const head = stream.wheels[0]!
    const now = performance.now()

    // EXTERNAL: CDP wheel ACKs include a compositor round trip, so a few in flight keep
    // one step per page frame. CDP makes each wheel its own gesture, which
    // Chrome cannot merge, so a page that falls behind would replay every one
    // of them. Hold the rest instead and send them as one step once it catches
    // up, as Chrome's own input queue does.
    if (
      stream.inFlight.length >= (head.message.modifiers === 0 ? 8 : 2) ||
      now - (stream.inFlight[0] ?? now) > WHEEL_BEHIND_MS
    ) {
      stream.congested = true

      return
    }

    if (
      head.message.barrier > (barriers.get(head.attachment) ?? 0) &&
      now - head.arrived < BARRIER_TIMEOUT_MS
    ) {
      stream.timer = setTimeout(
        () => pump(stream),
        BARRIER_TIMEOUT_MS - (now - head.arrived)
      )

      return
    }

    const slot = stream.dispatchedAt + WHEEL_SPACING_MS

    if (
      !stream.congested &&
      slot > now &&
      slot - head.arrived <= WHEEL_SPACING_MS
    ) {
      stream.timer = setTimeout(() => pump(stream), slot - now)

      return
    }

    // EXTERNAL: Native scrolls skip CDP's wait for the page's main thread. Modified
    // wheels (zoom, horizontal) keep CDP, which carries their modifiers.
    const native =
      stream.input !== null && head.message.modifiers === 0
        ? pointer(stream.input)
        : null

    if (
      native &&
      (native.raised !== stream.id || now - native.scrolledAt > GESTURE_GAP_MS)
    ) {
      stream.preparing = true
      void call(stream, 'Page.bringToFront', {})
        .catch(() => undefined)
        .finally(() => {
          native.raised = stream.id
          native.scrolledAt = performance.now()
          // EXTERNAL: Chromium drops the first scroll delta after the pointer enters
          // one of its windows: it only resynchronizes on it.
          native.socket.write(
            pointerEvent(false, [
              [2, 0.001],
              [3, 0.001]
            ])
          )
          stream.preparing = false
          pump(stream)
        })

      return
    }

    stream.wheels.shift()
    let last = head
    let { deltaX, deltaY } = head.message

    if (stream.congested) {
      for (
        let next = stream.wheels[0];
        next &&
        next.attachment === head.attachment &&
        next.message.modifiers === head.message.modifiers &&
        next.message.barrier === head.message.barrier;
        next = stream.wheels[0]
      ) {
        deltaX += next.message.deltaX
        deltaY += next.message.deltaY
        last = stream.wheels.shift()!
      }

      stream.congested = false
    }

    if (native) {
      const { x, y } = last.message
      stream.dispatchedAt = now
      native.scrolledAt = now

      if (native.x !== x || native.y !== y) {
        native.x = x
        native.y = y
        native.socket.write(
          pointerEvent(true, [
            [0, x],
            [1, y]
          ])
        )
      }

      native.socket.write(
        pointerEvent(false, [
          [2, deltaX],
          [3, deltaY]
        ])
      )
      cursor(head.attachment, x, y)
      continue
    }

    if (stream.scale === null || (head.message.modifiers & 2) !== 0) {
      stream.preparing = true
      void call(stream, 'Page.getLayoutMetrics', {})
        .then(
          (result) => {
            stream.scale = result.cssVisualViewport?.scale ?? 1
            stream.scaledAt = performance.now()
          },
          () => undefined
        )
        .finally(() => {
          stream.preparing = false
          dispatch(stream, last, deltaX, deltaY)
          pump(stream)
        })

      return
    }

    dispatch(stream, last, deltaX, deltaY)
  }
}

const wheel = (attachment: string, message: Wheel) => {
  const stream = viewerStream(attachment)

  if (!stream?.session) {
    emit({
      type: 'wheel',
      attachment,
      message: {
        type: 'wheel',
        x: message.x,
        y: message.y,
        modifiers: message.modifiers,
        deltaX: message.deltaX,
        deltaY: message.deltaY
      }
    })

    return
  }

  stream.wheels.push({ attachment, message, arrived: performance.now() })
  pump(stream)
}

const attachMedia = (attachment: string, socket: WebSocket) => {
  media.get(attachment)?.close(4001, 'Replaced by a newer media socket')
  media.set(attachment, socket)
  socket.on('message', (data, binary) => {
    const message = binary ? null : parseBrowserMediaClientMessage(parse(data))

    if (!message) {
      socket.close(1007, 'Invalid Browser media message')

      return
    }

    if (message.type === 'wheel') {
      wheel(attachment, message)

      return
    }

    const stream = viewerStream(attachment)
    const viewer = stream?.viewer

    if (!stream || !viewer || viewer.epoch !== message.epoch) {
      return
    }

    if (message.type === 'webcodecsKeyframe') {
      if (viewer.ready) {
        viewer.awaitingKey = true
        stream.capture?.send(
          JSON.stringify({ type: 'keyframe', epoch: viewer.epoch })
        )
      }

      return
    }

    if (message.sequence === 0) {
      if (!viewer.ready) {
        viewer.ready = true

        for (const packet of viewer.early.splice(0)) {
          forward(stream, viewer, packet, packet[16] === 1)
        }
      }

      return
    }

    stream.capture?.send(
      JSON.stringify({
        type: 'ack',
        epoch: viewer.epoch,
        sequence: message.sequence
      })
    )
  })
  socket.on('close', () => {
    if (media.get(attachment) === socket) {
      media.delete(attachment)
    }
  })
  socket.on('error', () => socket.close())
}

const captureMessage = (stream: Stream, data: RawData, binary: boolean) => {
  const viewer = stream.viewer

  if (!binary) {
    const value = Object(parse(data))

    if (value.type === 'error') {
      fail(stream, String(value.message))

      return
    }

    const config = parseBrowserServerMessage(value)

    if (
      viewer &&
      config?.type === 'webcodecsReady' &&
      config.epoch === viewer.epoch
    ) {
      emit({ type: 'ready', stream: stream.id, config })
    }

    return
  }

  if (!viewer || !Buffer.isBuffer(data)) {
    return
  }

  const packet = new Uint8Array(data)

  if (packet.byteLength < 18 || packet.byteLength > 4 * 1024 * 1024) {
    fail(stream, 'Invalid encoded packet.')

    return
  }

  const header = new DataView(packet.buffer, packet.byteOffset)

  if (header.getUint32(0) !== viewer.epoch) {
    return
  }

  const kind = header.getUint8(16)

  if (kind === AUDIO_PACKET) {
    const socket = media.get(viewer.attachment)

    if (
      viewer.ready &&
      socket?.readyState === WebSocket.OPEN &&
      socket.bufferedAmount < MAX_MEDIA_BUFFER
    ) {
      socket.send(packet)
    }

    return
  }

  const key = kind === 1

  if (!viewer.ready) {
    if (key) {
      viewer.early = []
    }

    viewer.early.push(packet)

    return
  }

  forward(stream, viewer, packet, key)
}

const open = async (
  command: Extract<BrowserRelayCommand, { type: 'open' }>
) => {
  const token = crypto.randomBytes(32).toString('hex')

  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    maxPayload: 4 * 1024 * 1024
  })

  const cdp = new WebSocket(command.endpoint, { perMessageDeflate: false })

  const stream: Stream = {
    id: command.stream,
    server,
    capture: null,
    cdp,
    session: null,
    input: command.input,
    calls: new Map(),
    nextCall: 0,
    viewer: null,
    wheels: [],
    inFlight: [],
    congested: false,
    preparing: false,
    dispatchedAt: 0,
    scale: null,
    scaledAt: 0,
    timer: null
  }

  streams.set(stream.id, stream)

  // EXTERNAL: Scrolls in the first few hundred milliseconds of a driver connection are
  // lost, which would swallow the start of the first gesture.
  if (stream.input) {
    pointer(stream.input)
  }

  cdp.on('message', (data) => {
    const message = Object(parse(data))
    const pending = stream.calls.get(message.id)

    if (!pending) {
      return
    }

    stream.calls.delete(message.id)

    if (message.error) {
      pending.reject(new Error(String(message.error.message)))
    } else {
      pending.resolve(message.result ?? {})
    }
  })
  cdp.on('error', () => cdp.close())
  cdp.once('close', () => {
    for (const pending of stream.calls.values()) {
      pending.reject(new Error('The page debugger disconnected.'))
    }

    stream.calls.clear()
    fail(stream, 'The hosted page disconnected. Reconnect to restart video.')
  })
  server.on('connection', (socket, request: IncomingMessage) => {
    if (
      stream.capture ||
      server.clients.size > 2 ||
      request.headers.origin !== `chrome-extension://${command.extensionId}`
    ) {
      socket.terminate()

      return
    }

    const timeout = setTimeout(() => socket.terminate(), 3000)
    socket.once('close', () => clearTimeout(timeout))
    socket.once('message', (data, binary) => {
      clearTimeout(timeout)

      if (
        binary ||
        !Buffer.isBuffer(data) ||
        data.byteLength > 256 ||
        data.toString() !== JSON.stringify({ token }) ||
        stream.capture
      ) {
        socket.terminate()

        return
      }

      stream.capture = socket
      socket.on('message', (message, binary) =>
        captureMessage(stream, message, binary)
      )
      socket.once('close', () => {
        if (stream.capture === socket) {
          stream.capture = null
          fail(
            stream,
            'Capture helper disconnected. Reconnect to restart video.'
          )
        }
      })
      socket.on('error', () => socket.close())
      emit({ type: 'connected', stream: stream.id })
    })
  })

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    }),
    new Promise<void>((resolve, reject) => {
      cdp.once('open', resolve)
      cdp.once('error', reject)
    })
  ])

  const { sessionId } = await call(stream, 'Target.attachToTarget', {
    targetId: command.targetId,
    flatten: true
  })

  stream.session = sessionId ?? null
  // SAFETY: listening has completed on a TCP host/port, never a Unix socket.
  const { port } = server.address() as AddressInfo
  emit({ type: 'opened', stream: stream.id, port, token })
}

process.on('message', (value, handle) => {
  // SAFETY: Only the daemon's BrowserRelay writes to this IPC channel.
  const command = value as BrowserRelayCommand

  if (command.type === 'media') {
    if (!handle) {
      return
    }

    // SAFETY: The daemon passes the upgraded request's TCP socket handle.
    const socket = handle as Socket

    // SAFETY: ws reads only the method, URL and headers of the upgrade request.
    const request = {
      method: 'GET',
      url: command.url,
      headers: command.headers
    } as IncomingMessage

    mediaServer.handleUpgrade(
      request,
      socket,
      Buffer.from(command.head, 'base64'),
      (accepted) => attachMedia(command.attachment, accepted)
    )

    return
  }

  if (command.type === 'release') {
    media.get(command.attachment)?.close(4001, 'Browser attachment closed')
    media.delete(command.attachment)
    barriers.delete(command.attachment)

    return
  }

  if (command.type === 'barrier') {
    barriers.set(
      command.attachment,
      Math.max(barriers.get(command.attachment) ?? 0, command.id)
    )

    for (const stream of streams.values()) {
      if (stream.wheels.length > 0) {
        pump(stream)
      }
    }

    return
  }

  if (command.type === 'open') {
    open(command).catch((error) => {
      const stream = streams.get(command.stream)
      const message = error instanceof Error ? error.message : String(error)

      if (stream) {
        fail(stream, message)
      } else {
        emit({ type: 'failed', stream: command.stream, message })
      }
    })

    return
  }

  const stream = streams.get(command.stream)

  if (!stream) {
    return
  }

  if (command.type === 'start') {
    if (stream.capture?.readyState !== WebSocket.OPEN) {
      fail(stream, 'Capture helper unavailable. Reconnect to restart video.')

      return
    }

    stream.viewer = {
      attachment: command.attachment,
      epoch: command.epoch,
      early: [],
      ready: false,
      awaitingKey: false
    }
    stream.capture.send(JSON.stringify({ type: 'start', epoch: command.epoch }))
  } else if (command.type === 'closeViewer') {
    if (stream.viewer?.attachment === command.attachment) {
      stream.viewer = null
      stream.capture?.send(JSON.stringify({ type: 'stop' }))
    }
  } else {
    close(stream)
  }
})
