import { Activity, useEffect, useRef, useState } from 'react'
import {
  decodeUnknownOrNull,
  panelDirtyMessageSchema,
  panelRequestMessageSchema,
  panelTitleMessageSchema,
  workspaceSelectionMessageSchema,
  type WebPanel
} from '@treeport/shared'
import { parseResponse, rpc, treeFilesRpc } from '../../api'
import { errorDescription, errorDetails } from '../../error-message'
import { cn } from '../../lib/utils'
import { traceWebPanelOpen } from '../../web-panel-open-tracing'

export function WebPanelWorkspace({
  tab,
  active,
  title,
  reloadRevision,
  autoFocusBlocked,
  onTitleChange,
  onDirtyChange,
  onSelectWorkspace,
  onFocusSurface
}: {
  tab: WebPanel
  active: boolean
  title: string
  reloadRevision: number
  autoFocusBlocked: boolean
  onTitleChange: (tabId: string, title: string | null) => void
  onDirtyChange: (tabId: string, dirty: boolean) => void
  onSelectWorkspace: (index: number) => void
  onFocusSurface: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const panelWindowRef = useRef<Window | null>(null)
  const panelRevision = `${tab.id}:${reloadRevision}`
  const [loadedPanelRevision, setLoadedPanelRevision] = useState<string | null>(
    null
  )

  useEffect(() => {
    traceWebPanelOpen(tab.id, 'web_panel.open.frame_mounted', {
      reloadRevision
    })
  }, [tab.id, reloadRevision])

  useEffect(() => {
    onTitleChange(tab.id, null)
    onDirtyChange(tab.id, false)
  }, [onDirtyChange, onTitleChange, tab.id, panelRevision])

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

      const titleMessage = decodeUnknownOrNull(
        panelTitleMessageSchema,
        event.data
      )
      if (titleMessage) {
        onTitleChange(tab.id, titleMessage.title?.trim().slice(0, 256) || null)
        return
      }

      const dirtyMessage = decodeUnknownOrNull(
        panelDirtyMessageSchema,
        event.data
      )
      if (dirtyMessage) {
        onDirtyChange(tab.id, dirtyMessage.dirty)
        return
      }

      const selectionMessage = decodeUnknownOrNull(
        workspaceSelectionMessageSchema,
        event.data
      )
      if (selectionMessage) {
        onSelectWorkspace(selectionMessage.index)
        return
      }

      const message = decodeUnknownOrNull(panelRequestMessageSchema, event.data)
      if (!message) {
        return
      }

      const { method } = message
      const startedAt = performance.now()
      traceWebPanelOpen(tab.id, 'web_panel.sdk.request', { method })
      let request: Promise<unknown>
      if (method === 'context') {
        request = parseResponse(
          rpc.api.tabs[':tabId'].context.$get({
            param: { tabId: tab.id }
          })
        ).then((result) => result.context)
      } else if (method === 'diff') {
        request = parseResponse(
          rpc.api.tabs[':tabId'].diff.$get({
            param: { tabId: tab.id }
          })
        ).then((result) => result.diff)
      } else if (method === 'diff.file') {
        request = parseResponse(
          rpc.api.tabs[':tabId'].diff.file.$post({
            param: { tabId: tab.id },
            json: { path: message.path }
          })
        )
      } else if (method === 'diff.image') {
        request = parseResponse(
          rpc.api.tabs[':tabId'].diff.image.$post({
            param: { tabId: tab.id },
            json: { path: message.path, commit: message.commit }
          })
        )
      } else if (method === 'network.listeners') {
        request = parseResponse(
          rpc.api.tabs[':tabId'].network.listeners.$get({
            param: { tabId: tab.id }
          })
        ).then((result) => result.discovery)
      } else if (method === 'files.list') {
        request = parseResponse(
          treeFilesRpc.api.tabs[':tabId'].files.$get({
            param: { tabId: tab.id }
          })
        )
      } else if (method === 'files.search') {
        request = parseResponse(
          treeFilesRpc.api.tabs[':tabId'].files.search.$post({
            param: { tabId: tab.id },
            json: { query: message.query }
          })
        )
      } else if (method === 'files.read') {
        request = parseResponse(
          treeFilesRpc.api.tabs[':tabId'].files.read.$post({
            param: { tabId: tab.id },
            json: { path: message.path }
          })
        )
      } else if (method === 'files.write') {
        request = parseResponse(
          treeFilesRpc.api.tabs[':tabId'].files.$put({
            param: { tabId: tab.id },
            json: {
              path: message.path,
              content: message.content,
              expectedRevision: message.expectedRevision
            }
          })
        )
      } else if (method === 'storage.get') {
        request = parseResponse(
          rpc.api.tabs[':tabId'].storage.get.$post({
            param: { tabId: tab.id },
            json: { key: message.key }
          })
        ).then((result) => (result.found ? result.value : undefined))
      } else if (method === 'storage.set') {
        request = parseResponse(
          rpc.api.tabs[':tabId'].storage.$put({
            param: { tabId: tab.id },
            json: { key: message.key, value: message.value }
          })
        ).then(() => undefined)
      } else if (method === 'storage.delete') {
        request = parseResponse(
          rpc.api.tabs[':tabId'].storage.$delete({
            param: { tabId: tab.id },
            json: { key: message.key }
          })
        ).then(() => undefined)
      } else {
        request = Promise.reject(new Error('Unsupported Treeport SDK method'))
      }

      void request.then(
        (value) => {
          traceWebPanelOpen(tab.id, 'web_panel.sdk.response', {
            method,
            durationMs: performance.now() - startedAt,
            ok: true
          })
          panelWindow?.postMessage(
            { source: 'treeport-host-v1', id: message.id, ok: true, value },
            '*'
          )
        },
        (error) => {
          traceWebPanelOpen(tab.id, 'web_panel.sdk.response', {
            method,
            durationMs: performance.now() - startedAt,
            ok: false
          })
          const details = errorDetails(error)
          panelWindow?.postMessage(
            {
              source: 'treeport-host-v1',
              id: message.id,
              ok: false,
              error: errorDescription(details),
              errorCode: details.code
            },
            '*'
          )
        }
      )
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [
    active,
    onDirtyChange,
    onSelectWorkspace,
    onTitleChange,
    tab.id,
    tab.permissions
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
          src={`/api/web-panels/${encodeURIComponent(tab.id)}/assets/`}
          sandbox={`allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads${tab.sandbox.allowSameOrigin ? ' allow-same-origin' : ''}`}
          allow="clipboard-read; clipboard-write; fullscreen"
          onFocus={onFocusSurface}
          className={cn(
            'h-full w-full border-0 bg-zinc-950',
            loadedPanelRevision === panelRevision ? 'opacity-100' : 'opacity-0'
          )}
          onLoad={() => {
            // Load also fires for error documents; this is not tab/data readiness.
            traceWebPanelOpen(tab.id, 'web_panel.open.iframe_load', {
              reloadRevision
            })
            panelWindowRef.current = frameRef.current?.contentWindow ?? null
            setLoadedPanelRevision(panelRevision)
          }}
        />
      </main>
    </Activity>
  )
}
