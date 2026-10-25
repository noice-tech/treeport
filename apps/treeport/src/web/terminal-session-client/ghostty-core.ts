import type {
  CellData,
  CursorState,
  MouseEncoding,
  TerminalColorOverrides,
  TerminalCore,
  TerminalGraphicsState,
  TerminalImageData,
  TerminalImageDescriptor,
  TerminalImagePlacement,
  TerminalPosition,
  TerminalRowMetadata,
  TrackedTerminalPosition,
  UnderlineStyle,
  UnhandledSequence
} from '@wterm/core'
import {
  GhosttyTerminal,
  type GhosttyTerminalCallbacks,
  type GhosttyVt,
  type LayoutBits,
  TERMINAL_BACKGROUND,
  TERMINAL_FOREGROUND,
  TERMINAL_IMAGE_STORAGE_BYTES
} from '../../ghostty-vt/ghostty-vt'
import ghosttyVtWasmUrl from '../../ghostty-vt/ghostty-vt.wasm?url'

const DEFAULT_COLOR = 256
const TEXT_BYTES = 4096

const BLANK_CELL: CellData = {
  char: 32,
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  flags: 0,
  width: 1
}

const UNDERLINE_STYLES: readonly UnderlineStyle[] = [
  'none',
  'single',
  'double',
  'curly',
  'dotted',
  'dashed'
]

const decoder = new TextDecoder()

const URL_PATTERN =
  /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g

const URL_ROW_LIMIT = 8

const HISTORY_ROW_CACHE = 512

let compiled: Promise<WebAssembly.Module> | null = null

export function loadGhosttyVtModule(): Promise<WebAssembly.Module> {
  compiled ??= fetch(ghosttyVtWasmUrl).then(async (response) => {
    if (!response.ok) {
      throw new Error(`ghostty-vt.wasm failed to load (${response.status})`)
    }

    return WebAssembly.compile(await response.arrayBuffer())
  })

  return compiled
}

interface CellStyle {
  flags: number
  fg: number | null
  fgRgb: number | null
  bg: number | null
  bgRgb: number | null
  underline: UnderlineStyle
  underlineColor: { palette: number | null; rgb: number | null }
}

interface DecodedRow {
  cells: CellData[]
  raw: CellData[]
  length: number
  metadata: TerminalRowMetadata
}

interface Session {
  terminal: GhosttyTerminal
  vt: GhosttyVt
  state: number
  rows: number
  cells: number
  placements: number
  point: number
  ref: number
  style: number
  selection: number
  info: number
  out: number
  text: number
}

function bits(lo: number, hi: number, { lsb, width }: LayoutBits): number {
  const value =
    lsb >= 32
      ? hi >>> (lsb - 32)
      : lsb + width <= 32
        ? lo >>> lsb
        : (lo >>> lsb) | (hi << (32 - lsb))

  return value & (2 ** width - 1)
}

function rgb(view: DataView, ptr: number): number {
  return (
    (view.getUint8(ptr) << 16) |
    (view.getUint8(ptr + 1) << 8) |
    view.getUint8(ptr + 2)
  )
}

export class GhosttyTerminalCore implements TerminalCore {
  private session: Session | null = null
  private layout: ReturnType<typeof readLayout> | null = null
  private viewport: DecodedRow[] = []
  private dirty: boolean[] = []
  private stale = true
  private history: { offset: number; row: DecodedRow | null } | null = null
  private historyRows = new Map<number, DecodedRow | null>()
  private cursor: CursorState = { row: 0, col: 0, visible: false }
  private palette: Uint8Array | null = null
  private responses: string[] = []
  private bells = 0
  private clipboard: string | null = null
  private titleChanged = false
  private graphics: TerminalGraphicsState | null = null
  private graphicsKey = ''
  private graphicsGeneration = 0
  private synchronizedGeneration = 0
  private owner = {}

  constructor(
    private readonly module: WebAssembly.Module,
    private readonly scrollbackLines: number
  ) {}

  private callbacks(): GhosttyTerminalCallbacks {
    return {
      writePty: (data) => this.responses.push(decoder.decode(data)),
      bell: () => {
        this.bells += 1
      },
      titleChanged: () => {
        this.titleChanged = true
      },
      progress: null,
      programStatus: () => {},
      reset: null,
      unknownOsc: null,
      renderHold: () => {
        this.synchronizedGeneration += 1
      },
      clipboardWrite: (text) => {
        this.clipboard = text
      }
    }
  }

  private options() {
    return {
      scrollbackLines: this.scrollbackLines,
      continuationBytes: 0,
      imageStorageBytes: TERMINAL_IMAGE_STORAGE_BYTES,
      foreground: TERMINAL_FOREGROUND,
      background: TERMINAL_BACKGROUND
    }
  }

