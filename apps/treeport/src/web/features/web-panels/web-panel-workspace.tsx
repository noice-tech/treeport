import { Activity, useEffect, useRef, useState } from 'react'
import type { WebPanel } from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { z } from 'zod'
import { rpc, treeFilesRpc } from '../../api'
import { errorDetails, errorMessage } from '../../error-message'
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
const panelDirtyMessageSchema = z.strictObject({
  source: z.literal('treeport-panel-v1'),
  method: z.literal('panel.dirty.set'),
  dirty: z.boolean()
})
const panelRequestFields = {
  source: z.literal('treeport-panel-v1'),
  id: z.string()
}
const panelRequestMessageSchema = z.discriminatedUnion('method', [
  z.strictObject({ ...panelRequestFields, method: z.literal('context') }),
  z.strictObject({ ...panelRequestFields, method: z.literal('diff') }),
  z.strictObject({
    ...panelRequestFields,
    method: z.literal('network.listeners')
  }),
  z.strictObject({ ...panelRequestFields, method: z.literal('files.list') }),
  z.strictObject({
    ...panelRequestFields,
    method: z.literal('files.search'),
    query: z.string()
  }),
  z.strictObject({
    ...panelRequestFields,
    method: z.literal('files.read'),
    path: z.string()
  }),
  z.strictObject({
    ...panelRequestFields,
    method: z.literal('files.write'),
    path: z.string(),
    content: z.string(),
    expectedRevision: z.string()
  }),
  z.strictObject({
    ...panelRequestFields,
    method: z.literal('storage.get'),
    key: z.string()
  }),
  z.strictObject({
    ...panelRequestFields,
    method: z.literal('storage.set'),
    key: z.string(),
    value: z.json()
  }),
  z.strictObject({
    ...panelRequestFields,
    method: z.literal('storage.delete'),
    key: z.string()
  })
])

export function WebPanelWorkspace({
  panel,
  active,
  title,
  reloadRevision,
  autoFocusBlocked,
  onTitleChange,
  onDirtyChange,
  onSelectWorkspace,
  onFocusSurface
}: {
  panel: WebPanel
  active: boolean
  title: string
  reloadRevision: number
  autoFocusBlocked: boolean
  onTitleChange: (panelId: string, title: string | null) => void
  onDirtyChange: (panelId: string, dirty: boolean) => void
  onSelectWorkspace: (index: number) => void
  onFocusSurface: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const panelWindowRef = useRef<Window | null>(null)
  const panelRevision = `${panel.id}:${reloadRevision}`
  const [loadedPanelRevision, setLoadedPanelRevision] = useState<string | null>(
    null
  )

  useEffect(() => {
    onTitleChange(panel.id, null)
    onDirtyChange(panel.id, false)
  }, [onDirtyChange, onTitleChange, panel.id, panelRevision])

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

    const detectFrameFocus = () => {
      window.requestAnimationFrame(() => {
        if (document.activeElement === frameRef.current) {
          onFocusSurface()
        }
      })
    }
    window.addEventListener('blur', detectFrameFocus)
    return () => window.removeEventListener('blur', detectFrameFocus)
  }, [active, onFocusSurface])

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

      if (event.data?.source !== 'treeport-panel-v1') {
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

      const dirtyMessage = panelDirtyMessageSchema.safeParse(event.data)
      if (dirtyMessage.success) {
        onDirtyChange(panel.id, dirtyMessage.data.dirty)
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
      } else if (method === 'files.list') {
        request = parseResponse(
          treeFilesRpc.api.panels[':panelId'].files.$get({
            param: { panelId: panel.id }
          })
        )
      } else if (method === 'files.search') {
        request = parseResponse(
          treeFilesRpc.api.panels[':panelId'].files.search.$post({
            param: { panelId: panel.id },
            json: { query: message.query }
          })
        )
      } else if (method === 'files.read') {
        request = parseResponse(
          treeFilesRpc.api.panels[':panelId'].files.read.$post({
            param: { panelId: panel.id },
            json: { path: message.path }
          })
        )
      } else if (method === 'files.write') {
        request = parseResponse(
          treeFilesRpc.api.panels[':panelId'].files.$put({
            param: { panelId: panel.id },
            json: {
              path: message.path,
              content: message.content,
              expectedRevision: message.expectedRevision
            }
          })
        )
      } else if (method === 'storage.get') {
        request = parseResponse(
          rpc.api.panels[':panelId'].storage.get.$post({
            param: { panelId: panel.id },
            json: { key: message.key }
          })
        ).then((result) => result.value)
      } else if (method === 'storage.set') {
        request = parseResponse(
          rpc.api.panels[':panelId'].storage.$put({
            param: { panelId: panel.id },
            json: { key: message.key, value: message.value }
          })
        ).then(() => undefined)
      } else if (method === 'storage.delete') {
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
              error: errorMessage(error),
              errorCode: errorDetails(error).code
            },
            '*'
          )
      )
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [
    active,
    onDirtyChange,
    onSelectWorkspace,
    onTitleChange,
    panel.id,
    panel.permissions
  ])

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
          onFocus={onFocusSurface}
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
