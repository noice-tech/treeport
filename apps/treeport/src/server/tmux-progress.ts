import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { parseTerminalProgress, type TerminalProgress } from '@treeport/shared'
import xtermHeadless, { type IDisposable } from '@xterm/headless'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'
import { TmuxControlParser } from './tmux-control'

const { Terminal } = xtermHeadless
const PROCESS_TERMINATION_GRACE_MS = 250

export type TerminalMetadataUpdate =
  | { type: 'title'; title: string }
  | { type: 'progress'; progress: TerminalProgress | null }
  | { type: 'bell' }

type TmuxObserverPhase =
  | 'spawn'
  | 'control_parse'
  | 'terminal_parse'
  | 'metadata_callback'
  | 'process'

export class TmuxObserverError {
  readonly _tag = 'TmuxObserverError'

  constructor(
    readonly phase: TmuxObserverPhase,
    readonly cause: unknown
  ) {}
}

/** Observes terminal metadata through xterm's public parser APIs. */
export class TerminalMetadataParser {
  private readonly decoder = new TextDecoder()
  private readonly terminal = new Terminal({
    allowProposedApi: true,
    cols: 2,
    rows: 1,
    scrollback: 0,
    disableStdin: true,
    logLevel: 'off'
  })
  private readonly subscriptions: IDisposable[]
  private writeTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly onUpdate: (update: TerminalMetadataUpdate) => void
  ) {
    this.subscriptions = [
      this.terminal.onTitleChange((title) =>
        this.emit({ type: 'title', title })
      ),
      this.terminal.onBell(() => this.emit({ type: 'bell' })),
      this.terminal.parser.registerOscHandler(9, (payload) => {
        const progress = parseTerminalProgress(payload)
        if (progress !== undefined) {
          this.emit({ type: 'progress', progress })
        }

        return true
      })
    ]
  }

  push(data: Uint8Array): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }

    const write = this.writeTail.then(() => {
      if (this.disposed) {
        return
      }

      // xterm 6.0 still drops a three-byte character split after its second
      // byte. Decode in stream order before feeding xterm.
      const decoded = this.decoder.decode(data, { stream: true })
      return new Promise<void>((resolve) =>
        this.terminal.write(Buffer.from(decoded), resolve)
      )
    })
    this.writeTail = write.catch(() => undefined)
    return write
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose()
    }
    this.terminal.dispose()
  }

  private emit(update: TerminalMetadataUpdate): void {
    if (!this.disposed) {
      this.onUpdate(update)
    }
  }
}

export interface TmuxProgressObserverOptions {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  onTitle?: (title: string) => void
  onProgress: (progress: TerminalProgress | null) => void
  onBell?: () => void
  onHistoryChange?: (viewing: boolean) => void
  onExit: () => void
}

export interface TerminalProgressObserver {
  readonly closed?: Promise<void>
  dispose(): void
}

export type TerminalProgressObserverFactory = (
  options: TmuxProgressObserverOptions
) => TerminalProgressObserver

type ProcessSpawner = typeof spawn

function waitForProcessExit(
  child: ChildProcessWithoutNullStreams
): Promise<boolean> {
  return new Promise((resolve) => {
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), PROCESS_TERMINATION_GRACE_MS)
    const finish = (exited: boolean) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    child.once('exit', onExit)
  })
}

async function terminateProcess(
  child: ChildProcessWithoutNullStreams,
  terminationStarted: boolean
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) {
    return
  }

  // Test doubles and a synchronously failed spawn do not necessarily have a
  // pid. There is no OS process to wait for or escalate in that case.
  if (!child.pid) {
    if (!terminationStarted) {
      child.kill('SIGTERM')
    }

    return
  }

  const terminated = waitForProcessExit(child)
  if (!terminationStarted) {
    try {
      child.kill('SIGTERM')
    } catch {
      await terminated
      return
    }
  }

  if (await terminated) {
    return
  }

  const killed = waitForProcessExit(child)
  try {
    child.kill('SIGKILL')
  } catch {
    await killed
    return
  }
  await killed
}

export class TmuxProgressObserver implements TerminalProgressObserver {
  readonly closed: Promise<void>
  private readonly lifecycleFiber: Fiber.RuntimeFiber<void, never>
  private process: ChildProcessWithoutNullStreams | null = null
  private metadataParser: TerminalMetadataParser | null = null
  private failed = false
  private disposed = false
  private notified = false
  private terminationStarted = false
  private historyQueryPending = false
  private historyQueryQueued = false
  private failLifecycle: ((error: TmuxObserverError) => void) | null = null

  constructor(
    private readonly options: TmuxProgressObserverOptions,
    private readonly spawnProcess: ProcessSpawner = spawn
  ) {
    this.lifecycleFiber = Effect.runFork(
      Effect.scoped(this.lifecycle()).pipe(
        Effect.catchAll(() => Effect.sync(() => this.notifyExit()))
      )
    )
    this.closed = Effect.runPromise(Fiber.await(this.lifecycleFiber)).then(
      () => undefined
    )
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.beginTermination()
    Effect.runFork(Fiber.interrupt(this.lifecycleFiber))
  }

