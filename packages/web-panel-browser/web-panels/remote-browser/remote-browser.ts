import { z } from 'zod'
import {
  treeport,
  type JsonValue,
  type WorktreeListener,
  type WorktreeListenerDiscovery
} from '@treeport/panel-sdk'
import './remote-browser.css'

type ClientMessage =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' | 'takeControl' | 'reset' }
  | { type: 'resize'; width: number; height: number }
  | {
      type: 'pointer'
      phase: 'move' | 'down' | 'up'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle'
    }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | { type: 'key'; phase: 'down' | 'up'; key: string }
  | { type: 'insertText'; text: string }
  | { type: 'frameAck'; sequence: number }

const sessionStateSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  controlled: z.boolean(),
  hasController: z.boolean(),
  controller: z.enum(['you', 'agent', 'other', 'none']),
  viewport: z.strictObject({ width: z.number(), height: z.number() })
})

const serverMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), state: sessionStateSchema }),
  z.strictObject({ type: z.literal('state'), state: sessionStateSchema }),
  z.strictObject({
    type: z.literal('controlChanged'),
    state: sessionStateSchema
  }),
  z.strictObject({ type: z.literal('navigationError'), message: z.string() }),
  z.strictObject({ type: z.literal('browserCrashed'), message: z.string() }),
  z.strictObject({ type: z.literal('closed'), reason: z.string() }),
  z.strictObject({
    type: z.literal('browserUnavailable'),
    message: z.string(),
    installCommand: z.string().nullable()
  }),
  z.strictObject({
    type: z.literal('frame'),
    sequence: z.number(),
    mimeType: z.literal('image/jpeg'),
    timestamp: z.number(),
    width: z.number(),
    height: z.number(),
    data: z.instanceof(ArrayBuffer)
  })
])

const browserUrlValueSchema = z.string().max(4_096)

type SessionState = z.infer<typeof sessionStateSchema>
type ServerMessage = z.infer<typeof serverMessageSchema>

const form = document.querySelector('form')!
const input = document.querySelector<HTMLInputElement>('input[name="url"]')!
const homeButton = document.querySelector<HTMLButtonElement>(
  '[data-action="home"]'
)!
const backButton = document.querySelector<HTMLButtonElement>(
  '[data-action="back"]'
)!
const forwardButton = document.querySelector<HTMLButtonElement>(
  '[data-action="forward"]'
)!
const reloadButton = document.querySelector<HTMLButtonElement>(
  '[data-action="reload"]'
)!
const stopButton = document.querySelector<HTMLButtonElement>(
  '[data-action="stop"]'
)!
const copyButton = document.querySelector<HTMLButtonElement>(
  '[data-action="copy"]'
)!
const resetButton = document.querySelector<HTMLButtonElement>(
  '[data-action="reset"]'
)!
const retryButton = document.querySelector<HTMLButtonElement>(
  '[data-action="retry"]'
)!
const refreshServers = document.querySelector<HTMLButtonElement>(
  '[data-action="refresh-servers"]'
)!
const error = document.querySelector<HTMLParagraphElement>('.error')!
const controlStatus =
  document.querySelector<HTMLParagraphElement>('.control-status')!
const loading = document.querySelector<HTMLDivElement>('.loading')!
const failure = document.querySelector<HTMLDivElement>('.failure')!
const failureMessage =
  document.querySelector<HTMLSpanElement>('.failure-message')!
const installCommand = document.querySelector<HTMLElement>('.install-command')!
const homepage = document.querySelector<HTMLElement>('.homepage')!
const serverStatus =
  document.querySelector<HTMLParagraphElement>('.server-status')!
const serverList = document.querySelector<HTMLUListElement>('.server-list')!
const serverEmpty =
  document.querySelector<HTMLParagraphElement>('.server-empty')!
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!
const drawing = canvas.getContext('2d', { alpha: false })!

