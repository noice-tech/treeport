type Export = (...args: number[]) => number

interface Exports {
  readonly memory: WebAssembly.Memory
  readonly __indirect_function_table: WebAssembly.Table
  readonly [name: string]: Export | WebAssembly.Memory | WebAssembly.Table
}

interface LayoutField {
  readonly offset: number
  readonly size: number
  readonly type: string
}

export interface LayoutBits {
  readonly lsb: number
  readonly width: number
  readonly arms?: Readonly<
    Record<
      string,
      { readonly bits?: Readonly<Record<string, LayoutBits>> } | null
    >
  >
}

interface LayoutType {
  readonly size?: number
  readonly fields?: Readonly<Record<string, LayoutField>>
  readonly values?: Readonly<Record<string, number>>
  readonly bits?: Readonly<Record<string, LayoutBits>>
}

interface Layout {
  readonly types: Readonly<Record<string, LayoutType>>
}

const layouts = new WeakMap<WebAssembly.Module, Layout>()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const GHOSTTY_SUCCESS = 0

export const TERMINAL_FOREGROUND = 0xe4e4e7
export const TERMINAL_BACKGROUND = 0x09090b

export const TERMINAL_IMAGE_STORAGE_BYTES = 32 * 1024 * 1024
const SCRATCH_BYTES = 1024

export interface GhosttyProgramStatus {
  readonly state: 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear'
  readonly kind: 'permission' | 'question' | 'auth' | null
  readonly progress: number | null
  readonly id: string
  readonly app: string
  readonly message: string
}

interface GhosttySemanticPrompt {
  readonly kind: 'promptStart' | 'inputStart' | 'outputStart' | 'commandEnd'
  readonly exitCode: number | null
  readonly command: string
}

export interface GhosttyTerminalCallbacks {
  writePty: ((data: Uint8Array) => void) | null
  bell: (() => void) | null
  titleChanged: (() => void) | null
  pwdChanged: (() => void) | null
  semanticPrompt: ((event: GhosttySemanticPrompt) => void) | null
  progress: ((state: number, value: number) => void) | null
  programStatus: ((report: GhosttyProgramStatus) => void) | null
  reset: (() => void) | null
  unknownOsc: ((content: string) => void) | null
  renderHold: ((held: boolean) => void) | null
  clipboardWrite: ((text: string) => void) | null
}

export interface GhosttyTerminalOptions {
  readonly scrollbackLines: number
  readonly continuationBytes: number
  readonly imageStorageBytes: number
  readonly foreground: number
  readonly background: number
}

export class GhosttyVt {
  readonly exports: Exports
  readonly layout: Layout
  readonly scratch: number
  private input = { ptr: 0, size: 0 }

  constructor(module: WebAssembly.Module) {
    const instance = new WebAssembly.Instance(module, {})
    // SAFETY: libghostty-vt exports only its C API, memory, and function table.
    this.exports = Object(instance.exports) as Exports
    let layout = layouts.get(module)

    if (!layout) {
      const ptr = this.call('ghostty_type_json')
      const bytes = this.bytes()
      const end = bytes.indexOf(0, ptr)
      // SAFETY: ghostty_type_json returns the library's NUL-terminated layout manifest.
      layout = JSON.parse(decoder.decode(bytes.subarray(ptr, end))) as Layout
      layouts.set(module, layout)
    }

    this.layout = layout
    this.scratch = this.call('ghostty_wasm_alloc', SCRATCH_BYTES)
  }

  call(name: string, ...args: number[]): number {
    // SAFETY: Callers name C API exports with their documented wasm32 arguments.
    return (this.exports[name] as Export)(...args)
  }

