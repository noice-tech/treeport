import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { parseTerminalProgress, type TerminalProgress } from '@tasktty/shared'
import { TmuxControlParser } from './tmux-control.js'

const ESC = '\x1b'
const BEL = '\x07'
const OSC = '\u009d'
const ST = '\u009c'
const MAX_OSC_BYTES = 1024

type ParserState =
  | 'ground'
  | 'escape'
  | 'osc'
  | 'osc_escape'
  | 'osc_discard'
  | 'osc_discard_escape'
export type TerminalMetadataUpdate =
  | { type: 'title'; title: string }
  | { type: 'progress'; progress: TerminalProgress | null }
  | { type: 'bell' }

/** Extracts title and OSC 9;4 progress metadata from arbitrary terminal bytes. */
export class TerminalMetadataParser {
  private readonly decoder = new TextDecoder()
  private state: ParserState = 'ground'
  private osc: string[] = []
  private oscBytes = 0

  push(data: Uint8Array): TerminalMetadataUpdate[] {
    const updates: TerminalMetadataUpdate[] = []
    for (const character of this.decoder.decode(data, { stream: true })) {
      if (this.state === 'ground') {
        if (character === ESC) {
          this.state = 'escape'
        } else if (character === OSC) {
          this.startOsc()
        } else if (character === BEL) {
          updates.push({ type: 'bell' })
        }

        continue
      }

      if (this.state === 'escape') {
        if (character === ']') {
          this.startOsc()
        } else {
          this.state = character === ESC ? 'escape' : 'ground'
        }

        continue
      }

      if (this.state === 'osc') {
        if (character === BEL || character === ST) {
          this.finishOsc(updates)
        } else if (character === ESC) {
          this.state = 'osc_escape'
        } else {
          this.appendOsc(character)
        }

        continue
      }

      if (this.state === 'osc_escape') {
        if (character === '\\' || character === ST || character === BEL) {
          this.finishOsc(updates)
        } else if (character === ']') {
          this.startOsc()
        } else if (character === ESC) {
          this.appendOsc(ESC)
        } else if (this.appendOsc(ESC) && this.appendOsc(character)) {
          this.state = 'osc'
        }

        continue
      }

      if (this.state === 'osc_discard') {
        if (character === BEL || character === ST) {
          this.state = 'ground'
        } else if (character === ESC) {
          this.state = 'osc_discard_escape'
        }

        continue
      }

      if (character === '\\' || character === ST || character === BEL) {
        this.state = 'ground'
      } else if (character === ']') {
        this.startOsc()
      } else if (character !== ESC) {
        this.state = 'osc_discard'
      }
    }
    return updates
  }

  private startOsc(): void {
    this.state = 'osc'
    this.osc = []
    this.oscBytes = 0
  }

  private appendOsc(character: string): boolean {
    this.osc.push(character)
    this.oscBytes += Buffer.byteLength(character)
    if (this.oscBytes <= MAX_OSC_BYTES) {
      return true
    }

    this.osc = []
    this.oscBytes = 0
    this.state = 'osc_discard'
    return false
  }

  private finishOsc(updates: TerminalMetadataUpdate[]): void {
    const osc = this.osc.join('')
    const separator = osc.indexOf(';')
    if (separator > 0) {
      const command = osc.slice(0, separator)
      const payload = osc.slice(separator + 1)
      if (command === '9') {
        const parsed = parseTerminalProgress(payload)
        if (parsed !== undefined) {
          updates.push({ type: 'progress', progress: parsed })
        }
      } else if (command === '0' || command === '2') {
        updates.push({ type: 'title', title: payload })
      }
    }

    this.osc = []
    this.oscBytes = 0
    this.state = 'ground'
  }
}

/** Backwards-compatible progress-only parser used by focused protocol tests. */
export class TerminalProgressParser {
  private readonly parser = new TerminalMetadataParser()

  push(data: Uint8Array): Array<TerminalProgress | null> {
    return this.parser
      .push(data)
      .filter(
        (
          update
        ): update is Extract<TerminalMetadataUpdate, { type: 'progress' }> =>
          update.type === 'progress'
      )
      .map((update) => update.progress)
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
  private readonly metadataParser = new TerminalMetadataParser()
  private disposed = false

  constructor(
    private readonly options: TmuxProgressObserverOptions,
    spawnProcess: ProcessSpawner = spawn
  ) {
    this.process = spawnProcess(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.process.stdout.on('data', (chunk: Buffer) => this.handleData(chunk))
    this.process.stderr.resume()
    this.process.once('error', () => this.stop(true))
    this.process.once('exit', () => this.stop(true))
  }

  dispose(): void {
    this.stop(false)
  }

  private handleData(chunk: Buffer): void {
    if (this.disposed) {
      return
    }

    try {
      for (const event of this.controlParser.push(chunk)) {
        if (event.type !== 'output') {
          continue
        }

        for (const update of this.metadataParser.push(event.data)) {
          if (update.type === 'title') {
            this.options.onTitle?.(update.title)
          } else if (update.type === 'progress') {
            this.options.onProgress(update.progress)
          } else {
            this.options.onBell?.()
          }
        }
      }
    } catch {
      this.stop(true)
    }
  }

  private stop(notify: boolean): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
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
