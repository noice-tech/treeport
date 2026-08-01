import { useEffect, useRef, useState } from 'react'
import type { WebPanel } from '@treeport/shared'
import { apiClient } from '../../api'
import { cn } from '../../lib/utils'

export function WebPanelWorkspace({ panel }: { panel: WebPanel }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [loadedPanelId, setLoadedPanelId] = useState<string | null>(null)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.data?.source !== 'treeport-panel-v1' ||
        typeof event.data.id !== 'string'
      ) {
        return
      }

      const method = event.data.method
      const request =
        method === 'context'
          ? apiClient.webPanelContext(panel.id)
          : method === 'diff'
            ? apiClient.webPanelDiff(panel.id)
            : Promise.reject(new Error('Unsupported Treeport SDK method'))
      void request.then(
        (value) =>
          frameRef.current?.contentWindow?.postMessage(
            { source: 'treeport-host-v1', id: event.data.id, ok: true, value },
            '*'
          ),
        (error: unknown) =>
          frameRef.current?.contentWindow?.postMessage(
            {
              source: 'treeport-host-v1',
              id: event.data.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            },
            '*'
          )
      )
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [panel.id])

  return (
    <main
      className="min-h-0 min-w-0 bg-zinc-950"
      aria-label={`${panel.title} web panel`}
    >
      <iframe
        key={panel.id}
        ref={frameRef}
        title={panel.title}
        src={`/api/web-panels/${encodeURIComponent(panel.id)}/assets/`}
        sandbox="allow-scripts"
        className={cn(
          'h-full w-full border-0 bg-zinc-950',
          loadedPanelId === panel.id ? 'opacity-100' : 'opacity-0'
        )}
        onLoad={() => setLoadedPanelId(panel.id)}
      />
    </main>
  )
}
