import { browserTrace, browserTracingEnabled } from './agent-tracing'

const appOpens = new Map<string, { requestId: string; startedAt: number }>()

export function registerBrowserOpen(appId: string, requestId: string): void {
  if (!browserTracingEnabled()) {
    return
  }

  appOpens.delete(appId)
  appOpens.set(appId, { requestId, startedAt: performance.now() })

  if (appOpens.size > 128) {
    appOpens.delete(appOpens.keys().next().value!)
  }
}

export function traceBrowserOpen(
  appId: string,
  event: string,
  attributes: Record<string, boolean | number | string | null> = {}
): void {
  const open = appOpens.get(appId)

  if (!open) {
    return
  }

  if (performance.now() - open.startedAt > 60_000) {
    appOpens.delete(appId)

    return
  }

  browserTrace(event, open.requestId, { appId, ...attributes })
}