let port: MessagePort | null = null
let currentUrl: URL | null = null
let configuredTitle = ''
let discoveryRequest = 0
let frameWidth = 1_280
let frameHeight = 800
let viewportWidth = 1_280
let viewportHeight = 800
let browserCrashed = false
let controlled = false
let pointerActive = false

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function browserUrl(value: JsonValue | undefined): URL | null {
  const parsed = browserUrlValueSchema.safeParse(value)
  if (!parsed.success || !URL.canParse(parsed.data)) {
    return null
  }

  const url = new URL(parsed.data)
  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === ''
    ? url
    : null
}

function listenerUrl(listener: WorktreeListener): URL | null {
  let host = listener.host
  if (['*', '0.0.0.0', '::', '::1', '127.0.0.1'].includes(host)) {
    host = 'localhost'
  } else if (host.includes(':')) {
    host = `[${host}]`
  }

  return browserUrl(`http://${host}:${listener.port}/`)
}

function showError(message: string | null) {
  error.textContent = message ?? ''
  error.hidden = message === null
}

function send(message: ClientMessage) {
  port?.postMessage(message)
}

function requestConnection() {
  parent.postMessage(
    { source: 'treeport-browser-panel-v1', method: 'browser.connect' },
    '*'
  )
}

function navigate(url: URL) {
  homepage.hidden = true
  failure.hidden = true
  showError(null)
  send({ type: 'takeControl' })
  send({ type: 'navigate', url: url.href })
}

function showHomepage() {
  homepage.hidden = false
  failure.hidden = true
  loading.hidden = true
}

function applyState(state: SessionState) {
  controlled = state.controlled
  if (!browserCrashed) {
    showError(null)
  }

  failure.hidden = true
  loading.hidden = !state.loading
  reloadButton.hidden = state.loading
  stopButton.hidden = !state.loading
  backButton.disabled = !state.canGoBack || !state.controlled
  forwardButton.disabled = !state.canGoForward || !state.controlled
  reloadButton.disabled = !state.controlled
  stopButton.disabled = !state.controlled
  resetButton.disabled = !state.controlled

  controlStatus.hidden = !state.hasController || state.controlled
  controlStatus.textContent = state.controlled
    ? ''
    : state.controller === 'agent'
      ? 'A coding agent controls this browser. Interact with the viewport to take control.'
      : 'Another Treeport client controls this browser. Interact with the viewport to take control.'

  const url = browserUrl(state.url)
  if (url) {
    homepage.hidden = true
    currentUrl = url
    input.value = url.href
    copyButton.disabled = false
    treeport.panel.setTitle(configuredTitle || state.title || url.host)
  } else {
    currentUrl = null
    copyButton.disabled = true
    if (state.url === 'about:blank') {
      showHomepage()
    }

    treeport.panel.setTitle(configuredTitle || state.title || null)
  }
}

async function drawFrame(message: Extract<ServerMessage, { type: 'frame' }>) {
  try {
    const bitmap = await createImageBitmap(
      new Blob([message.data], { type: message.mimeType })
    )
    frameWidth = message.width
    frameHeight = message.height
    if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
      canvas.width = frameWidth
      canvas.height = frameHeight
    }

    drawing.drawImage(bitmap, 0, 0, frameWidth, frameHeight)
    bitmap.close()
  } finally {
    send({ type: 'frameAck', sequence: message.sequence })
  }
}

function receive(message: ServerMessage) {
  if (message.type === 'frame') {
    void drawFrame(message)
    return
  }

  if (
    message.type === 'ready' ||
    message.type === 'state' ||
    message.type === 'controlChanged'
  ) {
    if (message.type === 'ready') {
      browserCrashed = false
    }

    applyState(message.state)
    return
  }

  if (message.type === 'browserUnavailable') {
    homepage.hidden = true
    loading.hidden = true
    failure.hidden = false
    failureMessage.textContent = message.message
    installCommand.hidden = message.installCommand === null
    installCommand.textContent = message.installCommand ?? ''
    return
  }

  if (message.type === 'closed') {
    showError(message.reason ?? 'The hosted browser session closed.')
    return
  }

  if (message.type === 'navigationError' || message.type === 'browserCrashed') {
    if (message.type === 'browserCrashed') {
      browserCrashed = true
    }

    showError(
      message.message ?? 'The hosted browser could not complete the request.'
    )
  }
}