  check(result: number, what: string): void {
    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`${what} failed with Ghostty result ${result}`)
    }
  }

  view(): DataView {
    return new DataView(this.exports.memory.buffer)
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer)
  }

  type(name: string): LayoutType {
    const type = this.layout.types[name]

    if (!type) {
      throw new Error(`libghostty-vt layout is missing ${name}`)
    }

    return type
  }

  value(type: string, name: string): number {
    const value = this.type(type).values?.[name]

    if (value === undefined) {
      throw new Error(`libghostty-vt layout is missing ${type}.${name}`)
    }

    return value
  }

  offset(type: string, field: string): number {
    const value = this.type(type).fields?.[field]

    if (!value) {
      throw new Error(`libghostty-vt layout is missing ${type}.${field}`)
    }

    return value.offset
  }

  size(type: string): number {
    return this.type(type).size ?? 0
  }

  bits(type: string, field: string): LayoutBits {
    const value = this.type(type).bits?.[field]

    if (!value) {
      throw new Error(`libghostty-vt layout is missing ${type}.${field}`)
    }

    return value
  }

  armBits(type: string, field: string, arm: string, name: string): LayoutBits {
    const value = this.bits(type, field).arms?.[arm]?.bits?.[name]

    if (!value) {
      throw new Error(`libghostty-vt layout is missing ${type}.${field}.${arm}`)
    }

    return value
  }

  stage(data: Uint8Array): number {
    if (data.length > this.input.size) {
      if (this.input.ptr) {
        this.call('ghostty_wasm_free', this.input.ptr, this.input.size)
      }

      const size = Math.max(data.length, 64 * 1024)
      this.input = { ptr: this.call('ghostty_wasm_alloc', size), size }

      if (!this.input.ptr) {
        this.input = { ptr: 0, size: 0 }
        throw new Error('libghostty-vt could not allocate input')
      }
    }

    this.bytes().set(data, this.input.ptr)

    return this.input.ptr
  }

  opaque(what: string, create: (out: number) => number): number {
    const handle = this.tryOpaque(create)

    if (handle === null) {
      throw new Error(`${what} failed`)
    }

    return handle
  }

  tryOpaque(create: (out: number) => number): number | null {
    const out = this.call('ghostty_wasm_alloc_opaque')
    const result = create(out)
    const handle = this.call('ghostty_wasm_take_opaque', out)
    this.call('ghostty_wasm_free_opaque', out)

    return result === GHOSTTY_SUCCESS ? handle : null
  }

  // EXTERNAL: Copy and free a buffer returned through (uint8_t** out_ptr, size_t* out_len).
  take(what: string, produce: (outPtr: number, outLen: number) => number) {
    const out = this.scratch
    this.check(produce(out, out + 4), what)
    const view = this.view()
    const ptr = view.getUint32(out, true)
    const length = view.getUint32(out + 4, true)
    const data = this.bytes().slice(ptr, ptr + length)
    this.call('ghostty_free', 0, ptr, length)

    return data
  }

  string(ptr: number, length: number): string {
    return decoder.decode(this.bytes().subarray(ptr, ptr + length))
  }

  callback(
    fn: (...args: number[]) => number | void,
    params: number,
    returns: boolean
  ): number {
    const name = [1, 0x66]

    const module = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      // EXTERNAL: Type section: one function type with i32 parameters.
      0x01,
      4 + params + (returns ? 1 : 0),
      0x01,
      0x60,
      params,
      ...Array.from({ length: params }, () => 0x7f),
      ...(returns ? [0x01, 0x7f] : [0x00]),
      // EXTERNAL: Import the JavaScript function as e.f and re-export it as f.
      0x02,
      7,
      0x01,
      1,
      0x65,
      ...name,
      0x00,
      0x00,
      0x07,
      5,
      0x01,
      ...name,
      0x00,
      0x00
    ])

    const wrapper = new WebAssembly.Instance(new WebAssembly.Module(module), {
      e: { f: fn }
    })

    const table = this.exports.__indirect_function_table
    const index = table.grow(1)
    table.set(index, wrapper.exports.f)

    return index
  }
}

export class GhosttyTerminal {
  private disposed = false

  private constructor(
    readonly vt: GhosttyVt,
    readonly handle: number
  ) {}

