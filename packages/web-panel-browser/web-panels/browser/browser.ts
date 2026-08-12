import {
  treeport,
  type JsonValue,
  type WorktreeListener,
  type WorktreeListenerDiscovery
} from '@treeport/panel-sdk'
import './browser.css'

const form = document.querySelector('form')!
const input = document.querySelector<HTMLInputElement>('input[name="url"]')!
const homeButton = document.querySelector<HTMLButtonElement>(
  '[data-action="home"]'
)!
const reload = document.querySelector<HTMLButtonElement>(
  '[data-action="reload"]'
)!
const external = document.querySelector<HTMLButtonElement>(
  '[data-action="external"]'
)!
const retry = document.querySelector<HTMLButtonElement>(
  '[data-action="retry"]'
)!
const refreshServers = document.querySelector<HTMLButtonElement>(
  '[data-action="refresh-servers"]'
)!
const error = document.querySelector<HTMLParagraphElement>('.error')!
const loading = document.querySelector<HTMLDivElement>('.loading')!
const failure = document.querySelector<HTMLDivElement>('.failure')!
const homepage = document.querySelector<HTMLElement>('.homepage')!
const serverStatus =
  document.querySelector<HTMLParagraphElement>('.server-status')!
const serverList = document.querySelector<HTMLUListElement>('.server-list')!
const serverEmpty =
  document.querySelector<HTMLParagraphElement>('.server-empty')!
const frame = document.querySelector<HTMLIFrameElement>('iframe')!

function browserUrl(value: unknown): URL | null {
  if (
    typeof value !== 'string' ||
    value.length > 4_096 ||
    !URL.canParse(value)
  ) {
    return null
  }

  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === ''
    ? url
    : null
}

function listenerUrl(listener: WorktreeListener): URL | null {
  let host = listener.host
  if (
    host === '*' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host === '127.0.0.1'
  ) {
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

let navigation = 0
let discoveryRequest = 0
let frameLoaded = false
let targetReachable = false
let showingHomepage = false
let currentUrl: URL | null = null
let chooseServer: ((url: URL) => void) | null = null
let receiveFrameLocation: ((url: URL) => void) | null = null
let frameLocationSubscription: string | null = null
let frameLocationSubscriptionSerial = 0

function showHomepage() {
  showingHomepage = true
  navigation += 1
  homepage.hidden = false
  frame.hidden = true
  loading.hidden = true
  failure.hidden = true
}

function navigate(url: URL) {
  showingHomepage = false
  homepage.hidden = true
  frame.hidden = false
  frameLocationSubscription = null
  const currentNavigation = ++navigation
  frameLoaded = false
  targetReachable = false
  failure.hidden = true
  loading.hidden = false
  reload.disabled = true
  external.disabled = false
  frame.src = url.href

  void fetch(url, {
    method: 'HEAD',
    mode: 'no-cors',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000)
  }).then(
    () => {
      if (navigation !== currentNavigation || showingHomepage) {
        return
      }

      targetReachable = true
      if (frameLoaded) {
        loading.hidden = true
        reload.disabled = false
      }
    },
    () => {
      if (navigation !== currentNavigation || showingHomepage) {
        return
      }

      loading.hidden = true
      failure.hidden = false
      reload.disabled = false
    }
  )
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
      left.url.href.localeCompare(right.url.href) ||
      left.listener.command.localeCompare(right.listener.command)
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
    button.addEventListener('click', () => chooseServer?.(url))
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
  } catch (reason) {
    if (request === discoveryRequest) {
      serverStatus.textContent = `Could not scan for development servers: ${
        reason instanceof Error ? reason.message : String(reason)
      }`
    }
  } finally {
    if (request === discoveryRequest) {
      refreshServers.disabled = false
    }
  }
}

frame.addEventListener('load', () => {
  if (frame.getAttribute('src') === 'about:blank') {
    return
  }

  frameLocationSubscription = String(++frameLocationSubscriptionSerial)
  frame.contentWindow?.postMessage(
    {
      source: 'treeport-browser-v1',
      method: 'location.subscribe',
      subscription: frameLocationSubscription
    },
    '*'
  )
  if (showingHomepage) {
    return
  }

  frameLoaded = true
  if (targetReachable) {
    loading.hidden = true
    reload.disabled = false
  }
})