function renderListeners(discovery: WorktreeListenerDiscovery) {
  serverList.replaceChildren()
  serverEmpty.hidden = true
  serverStatus.textContent = ''
  if (!discovery.supported) {
    serverStatus.textContent =
      discovery.message ?? 'TCP listener discovery is unavailable.'
    return
  }

  const candidates = new Map<string, { url: URL; listener: WorktreeListener }>()
  for (const listener of discovery.listeners) {
    const url = listenerUrl(listener)
    if (!url) {
      continue
    }

    const existing = candidates.get(url.href)
    if (!existing || (!existing.listener.terminalId && listener.terminalId)) {
      candidates.set(url.href, { url, listener })
    }
  }
  if (candidates.size === 0) {
    serverEmpty.hidden = false
    return
  }

  for (const { url, listener } of [...candidates.values()].sort(
    (left, right) =>
      left.listener.port - right.listener.port ||
      left.url.href.localeCompare(right.url.href)
  )) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(
      'aria-label',
      `Open ${url.href}, ${listener.command || 'unknown command'}`
    )
    const address = document.createElement('strong')
    address.textContent = url.href
    const command = document.createElement('span')
    command.textContent = listener.command || 'Unknown command'
    button.append(address, command)
    button.addEventListener('click', () => navigate(url))
    item.append(button)
    serverList.append(item)
  }
}

async function discoverListeners() {
  const request = ++discoveryRequest
  refreshServers.disabled = true
  serverStatus.textContent = 'Scanning for development servers…'
  serverList.replaceChildren()
  serverEmpty.hidden = true
  try {
    const discovery = await treeport.network.listeners()
    if (request === discoveryRequest) {
      renderListeners(discovery)
    }
  } catch (cause) {
    if (request === discoveryRequest) {
      serverStatus.textContent = `Could not scan for development servers: ${errorText(cause)}`
    }
  } finally {
    if (request === discoveryRequest) {
      refreshServers.disabled = false
    }
  }
}

addEventListener('message', (event) => {
  if (
    event.source !== parent ||
    event.data?.source !== 'treeport-host-v1' ||
    event.data.method !== 'browser.connected' ||
    !event.ports[0]
  ) {
    return
  }

  port?.close()
  port = event.ports[0]
  port.onmessage = (portEvent) => {
    const message = serverMessageSchema.safeParse(portEvent.data)
    if (message.success) {
      receive(message.data)
    }
  }
  port.start()
  const bounds = canvas.getBoundingClientRect()
  viewportWidth = Math.max(320, Math.min(3_840, Math.round(bounds.width)))
  viewportHeight = Math.max(200, Math.min(2_160, Math.round(bounds.height)))
  send({
    type: 'resize',
    width: viewportWidth,
    height: viewportHeight
  })
})

void treeport.context().then(
  (context) => {
    const launchTitle = z.string().safeParse(context.launch.input?.title)
    configuredTitle = launchTitle.success
      ? launchTitle.data.trim().slice(0, 256)
      : ''
    showHomepage()
    treeport.panel.setTitle(configuredTitle || null)
    requestConnection()
    void discoverListeners()
  },
  (cause: unknown) => showError(errorText(cause))
)

