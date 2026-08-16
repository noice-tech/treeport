const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024
const DEFAULT_INPUT_CHUNK_BYTES = 256

export type TmuxControlEvent =
  | { type: 'output'; paneId: string; data: Uint8Array; lagMs: number | null }
  | {
      type: 'command'
      timestamp: number
      commandNumber: number
      flags: number
      success: boolean
      lines: Uint8Array[]
    }
  | { type: 'pause' | 'continue'; paneId: string }
  | { type: 'exit'; reason: string | null }
  | { type: 'notification'; name: string; arguments: string }

interface CommandBlock {
  timestamp: number
  commandNumber: number
  flags: number
  lines: Uint8Array[]
}

export class TmuxControlProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TmuxControlProtocolError'
  }
}

function ascii(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'ascii'
  )
}

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'utf8'
  )
}

function parseInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new TmuxControlProtocolError(`Invalid ${label}`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new TmuxControlProtocolError(`Invalid ${label}`)
  }

  return parsed
}

function parseGuard(line: Uint8Array, name: '%begin' | '%end' | '%error') {
  const match = ascii(line).match(new RegExp(`^${name} (\\d+) (\\d+) (\\d+)$`))
  if (!match) {
    throw new TmuxControlProtocolError(`Malformed ${name} record`)
  }

  return {
    timestamp: parseInteger(match[1]!, 'command timestamp'),
    commandNumber: parseInteger(match[2]!, 'command number'),
    flags: parseInteger(match[3]!, 'command flags')
  }
}

export function decodeTmuxControlBytes(encoded: Uint8Array): Uint8Array {
  const decoded: number[] = []
  for (let index = 0; index < encoded.length; index += 1) {
    const byte = encoded[index]!
    if (byte !== 0x5c) {
      if (byte < 0x20) {
        throw new TmuxControlProtocolError(
          'Unescaped control byte in pane output'
        )
      }

      decoded.push(byte)
      continue
    }

    if (index + 3 >= encoded.length) {
      throw new TmuxControlProtocolError(
        'Truncated octal escape in pane output'
      )
    }

    const first = encoded[index + 1]!
    const second = encoded[index + 2]!
    const third = encoded[index + 3]!
    if (
      first < 0x30 ||
      first > 0x33 ||
      second < 0x30 ||
      second > 0x37 ||
      third < 0x30 ||
      third > 0x37
    ) {
      throw new TmuxControlProtocolError('Invalid octal escape in pane output')
    }

    decoded.push((first - 0x30) * 64 + (second - 0x30) * 8 + (third - 0x30))
    index += 3
  }
  return Uint8Array.from(decoded)
}

function splitAtSpaces(
  line: Uint8Array,
  count: number
): [string[], Uint8Array] {
  const fields: string[] = []
  let start = 0
  for (
    let index = 0;
    index < line.length && fields.length < count;
    index += 1
  ) {
    if (line[index] !== 0x20) {
      continue
    }

    fields.push(ascii(line.subarray(start, index)))
    start = index + 1
  }
  if (fields.length !== count) {
    throw new TmuxControlProtocolError('Malformed control record')
  }

  return [fields, line.subarray(start)]
}

export class TmuxControlParser {
  private pending = Buffer.alloc(0)
  private command: CommandBlock | null = null
  private commandBytes = 0
  private failed = false