  private attach(terminal: GhosttyTerminal): void {
    this.dispose()
    const { vt } = terminal
    const alloc = (size: number) => vt.call('ghostty_wasm_alloc', size)

    const handle = (name: string) =>
      vt.opaque(name, (out) => vt.call(name, 0, out))

    this.layout = readLayout(vt)
    this.session = {
      terminal,
      vt,
      state: handle('ghostty_render_state_new'),
      rows: handle('ghostty_render_state_row_iterator_new'),
      cells: handle('ghostty_render_state_row_cells_new'),
      placements: handle('ghostty_kitty_graphics_placement_iterator_new'),
      point: alloc(vt.size('GhosttyPoint')),
      ref: alloc(vt.size('GhosttyGridRef')),
      style: alloc(vt.size('GhosttyStyle')),
      selection: alloc(vt.size('GhosttySelection')),
      info: alloc(vt.size('GhosttyKittyGraphicsPlacementRenderInfo')),
      out: alloc(64),
      text: alloc(TEXT_BYTES)
    }
    this.owner = {}
    this.viewport = []
    this.dirty = []
    this.titleChanged = true
    this.invalidate()
  }

  init(cols: number, rows: number): void {
    this.attach(
      GhosttyTerminal.create(
        this.module,
        cols,
        rows,
        this.options(),
        this.callbacks()
      )
    )
  }

  restore(snapshot: Uint8Array): void {
    this.attach(
      GhosttyTerminal.restore(
        this.module,
        snapshot,
        this.options(),
        this.callbacks()
      )
    )
  }

  resize(cols: number, rows: number): void {
    this.session?.terminal.resize(cols, rows)
    this.invalidate()
  }

  writeString(str: string): void {
    this.session?.terminal.write(str)
    this.invalidate()
  }

  writeRaw(data: Uint8Array): void {
    this.session?.terminal.writeBytes(data)
    this.invalidate()
  }

  private invalidate(): void {
    this.stale = true
    this.history = null
    this.historyRows.clear()
    this.palette = null
    this.graphics = null
  }

  private ensureViewport(): void {
    const session = this.session
    const layout = this.layout

    if (!this.stale || !session || !layout) {
      return
    }

    this.stale = false
    const { vt } = session

    const renderData = (name: string, out: number) =>
      vt.call(
        'ghostty_render_state_get',
        session.state,
        vt.value('GhosttyRenderStateData', name),
        out
      )

    vt.check(
      vt.call(
        'ghostty_render_state_update',
        session.state,
        session.terminal.handle
      ),
      'ghostty_render_state_update'
    )
    renderData('DIRTY', session.out)
    renderData('ROWS', session.out + 4)
    let view = vt.view()
    const rows = view.getUint16(session.out + 4, true)

    const full =
      view.getInt32(session.out, true) === layout.dirtyFull ||
      rows !== this.viewport.length

    if (rows !== this.viewport.length) {
      this.viewport.length = rows
      this.dirty = Array.from({ length: rows }, () => true)
    }

    if (full || view.getInt32(session.out, true) !== layout.dirtyFalse) {
      view.setUint32(session.out, session.rows, true)
      renderData('ROW_ITERATOR', session.out)

      const rowData = (name: string, out: number) =>
        vt.call(
          'ghostty_render_state_row_get',
          session.rows,
          vt.value('GhosttyRenderStateRowData', name),
          out
        )

      for (
        let y = 0;
        y < rows &&
        vt.call('ghostty_render_state_row_iterator_next', session.rows);
        y++
      ) {
        rowData('DIRTY', session.out)

        if (!full && !vt.view().getUint8(session.out) && this.viewport[y]) {
          continue
        }

        rowData('RAW', session.out)

        const metadata = this.rowMetadata(
          vt.view().getBigUint64(session.out, true)
        )

        rowData('CELLS_RAW', session.out)
        view = vt.view()
        const cellsPtr = view.getUint32(session.out, true)
        const count = view.getUint32(session.out + 4, true)
        view.setUint32(session.out, session.cells, true)
        rowData('CELLS', session.out)
        this.viewport[y] = this.decodeRow(
          count,
          metadata,
          (x) => {
            const cell = vt.view()

            return [
              cell.getUint32(cellsPtr + x * 8, true),
              cell.getUint32(cellsPtr + x * 8 + 4, true)
            ]
          },
          {
            style: (x) => {
              vt.call('ghostty_render_state_row_cells_select', session.cells, x)
              vt.view().setUint32(session.style, vt.size('GhosttyStyle'), true)

              const result = vt.call(
                'ghostty_render_state_row_cells_get',
                session.cells,
                vt.value('GhosttyRenderStateRowCellsData', 'STYLE'),
                session.style
              )

              return result === 0 ? this.readStyle(session.style) : null
            },
            graphemes: (x) => {
              vt.call('ghostty_render_state_row_cells_select', session.cells, x)

              const cellsData = (name: string, out: number) =>
                vt.call(
                  'ghostty_render_state_row_cells_get',
                  session.cells,
                  vt.value('GhosttyRenderStateRowCellsData', name),
                  out
                )

              cellsData('GRAPHEMES_LEN', session.out)
              const length = vt.view().getUint32(session.out, true)

              if (length * 4 > TEXT_BYTES) {
                return undefined
              }

              cellsData('GRAPHEMES_BUF', session.text)

              return this.codepoints(session.text, length)
            },
            link: (x) => {
              this.writePoint(session.point, 'VIEWPORT', x, y)

              return this.hyperlinkAt(session.point)
            }
          }
        )
        this.dirty[y] = true
      }

      vt.call('ghostty_render_state_clean', session.state)

      for (let start = 0; start < this.viewport.length;) {
        let end = start

        while (
          end < this.viewport.length - 1 &&
          this.viewport[end]!.metadata.wrapsToNext
        ) {
          end++
        }

        const group = this.viewport.slice(start, end + 1)
        const linked = linkUrls(group)
        group.forEach((row, index) => {
          const cells = linked[index]!

          if (
            cells.length !== row.cells.length ||
            cells.some((cell, x) => cell.linkUri !== row.cells[x]!.linkUri)
          ) {
            this.dirty[start + index] = true
          }

          row.cells = cells
        })
        start = end + 1
      }
    }

    vt.view().setUint32(session.out, vt.size('GhosttyRenderStateCursor'), true)
    renderData('CURSOR', session.out)
    view = vt.view()

    const cursor = (field: string) =>
      session.out + vt.offset('GhosttyRenderStateCursor', field)

    const style = view.getInt32(cursor('visual_style'), true)
    this.cursor = {
      row: view.getUint16(cursor('viewport_y'), true),
      col: view.getUint16(cursor('viewport_x'), true),
      visible:
        view.getUint8(cursor('viewport_has_value')) !== 0 &&
        view.getUint8(cursor('visible')) !== 0,
      ['shape']:
        style === layout.cursorBar
          ? 'bar'
          : style === layout.cursorUnderline
            ? 'underline'
            : 'block',
      blinking: view.getUint8(cursor('blinking')) !== 0
    }
  }