treeport.shortcuts.onFind(() => {
  input.focus()
  input.select()
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const url = browserUrl(input.value.trim())
  if (!url) {
    showError('Enter an absolute HTTP or HTTPS URL without credentials.')
    return
  }

  navigate(url)
})
homeButton.addEventListener('click', showHomepage)
backButton.addEventListener('click', () => send({ type: 'back' }))
forwardButton.addEventListener('click', () => send({ type: 'forward' }))
reloadButton.addEventListener('click', () => send({ type: 'reload' }))
stopButton.addEventListener('click', () => send({ type: 'stop' }))
copyButton.addEventListener('click', () => {
  if (currentUrl) {
    void navigator.clipboard
      .writeText(currentUrl.href)
      .catch((cause) =>
        showError(
          cause instanceof Error ? cause.message : 'Could not copy the address.'
        )
      )
  }
})
resetButton.addEventListener('click', () => {
  if (
    confirm(
      'Reset this disposable browser and delete its cookies and local data?'
    )
  ) {
    browserCrashed = false
    send({ type: 'reset' })
  }
})
retryButton.addEventListener('click', requestConnection)
refreshServers.addEventListener('click', () => void discoverListeners())

function browserPoint(event: PointerEvent) {
  const bounds = canvas.getBoundingClientRect()
  return {
    x: Math.max(
      0,
      Math.min(
        viewportWidth,
        ((event.clientX - bounds.left) / bounds.width) * viewportWidth
      )
    ),
    y: Math.max(
      0,
      Math.min(
        viewportHeight,
        ((event.clientY - bounds.top) / bounds.height) * viewportHeight
      )
    )
  }
}

function mouseButton(button: number): 'left' | 'right' | 'middle' {
  return button === 2 ? 'right' : button === 1 ? 'middle' : 'left'
}

canvas.addEventListener('pointermove', (event) => {
  if (!controlled && !pointerActive) {
    return
  }

  const point = browserPoint(event)
  send({ type: 'pointer', phase: 'move', ...point })
})
canvas.addEventListener('pointerdown', (event) => {
  event.preventDefault()
  canvas.focus()
  canvas.setPointerCapture(event.pointerId)
  pointerActive = true
  send({ type: 'takeControl' })
  send({
    type: 'pointer',
    phase: 'down',
    ...browserPoint(event),
    button: mouseButton(event.button)
  })
})
for (const eventName of ['pointerup', 'pointercancel'] as const) {
  canvas.addEventListener(eventName, (event) => {
    event.preventDefault()
    send({
      type: 'pointer',
      phase: 'up',
      ...browserPoint(event),
      button: mouseButton(event.button)
    })
    pointerActive = false
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
  })
}
canvas.addEventListener('contextmenu', (event) => event.preventDefault())
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    send({ type: 'takeControl' })
    send({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY })
  },
  { passive: false }
)
canvas.addEventListener('keydown', (event) => {
  event.preventDefault()
  send({ type: 'takeControl' })
  send({ type: 'key', phase: 'down', key: event.key })
})
canvas.addEventListener('keyup', (event) => {
  event.preventDefault()
  send({ type: 'key', phase: 'up', key: event.key })
})
canvas.addEventListener('paste', (event) => {
  event.preventDefault()
  send({ type: 'takeControl' })
  send({
    type: 'insertText',
    text: event.clipboardData?.getData('text/plain') ?? ''
  })
})

let resizeTimer: ReturnType<typeof setTimeout> | null = null
new ResizeObserver(([entry]) => {
  if (!entry) {
    return
  }

  if (resizeTimer) {
    clearTimeout(resizeTimer)
  }

  resizeTimer = setTimeout(() => {
    viewportWidth = Math.max(
      320,
      Math.min(3_840, Math.round(entry.contentRect.width))
    )
    viewportHeight = Math.max(
      200,
      Math.min(2_160, Math.round(entry.contentRect.height))
    )
    send({
      type: 'resize',
      width: viewportWidth,
      height: viewportHeight
    })
  }, 100)
}).observe(canvas)

addEventListener('beforeunload', () => port?.close())
