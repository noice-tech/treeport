import {
  browserTrace,
  browserTracingEnabled,
  newBrowserCorrelationId
} from './agent-tracing'

const requests = new Map<string, number>()
const apps = new Map<string, { requestId: string; startedAt: number }>()

export function beginWebAppOpen(): string {
  const requestId = newBrowserCorrelationId()

  if (browserTracingEnabled()) {
    requests.set(requestId, performance.now())

    if (requests.size > 128) {
      requests.delete(requests.keys().next().value!)
    }

    browserTrace('web_app.open.requested', requestId)
  }

  return requestId
}

export function registerWebAppOpen(appId: string, requestId: string): void {
  if (!browserTracingEnabled() || apps.get(appId)?.requestId === requestId) {
    return
  }

  const startedAt = requests.get(requestId) ?? performance.now()
  apps.delete(appId)
  apps.set(appId, { requestId, startedAt })

  if (apps.size > 128) {
    apps.delete(apps.keys().next().value!)
  }
}

export function traceWebAppOpen(
  appId: string,
  event: string,
  attributes: Record<string, boolean | number | string | null> = {}
): void {
  const open = apps.get(appId)

  if (!open) {
    return
  }

  const elapsedMs = performance.now() - open.startedAt

  if (elapsedMs > 60_000) {
    apps.delete(appId)
    requests.delete(open.requestId)

    return
  }

  browserTrace(event, open.requestId, { appId, elapsedMs, ...attributes })
}