  private rowMetadata(row: bigint): TerminalRowMetadata {
    const session = this.session!
    const { vt } = session

    // SAFETY: ghostty_row_get takes the packed GhosttyRow by value, which
    // wasm32 passes as an i64.
    const rowGet = Object(vt.exports.ghostty_row_get) as (
      row: bigint,
      data: number,
      out: number
    ) => number

    const flag = (name: string) => {
      rowGet(row, vt.value('GhosttyRowData', name), session.out + 8)

      return vt.view().getUint8(session.out + 8) !== 0
    }

    return {
      wrapsToNext: flag('WRAP'),
      continuesPrevious: flag('WRAP_CONTINUATION')
    }
  }

  private decodeRow(
    count: number,
    metadata: TerminalRowMetadata,
    raw: (x: number) => [number, number],
    read: {
      style: (x: number) => CellStyle | null
      graphemes: (x: number) => string | undefined
      link: (x: number) => string | null
    }
  ): DecodedRow {
    const layout = this.layout!
    const styles = new Map<number, CellStyle | null>()
    const cells: CellData[] = []
    let length = 0

    for (let x = 0; x < count; x++) {
      const [lo, hi] = raw(x)
      const tag = bits(lo, hi, layout.tag)
      const content = bits(lo, hi, layout.content)
      const styleId = bits(lo, hi, layout.styleId)
      const wide = bits(lo, hi, layout.wide)
      const hyperlink = bits(lo, hi, layout.hyperlink) !== 0

      const codepoint =
        tag === layout.tagCodepoint || tag === layout.tagGrapheme
          ? content & (2 ** layout.codepoint.width - 1)
          : 0

      if (
        tag === layout.tagCodepoint &&
        codepoint === 0 &&
        styleId === 0 &&
        wide === layout.wideNarrow &&
        !hyperlink
      ) {
        cells.push(BLANK_CELL)
        continue
      }

      length = x + 1

      const cell: CellData = {
        char: codepoint || 32,
        fg: DEFAULT_COLOR,
        bg: DEFAULT_COLOR,
        flags: 0,
        width:
          wide === layout.wideWide ? 2 : wide === layout.wideSpacerTail ? 0 : 1
      }

      if (wide === layout.wideSpacerHead) {
        cell.spacerHead = true
      }

      if (tag === layout.tagGrapheme) {
        const chars = read.graphemes(x)

        if (chars !== undefined) {
          cell.chars = chars
        }
      } else if (tag === layout.tagBgPalette) {
        const index = bits(content, 0, layout.bgPalette)
        const bgRgb = index < 16 ? null : this.paletteColor(index)

        if (bgRgb === null) {
          cell.bg = index
        } else {
          cell.bgRgb = bgRgb
        }
      } else if (tag === layout.tagBgRgb) {
        cell.bgRgb =
          (bits(content, 0, layout.bgR) << 16) |
          (bits(content, 0, layout.bgG) << 8) |
          bits(content, 0, layout.bgB)
      }

      if (styleId !== 0) {
        let style = styles.get(styleId)

        if (style === undefined) {
          style = read.style(x)
          styles.set(styleId, style)
        }

        if (style) {
          cell.flags = style.flags

          if (style.fg !== null) {
            cell.fg = style.fg
          }

          if (style.fgRgb !== null) {
            cell.fgRgb = style.fgRgb
          }

          if (style.bg !== null && tag !== layout.tagBgPalette) {
            cell.bg = style.bg
          }

          if (
            style.bgRgb !== null &&
            tag !== layout.tagBgRgb &&
            tag !== layout.tagBgPalette
          ) {
            cell.bgRgb = style.bgRgb
          }

          if (style.underline !== 'none') {
            cell.underlineStyle = style.underline

            const underline =
              style.underlineColor.rgb ??
              (style.underlineColor.palette === null
                ? null
                : this.paletteColor(style.underlineColor.palette))

            if (underline !== null) {
              cell.underlineRgb = underline
            }
          }
        }
      }

      if (hyperlink) {
        const uri = read.link(x)

        if (uri) {
          cell.linkUri = uri
          cell.linkKey = uri
        }
      }

      cells.push(cell)
    }

    return { cells, raw: cells, length, metadata }
  }