void Promise.all([
  treeport.context(),
  treeport.storage.get<JsonValue>('browser-state')
]).then(
  ([context, storedValue]) => {
    const configuredInput = context.launch.input
    const configuredUrl = browserUrl(configuredInput?.url)
    const configuredTitle =
      typeof configuredInput?.title === 'string'
        ? configuredInput.title.trim().slice(0, 256)
        : ''
    const storedState =
      storedValue !== null &&
      typeof storedValue === 'object' &&
      !Array.isArray(storedValue)
        ? storedValue
        : null
    const storedUrl = browserUrl(storedState?.url)
    const storedLaunchUpdatedAt =
      typeof storedState?.launchUpdatedAt === 'string'
        ? storedState.launchUpdatedAt
        : null
    currentUrl =
      configuredUrl && storedLaunchUpdatedAt !== context.panel.updatedAt
        ? configuredUrl
        : (storedUrl ?? configuredUrl)

    let storageWrites: Promise<unknown> = Promise.resolve()
    const storeUrl = (url: URL) => {
      const write = storageWrites.then(() =>
        treeport.storage.set('browser-state', {
          url: url.href,
          launchUpdatedAt: context.panel.updatedAt
        })
      )
      storageWrites = write.catch(() => undefined)
      return write
    }

    receiveFrameLocation = (url) => {
      if (url.href === currentUrl?.href) {
        return
      }

      showError(null)
      currentUrl = url
      input.value = url.href
      void storeUrl(url).catch((reason: unknown) => {
        showError(reason instanceof Error ? reason.message : String(reason))
      })
    }

    const persistAndNavigate = (url: URL) => {
      showError(null)
      const controls = form.querySelectorAll<
        HTMLInputElement | HTMLButtonElement
      >('input, button')
      controls.forEach((control) => {
        control.disabled = true
      })
      void storeUrl(url)
        .then(() => {
          currentUrl = url
          input.value = url.href
          navigate(url)
          treeport.panel.setTitle(configuredTitle || url.host)
        })
        .catch((reason: unknown) => {
          showError(reason instanceof Error ? reason.message : String(reason))
        })
        .finally(() => {
          controls.forEach((control) => {
            control.disabled = false
          })
          reload.disabled = currentUrl === null
          external.disabled = currentUrl === null
        })
    }
    chooseServer = persistAndNavigate

    if (currentUrl) {
      input.value = currentUrl.href
      navigate(currentUrl)
      treeport.panel.setTitle(configuredTitle || currentUrl.host)
      void storeUrl(currentUrl).catch((reason: unknown) => {
        showError(reason instanceof Error ? reason.message : String(reason))
      })
    } else {
      reload.disabled = true
      external.disabled = true
      treeport.panel.setTitle(null)
      showHomepage()
      if (configuredInput?.url !== undefined) {
        input.value =
          typeof configuredInput.url === 'string'
            ? configuredInput.url
            : 'http://localhost:3000/'
        showError('Enter an absolute HTTP or HTTPS URL without credentials.')
      }
    }

    void discoverListeners()

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const url = browserUrl(input.value.trim())
      if (!url) {
        showError('Enter an absolute HTTP or HTTPS URL without credentials.')
        return
      }

      persistAndNavigate(url)
    })
    homeButton.addEventListener('click', showHomepage)
    refreshServers.addEventListener('click', () => void discoverListeners())
    reload.addEventListener('click', () => {
      if (currentUrl) {
        navigate(currentUrl)
      }
    })
    retry.addEventListener('click', () => {
      if (currentUrl) {
        navigate(currentUrl)
      }
    })
    external.addEventListener('click', () => {
      if (currentUrl) {
        window.open(currentUrl.href, '_blank', 'noopener,noreferrer')
      }
    })
  },
  (reason: unknown) => {
    loading.hidden = true
    showError(reason instanceof Error ? reason.message : String(reason))
  }
)

addEventListener('message', (event) => {
  if (
    event.source !== frame.contentWindow ||
    event.data?.source !== 'treeport-panel-v1'
  ) {
    return
  }

  if (event.data.method === 'panel.title.set') {
    if (event.data.title === null) {
      treeport.panel.setTitle(null)
    } else if (typeof event.data.title === 'string') {
      treeport.panel.setTitle(event.data.title.trim().slice(0, 256) || null)
    }

    return
  }

  if (
    event.data.method !== 'browser.location.set' ||
    event.data.subscription !== frameLocationSubscription
  ) {
    return
  }

  const url = browserUrl(event.data.url)
  if (url?.origin === event.origin) {
    receiveFrameLocation?.(url)
  }
})
