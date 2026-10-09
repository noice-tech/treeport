import type { PhoneAccessResponse } from '@treeport/shared'
import { CopyIcon, RefreshCwIcon } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import type { ComputerSummary } from '../desktop-contract'
import { Button, Dialog } from './ui'

export function OpenOnPhoneDialog({
  computer,
  onClose
}: {
  computer: ComputerSummary
  onClose: () => void
}) {
  const [result, setResult] = useState<PhoneAccessResponse | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle'
  )

  useEffect(() => {
    let active = true
    window.treeportShell.phoneAccess(computer.id).then(
      (value) => {
        if (active) {
          setResult(value)
        }
      },
      () => {
        if (active) {
          setResult({
            url: null,
            error: 'Could not check remote access. Please retry.',
            setupCommand: null
          })
        }
      }
    )
    return () => {
      active = false
    }
  }, [computer.id, attempt])

  return (
    <Dialog title="Open on phone" onClose={onClose}>
      <p className="text-center text-sm font-medium text-zinc-100">
        {computer.name}
      </p>
      {!result ? (
        <p className="py-12 text-center text-sm text-zinc-400" role="status">
          Loading remote address…
        </p>
      ) : result.url ? (
        <>
          <div className="flex justify-center">
            <QRCodeSVG
              value={result.url}
              size={240}
              level="M"
              marginSize={4}
              title={`Open ${computer.name} on your phone`}
              className="max-w-full"
            />
          </div>
          <p className="text-center text-sm text-pretty text-zinc-400">
            Scan with your phone’s camera. Your phone must be connected to
            Tailscale and allowed to access this computer.
          </p>
          <p className="text-center text-sm break-all select-text text-zinc-200">
            {result.url}
          </p>
          {copyState === 'failed' ? (
            <p className="text-sm text-rose-300" role="alert">
              Could not copy the link. Select and copy the URL above.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-sm text-pretty text-zinc-400" role="alert">
            {result.error ?? 'Remote access is unavailable for this computer.'}
          </p>
          {result.setupCommand ? (
            <code className="rounded-md bg-zinc-950/70 p-3 text-sm select-text">
              {result.setupCommand}
            </code>
          ) : null}
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={!result}
          onClick={() => {
            setResult(null)
            setCopyState('idle')
            setAttempt((value) => value + 1)
          }}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Retry
        </Button>
        {result?.url ? (
          <Button
            aria-label="Copy link"
            onClick={() => {
              void window.treeportShell.copyPhoneLink(result.url!).then(
                (copied) => setCopyState(copied ? 'copied' : 'failed'),
                () => setCopyState('failed')
              )
            }}
          >
            <CopyIcon data-icon="inline-start" />
            <span role="status">
              {copyState === 'copied' ? 'Copied' : 'Copy link'}
            </span>
          </Button>
        ) : null}
      </div>
    </Dialog>
  )
}
