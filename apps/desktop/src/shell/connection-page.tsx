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

function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [])

  if (since === null) {
    return null
  }

  const seconds = Math.max(0, Math.floor((now - since) / 1000))

  return (
    <span className="text-zinc-500 tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

function Origin({ children }: { children: string }) {
  return (
    <p className="break-all font-mono text-sm text-pretty text-accent-200 tabular-nums">
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

  const connecting = state?.connection.status === 'connecting'

  if (!connecting && connectingVisible) {
    setConnectingVisible(false)
  }

  useEffect(() => {
    if (!connecting) {
      return
    }

    const timer = setTimeout(() => setConnectingVisible(true), 300)

    return () => clearTimeout(timer)
  }, [connecting])

  if (!state) {
    return null
  }

  const computer = selectedComputer(state)
  let content: ReactNode = null

  const localServer =
    state.localServer &&
    computer?.origin === state.localServer.origin &&
    (state.connection.status === 'connecting' ||
      state.connection.status === 'unavailable')
      ? state.localServer
      : null

  const output = localServer?.output.length ? (
    <pre className="w-full overflow-hidden rounded-lg bg-zinc-900 px-3 py-2 font-mono text-xs leading-5 text-zinc-500 ring-1 ring-white/10">
      {localServer.output.join('\n')}
    </pre>
  ) : null

  if (localServer?.status === 'starting') {
    content = (
      <>
        <ConnectionHeading>Starting Treeport</ConnectionHeading>
        <p className="text-base text-pretty text-zinc-400 sm:text-sm sm:leading-6">
          Building and starting your clone. The first start can take a few
          minutes. <Elapsed since={localServer.startedAt} />
        </p>
        <Origin>{localServer.sourceRoot}</Origin>
        {output}
      </>
    )
  } else if (
    localServer &&
    !localServer.chosen &&
    state.connection.status === 'unavailable'
  ) {
    content = (
      <>
        <ConnectionHeading description="Run the server here from your clone, or control Treeport running on another computer, such as a Linux server on your tailnet.">
          Where should Treeport run?
        </ConnectionHeading>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="default"
            onClick={() => void window.treeportShell.startLocalServer()}
          >
            Run Treeport on this{' '}
            {state.platform === 'darwin' ? 'Mac' : 'computer'}
          </Button>
          <Button onClick={onConnect}>Connect to another computer</Button>
        </div>
      </>
    )
  } else if (localServer && state.connection.status === 'unavailable') {
    content = (
      <>
        <ConnectionHeading
          description={
            localServer.status === 'failed'
              ? (localServer.error ?? '')
              : 'Start the server to use Treeport on this computer. Terminals keep running while it’s stopped.'
          }
        >
          {localServer.status === 'failed'
            ? 'Treeport couldn’t start'
            : 'Treeport isn’t running'}
        </ConnectionHeading>
        <Origin>{localServer.sourceRoot}</Origin>
        {output}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="default"
            onClick={() => void window.treeportShell.startLocalServer()}
          >
            {localServer.status === 'failed' ? 'Try again' : 'Start Treeport'}
          </Button>
          {localServer.status === 'failed' ? (
            <>
              <Button
                onClick={() => void window.treeportShell.showLocalServerLogs()}
              >
                Show logs
              </Button>
              <Button
                onClick={() =>
                  void window.treeportShell.openLocalServerSource()
                }
              >
                Open clone
              </Button>
            </>
          ) : null}
          <Button variant="outline" onClick={onOpenMenu}>
            Switch computer
          </Button>
        </div>
      </>
    )
  } else {
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
                  ? 'Start Treeport. If an update failed, reinstall the same or a newer compatible release first.'
                  : `${state.connection.message} Retrying automatically.`
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
                  <code className="min-w-0 truncate font-mono text-sm text-accent-200">
                    pnpm start
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
                  onClick={() =>
                    void window.treeportShell.openInstallationDocs()
                  }
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
                Retry now
              </Button>
              <Button onClick={onOpenMenu}>Switch computer</Button>
              <Button variant="outline" onClick={onManage}>
                Edit computer
              </Button>
            </div>
          </>
        )
        break
    }
  }

  return (
    <main
      className="grid min-h-full place-items-center bg-zinc-950 px-5 pt-16 pb-8"
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
