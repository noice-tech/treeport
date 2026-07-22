import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { parseTerminalProgress, type TerminalProgress } from '@tasktty/shared'
import xtermHeadless, { type IDisposable } from '@xterm/headless'
import { TmuxControlParser } from './tmux-control.js'

const { Terminal } = xtermHeadless

export type TerminalMetadataUpdate =
  | { type: 'title'; title: string }
  | { type: 'progress'; progress: TerminalProgress | null }
  | { type: 'bell' }

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

    // xterm 5.5 drops a three-byte character split after its second byte.
    // Normalize through the same streaming decoder TaskTTY previously used,
    // then continue feeding ordered bytes into xterm's terminal parser.
    const decoded = this.decoder.decode(data, { stream: true })
    return new Promise((resolve) =>
      this.terminal.write(Buffer.from(decoded), resolve)
    )
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
  onExit: () => void
}

export interface TerminalProgressObserver {
  dispose(): void
}

export type TerminalProgressObserverFactory = (
  options: TmuxProgressObserverOptions
) => TerminalProgressObserver

type ProcessSpawner = typeof spawn

export class TmuxProgressObserver implements TerminalProgressObserver {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly controlParser = new TmuxControlParser()
  private readonly metadataParser: TerminalMetadataParser
  private pendingWrites = 0
  private failed = false
  private disposed = false

  constructor(
    private readonly options: TmuxProgressObserverOptions,
    spawnProcess: ProcessSpawner = spawn
  ) {
    this.metadataParser = new TerminalMetadataParser((update) =>
      this.handleMetadata(update)
    )
    try {
      this.process = spawnProcess(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      this.metadataParser.dispose()
      throw error
    }
    this.process.stdout.on('data', (chunk: Buffer) => this.handleData(chunk))
    this.process.stderr.resume()
    this.process.once('error', () => this.stop(true))
    this.process.once('exit', () => this.stop(true))
  }

  dispose(): void {
    this.stop(false)
  }

  private handleData(chunk: Buffer): void {
    if (this.disposed || this.failed) {
      return
    }

    try {
      for (const event of this.controlParser.push(chunk)) {
        if (event.type !== 'output') {
          continue
        }

        this.process.stdout.pause()
        this.pendingWrites += 1
        void this.metadataParser.push(event.data).then(
          () => this.handleWriteParsed(),
          () => this.stop(true)
        )
      }
    } catch {
      this.stop(true)
    }
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
    } catch {
      this.failed = true
      queueMicrotask(() => this.stop(true))
    }
  }

  private handleWriteParsed(): void {
    if (this.disposed) {
      return
    }

    this.pendingWrites -= 1
    if (this.pendingWrites === 0) {
      this.process.stdout.resume()
    }
  }

  private stop(notify: boolean): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.metadataParser.dispose()
    this.process.stdout.pause()
    try {
      this.process.kill()
    } catch {
      // The control client may already have exited.
    }
    if (notify) {
      this.options.onExit()
    }
  }
}

export const createTmuxProgressObserver: TerminalProgressObserverFactory = (
  options
) => new TmuxProgressObserver(options)
