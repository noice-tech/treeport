import {
  browserTrace,
  browserTracingEnabled,
  newBrowserCorrelationId
} from './agent-tracing'

// Request IDs join renderer milestones to treeport.request.id in server JSONL.
// Asset spans carry treeport.tab.id. Never record launch input, file paths, or URLs.
// Bound retention because failed requests/navigation may never finish.
const requests = new Map<string, number>()
const tabs = new Map<string, { requestId: string; startedAt: number }>()

export function beginWebPanelOpen(): string {
  const requestId = newBrowserCorrelationId()
  if (browserTracingEnabled()) {
    requests.set(requestId, performance.now())
    if (requests.size > 128) {
      requests.delete(requests.keys().next().value!)
    }

    browserTrace('web_panel.open.requested', requestId)
  }

  return requestId
}

export function registerWebPanelOpen(tabId: string, requestId: string): void {
  if (!browserTracingEnabled() || tabs.get(tabId)?.requestId === requestId) {
    return
  }

  const startedAt = requests.get(requestId) ?? performance.now()
  tabs.delete(tabId)
  tabs.set(tabId, { requestId, startedAt })
  if (tabs.size > 128) {
    tabs.delete(tabs.keys().next().value!)
  }
}

export function traceWebPanelOpen(
  tabId: string,
  event: string,
  attributes: Record<string, boolean | number | string | null> = {}
): void {
  const open = tabs.get(tabId)
  if (!open) {
    return
  }

  const elapsedMs = performance.now() - open.startedAt
  if (elapsedMs > 60_000) {
    tabs.delete(tabId)
    requests.delete(open.requestId)
    return
  }

  browserTrace(event, open.requestId, { tabId, elapsedMs, ...attributes })
}
