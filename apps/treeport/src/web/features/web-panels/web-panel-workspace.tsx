import { Activity, useEffect, useRef, useState } from 'react'
import type { WebPanel } from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { z } from 'zod'
import { rpc } from '../../api'
import { errorMessage } from '../../error-message'
import { cn } from '../../lib/utils'

const panelTitleMessageSchema = z.object({
  source: z.literal('treeport-panel-v1'),
  method: z.literal('panel.title.set'),
  title: z.string().nullable()
})
const workspaceSelectionMessageSchema = z.object({
  source: z.literal('treeport-panel-v1'),
  method: z.literal('workspace.select'),
  index: z.number().int().min(0).max(8)
})
const panelRequestMessageSchema = z.object({
  source: z.literal('treeport-panel-v1'),
  id: z.string(),
  method: z.enum([
    'context',
    'diff',
    'network.listeners',
    'storage.get',
    'storage.set',
    'storage.delete'
  ]),
  key: z.string().optional(),
  value: z.json().optional()
})

export function WebPanelWorkspace({
  panel,
  active,
  title,
  reloadRevision,
  autoFocusBlocked,
  onTitleChange,
  onSelectWorkspace
}: {
  panel: WebPanel
  active: boolean
  title: string
  reloadRevision: number
  autoFocusBlocked: boolean
  onTitleChange: (panelId: string, title: string | null) => void
  onSelectWorkspace: (index: number) => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const panelWindowRef = useRef<Window | null>(null)
  const panelRevision = `${panel.id}:${reloadRevision}`
  const [loadedPanelRevision, setLoadedPanelRevision] = useState<string | null>(
    null
  )

  useEffect(() => {
    onTitleChange(panel.id, null)
  }, [onTitleChange, panel.id, panelRevision])

  useEffect(() => {
    if (!active || autoFocusBlocked || loadedPanelRevision !== panelRevision) {
      return
    }

    const frame = window.requestAnimationFrame(() => frameRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [active, autoFocusBlocked, loadedPanelRevision, panelRevision])

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
      if (event.source !== panelWindow) {
        return
      }

      const titleMessage = panelTitleMessageSchema.safeParse(event.data)
      if (titleMessage.success) {
        onTitleChange(
          panel.id,
          titleMessage.data.title?.trim().slice(0, 256) || null
        )
        return
      }

      const selectionMessage = workspaceSelectionMessageSchema.safeParse(
        event.data
      )
      if (selectionMessage.success) {
        onSelectWorkspace(selectionMessage.data.index)
        return
      }

      const parsedRequest = panelRequestMessageSchema.safeParse(event.data)
      if (!parsedRequest.success) {
        return
      }

      const message = parsedRequest.data
      const { method } = message
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
      } else if (method === 'network.listeners') {
        request = parseResponse(
          rpc.api.panels[':panelId'].network.listeners.$get({
            param: { panelId: panel.id }
          })
        ).then((result) => result.discovery)
      } else if (method === 'storage.get' && message.key) {
        request = parseResponse(
          rpc.api.panels[':panelId'].storage.get.$post({
            param: { panelId: panel.id },
            json: { key: message.key }
          })
        ).then((result) => result.value)
      } else if (
        method === 'storage.set' &&
        message.key &&
        message.value !== undefined
      ) {
        request = parseResponse(
          rpc.api.panels[':panelId'].storage.$put({
            param: { panelId: panel.id },
            json: { key: message.key, value: message.value }
          })
        ).then(() => undefined)
      } else if (method === 'storage.delete' && message.key) {
        request = parseResponse(
          rpc.api.panels[':panelId'].storage.$delete({
            param: { panelId: panel.id },
            json: { key: message.key }
          })
        ).then(() => undefined)
      } else {
        request = Promise.reject(new Error('Unsupported Treeport SDK method'))
      }

      void request.then(
        (value) =>
          panelWindow?.postMessage(
            { source: 'treeport-host-v1', id: message.id, ok: true, value },
            '*'
          ),
        (error) =>
          panelWindow?.postMessage(
            {
              source: 'treeport-host-v1',
              id: message.id,
              ok: false,
              error: errorMessage(error)
            },
            '*'
          )
      )
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [onSelectWorkspace, onTitleChange, panel.id])

  return (
    <Activity mode={active ? 'visible' : 'hidden'}>
      <main
        className="min-h-0 min-w-0 bg-zinc-950"
        aria-label={`${title} web panel`}
      >
        <iframe
          key={panelRevision}
          ref={frameRef}
          title={title}
          src={`/api/web-panels/${encodeURIComponent(panel.id)}/assets/`}
          sandbox={`allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads${panel.sandbox.allowSameOrigin ? ' allow-same-origin' : ''}`}
          allow="clipboard-read; clipboard-write; fullscreen"
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