  private readStyle(ptr: number): CellStyle {
    const { vt } = this.session!
    const layout = this.layout!
    const view = vt.view()
    const field = (name: string) => ptr + vt.offset('GhosttyStyle', name)

    const flag = (name: string, value: number) =>
      view.getUint8(field(name)) ? value : 0

    // EXTERNAL: wterm themes the 16 ANSI colors but builds indices 16-255 from a
    // 51-step cube instead of xterm's, so those resolve through Ghostty's palette.
    const color = (name: string) => {
      const base = field(name)
      const tag = view.getInt32(base, true)
      const value = base + layout.colorValue
      const palette = tag === layout.colorPalette ? view.getUint8(value) : null

      return {
        palette: palette !== null && palette < 16 ? palette : null,
        rgb:
          tag === layout.colorRgb
            ? rgb(view, value)
            : palette === null || palette < 16
              ? null
              : this.paletteColor(palette)
      }
    }

    const underline =
      UNDERLINE_STYLES[view.getInt32(field('underline'), true)] ?? 'single'

    const fg = color('fg_color')
    const bg = color('bg_color')

    return {
      flags:
        flag('bold', 0x01) |
        flag('faint', 0x02) |
        flag('italic', 0x04) |
        (underline === 'none' ? 0 : 0x08) |
        flag('blink', 0x10) |
        flag('inverse', 0x20) |
        flag('invisible', 0x40) |
        flag('strikethrough', 0x80),
      fg: fg.palette,
      fgRgb: fg.rgb,
      bg: bg.palette,
      bgRgb: bg.rgb,
      underline,
      underlineColor: color('underline_color')
    }
  }

  private paletteColor(index: number): number | null {
    const session = this.session!
    this.palette ??=
      session.terminal.data('COLOR_PALETTE', (view, ptr) =>
        new Uint8Array(view.buffer, ptr, 256 * 3).slice()
      ) ?? null
    const palette = this.palette

    return palette
      ? (palette[index * 3]! << 16) |
          (palette[index * 3 + 1]! << 8) |
          palette[index * 3 + 2]!
      : null
  }

  private codepoints(ptr: number, length: number): string {
    const view = this.session!.vt.view()

    return String.fromCodePoint(
      ...Array.from({ length }, (_, index) =>
        view.getUint32(ptr + index * 4, true)
      )
    )
  }

  private writePoint(ptr: number, tag: string, x: number, y: number): void {
    const { vt } = this.session!
    const view = vt.view()
    const coordinate = ptr + vt.offset('GhosttyPoint', 'value')
    view.setInt32(ptr, vt.value('GhosttyPointTag', tag), true)
    view.setUint16(
      coordinate + vt.offset('GhosttyPointCoordinate', 'x'),
      x,
      true
    )
    view.setUint32(
      coordinate + vt.offset('GhosttyPointCoordinate', 'y'),
      y,
      true
    )
  }

  private gridRef(point: number): boolean {
    const session = this.session!
    const { vt } = session
    vt.view().setUint32(session.ref, vt.size('GhosttyGridRef'), true)

    return (
      vt.call(
        'ghostty_terminal_grid_ref',
        session.terminal.handle,
        point,
        session.ref
      ) === 0
    )
  }

  private hyperlinkAt(point: number): string | null {
    const session = this.session!
    const { vt } = session

    if (!this.gridRef(point)) {
      return null
    }

    const result = vt.call(
      'ghostty_grid_ref_hyperlink_uri',
      session.ref,
      session.text,
      TEXT_BYTES,
      session.out
    )

    return result === 0
      ? vt.string(session.text, vt.view().getUint32(session.out, true)) || null
      : null
  }

