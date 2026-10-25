import { Activity, useEffect, useRef, useState } from 'react'
import { ArrowPathIcon } from '@heroicons/react/16/solid'
import {
  decodeUnknownOrNull,
  appDirtyMessageSchema,
  appRequestMessageSchema,
  appTitleMessageSchema,
  workspaceSelectionMessageSchema,
  type WebApp,
  type GitFileDiffRequest
} from '@treeport/shared'
import { parseResponse, rpc, treeFilesRpc } from '../../api'
import { errorDescription, errorDetails } from '../../error-message'
import { cn } from '../../lib/utils'
import { traceWebAppOpen } from '../../web-app-open-tracing'

export function WebAppWorkspace({
  app,
  active,
  title,
  reloadRevision,
  autoFocusBlocked,
  onTitleChange,
  onDirtyChange,
  onSelectWorkspace,
  onFocusSurface
}: {
  app: WebApp
  active: boolean
  title: string
  reloadRevision: number
  autoFocusBlocked: boolean
  onTitleChange: (appId: string, title: string | null) => void
  onDirtyChange: (appId: string, dirty: boolean) => void
  onSelectWorkspace: (index: number) => void
  onFocusSurface: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const appWindowRef = useRef<Window | null>(null)
  // EXTERNAL: Sandbox changes only take effect on a new document, so remount on policy changes.
  const appRevision = `${app.id}:${reloadRevision}:${app.sandbox.enabled}:${app.sandbox.allowSameOrigin}`

  const [loadedAppRevision, setLoadedAppRevision] = useState<string | null>(
    null
  )

  useEffect(() => {
    traceWebAppOpen(app.id, 'web_app.open.frame_mounted', {
      reloadRevision
    })
  }, [app.id, reloadRevision])

  useEffect(() => {
    onTitleChange(app.id, null)
    onDirtyChange(app.id, false)
  }, [onDirtyChange, onTitleChange, app.id, appRevision])

  useEffect(() => {
    if (!active || autoFocusBlocked || loadedAppRevision !== appRevision) {
      return
    }

    const frame = window.requestAnimationFrame(() => frameRef.current?.focus())

    return () => window.cancelAnimationFrame(frame)
  }, [active, autoFocusBlocked, loadedAppRevision, appRevision])

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
      const appWindow = frameRef.current?.contentWindow ?? appWindowRef.current

      appWindow?.postMessage(
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
      const appWindow = frameRef.current?.contentWindow ?? appWindowRef.current

      if (event.source !== appWindow) {
        return
      }

      if (event.data?.source !== 'treeport-app-v1') {
        return
      }

      const titleMessage = decodeUnknownOrNull(
        appTitleMessageSchema,
        event.data
      )

      if (titleMessage) {
        onTitleChange(app.id, titleMessage.title?.trim().slice(0, 256) || null)

        return
      }

      const dirtyMessage = decodeUnknownOrNull(
        appDirtyMessageSchema,
        event.data
      )

      if (dirtyMessage) {
        onDirtyChange(app.id, dirtyMessage.dirty)

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

      const message = decodeUnknownOrNull(appRequestMessageSchema, event.data)

      if (!message) {
        return
      }

      const { method } = message
      const startedAt = performance.now()
      traceWebAppOpen(app.id, 'web_app.sdk.request', { method })
      let request: Promise<unknown>

      if (method === 'context') {
        request = parseResponse(
          rpc.api.apps[':appId'].context.$get({
            param: { appId: app.id }
          })
        ).then((result) => result.context)
      } else if (
        method === 'services.ensure' ||
        method === 'services.status' ||
        method === 'services.stop'
      ) {
        const action =
          method === 'services.status'
            ? 'status'
            : method === 'services.stop'
              ? 'stop'
              : 'ensure'

        request = parseResponse(
          rpc.api.apps[':appId'].services.$post({
            param: { appId: app.id, action },
            json: { name: message.name }
          })
        )
      } else if (method === 'diff') {
        request = parseResponse(
          rpc.api.apps[':appId'].diff.$get({
            param: { appId: app.id },
            query: message.scope ? { scope: message.scope } : {}
          })
        ).then((result) => result.diff)
      } else if (method === 'diff.file') {
        const input: GitFileDiffRequest = { path: message.path }

        if (message.scope) {
          input.scope = message.scope
        }

        request = parseResponse(
          rpc.api.apps[':appId'].diff.file.$post({
            param: { appId: app.id },
            json: input
          })
        )
      } else if (method === 'diff.image') {
        request = parseResponse(
          rpc.api.apps[':appId'].diff.image.$post({
            param: { appId: app.id },
            json: { path: message.path, commit: message.commit }
          })
        )
      } else if (method === 'network.listeners') {
        request = parseResponse(
          rpc.api.apps[':appId'].network.listeners.$get({
            param: { appId: app.id }
          })
        ).then((result) => result.discovery)
      } else if (method === 'files.list') {
        request = parseResponse(
          treeFilesRpc.api.apps[':appId'].files.$get({
            param: { appId: app.id }
          })
        )
      } else if (method === 'files.search') {
        request = parseResponse(
          treeFilesRpc.api.apps[':appId'].files.search.$post({
            param: { appId: app.id },
            json: { query: message.query }
          })
        )
      } else if (method === 'files.read') {
        request = parseResponse(
          treeFilesRpc.api.apps[':appId'].files.read.$post({
            param: { appId: app.id },
            json: { path: message.path }
          })
        )
      } else if (method === 'files.write') {
        request = parseResponse(
          treeFilesRpc.api.apps[':appId'].files.$put({
            param: { appId: app.id },
            json: {
              path: message.path,
              content: message.content,
              expectedRevision: message.expectedRevision
            }
          })
        )
      } else if (method === 'storage.get') {
        request = parseResponse(
          rpc.api.apps[':appId'].storage.get.$post({
            param: { appId: app.id },
            json: { key: message.key, scope: message.scope }
          })
        ).then((result) => (result.found ? result.value : undefined))
      } else if (method === 'storage.set') {
        request = parseResponse(
          rpc.api.apps[':appId'].storage.$put({
            param: { appId: app.id },
            json: {
              key: message.key,
              value: message.value,
              scope: message.scope
            }
          })
        ).then(() => undefined)
      } else if (method === 'storage.delete') {
        request = parseResponse(
          rpc.api.apps[':appId'].storage.$delete({
            param: { appId: app.id },
            json: { key: message.key, scope: message.scope }
          })
        ).then(() => undefined)
      } else {
        request = Promise.reject(new Error('Unsupported Treeport SDK method'))
      }

      void request.then(
        (value) => {
          traceWebAppOpen(app.id, 'web_app.sdk.response', {
            method,
            durationMs: performance.now() - startedAt,
            ok: true
          })
          appWindow?.postMessage(
            { source: 'treeport-host-v1', id: message.id, ok: true, value },
            '*'
          )
        },
        (error) => {
          traceWebAppOpen(app.id, 'web_app.sdk.response', {
            method,
            durationMs: performance.now() - startedAt,
            ok: false
          })
          const details = errorDetails(error)
          appWindow?.postMessage(
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
    app.id,
    app.permissions
  ])

  return (
    <Activity mode={active ? 'visible' : 'hidden'}>
      <main
        className="relative min-h-0 min-w-0 bg-zinc-950"
        aria-label={`${title} web app`}
        aria-busy={loadedAppRevision !== appRevision}
      >
        {loadedAppRevision !== appRevision ? (
          <div className="absolute inset-0 grid place-items-center overflow-auto p-6 sm:p-8">
            <div
              className="flex min-w-0 flex-col items-center gap-3 text-center"
              role="status"
            >
              <ArrowPathIcon
                className="size-4 shrink-0 fill-zinc-500 motion-safe:animate-spin"
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-col items-center gap-1.5 text-base sm:text-sm">
                <p className="max-w-[32ch] font-medium text-pretty break-words text-zinc-300">
                  Loading {title}…
                </p>
                <p className="max-w-[32ch] text-pretty text-zinc-500">
                  First launch may take a moment to build.
                </p>
              </div>
            </div>
          </div>
        ) : null}
        <iframe
          key={appRevision}
          ref={frameRef}
          title={title}
          src={`/api/web-apps/${encodeURIComponent(app.id)}/assets/`}
          sandbox={
            !app.sandbox.enabled
              ? undefined
              : `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads${app.sandbox.allowSameOrigin ? ' allow-same-origin' : ''}`
          }
          allow="clipboard-read; clipboard-write; fullscreen"
          onFocus={onFocusSurface}
          tabIndex={loadedAppRevision === appRevision ? 0 : -1}
          // EXTERNAL: A dark host scheme with a default-scheme document makes Chromium
          // paint an opaque white canvas instead of this loading background.
          className={cn(
            'h-full w-full border-0 bg-zinc-950 [color-scheme:normal]',
            loadedAppRevision === appRevision ? 'opacity-100' : 'opacity-0'
          )}
          onLoad={() => {
            // EXTERNAL: Load also fires for error documents; this is not app/data readiness.
            traceWebAppOpen(app.id, 'web_app.open.iframe_load', {
              reloadRevision
            })
            appWindowRef.current = frameRef.current?.contentWindow ?? null
            setLoadedAppRevision(appRevision)
          }}
        />
      </main>
    </Activity>
  )
}
