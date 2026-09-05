import type { Page } from '@playwright/test'
import type { JsonValue, TerminalRuntimeMetadata } from '@treeport/shared'

export async function installMockSockets(
  page: Page,
  initialMetadata: TerminalRuntimeMetadata[]
) {
  await page.addInitScript((initialMetadata) => {
    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== '/api/rpc') {
        return nativeFetch(request)
      }

      const message = JSON.parse((await request.text()).trim())
      if (message._tag !== 'Request' || message.tag !== 'WatchProjectEvents') {
        throw new Error('Unexpected RPC request in browser fixture')
      }

      const encoder = new TextEncoder()
      let active = true
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (value: JsonValue) => {
            if (!active) {
              return
            }

            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  _tag: 'Chunk',
                  requestId: message.id,
                  values: [value]
                }) + '\n'
              )
            )
          }
          window.__eventSource = {
            emit: (name, source) => {
              send({
                _tag: 'ProductEvent',
                event: {
                  id: crypto.randomUUID(),
                  type: name,
                  at: new Date().toISOString(),
                  data: JSON.parse(source)
                }
              })
            }
          }
          send({
            _tag: 'Snapshot',
            snapshot: {
              at: new Date().toISOString(),
              terminalMetadata: initialMetadata,
              webPanels: [],
              browserPanels: [],
              presence: []
            }
          })
          request.signal.addEventListener(
            'abort',
            () => {
              if (!active) {
                return
              }

              active = false
              controller.close()
            },
            { once: true }
          )
        },
        cancel() {
          active = false
        }
      })
      return new Response(stream, {
        headers: { 'content-type': 'application/ndjson' }
      })
    }

    const terminalStatePrefix = '__treeport_terminal_state__:'
    const readState = (
      terminalId: string
    ): TreeportTestTerminalState | null => {
      const stored = localStorage.getItem(`${terminalStatePrefix}${terminalId}`)
      return stored ? JSON.parse(stored) : null
    }
    const notify = (state: TreeportTestTerminalState) => {
      for (const socket of window.__wsInstances ?? []) {
        if (socket.terminalId === state.terminalId) {
          socket.applyTerminalState(state)
        }
      }
    }
    window.addEventListener('storage', (event) => {
      if (event.key?.startsWith(terminalStatePrefix) && event.newValue) {
        notify(JSON.parse(event.newValue))
      }
    })

    class MockWebSocket extends EventTarget {
      static OPEN = 1
      readyState = 0
      binaryType = 'arraybuffer'
      clientId = ''
      terminalId = ''
      namespace = '/terminals'
      streamId = crypto.randomUUID()
      generation = 1
      cols = 100
      rows = 30
      revision = 1

      constructor(public url: string) {
        super()
        window.__wsInstances = [...(window.__wsInstances ?? []), this]
        window.__lastWs = this
        queueMicrotask(() => {
          this.readyState = 1
          this.dispatchEvent(new Event('open'))
        })
      }

      send(data: string) {
        const message = JSON.parse(data)
        if (message.type === 'handshake') {
          const auth = message.auth
          this.clientId = auth.clientId
          this.terminalId = auth.terminalId
          const state = readState(this.terminalId) ?? {
            terminalId: this.terminalId,
            cols: auth.cols,
            rows: auth.rows,
            revision: 1,
            generation: 1,
            controllerClientId: 'other'
          }
          localStorage.setItem(
            `${terminalStatePrefix}${this.terminalId}`,
            JSON.stringify(state)
          )
          this.cols = state.cols
          this.rows = state.rows
          this.revision = state.revision
          this.generation = state.generation
          this.receive('connected', null)
          this.receive('ready', {
            connectionId: crypto.randomUUID(),
            streamId: this.streamId,
            generation: this.generation,
            controller: state.controllerClientId === this.clientId,
            reset: 'full',
            cols: this.cols,
            rows: this.rows,
            revision: this.revision,
            snapshot: ''
          })
          this.receive('output', {
            streamId: this.streamId,
            sequence: 1,
            data: 'same persistent terminal session\r\n'
          })
          this.receive('title', {
            title:
              this.terminalId === 'term_dev'
                ? 'dev · /worktrees/topic'
                : 'zsh · /worktrees/topic'
          })
          return
        }

        const { event: type, payload } = message
        window.__wsSent = [...(window.__wsSent ?? []), { type, ...payload }]
        if (type === 'query_authority') {
          this.receive('query_authority', {
            generation: this.generation,
            transitionId: null,
            active: true
          })
          return
        }

        if (type !== 'resize' && type !== 'take_control') {
          return
        }

        const apply = () => {
          const state = readState(this.terminalId)!
          if (payload.cols !== this.cols || payload.rows !== this.rows) {
            state.cols = payload.cols
            state.rows = payload.rows
            state.revision += 1
          }

          if (type === 'take_control') {
            state.controllerClientId = this.clientId
            state.generation += 1
          }

          localStorage.setItem(
            `${terminalStatePrefix}${this.terminalId}`,
            JSON.stringify(state)
          )
          notify(state)
        }
        if (type === 'take_control' && window.__delayTakeControl) {
          window.__releaseTakeControl = () => {
            window.__delayTakeControl = false
            window.__releaseTakeControl = null
            apply()
          }
        } else {
          apply()
        }
      }

      applyTerminalState(state: TreeportTestTerminalState) {
        const dimensionsChanged = state.revision !== this.revision
        this.cols = state.cols
        this.rows = state.rows
        this.revision = state.revision
        this.generation = state.generation
        if (this.readyState !== 1) {
          return
        }

        if (dimensionsChanged) {
          this.receive('dimensions', {
            cols: this.cols,
            rows: this.rows,
            revision: this.revision
          })
        }

        this.receive('control', {
          generation: this.generation,
          controller: state.controllerClientId === this.clientId
        })
      }

      receive(event: string, payload: JsonValue) {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ event, payload })
            })
          )
        )
      }

      close() {
        if (this.readyState === 3) {
          return
        }

        this.readyState = 3
        this.dispatchEvent(new CloseEvent('close', { code: 1000 }))
      }
    }
    Object.assign(window, { WebSocket: MockWebSocket })
  }, initialMetadata)
}