  private historyRow(offset: number): DecodedRow | null {
    if (!this.session || !Number.isInteger(offset) || offset < 0) {
      return null
    }

    if (this.history?.offset === offset) {
      return this.history.row
    }

    const row = this.decodeHistoryRow(offset)

    if (row) {
      const above: DecodedRow[] = []

      for (
        let current = row;
        current.metadata.continuesPrevious && above.length < URL_ROW_LIMIT;
      ) {
        const previous = this.decodeHistoryRow(offset + above.length + 1)

        if (!previous) {
          break
        }

        above.unshift(previous)
        current = previous
      }

      const below: DecodedRow[] = []

      for (
        let current = row;
        current.metadata.wrapsToNext && below.length < URL_ROW_LIMIT;
      ) {
        const nextOffset = offset - below.length - 1

        if (nextOffset < 0) {
          this.ensureViewport()
        }

        const next =
          nextOffset >= 0
            ? this.decodeHistoryRow(nextOffset)
            : this.viewport[-nextOffset - 1]

        if (!next) {
          break
        }

        below.push(next)
        current = next
      }

      row.cells = linkUrls([...above, row, ...below])[above.length]!
    }

    this.history = { offset, row }

    return row
  }

  private decodeHistoryRow(offset: number): DecodedRow | null {
    const cached = this.historyRows.get(offset)

    if (cached !== undefined) {
      return cached
    }

    const session = this.session!
    const { vt, terminal } = session
    const total = terminal.scrollbackRows
    let row: DecodedRow | null = null
    this.writePoint(session.point, 'HISTORY', 0, total - 1 - offset)

    if (offset < total && this.gridRef(session.point)) {
      vt.call('ghostty_grid_ref_row', session.ref, session.out)

      const metadata = this.rowMetadata(
        vt.view().getBigUint64(session.out, true)
      )

      const cols = terminal.cols

      const x = (column: number) =>
        vt
          .view()
          .setUint16(
            session.ref + vt.offset('GhosttyGridRef', 'x'),
            column,
            true
          )

      row = this.decodeRow(
        cols,
        metadata,
        (column) => {
          x(column)
          vt.call('ghostty_grid_ref_cell', session.ref, session.out)
          const view = vt.view()

          return [
            view.getUint32(session.out, true),
            view.getUint32(session.out + 4, true)
          ]
        },
        {
          style: (column) => {
            x(column)
            vt.view().setUint32(session.style, vt.size('GhosttyStyle'), true)

            return vt.call(
              'ghostty_grid_ref_style',
              session.ref,
              session.style
            ) === 0
              ? this.readStyle(session.style)
              : null
          },
          graphemes: (column) => {
            x(column)

            const result = vt.call(
              'ghostty_grid_ref_graphemes',
              session.ref,
              session.text,
              TEXT_BYTES / 4,
              session.out
            )

            return result === 0
              ? this.codepoints(
                  session.text,
                  vt.view().getUint32(session.out, true)
                )
              : undefined
          },
          link: (column) => {
            this.writePoint(
              session.point,
              'HISTORY',
              column,
              total - 1 - offset
            )

            return this.hyperlinkAt(session.point)
          }
        }
      )
    }

    if (this.historyRows.size >= HISTORY_ROW_CACHE) {
      this.historyRows.clear()
    }

    this.historyRows.set(offset, row)

    return row
  }

  getCell(row: number, col: number): CellData {
    this.ensureViewport()

    return this.viewport[row]?.cells[col] ?? BLANK_CELL
  }

  getRowMetadata(row: number): TerminalRowMetadata | null {
    this.ensureViewport()

    return this.viewport[row]?.metadata ?? null
  }

  isDirtyRow(row: number): boolean {
    this.ensureViewport()

    return this.dirty[row] ?? false
  }

  clearDirty(): void {
    this.dirty.fill(false)
  }

  getCols(): number {
    return this.session?.terminal.cols ?? 0
  }

  getRows(): number {
    return this.session?.terminal.rows ?? 0
  }

  trackPosition(position: TerminalPosition): TrackedTerminalPosition | null {
    const session = this.session

    if (
      !session ||
      !Number.isInteger(position.row) ||
      position.row < 0 ||
      !Number.isInteger(position.col) ||
      position.col < 0 ||
      position.col >= 65_536
    ) {
      return null
    }

    const { vt, terminal } = session
    this.writePoint(session.point, 'SCREEN', position.col, position.row)

    const handle = vt.tryOpaque((out) =>
      vt.call(
        'ghostty_terminal_grid_ref_track',
        terminal.handle,
        session.point,
        out
      )
    )

    if (handle === null) {
      return null
    }

    const owner = this.owner
    const alternate = this.usingAltScreen()
    let disposed = false

    return {
      resolve: () => {
        if (
          disposed ||
          owner !== this.owner ||
          alternate !== this.usingAltScreen() ||
          vt.call(
            'ghostty_tracked_grid_ref_point',
            handle,
            vt.value('GhosttyPointTag', 'SCREEN'),
            session.out
          ) !== 0
        ) {
          return null
        }

        const view = vt.view()

        return {
          row: view.getUint32(
            session.out + vt.offset('GhosttyPointCoordinate', 'y'),
            true
          ),
          col: view.getUint16(
            session.out + vt.offset('GhosttyPointCoordinate', 'x'),
            true
          )
        }
      },
      dispose: () => {
        if (disposed) {
          return
        }

        disposed = true

        if (owner === this.owner) {
          vt.call('ghostty_tracked_grid_ref_free', handle)
        }
      }
    }
  }

