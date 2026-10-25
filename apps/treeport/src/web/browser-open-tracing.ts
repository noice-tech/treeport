import { browserTrace, browserTracingEnabled } from './agent-tracing'

// Opt in with localStorage['treeport.trace'] = 'jsonl'. Renderer correlationId
// matches the HTTP span's treeport.request.id in TREEPORT_TRACE=jsonl output.
// Lifecycle events describe the latest open for a app, not a navigation ID.
// Only retain recent opens; a failed navigation may never report completion.
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
