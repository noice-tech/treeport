import { Activity, useEffect, useRef, useState } from 'react'
import type { WebPanel } from '@treeport/shared'
import { apiClient } from '../../api'
import { cn } from '../../lib/utils'

export function WebPanelWorkspace({
  panel,
  active,
  onSelectWorkspace
}: {
  panel: WebPanel
  active: boolean
  onSelectWorkspace: (index: number) => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const panelWindowRef = useRef<Window | null>(null)
  const [loadedPanelId, setLoadedPanelId] = useState<string | null>(null)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const panelWindow =
        frameRef.current?.contentWindow ?? panelWindowRef.current
      if (
        event.source !== panelWindow ||
        event.data?.source !== 'treeport-panel-v1'
      ) {
        return
      }

      const method = event.data.method
      if (
        method === 'workspace.select' &&
        Number.isInteger(event.data.index) &&
        event.data.index >= 0 &&
        event.data.index <= 8
      ) {
        onSelectWorkspace(event.data.index)
        return
      }

      if (typeof event.data.id !== 'string') {
        return
      }

      let request: Promise<unknown>
      if (method === 'context') {
        request = apiClient.webPanelContext(panel.id)
      } else if (method === 'diff') {
        request = apiClient.webPanelDiff(panel.id)
      } else if (
        method === 'storage.get' &&
        typeof event.data.key === 'string'
      ) {
        request = apiClient.getWebPanelStorage(panel.id, event.data.key)
      } else if (
        method === 'storage.set' &&
        typeof event.data.key === 'string'
      ) {
        request = apiClient
          .setWebPanelStorage(panel.id, event.data.key, event.data.value)
          .then(() => undefined)
      } else if (
        method === 'storage.delete' &&
        typeof event.data.key === 'string'
      ) {
        request = apiClient
          .deleteWebPanelStorage(panel.id, event.data.key)
          .then(() => undefined)
      } else {
        request = Promise.reject(new Error('Unsupported Treeport SDK method'))
      }

      void request.then(
        (value) =>
          panelWindow?.postMessage(
            { source: 'treeport-host-v1', id: event.data.id, ok: true, value },
            '*'
          ),
        (error: unknown) =>
          panelWindow?.postMessage(
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
  }, [onSelectWorkspace, panel.id])

  return (
    <Activity mode={active ? 'visible' : 'hidden'}>
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
          onLoad={() => {
            panelWindowRef.current = frameRef.current?.contentWindow ?? null
            setLoadedPanelId(panel.id)
          }}
        />
      </main>
    </Activity>
  )
}
