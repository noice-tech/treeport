import { Activity, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  InformationCircleIcon
} from '@heroicons/react/16/solid'
import type { WebPanel, WebPanelInput } from '@treeport/shared'
import { parseResponse } from 'hono/client'
import { rpc } from '../../api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { notifyError } from '../notifications/error-notifications'
import { projectsQueryOptions } from '../../project-metadata'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '../../components/ui/tooltip'

function browserUrl(input: WebPanelInput | null): string | null {
  if (!input || typeof input.url !== 'string') {
    return null
  }

  try {
    const url = new URL(input.url)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null
  } catch {
    return null
  }
}

export function BrowserPanelWorkspace({
  panel,
  active,
  title,
  onTitleChange
}: {
  panel: WebPanel
  active: boolean
  title: string
  onTitleChange: (panelId: string, title: string | null) => void
}) {
  const queryClient = useQueryClient()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const panelWindowRef = useRef<Window | null>(null)
  const configuredUrl = browserUrl(panel.launch.input)
  const configuredInputTitle =
    typeof panel.launch.input?.title === 'string'
      ? panel.launch.input.title
      : undefined
  const panelRevision = `${panel.id}:${panel.updatedAt}`
  const targetIsTreeportOrigin = configuredUrl
    ? new URL(configuredUrl).origin === window.location.origin
    : false
  const [draft, setDraft] = useState({
    panelRevision,
    url: configuredUrl ?? ''
  })
  const draftUrl =
    draft.panelRevision === panelRevision ? draft.url : (configuredUrl ?? '')
  const [reloadSerial, setReloadSerial] = useState(0)

  useEffect(() => {
    onTitleChange(panel.id, null)
  }, [onTitleChange, panel.id, panelRevision])

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

      if (event.data.method === 'panel.title.set') {
        if (event.data.title === null) {
          onTitleChange(panel.id, null)
        } else if (typeof event.data.title === 'string') {
          onTitleChange(panel.id, event.data.title.trim().slice(0, 256) || null)
        }

        return
      }

      if (typeof event.data.id === 'string') {
        panelWindow?.postMessage(
          {
            source: 'treeport-host-v1',
            id: event.data.id,
            ok: false,
            error: 'This Treeport SDK method is unavailable in Browser panels'
          },
          '*'
        )
      }
    }

    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [onTitleChange, panel.id])

  const updateLaunch = useMutation({
    mutationFn: (url: string) =>
      parseResponse(
        rpc.api.panels[':panelId'].launch.$put({
          param: { panelId: panel.id },
          json: {
            input: {
              url,
              ...(configuredInputTitle ? { title: configuredInputTitle } : {})
            },
            launchCwd: panel.launch.cwd,
            expectedUpdatedAt: panel.updatedAt
          }
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
    },
    onError: (error) => {
      void queryClient.invalidateQueries({
        queryKey: projectsQueryOptions.queryKey
      })
      notifyError(error, { operation: `open “${draftUrl}”` })
    }
  })

  return (
    <Activity mode={active ? 'visible' : 'hidden'}>
      <main
        className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-zinc-950"
        aria-label={`${title} web panel`}
      >
        <form
          className="flex min-w-0 items-center gap-1.5 border-b border-white/8 bg-zinc-900 px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            updateLaunch.mutate(draftUrl)
          }}
        >
          <Input
            type="url"
            value={draftUrl}
            onChange={(event) =>
              setDraft({ panelRevision, url: event.target.value })
            }
            aria-label="Application URL"
            placeholder="http://127.0.0.1:3000"
            className="h-8 min-w-0 flex-1 bg-zinc-950"
            required
            disabled={updateLaunch.isPending}
          />
          <Button
            type="submit"
            size="sm"
            disabled={updateLaunch.isPending || !draftUrl.trim()}
          >
            Go
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Reload application"
            title="Reload application"
            disabled={!configuredUrl}
            onClick={() => setReloadSerial((value) => value + 1)}
          >
            <ArrowPathIcon data-icon="inline-start" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Open application externally"
            title="Open application externally"
            disabled={!configuredUrl}
            onClick={() => {
              if (configuredUrl) {
                window.open(configuredUrl, '_blank', 'noopener,noreferrer')
              }
            }}
          >
            <ArrowTopRightOnSquareIcon
              data-icon="inline-start"
              aria-hidden="true"
            />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="grid size-7 place-items-center rounded-md text-zinc-400 outline-none hover:bg-white/6 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-cyan-400"
                aria-label="Browser panel help"
              >
                <InformationCircleIcon className="size-4" aria-hidden="true" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              The application must allow iframe use and must be reachable from
              this browser. Use browser development tools to inspect it.
            </TooltipContent>
          </Tooltip>
        </form>
        <iframe
          key={`${panelRevision}:${reloadSerial}`}
          ref={frameRef}
          title={title}
          src={configuredUrl ?? 'about:blank'}
          sandbox={`allow-scripts ${targetIsTreeportOrigin ? '' : 'allow-same-origin '}allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads`}
          allow="clipboard-read; clipboard-write"
          className="h-full w-full border-0 bg-white"
          onLoad={() => {
            panelWindowRef.current = frameRef.current?.contentWindow ?? null
          }}
        />
      </main>
    </Activity>
  )
}