  static create(
    module: WebAssembly.Module,
    cols: number,
    rows: number,
    options: GhosttyTerminalOptions,
    callbacks: GhosttyTerminalCallbacks
  ): GhosttyTerminal {
    const vt = new GhosttyVt(module)

    const handle = vt.opaque('ghostty_terminal_new', (out) =>
      vt.call('ghostty_terminal_new', 0, out, cols, rows)
    )

    const terminal = new GhosttyTerminal(vt, handle)
    terminal.configure(options, callbacks)

    return terminal
  }

  static restore(
    module: WebAssembly.Module,
    snapshot: Uint8Array,
    options: GhosttyTerminalOptions,
    callbacks: GhosttyTerminalCallbacks
  ): GhosttyTerminal {
    const vt = new GhosttyVt(module)
    const ptr = vt.call('ghostty_wasm_alloc', snapshot.length)
    vt.bytes().set(snapshot, ptr)

    const decoder = vt.opaque('ghostty_snapshot_decoder_new_buf', (out) =>
      vt.call('ghostty_snapshot_decoder_new_buf', 0, out, ptr, snapshot.length)
    )

    let handle = 0

    try {
      handle = vt.opaque('ghostty_snapshot_decoder_decode', (out) =>
        vt.call('ghostty_snapshot_decoder_decode', decoder, out)
      )
    } finally {
      vt.call('ghostty_snapshot_decoder_free', decoder)
      vt.call('ghostty_wasm_free', ptr, snapshot.length)
    }

    const terminal = new GhosttyTerminal(vt, handle)
    terminal.configure(options, callbacks)

    return terminal
  }

