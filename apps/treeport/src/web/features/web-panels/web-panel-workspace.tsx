import { Activity, useEffect, useRef, useState } from 'react'
import type { WebPanel } from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { rpc } from '../../api'
import { errorMessage } from '../../error-message'
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
  const panelRevision = `${panel.id}:${panel.updatedAt}`
  const [loadedPanelRevision, setLoadedPanelRevision] = useState<string | null>(
    null
  )

  useEffect(() => {
    if (!active) {
      return
    }

    const forwardFindShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'f' ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        document.querySelector('[role="dialog"]')
      ) {
        return
      }

      event.preventDefault()
      const panelWindow =
        frameRef.current?.contentWindow ?? panelWindowRef.current

      panelWindow?.postMessage(
        {
          source: 'treeport-host-v1',
          method: 'shortcut',
          shortcut: 'find'
        },
        '*'
      )
    }

    window.addEventListener('keydown', forwardFindShortcut, true)
    return () =>
      window.removeEventListener('keydown', forwardFindShortcut, true)
  }, [active])

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
        request = parseResponse(
          rpc.api.panels[':panelId'].context.$get({
            param: { panelId: panel.id }
          })
        ).then((result) => result.context)
      } else if (method === 'diff') {
        request = parseResponse(
          rpc.api.panels[':panelId'].diff.$get({
            param: { panelId: panel.id }
          })
        ).then((result) => result.diff)
      } else if (
        method === 'storage.get' &&
        typeof event.data.key === 'string'
      ) {
        request = parseResponse(
          rpc.api.panels[':panelId'].storage.get.$post({
            param: { panelId: panel.id },
            json: { key: event.data.key }
          })
        ).then((result) => result.value)
      } else if (
        method === 'storage.set' &&
        typeof event.data.key === 'string'
      ) {
        request = parseResponse(
          rpc.api.panels[':panelId'].storage.$put({
            param: { panelId: panel.id },
            json: { key: event.data.key, value: event.data.value }
          })
        ).then(() => undefined)
      } else if (
        method === 'storage.delete' &&
        typeof event.data.key === 'string'
      ) {
        request = parseResponse(
          rpc.api.panels[':panelId'].storage.$delete({
            param: { panelId: panel.id },
            json: { key: event.data.key }
          })
        ).then(() => undefined)
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
              error: errorMessage(error)
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
          key={panelRevision}
          ref={frameRef}
          title={panel.title}
          src={`/api/web-panels/${encodeURIComponent(panel.id)}/assets/`}
          sandbox="allow-scripts"
          className={cn(
            'h-full w-full border-0 bg-zinc-950',
            loadedPanelRevision === panelRevision ? 'opacity-100' : 'opacity-0'
          )}
          onLoad={() => {
            panelWindowRef.current = frameRef.current?.contentWindow ?? null
            setLoadedPanelRevision(panelRevision)
          }}
        />
      </main>
    </Activity>
  )
}
