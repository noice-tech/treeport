import { useEffect, useState, type ReactNode } from 'react'
import { selectedComputer, useShellState } from './shell-state'
import { Button } from './ui'

function ConnectionHeading({
  children,
  description
}: {
  children: ReactNode
  description?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-balance text-xl font-semibold text-zinc-50">
        {children}
      </h1>
      {description ? (
        <p className="text-base text-pretty text-zinc-400 sm:text-sm sm:leading-6">
          {description}
        </p>
      ) : null}
    </div>
  )
}

function Origin({ children }: { children: string }) {
  return (
    <p className="break-all font-mono text-sm text-pretty text-cyan-200 tabular-nums">
      {children}
    </p>
  )
}

export function ConnectionPage({
  onConnect,
  onManage,
  onOpenMenu
}: {
  onConnect: () => void
  onManage: () => void
  onOpenMenu: () => void
}) {
  const state = useShellState()
  const [connectingVisible, setConnectingVisible] = useState(false)

  useEffect(() => {
    if (state?.connection.status !== 'connecting') {
      setConnectingVisible(false)
      return
    }

    const timer = setTimeout(() => setConnectingVisible(true), 300)
    return () => clearTimeout(timer)
  }, [state?.connection.status])

  if (!state) {
    return null
  }

  const computer = selectedComputer(state)
  let content: ReactNode = null
  switch (state.connection.status) {
    case 'ready':
      break
    case 'connecting':
      content = connectingVisible ? (
        <>
          <ConnectionHeading>
            Connecting to {computer?.name ?? 'Treeport'}…
          </ConnectionHeading>
          <Origin>{computer?.origin ?? ''}</Origin>
        </>
      ) : null
      break
    case 'empty':
      content = (
        <>
          <ConnectionHeading description="Connect to Treeport running on this computer or another private computer.">
            Connect Treeport to a computer
          </ConnectionHeading>
          <Button variant="default" onClick={onConnect}>
            Connect to a computer
          </Button>
        </>
      )
      break
    case 'unavailable':
      content = (
        <>
          <ConnectionHeading
            description={
              computer?.loopback
                ? 'Start Treeport, then retry the connection.'
                : state.connection.message
            }
          >
            {computer?.loopback
              ? 'Treeport isn’t available on this computer'
              : `${computer?.name ?? 'Treeport'} is unavailable`}
          </ConnectionHeading>
          <Origin>{computer?.origin ?? ''}</Origin>
          {computer?.loopback ? (
            <>
              <div className="flex w-full items-center justify-between gap-3 rounded-lg bg-zinc-900 py-1 pr-1 pl-3 ring-1 ring-white/10">
                <code className="min-w-0 truncate font-mono text-sm text-cyan-200">
                  treeport up
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    void window.treeportShell.copyStartCommand()
                    event.currentTarget.textContent = 'Copied'
                  }}
                >
                  Copy command
                </Button>
              </div>
              <Button
                variant="link"
                onClick={() => void window.treeportShell.openInstallationDocs()}
              >
                Installation instructions
              </Button>
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="default"
              onClick={() => window.treeportShell.retryConnection()}
            >
              Retry
            </Button>
            <Button onClick={onOpenMenu}>Switch computer</Button>
            <Button variant="outline" onClick={onManage}>
              Edit computer
            </Button>
          </div>
        </>
      )
      break
    case 'incompatible':
      content = (
        <>
          <ConnectionHeading
            description={`${computer?.name ?? 'The selected computer'} uses desktop protocol ${state.connection.receivedProtocolVersion}; this desktop expects protocol ${state.connection.expectedProtocolVersion}.`}
          >
            This Treeport version is incompatible
          </ConnectionHeading>
          <p className="text-sm text-pretty text-zinc-400 tabular-nums">
            Desktop {state.appVersion} · Treeport{' '}
            {state.connection.serverVersion}
          </p>
          <Origin>{computer?.origin ?? ''}</Origin>
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={onOpenMenu}>
              Switch computer
            </Button>
            <Button variant="outline" onClick={onManage}>
              Edit computer
            </Button>
          </div>
        </>
      )
  }

  return (
    <main
      className="grid min-h-dvh place-items-center bg-zinc-950 px-5 pt-16 pb-8"
      aria-label={
        state.connection.status === 'connecting'
          ? 'Connecting to Treeport'
          : undefined
      }
    >
      <section className="flex w-full max-w-md flex-col items-start gap-4">
        {content}
      </section>
    </main>
  )
}
