import type { Page } from '@playwright/test'
import type { JsonValue, TerminalRuntimeMetadata } from '@treeport/shared'

export async function installMockSockets(
  page: Page,
  initialMetadata: TerminalRuntimeMetadata[],
  options: {
    hostedBrowser?: boolean
    browserInstallRequired?: boolean
  }
) {
  const socketFixture = {
    initialMetadata,
    hostedBrowser: options.hostedBrowser ?? false,
    browserInstallRequired: options.browserInstallRequired ?? false
  }
  await page.addInitScript((fixture) => {
    const { initialMetadata, hostedBrowser, browserInstallRequired } = fixture
    const terminalStatePrefix = '__treeport_terminal_state__:'
    const readTerminalState = (terminalId: string) => {
      const stored = localStorage.getItem(`${terminalStatePrefix}${terminalId}`)
      return stored ? JSON.parse(stored) : null
    }
    const notifyTerminalState = (state: any) => {
      const scope = window
      for (const socket of scope.__wsInstances || []) {
        if (
          socket.namespace !== '/terminals' ||
          socket.terminalId !== state.terminalId
        ) {
          continue
        }

        socket.applyTerminalState(state)
      }
    }
    const storeTerminalState = (state: any) => {
      localStorage.setItem(
        `${terminalStatePrefix}${state.terminalId}`,
        JSON.stringify(state)
      )
      notifyTerminalState(state)
    }
    const scope = window
    let hostedBrowserConnections = 0
    scope.__browserCommands = []
    scope.__browserNavigationCompleted = null
    if (!scope.__terminalStateListener) {
      scope.__terminalStateListener = true
      window.addEventListener('storage', (event) => {
        if (!event.key?.startsWith(terminalStatePrefix) || !event.newValue) {
          return
        }

        notifyTerminalState(JSON.parse(event.newValue))
      })
    }

    class MockWebSocket {
      static OPEN = 1
      readyState = 0
      binaryType = 'arraybuffer'
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      clientId = ''
      terminalId = ''
      namespace = ''
      streamId = crypto.randomUUID()
      generation = 1
      cols = 100
      rows = 30
      revision = 1
      browserState = {
        url: 'about:blank',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        viewport: { width: 1_280, height: 800 },
        controlled: true,
        hasController: true,
        controller: 'you'
      }
      private messageHandler: ((event: { data: string }) => void) | null = null
      private closeHandler: (() => void) | null = null

      constructor(public url: string) {
        const scope = window
        scope.__wsInstances = [...(scope.__wsInstances || []), this]
        scope.__lastWs = this
        setTimeout(() => {
          this.readyState = 1
          this.onopen?.()
          this.deliver(
            `0${JSON.stringify({
              sid: crypto.randomUUID(),
              upgrades: [],
              pingInterval: 25_000,
              pingTimeout: 20_000,
              maxPayload: 128 * 1024
            })}`
          )
        }, 10)
      }

      set onmessage(handler: ((event: { data: string }) => void) | null) {
        this.messageHandler = handler
      }

      get onmessage() {
        return (event: { data: string }) => {
          let message: any = null
          try {
            message = JSON.parse(String(event.data))
          } catch {
            this.messageHandler?.(event)
            return
          }
          if (!message?.type || this.namespace !== '/terminals') {
            this.messageHandler?.(event)
            return
          }

          const type =
            message.type === 'error' ? 'terminal_error' : message.type
          const { type: _type, version: _version, ...payload } = message
          if (type === 'control' && payload.generation === undefined) {
            payload.generation = this.generation
          }

          this.deliverSocket(type, payload)
        }
      }

      set onclose(handler: (() => void) | null) {
        this.closeHandler = handler
      }

      get onclose() {
        return () => {
          this.readyState = 3
          this.closeHandler?.()
        }
      }

      send(data: string) {
        const scope = window
        if (data === '2') {
          this.deliver('3')
          return
        }

        if (data.startsWith('40/events')) {
          this.namespace = '/events'
          this.deliver(
            `40/events,${JSON.stringify({ sid: crypto.randomUUID() })}`
          )
          scope.__eventSource = {
            disconnect: () => this.deliver('41/events,'),
            emit: (name: string, source = '{}') => {
              if (name === 'error') {
                this.close()
                return
              }

              const value = JSON.parse(source)
              if (name === 'connected') {
                this.deliverSocket('snapshot', {
                  webPanels: [],
                  browserPanels: [],
                  ...value
                })
                return
              }

              const data = value?.data ?? value
              const event = value?.type
                ? value
                : {
                    id: crypto.randomUUID(),
                    type: name,
                    at: new Date().toISOString(),
                    data: {
                      ...data,
                      worktreeId: data.worktreeId ?? null
                    }
                  }
              this.deliverSocket('product_event', event)
            }
          }
          this.deliverSocket('snapshot', {
            at: new Date().toISOString(),
            terminalMetadata: initialMetadata,
            webPanels: [],
            browserPanels: []
          })
          return
        }

        if (data.startsWith('40/browsers') && hostedBrowser) {
          this.namespace = '/browsers'
          hostedBrowserConnections += 1
          this.deliver(
            `40/browsers,${JSON.stringify({ sid: crypto.randomUUID() })}`
          )
          if (
            browserInstallRequired &&
            sessionStorage.getItem('__treeport_browser_installed__') !==
              'true' &&
            hostedBrowserConnections === 1
          ) {
            this.deliverSocket('message', {
              type: 'browserUnavailable',
              message: 'Chromium is not installed on this daemon.',
              installCommand: 'treeport browser install'
            })
            return
          }

          if (browserInstallRequired) {
            sessionStorage.setItem('__treeport_browser_installed__', 'true')
          }

          scope.__repeatBrowserState = () =>
            this.deliverSocket('message', {
              type: 'state',
              state: this.browserState
            })
          scope.__setBrowserLoading = (loading) => {
            this.browserState = { ...this.browserState, loading }
            scope.__repeatBrowserState()
          }
          scope.__setBrowserUrl = (url) => {
            this.browserState = { ...this.browserState, url }
            scope.__repeatBrowserState()
          }
          this.deliverSocket('message', {
            type: 'ready',
            state: this.browserState
          })
          return
        }

        if (data.startsWith('40/terminals')) {
          this.namespace = '/terminals'
          const separator = data.indexOf(',')
          const auth = JSON.parse(data.slice(separator + 1))
          this.clientId = auth.clientId
          this.terminalId = auth.terminalId
          let terminalState = readTerminalState(this.terminalId)
          if (!terminalState) {
            terminalState = {
              terminalId: this.terminalId,
              cols: auth.cols,
              rows: auth.rows,
              revision: 1,
              generation: 1,
              controllerClientId: 'other'
            }
            localStorage.setItem(
              `${terminalStatePrefix}${this.terminalId}`,
              JSON.stringify(terminalState)
            )
          }

          this.cols = terminalState.cols
          this.rows = terminalState.rows
          this.revision = terminalState.revision
          this.generation = terminalState.generation
          this.url = `${this.url}#${this.terminalId}`
          this.deliver(
            `40/terminals,${JSON.stringify({ sid: crypto.randomUUID() })}`
          )
          const controller = terminalState.controllerClientId === this.clientId
          this.deliverSocket('ready', {
            connectionId: crypto.randomUUID(),
            streamId: this.streamId,
            generation: this.generation,
            controller,
            reset: 'full',
            cols: this.cols,
            rows: this.rows,
            revision: this.revision,
            snapshot: ''
          })
          this.deliverSocket('output', {
            streamId: this.streamId,
            sequence: 1,
            data:
              this.terminalId === 'term_new'
                ? '[Treeport setup] bootstrap\\r\\nSETUP_OUTPUT\\r\\n[Treeport setup] bootstrap complete\\r\\nSHELL_READY\\r\\n'
                : 'same persistent terminal session\\r\\n'
          })
          if (!scope.__suppressInitialTitle) {
            this.deliverSocket('title', {
              title:
                this.terminalId === 'term_dev'
                  ? 'dev · /worktrees/topic'
                  : 'zsh · /worktrees/topic'
            })
          }

          return
        }

        if (data.startsWith('42/browsers,') && hostedBrowser) {
          const [type, payload = {}] = JSON.parse(
            data.slice('42/browsers,'.length)
          )
          if (type === 'command') {
            scope.__browserCommands = [
              ...(scope.__browserCommands || []),
              payload
            ]
            if (payload.type === 'navigate') {
              this.deliverSocket('message', {
                type: 'controlChanged',
                state: this.browserState
              })
              setTimeout(() => {
                this.browserState = {
                  ...this.browserState,
                  url: payload.url,
                  title: new URL(payload.url).host
                }
                scope.__browserNavigationCompleted = payload.url
                this.deliverSocket('message', {
                  type: 'state',
                  state: this.browserState
                })
              }, 25)
            }
          }

          return
        }

        if (!data.startsWith('42/terminals,')) {
          return
        }

        const [type, payload = {}] = JSON.parse(
          data.slice('42/terminals,'.length)
        )
        const message = { type, ...payload }
        scope.__wsSent = [...(scope.__wsSent || []), message]
        if (type === 'query_authority') {
          this.deliverSocket('query_authority', {
            generation: this.generation,
            transitionId: null,
            active: true
          })
          return
        }

        if (type === 'resize' || type === 'take_control') {
          const applyTerminalUpdate = () => {
            const terminalState = readTerminalState(this.terminalId)
            if (!terminalState) {
              throw new Error('Missing mock terminal state')
            }

            if (payload.cols !== this.cols || payload.rows !== this.rows) {
              terminalState.cols = payload.cols
              terminalState.rows = payload.rows
              terminalState.revision += 1
            }

            if (type === 'take_control') {
              terminalState.controllerClientId = this.clientId
              terminalState.generation += 1
            }

            storeTerminalState(terminalState)
          }
          if (type === 'take_control' && scope.__delayTakeControl) {
            scope.__releaseTakeControl = () => {
              scope.__delayTakeControl = false
              scope.__releaseTakeControl = null
              applyTerminalUpdate()
            }
          } else {
            applyTerminalUpdate()
          }
        }
      }

      applyTerminalState(state: any) {
        const dimensionsChanged =
          state.cols !== this.cols ||
          state.rows !== this.rows ||
          state.revision !== this.revision
        this.cols = state.cols
        this.rows = state.rows
        this.revision = state.revision
        this.generation = state.generation
        if (this.readyState !== 1) {
          return
        }

        if (dimensionsChanged) {
          this.deliverSocket('dimensions', {
            cols: this.cols,
            rows: this.rows,
            revision: this.revision
          })
        }

        this.deliverSocket('control', {
          generation: this.generation,
          controller: state.controllerClientId === this.clientId
        })
      }

      close() {
        this.readyState = 3
        this.closeHandler?.()
      }

      private deliver(data: string): void {
        queueMicrotask(() => this.messageHandler?.({ data }))
      }

      private deliverSocket(type: string, payload: JsonValue): void {
        this.deliver(`42${this.namespace},${JSON.stringify([type, payload])}`)
      }
    }
    Object.assign(window, { WebSocket: MockWebSocket })
  }, socketFixture)
}
