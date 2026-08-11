import { treeport, type JsonValue } from '@treeport/panel-sdk'
import './browser.css'

const form = document.querySelector('form')!
const input = document.querySelector<HTMLInputElement>('input[name="url"]')!
const reload = document.querySelector<HTMLButtonElement>(
  '[data-action="reload"]'
)!
const external = document.querySelector<HTMLButtonElement>(
  '[data-action="external"]'
)!
const retry = document.querySelector<HTMLButtonElement>(
  '[data-action="retry"]'
)!
const error = document.querySelector<HTMLParagraphElement>('.error')!
const loading = document.querySelector<HTMLDivElement>('.loading')!
const failure = document.querySelector<HTMLDivElement>('.failure')!
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

function showError(message: string | null) {
  error.textContent = message ?? ''
  error.hidden = message === null
}

let navigation = 0
let frameLoaded = false
let targetReachable = false

function navigate(url: URL) {
  const currentNavigation = ++navigation
  frameLoaded = false
  targetReachable = false
  failure.hidden = true
  loading.hidden = false
  reload.disabled = true
  frame.src = url.href

  void fetch(url, {
    method: 'HEAD',
    mode: 'no-cors',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000)
  }).then(
    () => {
      if (navigation !== currentNavigation) {
        return
      }

      targetReachable = true
      if (frameLoaded) {
        loading.hidden = true
        reload.disabled = false
      }
    },
    () => {
      if (navigation !== currentNavigation) {
        return
      }

      loading.hidden = true
      failure.hidden = false
      reload.disabled = false
    }
  )
}

frame.addEventListener('load', () => {
  if (frame.getAttribute('src') === 'about:blank') {
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
    let currentUrl =
      configuredUrl && storedLaunchUpdatedAt !== context.panel.updatedAt
        ? configuredUrl
        : (storedUrl ?? configuredUrl)

    if (currentUrl) {
      input.value = currentUrl.href
      navigate(currentUrl)
      treeport.panel.setTitle(configuredTitle || currentUrl.host)
      void treeport.storage.set('browser-state', {
        url: currentUrl.href,
        launchUpdatedAt: context.panel.updatedAt
      })
    } else {
      loading.hidden = true
      reload.disabled = true
      external.disabled = true
      treeport.panel.setTitle(null)
      if (configuredInput?.url !== undefined) {
        input.value =
          typeof configuredInput.url === 'string'
            ? configuredInput.url
            : 'http://localhost:3000/'
        showError('Enter an absolute HTTP or HTTPS URL without credentials.')
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const url = browserUrl(input.value.trim())
      if (!url) {
        showError('Enter an absolute HTTP or HTTPS URL without credentials.')
        return
      }

      showError(null)
      const controls = form.querySelectorAll<
        HTMLInputElement | HTMLButtonElement
      >('input, button')
      controls.forEach((control) => {
        control.disabled = true
      })
      void treeport.storage
        .set('browser-state', {
          url: url.href,
          launchUpdatedAt: context.panel.updatedAt
        })
        .then(() => {
          currentUrl = url
          navigate(url)
          treeport.panel.setTitle(configuredTitle || url.host)
          controls.forEach((control) => {
            control.disabled = false
          })
        })
        .catch((reason: unknown) => {
          controls.forEach((control) => {
            control.disabled = false
          })
          showError(reason instanceof Error ? reason.message : String(reason))
        })
    })

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
    event.data?.source !== 'treeport-panel-v1' ||
    event.data.method !== 'panel.title.set'
  ) {
    return
  }

  if (event.data.title === null) {
    treeport.panel.setTitle(null)
  } else if (typeof event.data.title === 'string') {
    treeport.panel.setTitle(event.data.title.trim().slice(0, 256) || null)
  }
})