  getCursor(): CursorState {
    this.ensureViewport()

    return this.cursor
  }

  getColorOverrides(): TerminalColorOverrides {
    const terminal = this.session?.terminal
    const colors: TerminalColorOverrides = {}

    if (!terminal) {
      return colors
    }

    const foreground = terminal.data('COLOR_FOREGROUND', rgb)
    const background = terminal.data('COLOR_BACKGROUND', rgb)
    const cursor = terminal.data('COLOR_CURSOR', rgb)

    if (foreground !== null && foreground !== TERMINAL_FOREGROUND) {
      colors.foreground = foreground
    }

    if (background !== null && background !== TERMINAL_BACKGROUND) {
      colors.background = background
    }

    if (cursor !== null) {
      colors.cursor = cursor
    }

    return colors
  }

  private mode(value: number): boolean {
    return this.session?.terminal.mode(value) ?? false
  }

  cursorKeysApp(): boolean {
    return this.mode(1)
  }

  bracketedPaste(): boolean {
    return this.mode(2004)
  }

  usingAltScreen(): boolean {
    const layout = this.layout

    return (
      layout !== null &&
      this.session?.terminal.data('ACTIVE_SCREEN', (view, ptr) =>
        view.getInt32(ptr, true)
      ) === layout.screenAlternate
    )
  }

  mouseTracking(): 0 | 1000 | 1002 | 1003 {
    return this.mode(1003)
      ? 1003
      : this.mode(1002)
        ? 1002
        : this.mode(1000) || this.mode(9)
          ? 1000
          : 0
  }

  mouseSgr(): boolean {
    return this.mode(1006)
  }

  mouseEncoding(): MouseEncoding | null {
    return this.mode(1016)
      ? 'sgr-pixels'
      : this.mode(1006)
        ? 'sgr'
        : this.mode(1015)
          ? 'urxvt'
          : this.mode(1005)
            ? 'utf8'
            : 'x10'
  }

  focusEvents(): boolean {
    return this.mode(1004)
  }

  synchronizedOutput(): boolean {
    return this.mode(2026)
  }

  synchronizedOutputGeneration(): number {
    return this.synchronizedGeneration
  }

  kittyKeyboardFlags(): number {
    return (
      this.session?.terminal.data('KITTY_KEYBOARD_FLAGS', (view, ptr) =>
        view.getUint8(ptr)
      ) ?? 0
    )
  }

  // EXTERNAL: wterm polls after every write and expects a title only when it changed.
  getTitle(): string | null {
    if (!this.session || !this.titleChanged) {
      return null
    }

    this.titleChanged = false

    return this.session.terminal.title()
  }

  getBellCount(): number {
    const bells = this.bells
    this.bells = 0

    return bells
  }

  getClipboardWrite(): string | null {
    const text = this.clipboard
    this.clipboard = null

    return text
  }

  getResponse(): string | null {
    if (!this.responses.length) {
      return null
    }

    const response = this.responses.join('')
    this.responses = []

    return response
  }

  getScrollbackCount(): number {
    return this.session?.terminal.scrollbackRows ?? 0
  }

  getScrollbackCell(offset: number, col: number): CellData {
    return this.historyRow(offset)?.cells[col] ?? BLANK_CELL
  }

  getScrollbackLineLen(offset: number): number {
    return this.historyRow(offset)?.length ?? 0
  }

  getScrollbackRowMetadata(offset: number): TerminalRowMetadata | null {
    return this.historyRow(offset)?.metadata ?? null
  }

