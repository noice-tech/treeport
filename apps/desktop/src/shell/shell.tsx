import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, MonitorIcon } from 'lucide-react'
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'
import { createRoot } from 'react-dom/client'
import type { ComputerSummary, DesktopShellState } from '../desktop-contract'
import { Button, Dialog, Field, FieldLabel, Input } from './ui'

const ShellStateContext = createContext<DesktopShellState | null>(null)

function ShellStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopShellState | null>(null)

  useEffect(() => {
    const unsubscribe = window.treeportShell.onState(setState)
    void window.treeportShell.getState().then(setState)
    return unsubscribe
  }, [])

  return (
    <ShellStateContext.Provider value={state}>
      {children}
    </ShellStateContext.Provider>
  )
}

function useShellState() {
  return useContext(ShellStateContext)
}

function selectedComputer(
  state: DesktopShellState
): ComputerSummary | undefined {
  return state.computers.find((computer) => computer.selected)
}

function Titlebar() {
  const state = useShellState()
  if (!state || (state.platform === 'darwin' && state.fullscreen)) {
    return null
  }

  return (
    <header className="fixed inset-x-0 top-0 z-10 h-8 select-none bg-zinc-950 [-webkit-app-region:drag]" />
  )
}

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

function ConnectionPage({
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

function ConnectDialog({
  onClose,
  state
}: {
  onClose: () => void
  state: DesktopShellState
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [duplicateId, setDuplicateId] = useState<string>()
  const duplicate = state.computers.find(
    (computer) => computer.id === duplicateId
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await window.treeportShell.addComputer(url)
    if (result.ok) {
      onClose()
      return
    }

    setError(result.error)
    setDuplicateId(result.duplicateId)
  }

  return (
    <Dialog
      title="Connect to another computer"
      showCloseButton={false}
      onClose={onClose}
    >
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="computer-url">Computer URL</FieldLabel>
          <Input
            autoFocus
            id="computer-url"
            name="url"
            type="url"
            required
            autoComplete="url"
            placeholder="https://treeport.example.ts.net"
            value={url}
            aria-invalid={Boolean(error)}
            onChange={(event) => setUrl(event.target.value)}
          />
          <p className="text-base text-pretty text-zinc-400 sm:text-sm">
            Remote computers require HTTPS with a trusted certificate.
          </p>
        </Field>
        {error ? (
          <p className="text-sm text-pretty text-rose-300" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col-reverse items-stretch gap-2 min-[440px]:flex-row min-[440px]:items-center min-[440px]:justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {duplicateId ? (
            <Button
              variant="default"
              onClick={async () => {
                await window.treeportShell.selectComputer(duplicateId)
                onClose()
              }}
            >
              Switch to {duplicate?.name ?? 'saved computer'}
            </Button>
          ) : (
            <Button type="submit" variant="default">
              Connect
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  )
}

function ComputerEditor({
  computer,
  onError
}: {
  computer: ComputerSummary
  onError: (message: string) => void
}) {
  const [name, setName] = useState(computer.nameOverride ?? '')
  const [origin, setOrigin] = useState(computer.origin)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await window.treeportShell.updateComputer({
      id: computer.id,
      origin,
      nameOverride: name
    })
    if (!result.ok) {
      onError(result.error)
    }
  }

  return (
    <form
      className="flex shrink-0 flex-col gap-3 py-3 first:pt-0 last:pb-0"
      aria-label={`Edit ${computer.name} at ${computer.origin}`}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-[2fr_3fr]">
        <Field>
          <FieldLabel htmlFor={`name-${computer.id}`}>Name</FieldLabel>
          <Input
            id={`name-${computer.id}`}
            name={`name-${computer.id}`}
            value={name}
            placeholder={computer.name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`url-${computer.id}`}>URL</FieldLabel>
          <Input
            id={`url-${computer.id}`}
            name={`url-${computer.id}`}
            type="url"
            required
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-rose-300 hover:text-rose-200"
          onClick={() => void window.treeportShell.removeComputer(computer.id)}
        >
          Remove
        </Button>
        <Button type="submit" variant="secondary" size="sm">
          Save
        </Button>
      </div>
    </form>
  )
}

function ManageDialog({
  onClose,
  onConnect,
  state
}: {
  onClose: () => void
  onConnect: () => void
  state: DesktopShellState
}) {
  const [error, setError] = useState('')
  return (
    <Dialog title="Manage computers" size="large" onClose={onClose}>
      <div className="flex min-h-40 flex-1 flex-col overflow-y-auto divide-y divide-white/8 pr-1 [scrollbar-color:var(--color-zinc-700)_transparent]">
        {state.computers.length === 0 ? (
          <p className="grid min-h-40 place-items-center text-sm text-pretty text-zinc-400">
            No computers are saved.
          </p>
        ) : null}
        {state.computers.map((computer) => (
          <ComputerEditor
            key={computer.id}
            computer={computer}
            onError={setError}
          />
        ))}
      </div>
      {error ? (
        <p className="text-sm text-pretty text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex shrink-0 justify-end border-t border-white/8 pt-4">
        <Button variant="default" onClick={onConnect}>
          Connect to another computer…
        </Button>
      </div>
    </Dialog>
  )
}

function ComputerSelector({
  state,
  open,
  onOpenChange,
  onConnect,
  onManage
}: {
  state: DesktopShellState
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnect: () => void
  onManage: () => void
}) {
  const selected = selectedComputer(state)
  const label = selected?.name ?? 'Connect to a computer'
  const trigger = (
    <Button
      variant="ghost"
      size="xs"
      title={label}
      aria-label={selected ? `Connected computer: ${selected.name}` : label}
      className="pointer-events-auto max-w-[min(16rem,calc(100vw-1rem))] pr-2 pl-1.5 text-zinc-500 hover:text-zinc-100 [-webkit-app-region:no-drag]"
      onClick={state.computers.length === 0 ? onConnect : undefined}
    >
      <MonitorIcon data-icon="inline-start" />
      <span className="truncate">{label}</span>
    </Button>
  )

  if (state.computers.length === 0) {
    return trigger
  }

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align={state.platform === 'darwin' ? 'end' : 'center'}
          sideOffset={2}
          collisionPadding={4}
          className="flex max-h-[calc(100dvh-2.25rem)] w-72 flex-col gap-1 overflow-y-auto rounded-lg bg-zinc-900 p-1.5 text-zinc-200 shadow-xl ring-1 ring-white/10 outline-none [scrollbar-color:var(--color-zinc-700)_transparent]"
          aria-label="Computers"
        >
          <DropdownMenu.Group>
            <DropdownMenu.RadioGroup
              value={state.selectedComputerId ?? ''}
              onValueChange={(id) =>
                void window.treeportShell.selectComputer(id)
              }
            >
              {state.computers.map((computer) => (
                <DropdownMenu.RadioItem
                  key={computer.id}
                  value={computer.id}
                  className="grid min-h-10 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left text-zinc-200 outline-none data-[highlighted]:bg-white/6 data-[state=checked]:bg-white/6"
                >
                  <div className="flex h-5 items-center justify-center">
                    <DropdownMenu.ItemIndicator>
                      <CheckIcon className="size-4 shrink-0 stroke-cyan-300" />
                    </DropdownMenu.ItemIndicator>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[0.8125rem] font-medium text-zinc-100">
                      {computer.name}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {computer.origin}
                    </div>
                  </div>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Group>
          <DropdownMenu.Separator className="h-px shrink-0 bg-white/8" />
          <DropdownMenu.Group>
            <DropdownMenu.Item
              className="flex h-8 cursor-pointer items-center rounded-md px-2.5 text-sm text-zinc-400 outline-none data-[highlighted]:bg-white/6 data-[highlighted]:text-zinc-100"
              onSelect={onConnect}
            >
              Connect to another computer…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="flex h-8 cursor-pointer items-center rounded-md px-2.5 text-sm text-zinc-400 outline-none data-[highlighted]:bg-white/6 data-[highlighted]:text-zinc-100"
              onSelect={onManage}
            >
              Manage computers…
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function MainShell() {
  const state = useShellState()
  const [dialog, setDialog] = useState<'connect' | 'manage' | null>(null)
  const [selectorOpen, setSelectorOpen] = useState(false)

  useEffect(
    () =>
      window.treeportShell.onComputerSelectorDismiss(() =>
        setSelectorOpen(false)
      ),
    []
  )

  const openDialog = (nextDialog: 'connect' | 'manage') => {
    setSelectorOpen(false)
    setDialog(nextDialog)
  }
  const computer = state ? selectedComputer(state) : undefined
  const showTitlebar =
    state && !(state.platform === 'darwin' && state.fullscreen)

  return (
    <>
      <Titlebar />
      {state?.connection.status === 'ready' && computer ? (
        <webview
          key={computer.origin}
          src={computer.origin}
          partition="persist:treeport-desktop"
          className={
            state.platform === 'darwin' && state.fullscreen
              ? 'fixed inset-0 h-full w-full'
              : 'fixed inset-x-0 top-8 bottom-0 h-[calc(100%-2rem)] w-full'
          }
        />
      ) : (
        <ConnectionPage
          onConnect={() => openDialog('connect')}
          onManage={() => openDialog('manage')}
          onOpenMenu={() => setSelectorOpen(true)}
        />
      )}
      {showTitlebar ? (
        <div
          className={
            state.platform === 'darwin'
              ? 'pointer-events-none fixed top-0 right-2 z-20 flex h-8 items-center'
              : 'pointer-events-none fixed inset-x-0 top-0 z-20 flex h-8 items-center justify-center'
          }
        >
          <ComputerSelector
            state={state}
            open={selectorOpen}
            onOpenChange={setSelectorOpen}
            onConnect={() => openDialog('connect')}
            onManage={() => openDialog('manage')}
          />
        </div>
      ) : null}
      {state && dialog === 'connect' ? (
        <ConnectDialog state={state} onClose={() => setDialog(null)} />
      ) : null}
      {state && dialog === 'manage' ? (
        <ManageDialog
          state={state}
          onClose={() => setDialog(null)}
          onConnect={() => openDialog('connect')}
        />
      ) : null}
    </>
  )
}

function App() {
  return <MainShell />
}

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('Missing desktop shell root')
}

createRoot(root).render(
  <ShellStateProvider>
    <App />
  </ShellStateProvider>
)
