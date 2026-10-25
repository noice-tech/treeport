import { useEffect, useRef, useState } from 'react'
import {
  BROWSER_MAX_UPLOAD_BYTES,
  BROWSER_MAX_UPLOAD_FILES,
  type BrowserServerMessage
} from '@treeport/shared'
import type { BrowserAppConnection } from '../../browser-session-client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

export function BrowserFilePicker({
  request,
  connection,
  onCancel
}: {
  request: Extract<BrowserServerMessage, { type: 'fileChooser' }>
  connection: BrowserAppConnection
  onCancel(): void
}) {
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 p-6 text-center"
      role="region"
      aria-label="Upload files to browser"
    >
      <strong>Select files for this website</strong>
      <span className="text-sm text-muted-foreground">
        Up to 10 MiB total. Files are sent to the remote browser.
      </span>
      <Input
        className="max-w-sm"
        type="file"
        aria-label="Choose files to upload"
        accept={request.accept}
        multiple={request.multiple}
        disabled={busy}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''

          if (!files.length) {
            return
          }

          if (
            files.length > BROWSER_MAX_UPLOAD_FILES ||
            files.reduce((total, file) => total + file.size, 0) >
              BROWSER_MAX_UPLOAD_BYTES
          ) {
            setError(
              `Select at most ${BROWSER_MAX_UPLOAD_FILES} files, totaling no more than 10 MiB.`
            )

            return
          }

          setError(null)
          setBusy(true)
          void Promise.all(
            files.map(async (file) => {
              const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => {
                  // eslint-disable-next-line anti-slop/no-runtime-typeof -- readAsDataURL returns a string on success.
                  if (typeof reader.result === 'string') {
                    resolve(reader.result.slice(reader.result.indexOf(',') + 1))
                  } else {
                    reject(new Error('Could not read the selected file.'))
                  }
                }

                reader.onerror = () =>
                  reject(new Error('Could not read the selected file.'))
                reader.readAsDataURL(file)
              })

              return { name: file.name, mimeType: file.type, base64 }
            })
          )
            .then((payload) => {
              if (mounted.current) {
                connection.send({
                  type: 'fileChooserResponse',
                  requestId: request.requestId,
                  files: payload
                })
              }
            })
            .catch((cause: unknown) => {
              if (mounted.current) {
                setBusy(false)
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Could not read the selected files.'
                )
              }
            })
        }}
      />
      {busy ? (
        <span role="status" className="text-sm text-muted-foreground">
          Uploading files…
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      ) : null}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          mounted.current = false
          connection.send({
            type: 'fileChooserResponse',
            requestId: request.requestId,
            files: null
          })
          onCancel()
        }}
      >
        Cancel
      </Button>
    </div>
  )
}