  private configure(
    options: GhosttyTerminalOptions,
    callbacks: GhosttyTerminalCallbacks
  ): void {
    const { vt } = this
    const option = (name: string) => vt.value('GhosttyTerminalOption', name)
    this.setSize(option('CONTINUATION_MAX_BYTES'), options.continuationBytes)
    this.set(option('SCROLLBACK_MAX_BYTES'), 0)
    this.setSize(option('SCROLLBACK_MAX_LINES'), options.scrollbackLines)
    this.setColor(option('COLOR_FOREGROUND'), options.foreground)
    this.setColor(option('COLOR_BACKGROUND'), options.background)
    vt.view().setBigUint64(vt.scratch, BigInt(options.imageStorageBytes), true)
    this.set(option('KITTY_IMAGE_STORAGE_LIMIT'), vt.scratch)

    if (callbacks.writePty) {
      const writePty = callbacks.writePty
      this.set(
        option('WRITE_PTY'),
        vt.callback(
          (_terminal, _user, ptr, length) =>
            writePty(vt.bytes().slice(ptr, ptr + length)),
          4,
          false
        )
      )
    }

    if (callbacks.bell) {
      const bell = callbacks.bell
      this.set(
        option('BELL'),
        vt.callback(() => bell(), 2, false)
      )
    }

    if (callbacks.titleChanged) {
      const titleChanged = callbacks.titleChanged
      this.set(
        option('TITLE_CHANGED'),
        vt.callback(() => titleChanged(), 2, false)
      )
    }

    if (callbacks.pwdChanged) {
      const pwdChanged = callbacks.pwdChanged
      this.set(
        option('PWD_CHANGED'),
        vt.callback(() => pwdChanged(), 2, false)
      )
    }

    if (callbacks.semanticPrompt) {
      const semanticPrompt = callbacks.semanticPrompt

      const field = (name: string) =>
        vt.offset('GhosttyTerminalSemanticPrompt', name)

      const kinds = new Map(
        (
          [
            ['PROMPT_START', 'promptStart'],
            ['INPUT_START', 'inputStart'],
            ['OUTPUT_START', 'outputStart'],
            ['COMMAND_END', 'commandEnd']
          ] as const
        ).map(([name, kind]) => [
          vt.value('GhosttySemanticPromptKind', name),
          kind
        ])
      )

      this.set(
        option('SEMANTIC_PROMPT'),
        vt.callback(
          (_terminal, _user, event) => {
            const view = vt.view()
            const kind = kinds.get(view.getInt32(event + field('kind'), true))

            if (!kind) {
              return
            }

            semanticPrompt({
              kind,
              exitCode: view.getUint8(event + field('has_exit_code'))
                ? view.getInt32(event + field('exit_code'), true)
                : null,
              command: vt.string(
                view.getUint32(event + field('command'), true),
                view.getUint32(event + field('command') + 4, true)
              )
            })
          },
          3,
          false
        )
      )
    }

    if (callbacks.progress) {
      const progress = callbacks.progress
      const state = vt.offset('GhosttyTerminalProgressReport', 'state')
      const value = vt.offset('GhosttyTerminalProgressReport', 'progress')
      this.set(
        option('PROGRESS_REPORT'),
        vt.callback(
          (_terminal, _user, report) => {
            const view = vt.view()
            progress(
              view.getInt32(report + state, true),
              view.getInt8(report + value)
            )
          },
          3,
          false
        )
      )
    }

    if (callbacks.programStatus) {
      const programStatus = callbacks.programStatus

      const field = (name: string) =>
        vt.offset('GhosttyTerminalProgramStatus', name)

      const names = <T extends string>(type: string, values: readonly T[]) =>
        new Map(
          values.map((name) => [vt.value(type, name.toUpperCase()), name])
        )

      const states = names<GhosttyProgramStatus['state']>(
        'GhosttyProgramStatusState',
        ['idle', 'working', 'done', 'blocked', 'error', 'clear']
      )

      const kinds = names<NonNullable<GhosttyProgramStatus['kind']>>(
        'GhosttyProgramStatusKind',
        ['permission', 'question', 'auth']
      )

      this.set(
        option('PROGRAM_STATUS'),
        vt.callback(
          (_terminal, _user, report) => {
            const view = vt.view()

            const string = (name: string) =>
              vt.string(
                view.getUint32(report + field(name), true),
                view.getUint32(report + field(name) + 4, true)
              )

            const state = states.get(
              view.getInt32(report + field('state'), true)
            )

            if (!state) {
              return
            }

            const progress = view.getInt8(report + field('progress'))
            programStatus({
              state,
              kind:
                kinds.get(view.getInt32(report + field('kind'), true)) ?? null,
              progress: progress < 0 ? null : progress,
              id: string('id'),
              app: string('app'),
              message: string('message')
            })
          },
          3,
          false
        )
      )
    }

    if (callbacks.reset) {
      const reset = callbacks.reset
      this.set(
        option('RESET'),
        vt.callback(() => reset(), 2, false)
      )
    }

    if (callbacks.unknownOsc) {
      const unknownOsc = callbacks.unknownOsc
      const osc = vt.value('GhosttyTerminalUnknownSequenceTag', 'OSC')
      const valueOffset = vt.offset('GhosttyTerminalUnknownSequence', 'value')

      const truncated = vt.offset(
        'GhosttyTerminalUnknownOscSequence',
        'truncated'
      )

      const content = vt.offset('GhosttyTerminalUnknownOscSequence', 'content')
      this.set(
        option('UNKNOWN_SEQUENCE'),
        vt.callback(
          (_terminal, _user, sequence) => {
            const view = vt.view()

            if (view.getInt32(sequence, true) !== osc) {
              return
            }

            const value = sequence + valueOffset

            if (view.getUint8(value + truncated)) {
              return
            }

            unknownOsc(
              vt.string(
                view.getUint32(value + content, true),
                view.getUint32(value + content + 4, true)
              )
            )
          },
          3,
          false
        )
      )
      this.setSize(option('UNKNOWN_MAX_BYTES'), 4_096)
    }

    if (callbacks.clipboardWrite) {
      const clipboardWrite = callbacks.clipboardWrite
      const write = (field: string) => vt.offset('GhosttyClipboardWrite', field)

      const content = (field: string) =>
        vt.offset('GhosttyClipboardContent', field)

      const contentSize = vt.size('GhosttyClipboardContent')
      const reply = vt.scratch + SCRATCH_BYTES / 2
      this.set(
        option('CLIPBOARD_WRITE'),
        vt.callback(
          (_terminal, _user, request) => {
            const view = vt.view()
            const contents = view.getUint32(request + write('contents'), true)
            const count = view.getUint32(request + write('contents_len'), true)

            const entries = Array.from({ length: count }, (_, index) => {
              const entry = contents + index * contentSize

              const string = (field: string) =>
                vt.string(
                  view.getUint32(entry + content(field), true),
                  view.getUint32(entry + content(field) + 4, true)
                )

              return { mime: string('mime'), data: string('data') }
            })

            const text =
              entries.find((entry) => entry.mime.startsWith('text/plain')) ??
              entries[0]

            if (count > 0 && !text) {
              return
            }

            clipboardWrite(text?.data ?? '')
            vt.bytes().fill(
              0,
              reply,
              reply + vt.size('GhosttyClipboardWriteReply')
            )
            view.setUint32(reply, vt.size('GhosttyClipboardWriteReply'), true)

            // SAFETY: reply is the request's C function pointer, an index into
            // this instance's function table.
            const answer = vt.exports.__indirect_function_table.get(
              view.getUint32(request + write('reply'), true)
            ) as (request: number, reply: number) => void

            answer(request, reply)
          },
          3,
          false
        )
      )
    }

    if (callbacks.renderHold) {
      const renderHold = callbacks.renderHold
      this.set(
        option('RENDER_HOLD'),
        vt.callback(
          (_terminal, _user, held) => renderHold(held !== 0),
          3,
          false
        )
      )
    }
  }