  private lifecycle(): Effect.Effect<void, TmuxObserverError, Scope.Scope> {
    return Effect.gen(this, function* () {
      const parser = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const acquired = new TerminalMetadataParser((update) =>
            this.handleMetadata(update)
          )
          this.metadataParser = acquired
          return acquired
        }),
        (acquired) =>
          Effect.sync(() => {
            if (this.metadataParser === acquired) {
              this.metadataParser = null
            }

            acquired.dispose()
          })
      )
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const acquired = this.spawnProcess(
              this.options.executable,
              this.options.args,
              {
                cwd: this.options.cwd,
                env: this.options.env,
                stdio: ['pipe', 'pipe', 'pipe']
              }
            )
            // Keep a no-op listener for the stream's whole lifetime. The
            // active lifecycle listener below reports write failures, while
            // this one prevents a queued EPIPE from becoming uncaught after
            // lifecycle cleanup has started.
            const onStdinResourceError = () => {}
            acquired.stdin.on('error', onStdinResourceError)
            acquired.stdin.once('close', () => {
              acquired.stdin.off('error', onStdinResourceError)
            })
            this.process = acquired
            return acquired
          },
          catch: (cause) => new TmuxObserverError('spawn', cause)
        }),
        (acquired) =>
          Effect.promise(async () => {
            acquired.stdout.pause()
            await terminateProcess(acquired, this.terminationStarted)
            if (this.process === acquired) {
              this.process = null
            }
          })
      )

      yield* Effect.async<void, TmuxObserverError>((resume) => {
        const fail = (error: TmuxObserverError) => {
          if (this.failed || this.disposed) {
            return
          }

          this.failed = true
          this.beginTermination()
          this.notifyExit()
          resume(Effect.fail(error))
        }
        this.failLifecycle = fail
        const onData = (chunk: Buffer) => {
          if (this.failed || this.disposed) {
            return
          }

          let writes: Promise<void>[]
          try {
            // Keep control and terminal parser state across every stdout chunk.
            writes = this.handleData(chunk, parser)
          } catch (cause) {
            fail(new TmuxObserverError('control_parse', cause))
            return
          }

          if (!writes.length) {
            return
          }

          child.stdout.pause()
          void Promise.all(writes).then(
            () => {
              if (!this.failed && !this.disposed) {
                child.stdout.resume()
              }
            },
            (cause) => fail(new TmuxObserverError('terminal_parse', cause))
          )
        }
        const onError = (cause: Error) =>
          fail(new TmuxObserverError('process', cause))
        const onStdinError = (cause: Error) =>
          fail(new TmuxObserverError('process', cause))
        const onExit = () =>
          fail(
            new TmuxObserverError(
              'process',
              new Error('tmux metadata observer exited')
            )
          )
        child.stdout.on('data', onData)
        child.stderr.resume()
        child.once('error', onError)
        child.stdin.on('error', onStdinError)
        child.once('exit', onExit)

        return Effect.sync(() => {
          this.failLifecycle = null
          child.stdout.off('data', onData)
          child.off('error', onError)
          child.stdin.off('error', onStdinError)
          child.off('exit', onExit)
          child.stdout.pause()
        })
      })
    })
  }

  private readonly controlParser = new TmuxControlParser()

  private handleData(
    chunk: Buffer,
    parser: TerminalMetadataParser
  ): Promise<void>[] {
    const writes: Promise<void>[] = []
    for (const event of this.controlParser.push(chunk)) {
      if (event.type === 'output') {
        writes.push(parser.push(event.data))
        continue
      }

      if (
        event.type === 'notification' &&
        (event.name === 'session-changed' || event.name === 'pane-mode-changed')
      ) {
        this.requestHistoryState()
        continue
      }

      if (event.type === 'command' && this.historyQueryPending) {
        this.historyQueryPending = false
        if (!event.success || event.lines.length !== 1) {
          throw new Error('tmux did not report the pane mode')
        }

        const mode = Buffer.from(event.lines[0]!).toString('utf8')
        this.options.onHistoryChange?.(mode === 'copy-mode')
        if (this.historyQueryQueued) {
          this.historyQueryQueued = false
          this.requestHistoryState()
        }
      }
    }
    return writes
  }

  private requestHistoryState(): void {
    if (!this.options.onHistoryChange || this.disposed || this.failed) {
      return
    }

    if (this.historyQueryPending) {
      this.historyQueryQueued = true
      return
    }

    const child = this.process
    if (!child) {
      return
    }

    this.historyQueryPending = true
    child.stdin.write('display-message -p "#{pane_mode}"\n')
  }

  private handleMetadata(update: TerminalMetadataUpdate): void {
    if (this.disposed || this.failed) {
      return
    }

    try {
      if (update.type === 'title') {
        this.options.onTitle?.(update.title)
      } else if (update.type === 'progress') {
        this.options.onProgress(update.progress)
      } else {
        this.options.onBell?.()
      }
    } catch (cause) {
      this.failLifecycle?.(new TmuxObserverError('metadata_callback', cause))
    }
  }

  private beginTermination(): void {
    const child = this.process
    if (this.terminationStarted || !child) {
      return
    }

    this.terminationStarted = true
    if (child.exitCode != null || child.signalCode != null) {
      return
    }

    try {
      child.kill('SIGTERM')
    } catch {
      // The process may have exited between the status check and signal.
    }
  }

  private notifyExit(): void {
    if (this.disposed || this.notified) {
      return
    }

    this.notified = true
    this.options.onExit()
  }
}

export const createTmuxProgressObserver: TerminalProgressObserverFactory = (
  options
) => new TmuxProgressObserver(options)