  constructor(private readonly maxRecordBytes = DEFAULT_MAX_RECORD_BYTES) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new RangeError('maxRecordBytes must be a positive integer')
    }
  }

  push(chunk: Uint8Array): TmuxControlEvent[] {
    if (this.failed) {
      throw new TmuxControlProtocolError('Parser is in a failed state')
    }

    try {
      if (chunk.byteLength) {
        const incoming = Buffer.from(
          chunk.buffer,
          chunk.byteOffset,
          chunk.byteLength
        )
        this.pending = this.pending.length
          ? Buffer.concat([this.pending, incoming])
          : Buffer.from(incoming)
      }

      const events: TmuxControlEvent[] = []
      let newline = this.pending.indexOf(0x0a)
      while (newline !== -1) {
        if (newline > this.maxRecordBytes) {
          throw new TmuxControlProtocolError(
            'Control record exceeds size limit'
          )
        }

        let line = this.pending.subarray(0, newline)
        this.pending = this.pending.subarray(newline + 1)
        if (line.at(-1) === 0x0d) {
          line = line.subarray(0, line.length - 1)
        }

        this.parseLine(line, events)
        newline = this.pending.indexOf(0x0a)
      }
      if (this.pending.length > this.maxRecordBytes) {
        throw new TmuxControlProtocolError('Control record exceeds size limit')
      }

      return events
    } catch (error) {
      this.failed = true
      this.pending = Buffer.alloc(0)
      this.command = null
      this.commandBytes = 0
      throw error
    }
  }

  finish(): void {
    if (this.failed) {
      throw new TmuxControlProtocolError('Parser is in a failed state')
    }

    if (this.pending.length || this.command) {
      throw new TmuxControlProtocolError('Incomplete tmux control stream')
    }
  }

  private parseLine(line: Uint8Array, events: TmuxControlEvent[]): void {
    if (this.command) {
      if (ascii(line).startsWith('%end ')) {
        this.closeCommand(line, true, events)
      } else if (ascii(line).startsWith('%error ')) {
        this.closeCommand(line, false, events)
      } else {
        this.commandBytes += line.byteLength
        if (this.commandBytes > this.maxRecordBytes) {
          throw new TmuxControlProtocolError(
            'Command response exceeds size limit'
          )
        }

        this.command.lines.push(Uint8Array.from(line))
      }

      return
    }

    if (ascii(line).startsWith('%begin ')) {
      this.command = { ...parseGuard(line, '%begin'), lines: [] }
      this.commandBytes = 0
      return
    }

    if (ascii(line).startsWith('%output ')) {
      const [fields, payload] = splitAtSpaces(line, 2)
      const paneId = fields[1]!
      assertPaneId(paneId)
      events.push({
        type: 'output',
        paneId,
        data: decodeTmuxControlBytes(payload),
        lagMs: null
      })
      return
    }

    if (ascii(line).startsWith('%extended-output ')) {
      const [fields, remainder] = splitAtSpaces(line, 2)
      const paneId = fields[1]!
      assertPaneId(paneId)
      let delimiter = -1
      for (let index = 0; index + 2 < remainder.length; index += 1) {
        if (
          remainder[index] === 0x20 &&
          remainder[index + 1] === 0x3a &&
          remainder[index + 2] === 0x20
        ) {
          delimiter = index
          break
        }
      }
      if (delimiter === -1) {
        throw new TmuxControlProtocolError('Malformed extended output record')
      }

      events.push({
        type: 'output',
        paneId,
        data: decodeTmuxControlBytes(remainder.subarray(delimiter + 3)),
        lagMs: parseInteger(
          ascii(remainder.subarray(0, delimiter)).split(' ', 1)[0]!,
          'output lag'
        )
      })
      return
    }

    const text = ascii(line)
    if (/^%(?:begin|end|error)(?: |$)/.test(text)) {
      throw new TmuxControlProtocolError(
        'Unexpected or malformed command guard'
      )
    }

    const lifecycle = text.match(/^%(pause|continue) (%\d+)$/)
    const lifecycleType = lifecycle?.[1]
    const lifecyclePaneId = lifecycle?.[2]
    if (
      (lifecycleType === 'pause' || lifecycleType === 'continue') &&
      lifecyclePaneId
    ) {
      events.push({
        type: lifecycleType,
        paneId: lifecyclePaneId
      })
      return
    }

    if (text === '%exit' || text.startsWith('%exit ')) {
      events.push({
        type: 'exit',
        reason: line.length > 5 ? utf8(line.subarray(6)) : null
      })
      return
    }

    const notification = text.match(/^%([a-z][a-z-]*)(?: |$)/)
    if (notification) {
      const argumentOffset = notification[0].length
      events.push({
        type: 'notification',
        name: notification[1]!,
        arguments:
          argumentOffset < line.length
            ? utf8(line.subarray(argumentOffset))
            : ''
      })
      return
    }

    throw new TmuxControlProtocolError(
      'Unexpected data outside a command block'
    )
  }

  private closeCommand(
    line: Uint8Array,
    success: boolean,
    events: TmuxControlEvent[]
  ): void {
    const command = this.command!
    const guard = parseGuard(line, success ? '%end' : '%error')
    if (
      guard.timestamp !== command.timestamp ||
      guard.commandNumber !== command.commandNumber ||
      guard.flags !== command.flags
    ) {
      throw new TmuxControlProtocolError('Mismatched command guard')
    }

    this.command = null
    this.commandBytes = 0
    events.push({ type: 'command', ...command, success })
  }
}

function assertPaneId(paneId: string): void {
  if (!/^%\d+$/.test(paneId)) {
    throw new RangeError('Invalid tmux pane ID')
  }
}

export function controlAttachArgs(
  socketName: string,
  configPath: string,
  sessionName: string
): string[] {
  return [
    '-L',
    socketName,
    '-f',
    configPath,
    '-C',
    'attach-session',
    '-t',
    sessionName
  ]
}

export function progressControlAttachArgs(
  socketName: string,
  configPath: string,
  sessionName: string
): string[] {
  return [
    '-L',
    socketName,
    '-f',
    configPath,
    '-C',
    'attach-session',
    '-r',
    '-t',
    sessionName
  ]
}

export function encodeControlInput(
  paneId: string,
  input: Uint8Array,
  chunkBytes = DEFAULT_INPUT_CHUNK_BYTES
): string[] {
  assertPaneId(paneId)
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < 1 ||
    chunkBytes > 4096
  ) {
    throw new RangeError('chunkBytes must be between 1 and 4096')
  }

  const commands: string[] = []
  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    const hex = [...input.subarray(offset, offset + chunkBytes)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ')
    commands.push(`send-keys -H -t ${paneId} ${hex}\n`)
  }
  return commands
}

export function resizeControlClient(cols: number, rows: number): string {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 65_535 ||
    rows > 65_535
  ) {
    throw new RangeError(
      'Terminal dimensions must be integers between 1 and 65535'
    )
  }

  return `refresh-client -C ${cols}x${rows}\n`
}
