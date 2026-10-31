import { useState } from 'react'
import type { BrowserServerMessage } from '#protocol/browser'
import type { BrowserAppConnection } from '../../browser-session-client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

export function BrowserPageDialog({
  request,
  url,
  connection,
  onClose
}: {
  request: Extract<BrowserServerMessage, { type: 'dialog' }>
  url: string
  connection: BrowserAppConnection
  onClose(): void
}) {
  const [promptText, setPromptText] = useState(request.defaultValue)
  const host = URL.canParse(url) ? new URL(url).host : ''

  const respond = (accept: boolean) => {
    connection.send({
      type: 'dialogResponse',
      requestId: request.requestId,
      accept,
      promptText: accept && request.dialogType === 'prompt' ? promptText : null
    })
    onClose()
  }

  return (
    <div className="absolute inset-0 flex items-start justify-center bg-zinc-950/60 p-6">
      <form
        className="flex max-h-full w-full max-w-md flex-col gap-4 rounded-xl bg-zinc-900 p-5 text-zinc-200 shadow-2xl ring-1 ring-white/10"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${request.requestId}-title`}
        aria-describedby={`${request.requestId}-message`}
        onSubmit={(event) => {
          event.preventDefault()
          respond(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            respond(false)
          }
        }}
      >
        <strong id={`${request.requestId}-title`} className="text-zinc-50">
          {host ? `${host} says` : 'This page says'}
        </strong>
        <p
          id={`${request.requestId}-message`}
          className="min-h-0 overflow-y-auto text-sm break-words whitespace-pre-wrap"
        >
          {request.message}
        </p>
        {request.dialogType === 'prompt' ? (
          <Input
            autoFocus
            aria-label="Response"
            value={promptText}
            onChange={(event) => setPromptText(event.currentTarget.value)}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          {request.dialogType === 'alert' ? null : (
            <Button
              type="button"
              variant="outline"
              onClick={() => respond(false)}
            >
              Cancel
            </Button>
          )}
          <Button type="submit" autoFocus={request.dialogType !== 'prompt'}>
            OK
          </Button>
        </div>
      </form>
    </div>
  )
}