  getGraphicsState(): TerminalGraphicsState | null {
    const session = this.session

    if (!session) {
      return null
    }

    if (this.graphics) {
      return this.graphics
    }

    const { vt, terminal } = session
    const images = new Map<number, TerminalImageDescriptor>()
    const placements: TerminalImagePlacement[] = []

    const storage = terminal.data('KITTY_GRAPHICS', (view, ptr) =>
      view.getUint32(ptr, true)
    )

    vt.view().setUint32(session.out, session.placements, true)

    if (
      storage &&
      vt.call(
        'ghostty_kitty_graphics_get',
        storage,
        vt.value('GhosttyKittyGraphicsData', 'PLACEMENT_ITERATOR'),
        session.out
      ) === 0
    ) {
      const placement = (name: string) => {
        vt.call(
          'ghostty_kitty_graphics_placement_get',
          session.placements,
          vt.value('GhosttyKittyGraphicsPlacementData', name),
          session.out
        )

        return vt.view().getUint32(session.out, true)
      }

      const info = (name: string) =>
        vt
          .view()
          .getUint32(
            session.info +
              vt.offset('GhosttyKittyGraphicsPlacementRenderInfo', name),
            true
          )

      while (
        vt.call('ghostty_kitty_graphics_placement_next', session.placements)
      ) {
        vt.call(
          'ghostty_kitty_graphics_placement_get',
          session.placements,
          vt.value('GhosttyKittyGraphicsPlacementData', 'IS_VIRTUAL'),
          session.out
        )

        if (vt.view().getUint8(session.out)) {
          continue
        }

        const imageId = placement('IMAGE_ID')
        const descriptor = images.get(imageId) ?? this.imageDescriptor(imageId)
        const image = this.kittyImage(imageId)
        vt.view().setUint32(
          session.info,
          vt.size('GhosttyKittyGraphicsPlacementRenderInfo'),
          true
        )
        vt.view().setUint32(
          session.selection,
          vt.size('GhosttySelection'),
          true
        )

        if (
          !descriptor ||
          vt.call(
            'ghostty_kitty_graphics_placement_render_info',
            session.placements,
            image,
            terminal.handle,
            session.info
          ) !== 0 ||
          vt.call(
            'ghostty_kitty_graphics_placement_rect',
            session.placements,
            image,
            terminal.handle,
            session.selection
          ) !== 0 ||
          vt.call(
            'ghostty_terminal_point_from_grid_ref',
            terminal.handle,
            session.selection + vt.offset('GhosttySelection', 'start'),
            vt.value('GhosttyPointTag', 'SCREEN'),
            session.point
          ) !== 0
        ) {
          continue
        }

        const view = vt.view()

        const row = view.getUint32(
          session.point + vt.offset('GhosttyPointCoordinate', 'y'),
          true
        )

        const col = view.getUint16(
          session.point + vt.offset('GhosttyPointCoordinate', 'x'),
          true
        )

        images.set(imageId, descriptor)
        placements.push({
          placementKey: `${imageId}:${placement('PLACEMENT_ID')}:${row}:${col}`,
          imageId,
          imageVersion: descriptor.version,
          row,
          col,
          offsetX: placement('X_OFFSET'),
          offsetY: placement('Y_OFFSET'),
          sourceX: info('source_x'),
          sourceY: info('source_y'),
          sourceWidth: info('source_width'),
          sourceHeight: info('source_height'),
          // EXTERNAL: wterm stretches to both cell dimensions and treats zero rows as
          // unreserved, so keep aspect ratio unless the program asked for both.
          columns: placement('ROWS') ? placement('COLUMNS') : 0,
          rows: placement('ROWS') || info('grid_rows'),
          z: placement('Z') | 0
        })
      }
    }

    const key = JSON.stringify(placements)

    if (key !== this.graphicsKey) {
      this.graphicsKey = key
      this.graphicsGeneration += 1
    }

    this.graphics = {
      generation: this.graphicsGeneration,
      images: [...images.values()],
      placements
    }

    return this.graphics
  }

  getGraphicsImage(imageId: number, version: number): TerminalImageData | null {
    const session = this.session
    const descriptor = this.imageDescriptor(imageId)
    const image = this.kittyImage(imageId)

    if (!session || !descriptor || descriptor.version !== version) {
      return null
    }

    const { vt } = session

    const get = (name: string) =>
      vt.call(
        'ghostty_kitty_graphics_image_get',
        image,
        vt.value('GhosttyKittyGraphicsImageData', name),
        session.out
      ) === 0
        ? vt.view().getUint32(session.out, true)
        : null

    const format = get('FORMAT')
    const ptr = get('DATA_PTR')
    const length = get('DATA_LEN')

    if (ptr === null || length === null) {
      return null
    }

    const source = vt.bytes().subarray(ptr, ptr + length)
    const { width, height } = descriptor

    const formatValue = (name: string) =>
      vt.value('GhosttyKittyImageFormat', name)

    const channels =
      format === formatValue('RGBA')
        ? 4
        : format === formatValue('RGB')
          ? 3
          : format === formatValue('GRAY_ALPHA')
            ? 2
            : format === formatValue('GRAY')
              ? 1
              : 0

    if (channels === 0 || length !== width * height * channels) {
      return null
    }

    if (channels === 4) {
      return { imageId, version, width, height, rgba: source.slice() }
    }

    const rgba = new Uint8Array(width * height * 4)

    for (let pixel = 0; pixel < width * height; pixel++) {
      const input = pixel * channels
      const gray = channels < 3
      rgba[pixel * 4] = source[input]!
      rgba[pixel * 4 + 1] = source[gray ? input : input + 1]!
      rgba[pixel * 4 + 2] = source[gray ? input : input + 2]!
      rgba[pixel * 4 + 3] = channels === 2 ? source[input + 1]! : 255
    }

    return { imageId, version, width, height, rgba }
  }

