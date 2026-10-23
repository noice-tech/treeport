import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test'
import type {
  JsonValue,
  TerminalAuth,
  TerminalRuntimeMetadata,
  TerminalServerEventPayloads,
  ProjectEventsItem,
  NetworkProductEvent
} from '@treeport/shared'
import { GhosttyTerminal } from '../../src/ghostty-vt/ghostty-vt'

const ghosttyModule = new WebAssembly.Module(
  readFileSync(new URL('../../src/ghostty-vt/ghostty-vt.wasm', import.meta.url))
)

function emptySnapshot(cols: number, rows: number): string {
  const terminal = GhosttyTerminal.create(
    ghosttyModule,
    cols,
    rows,
    {
      scrollbackLines: 0,
      continuationBytes: 0,
      imageStorageBytes: 0,
      foreground: 0,
      background: 0
    },
    {
      writePty: null,
      bell: null,
      titleChanged: null,
      progress: null,
      unknownOsc: null,
      renderHold: null,
      clipboardWrite: null
    }
  )
  const snapshot = Buffer.from(terminal.snapshot()).toString('base64')
  terminal.dispose()
  return snapshot
}

interface TerminalState {
  terminalId: string
  cols: number
  rows: number
  revision: number
  generation: number
  controllerClientId: string
}

interface ClientPayload {
  cols: number
  rows: number
  data?: string
  cellSize?: { width: number; height: number }
}

interface ClientMessage extends ClientPayload {
  type: string
}

export interface TerminalMock {
  messages: ClientMessage[]
  connections: TerminalConnection[]
  delayTakeControl: boolean
  releaseTakeControl: (() => void) | null
  readonly connection: TerminalConnection
}

const terminalServers = new WeakMap<
  BrowserContext,
  {
    states: Map<string, TerminalState>
    connections: Set<TerminalConnection>
  }
>()

class TerminalConnection {
  terminalId = ''
  clientId = ''
  streamId = randomUUID()
  generation = 1
  cols = 100
  rows = 30
  revision = 1
  closed = false

  constructor(readonly route: WebSocketRoute) {}

  receive<Event extends keyof TerminalServerEventPayloads>(
    event: Event,
    payload: TerminalServerEventPayloads[Event]
  ) {
    if (!this.closed) {
      this.route.send(JSON.stringify({ event, payload }))
    }
  }

  applyTerminalState(state: TerminalState) {
    const dimensionsChanged = state.revision !== this.revision
    this.cols = state.cols
    this.rows = state.rows
    this.revision = state.revision
    this.generation = state.generation
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

  close() {
    this.closed = true
    this.route.close({ code: 1000 })
  }
}

export async function installMockSockets(
  page: Page,
  initialMetadata: TerminalRuntimeMetadata[]
) {
  // Project event streaming is supplied at the HTTP boundary inside the page.
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
          const send = (value: ProjectEventsItem) => {
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
              webApps: [],
              browserApps: [],
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
  }, initialMetadata)

  const server = terminalServers.get(page.context()) ?? {
    states: new Map<string, TerminalState>(),
    connections: new Set<TerminalConnection>()
  }
  terminalServers.set(page.context(), server)
  const terminal: TerminalMock = {
    messages: [],
    connections: [],
    delayTakeControl: false,
    releaseTakeControl: null,
    get connection() {
      return this.connections.at(-1)!
    }
  }

  // Keep the server in the test runner: the app uses a real browser WebSocket,
  // and tests observe its protocol messages rather than browser globals/storage.
  await page.routeWebSocket('**/api/socket/terminals', (route) => {
    const connection = new TerminalConnection(route)
    terminal.connections.push(connection)
    server.connections.add(connection)
    route.onClose(() => {
      connection.closed = true
      server.connections.delete(connection)
    })
    route.onMessage((data) => {
      const message: {
        type: string
        auth: TerminalAuth
        event: string
        payload: ClientPayload
      } = JSON.parse(data.toString())
      if (message.type === 'handshake') {
        const auth = message.auth
        connection.clientId = auth.clientId
        connection.terminalId = auth.terminalId
        const state = server.states.get(auth.terminalId) ?? {
          terminalId: auth.terminalId,
          cols: auth.cols,
          rows: auth.rows,
          revision: 1,
          generation: 1,
          controllerClientId: 'other'
        }
        server.states.set(auth.terminalId, state)
        Object.assign(connection, {
          cols: state.cols,
          rows: state.rows,
          revision: state.revision,
          generation: state.generation
        })
        // The protocol handshake acknowledgment precedes terminal events.
        route.send(JSON.stringify({ event: 'connected', payload: null }))
        connection.receive('ready', {
          connectionId: randomUUID(),
          streamId: connection.streamId,
          generation: state.generation,
          controller: state.controllerClientId === auth.clientId,
          reset: 'full',
          cols: state.cols,
          rows: state.rows,
          revision: state.revision,
          snapshot: emptySnapshot(state.cols, state.rows)
        })
        connection.receive('output', {
          streamId: connection.streamId,
          sequence: 1,
          data: 'same persistent terminal session\r\n'
        })
        connection.receive('title', {
          title:
            auth.terminalId === 'term_dev'
              ? 'dev · /worktrees/topic'
              : 'zsh · /worktrees/topic'
        })
        return
      }

      const { event: type, payload } = message
      terminal.messages.push({ type, ...payload })
      if (type === 'query_authority') {
        connection.receive('query_authority', {
          generation: connection.generation,
          transitionId: null,
          active: true
        })
        return
      }

      if (type !== 'resize' && type !== 'take_control') {
        return
      }

      const apply = () => {
        const state = server.states.get(connection.terminalId)!
        if (payload.cols !== state.cols || payload.rows !== state.rows) {
          state.cols = payload.cols
          state.rows = payload.rows
          state.revision += 1
        }

        if (type === 'take_control') {
          state.controllerClientId = connection.clientId
          state.generation += 1
        }

        for (const target of server.connections) {
          if (target.terminalId === state.terminalId) {
            target.applyTerminalState(state)
          }
        }
      }
      if (type === 'take_control' && terminal.delayTakeControl) {
        terminal.releaseTakeControl = () => {
          terminal.delayTakeControl = false
          terminal.releaseTakeControl = null
          apply()
        }
      } else {
        apply()
      }
    })
  })
  return {
    terminal,
    emitProjectEvent: (type: NetworkProductEvent['type'], data: JsonValue) =>
      page.evaluate((source) => {
        const { type, data } = JSON.parse(source)
        window.__eventSource.emit(type, JSON.stringify(data))
      }, JSON.stringify({ type, data }))
  }
}