  private set(option: number, value: number): void {
    this.vt.check(
      this.vt.call('ghostty_terminal_set', this.handle, option, value),
      `ghostty_terminal_set(${option})`
    )
  }

  private setSize(option: number, value: number): void {
    this.vt.view().setUint32(this.vt.scratch, value, true)
    this.set(option, this.vt.scratch)
  }

  private setColor(option: number, rgb: number): void {
    this.vt
      .bytes()
      .set([(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff], this.vt.scratch)
    this.set(option, this.vt.scratch)
  }

  write(data: string): void {
    this.writeBytes(encoder.encode(data))
  }

  writeBytes(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return
    }

    const ptr = this.vt.stage(bytes)
    this.vt.call('ghostty_terminal_vt_write', this.handle, ptr, bytes.length)
  }

  resize(
    cols: number,
    rows: number,
    cellWidth = this.get('WIDTH_PX', (view, ptr) => view.getUint32(ptr, true)) /
      this.cols,
    cellHeight = this.get('HEIGHT_PX', (view, ptr) =>
      view.getUint32(ptr, true)
    ) / this.rows
  ): void {
    // EXTERNAL: Ghostty ends synchronized output on every resize, but an application
    // only redraws its frame when the grid itself changes.
    const synchronized =
      cols === this.cols && rows === this.rows && this.mode(2026)

    this.vt.check(
      this.vt.call(
        'ghostty_terminal_resize',
        this.handle,
        cols,
        rows,
        Math.round(cellWidth),
        Math.round(cellHeight)
      ),
      'ghostty_terminal_resize'
    )

    if (synchronized) {
      this.write('\x1b[?2026h')
    }
  }

  data<T>(data: string, read: (view: DataView, ptr: number) => T): T | null {
    const { vt } = this

    const result = vt.call(
      'ghostty_terminal_get',
      this.handle,
      vt.value('GhosttyTerminalData', data),
      vt.scratch
    )

    if (result === vt.value('GhosttyResult', 'NO_VALUE')) {
      return null
    }

    vt.check(result, `ghostty_terminal_get(${data})`)

    return read(vt.view(), vt.scratch)
  }