  private kittyImage(imageId: number): number {
    const terminal = this.session?.terminal

    const storage = terminal?.data('KITTY_GRAPHICS', (view, ptr) =>
      view.getUint32(ptr, true)
    )

    return storage
      ? terminal!.vt.call('ghostty_kitty_graphics_image', storage, imageId)
      : 0
  }

  private imageDescriptor(imageId: number): TerminalImageDescriptor | null {
    const session = this.session
    const image = this.kittyImage(imageId)

    if (!session || !image) {
      return null
    }

    const { vt } = session

    const get = (name: string) =>
      vt.call(
        'ghostty_kitty_graphics_image_get',
        image,
        vt.value('GhosttyKittyGraphicsImageData', name),
        session.out
      ) === 0

    if (!get('DATA_PTR') || !get('WIDTH')) {
      return null
    }

    const width = vt.view().getUint32(session.out, true)
    get('HEIGHT')
    const height = vt.view().getUint32(session.out, true)
    get('GENERATION')
    const version = Number(vt.view().getBigUint64(session.out, true))

    return { imageId, version, width, height }
  }

  getUnhandledSequences(): UnhandledSequence[] {
    return []
  }

  dispose(): void {
    this.session?.terminal.dispose()
    this.session = null
    this.owner = {}
  }
}

function readLayout(vt: GhosttyVt) {
  const value = (type: string, name: string) => vt.value(type, name)

  return {
    tag: vt.bits('GhosttyCell', 'content_tag'),
    content: vt.bits('GhosttyCell', 'content'),
    styleId: vt.bits('GhosttyCell', 'style_id'),
    wide: vt.bits('GhosttyCell', 'wide'),
    hyperlink: vt.bits('GhosttyCell', 'hyperlink'),
    codepoint: vt.armBits('GhosttyCell', 'content', 'CODEPOINT', 'codepoint'),
    bgPalette: vt.armBits(
      'GhosttyCell',
      'content',
      'BG_COLOR_PALETTE',
      'index'
    ),
    bgR: vt.armBits('GhosttyCell', 'content', 'BG_COLOR_RGB', 'r'),
    bgG: vt.armBits('GhosttyCell', 'content', 'BG_COLOR_RGB', 'g'),
    bgB: vt.armBits('GhosttyCell', 'content', 'BG_COLOR_RGB', 'b'),
    tagCodepoint: value('GhosttyCellContentTag', 'CODEPOINT'),
    tagGrapheme: value('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME'),
    tagBgPalette: value('GhosttyCellContentTag', 'BG_COLOR_PALETTE'),
    tagBgRgb: value('GhosttyCellContentTag', 'BG_COLOR_RGB'),
    wideNarrow: value('GhosttyCellWide', 'NARROW'),
    wideWide: value('GhosttyCellWide', 'WIDE'),
    wideSpacerTail: value('GhosttyCellWide', 'SPACER_TAIL'),
    wideSpacerHead: value('GhosttyCellWide', 'SPACER_HEAD'),
    colorPalette: value('GhosttyStyleColorTag', 'PALETTE'),
    colorRgb: value('GhosttyStyleColorTag', 'RGB'),
    colorValue: vt.offset('GhosttyStyleColor', 'value'),
    dirtyFalse: value('GhosttyRenderStateDirty', 'FALSE'),
    dirtyFull: value('GhosttyRenderStateDirty', 'FULL'),
    cursorBar: value('GhosttyRenderStateCursorVisualStyle', 'BAR'),
    cursorUnderline: value('GhosttyRenderStateCursorVisualStyle', 'UNDERLINE'),
    screenAlternate: value('GhosttyTerminalScreen', 'ALTERNATE')
  }
}

function linkUrls(rows: readonly DecodedRow[]): CellData[][] {
  const result = rows.map((row) => row.raw)
  let text = ''
  const positions: [number, number][] = []
  result.forEach((cells, row) =>
    cells.forEach((cell, col) => {
      if (cell.width === 0) {
        return
      }

      const chars = cell.chars ?? String.fromCodePoint(cell.char)
      text += chars

      for (let index = 0; index < chars.length; index++) {
        positions.push([row, col])
      }
    })
  )

  if (!text.includes('://')) {
    return result
  }

  const openStart = rows[0]!.metadata.continuesPrevious
  const openEnd = rows.at(-1)!.metadata.wrapsToNext

  for (const match of text.matchAll(URL_PATTERN)) {
    const first = match.index
    const last = first + match[0].length - 1
    const span = positions.slice(first, last + 1)

    if (
      (openStart && first === 0) ||
      (openEnd && last === text.length - 1) ||
      span.some(([row, col]) => result[row]![col]!.linkUri)
    ) {
      continue
    }

    for (const [row, col] of span) {
      if (result[row] === rows[row]!.raw) {
        result[row] = [...result[row]!]
      }

      result[row]![col] = {
        ...result[row]![col]!,
        linkUri: match[0],
        linkKey: match[0]
      }
    }
  }

  return result
}
