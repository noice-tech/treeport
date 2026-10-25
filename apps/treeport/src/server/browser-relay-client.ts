import { fork, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type {
  BrowserClientMessage,
  BrowserServerMessage
} from '@treeport/shared'

type WebCodecsReady = Extract<BrowserServerMessage, { type: 'webcodecsReady' }>

export type BrowserRelayCommand =
  | {
      type: 'open'
      stream: string
      extensionId: string
      endpoint: string
      targetId: string
      input: string | null
    }
  | { type: 'start'; stream: string; attachment: string; epoch: number }
  | { type: 'closeViewer'; stream: string; attachment: string }
  | { type: 'close'; stream: string }
  | {
      type: 'media'
      attachment: string
      url: string
      headers: IncomingMessage['headers']
      head: string
    }
  | { type: 'release'; attachment: string }
  | { type: 'barrier'; attachment: string; id: number }

export type BrowserRelayEvent =
  | { type: 'opened'; stream: string; port: number; token: string }
  | { type: 'connected'; stream: string }
  | { type: 'ready'; stream: string; config: WebCodecsReady }
  | { type: 'failed'; stream: string; message: string }
  | {
      type: 'wheel'
      attachment: string
      message: Extract<BrowserClientMessage, { type: 'wheel' }>
    }
  | { type: 'cursor'; attachment: string; x: number; y: number }

export interface BrowserRelayStream {
  port: number
  token: string
  connected: Promise<void>
  start(attachment: string, epoch: number): void
  closeViewer(attachment: string): void
  close(): void
}

export class BrowserRelay {
  #child: ChildProcess | null = null
  readonly #streams = new Map<
    string,
    {
      opened(port: number, token: string): void
      connected(): void
      ready(config: WebCodecsReady): void
      failed(message: string): void
    }
  >()

  constructor(
    private readonly entry: string,
    private readonly input: {
      wheel(
        attachment: string,
        message: Extract<BrowserClientMessage, { type: 'wheel' }>
      ): void
      cursor(attachment: string, point: { x: number; y: number }): void
    }
  ) {}

  open(
    params: {
      extensionId: string
      endpoint: string
      targetId: string
      input: string | null
    },
    handlers: {
      ready(config: WebCodecsReady): void
      failed(message: string): void
    }
  ): Promise<BrowserRelayStream> {
    const stream = crypto.randomUUID()
    let resolve: () => void = () => undefined
    let reject: (error: Error) => void = () => undefined

    const connected = new Promise<void>((resolved, rejected) => {
      resolve = resolved
      reject = rejected
    })

    void connected.catch(() => undefined)

    return new Promise<BrowserRelayStream>((opened, failed) => {
      let live = false
      this.#streams.set(stream, {
        opened: (port, token) => {
          opened({
            port,
            token,
            connected,
            start: (attachment, epoch) =>
              this.send({ type: 'start', stream, attachment, epoch }),
            closeViewer: (attachment) =>
              this.send({ type: 'closeViewer', stream, attachment }),
            close: () => {
              if (this.#streams.delete(stream)) {
                this.send({ type: 'close', stream })
              }
            }
          })
        },
        connected: () => {
          live = true
          resolve()
        },
        ready: handlers.ready,
        failed: (message) => {
          const error = new Error(message)
          failed(error)
          reject(error)

          if (live) {
            handlers.failed(message)
          }
        }
      })
      this.send({ type: 'open', stream, ...params })
    })
  }

  handoff(
    attachment: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): boolean {
    if (!(socket instanceof Socket)) {
      return false
    }

    const command: BrowserRelayCommand = {
      type: 'media',
      attachment,
      url: request.url ?? '/',
      headers: request.headers,
      head: head.toString('base64')
    }

    this.process().send(command, socket)

    return true
  }

  release(attachment: string): void {
    if (this.#child?.connected) {
      this.send({ type: 'release', attachment })
    }
  }

  barrier(attachment: string, id: number): void {
    if (this.#child?.connected) {
      this.send({ type: 'barrier', attachment, id })
    }
  }

  close(): void {
    this.#child?.kill()
  }

  private send(command: BrowserRelayCommand): void {
    this.process().send(command)
  }

  private process(): ChildProcess {
    if (this.#child?.connected) {
      return this.#child
    }

    const child = fork(this.entry, [], {
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    })

    this.#child = child
    child.on('message', (value) => {
      // SAFETY: Only the relay entrypoint writes to this IPC channel.
      const event = value as BrowserRelayEvent

      if (event.type === 'wheel') {
        this.input.wheel(event.attachment, event.message)

        return
      }

      if (event.type === 'cursor') {
        this.input.cursor(event.attachment, { x: event.x, y: event.y })

        return
      }

      const stream = this.#streams.get(event.stream)

      if (!stream) {
        return
      }

      if (event.type === 'opened') {
        stream.opened(event.port, event.token)
      } else if (event.type === 'connected') {
        stream.connected()
      } else if (event.type === 'ready') {
        stream.ready(event.config)
      } else {
        this.#streams.delete(event.stream)
        stream.failed(event.message)
      }
    })
    child.on('error', () => child.kill())
    child.once('disconnect', () => {
      child.kill()

      if (this.#child !== child) {
        return
      }

      this.#child = null
      const streams = [...this.#streams.values()]
      this.#streams.clear()

      for (const stream of streams) {
        stream.failed(
          'Browser video relay stopped. Reconnect to restart video.'
        )
      }
    })

    return child
  }
}