  private get(data: string, read: (view: DataView, ptr: number) => number) {
    return this.data(data, read) ?? 0
  }

  get cols(): number {
    return this.get('COLS', (view, ptr) => view.getUint16(ptr, true))
  }

  get rows(): number {
    return this.get('ROWS', (view, ptr) => view.getUint16(ptr, true))
  }

  get scrollbackRows(): number {
    return this.get('SCROLLBACK_ROWS', (view, ptr) => view.getUint32(ptr, true))
  }

  title(): string {
    const ptr = this.get('TITLE', (view, out) => view.getUint32(out, true))
    const length = this.vt.view().getUint32(this.vt.scratch + 4, true)

    return this.vt.string(ptr, length)
  }

  pwd(): string {
    const ptr = this.get('PWD', (view, out) => view.getUint32(out, true))
    const length = this.vt.view().getUint32(this.vt.scratch + 4, true)

    return this.vt.string(ptr, length)
  }

  mode(value: number, ansi = false): boolean {
    const { vt } = this
    const config = vt.scratch
    const view = vt.view()
    view.setUint16(
      config + vt.offset('GhosttyTerminalModeConfig', 'mode'),
      (value & 0x7fff) | (ansi ? 0x8000 : 0),
      true
    )
    vt.check(
      vt.call(
        'ghostty_terminal_get',
        this.handle,
        vt.value('GhosttyTerminalData', 'MODE'),
        config
      ),
      `ghostty_terminal_get(MODE ${value})`
    )

    return (
      vt
        .view()
        .getUint8(config + vt.offset('GhosttyTerminalModeConfig', 'value')) !==
      0
    )
  }

  snapshot(): Uint8Array {
    return this.vt.take('ghostty_snapshot_encode_alloc', (outPtr, outLen) =>
      this.vt.call(
        'ghostty_snapshot_encode_alloc',
        this.handle,
        0,
        outPtr,
        outLen
      )
    )
  }

  text(format: 'PLAIN' | 'VT' = 'PLAIN'): string {
    const { vt } = this
    const options = 'GhosttyFormatterTerminalOptions'
    const extra = 'GhosttyFormatterTerminalExtra'
    const screen = 'GhosttyFormatterScreenExtra'
    const ptr = vt.call('ghostty_wasm_alloc', vt.size(options))
    vt.bytes().fill(0, ptr, ptr + vt.size(options))
    const view = vt.view()
    view.setUint32(ptr, vt.size(options), true)
    view.setInt32(
      ptr + vt.offset(options, 'emit'),
      vt.value('GhosttyFormatterFormat', format),
      true
    )
    view.setUint8(ptr + vt.offset(options, 'trim'), 1)
    const extraPtr = ptr + vt.offset(options, 'extra')
    view.setUint32(extraPtr, vt.size(extra), true)
    const screenPtr = extraPtr + vt.offset(extra, 'screen')
    view.setUint32(screenPtr, vt.size(screen), true)

    if (format === 'VT') {
      view.setUint8(ptr + vt.offset(options, 'unwrap'), 1)
      view.setUint8(screenPtr + vt.offset(screen, 'style'), 1)
      view.setUint8(screenPtr + vt.offset(screen, 'hyperlink'), 1)
    }

    const formatter = vt.opaque('ghostty_formatter_terminal_new', (out) =>
      vt.call('ghostty_formatter_terminal_new', 0, out, this.handle, ptr)
    )

    vt.call('ghostty_wasm_free', ptr, vt.size(options))

    try {
      return decoder.decode(
        vt.take('ghostty_formatter_format_alloc', (outPtr, outLen) =>
          vt.call(
            'ghostty_formatter_format_alloc',
            formatter,
            0,
            outPtr,
            outLen
          )
        )
      )
    } finally {
      vt.call('ghostty_formatter_free', formatter)
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.vt.call('ghostty_terminal_free', this.handle)
  }
}
