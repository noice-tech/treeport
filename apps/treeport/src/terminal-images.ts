import { ImageAddon } from '@xterm/addon-image'
import type { Terminal } from '@xterm/xterm'
import type {
  TerminalImageSnapshot,
  TerminalImagePlacement
} from '@treeport/shared'

const IMAGE_BYTES_LIMIT = 16 * 1024 * 1024
const IMAGE_COUNT_LIMIT = 256
const PLACEMENT_COUNT_LIMIT = 2_048
const PIXEL_LIMIT = 16_777_216
const DEFAULT_CELL_SIZE = { width: 7, height: 14 }

type Disposable = { dispose(): void }
type Bitmap = { width: number; height: number; close?: () => void }
type Image = {
  id: number
  data: Blob
  width: number
  height: number
  format: number
  compression: string
}
type Command = TerminalImagePlacement['command'] & {
  id?: number
  action?: string
  deleteSelector?: string
}
type CellSize = { width: number; height: number }
type Line = {
  getExtended(column: number): { payload?: { imageId: number; tileId: number } }
}
type Buffer = {
  x: number
  y: number
  ybase: number
  lines: { length: number; get(index: number): Line | undefined }
  addMarker(
    line: number
  ): Disposable & { onDispose(callback: () => void): Disposable }
}
type ImageSpec = {
  orig: Bitmap
  actual: Bitmap
  origCellSize: CellSize
  actualCellSize: CellSize
  marker:
    | (Disposable & { onDispose(callback: () => void): Disposable })
    | undefined
  tileCount: number
  bufferType: 'normal' | 'alternate'
  layer: 'top' | 'bottom'
  zIndex: number
}
interface Internals {
  _storage: {
    _images: Map<number, ImageSpec>
    _lastId: number
    _delImg(id: number): void
    _writeToCell(
      line: Line,
      column: number,
      imageId: number,
      tileId: number
    ): void
    addImage(
      image: Bitmap,
      options: {
        scrolling: boolean
        layer: string
        zIndex: number
        cursorPos: string
      }
    ): number
    deleteImage(id: number): void
    reset(): void
    onImageDeleted?: (id: number) => void
    onImageAdded?: () => void
  }
  _renderer: { cellSize: CellSize }
  _handlers: Map<
    string,
    {
      _kittyStorage: {
        _images: Map<number, Image>
        _nextImageId: number
        storeImage(id: number | undefined, image: Omit<Image, 'id'>): number
        addImage(
          id: number,
          image: Bitmap,
          scrolling: boolean,
          layer: 'top' | 'bottom',
          zIndex: number
        ): void
        reset(): void
      }
      _renderer: { dimensions: { css: { cell: CellSize } } | undefined }
      _displayImage(image: Image, command: Command): Promise<boolean>
      _decodeAndDisplay(image: Image, command: Command): Promise<void>
      _handleDelete(command: Command): boolean
      _cleanupAllPending(): void
      _activeDecoder: { release(): void } | null
      _parsedCommand: { id?: number } | null
      _lastPendingKey: number | undefined
      pendingTransmissions: Map<
        number,
        { decoder: { release(): void }; totalEncodedSize: number }
      >
      start(): void
      put(data: Uint32Array, start: number, end: number): void
      end(success: boolean): boolean | Promise<boolean>
    }
  >
}
interface TerminalInternals {
  _core: {
    buffer: Buffer
    _bufferService: { buffers: { normal: Buffer; alt: Buffer } }
    _inputHandler: {
      lineFeed(): boolean
      _parser: { currentState: number }
    }
  }
}

/**
 * The pinned image addon couples upload lifetime to canvas placements and has
 * no snapshot API. Keep those lifetimes separate, and use its same cell/tile
 * storage in the host (without decoding pixels) and browser. All private xterm
 * access lives here and is exercised against the real addon in regression tests.
 */
export class TerminalImages {
  private readonly addon: ImageAddon
  private terminal: Terminal | null = null
  private readonly placements = new Map<
    number,
    { imageId: number; command: Command }
  >()
  private readonly pending = new Map<number, string>()
  private current = ''
  private capturing = false
  private restoring: TerminalImagePlacement | null = null
  private activeCommand: Command = {}
  private cellSize = { ...DEFAULT_CELL_SIZE }

  constructor(private readonly headless = false) {
    this.addon = new ImageAddon({
      iipSupport: false,
      kittySupport: true,
      sixelSupport: false,
      enableSizeReports: !headless,
      storageLimit: 64,
      kittySizeLimit: IMAGE_BYTES_LIMIT,
      pixelLimit: PIXEL_LIMIT
    })
  }

  setCellSize(size: CellSize): void {
    this.cellSize = size
  }

  activate(terminal: Terminal): void {
    this.terminal = terminal
    // SAFETY: The headless xterm shares the parser and buffer API, but has no
    // render event or pixel dimensions. Never install browser globals in Node.
    const target = this.headless
      ? new Proxy(terminal, {
          get: (value, key) => {
            if (key === 'onRender') {
              return () => ({ dispose() {} })
            }

            if (key === 'dimensions') {
              return { css: { cell: this.cellSize } }
            }

            // eslint-disable-next-line anti-slop/no-reflect-get -- This proxy must forward xterm's private string and symbol members unchanged.
            return Reflect.get(value, key)
          }
        })
      : terminal
    this.addon.activate(target)
    // SAFETY: These are the pinned addon/xterm internals documented above.
    const { _storage: storage, _handlers: handlers } = Object(
      this.addon
    ) as Internals
    // SAFETY: Browser and headless xterm expose the same pinned core buffers.
    const core = (Object(terminal) as TerminalInternals)._core
    const handler = handlers.get('kitty')!
    const uploads = handler._kittyStorage

    // Canvas eviction, erasure, scrolling and buffer switches remove placements,
    // not transmitted images. Pi legitimately reuses those uploads with a=p.
    storage.onImageDeleted = (id) => this.placements.delete(id)
    storage._delImg = (id) => {
      const spec = storage._images.get(id)
      if (!spec) {
        return
      }

      storage._images.delete(id)
      spec.orig.close?.()
      if (spec.actual !== spec.orig) {
        spec.actual.close?.()
      }

      storage.onImageDeleted?.(id)
    }
    const resetStorage = storage.reset.bind(storage)
    storage.reset = () => {
      // Alternate-buffer images have no eviction markers to close bitmaps.
      for (const id of storage._images.keys()) {
        storage.deleteImage(id)
      }
      resetStorage()
    }
    const resetUploads = uploads.reset.bind(uploads)
    uploads.reset = () => {
      for (const id of storage._images.keys()) {
        storage.deleteImage(id)
      }
      this.placements.clear()
      this.pending.clear()
      this.current = ''
      this.capturing = false
      resetUploads()
    }
    const storeImage = uploads.storeImage.bind(uploads)
    uploads.storeImage = (id, image) => {
      if (id !== undefined) {
        for (const [storageId, placement] of this.placements) {
          if (placement.imageId === id) {
            storage.deleteImage(storageId)
          }
        }
        uploads._images.delete(id)
      }

      let bytes = image.data.size
      for (const stored of uploads._images.values()) {
        bytes += stored.data.size
      }
      for (const [oldId, stored] of uploads._images) {
        if (
          bytes <= IMAGE_BYTES_LIMIT &&
          uploads._images.size < IMAGE_COUNT_LIMIT
        ) {
          break
        }

        bytes -= stored.data.size
        uploads._images.delete(oldId)
        for (const [storageId, placement] of this.placements) {
          if (placement.imageId === oldId) {
            storage.deleteImage(storageId)
          }
        }
      }
      return storeImage(id, image)
    }
    const displayImage = handler._displayImage.bind(handler)
    handler._displayImage = async (image, command) => {
      this.activeCommand = Object.fromEntries(
        (
          [
            'columns',
            'rows',
            'x',
            'y',
            'sourceWidth',
            'sourceHeight',
            'xOffset',
            'yOffset',
            'zIndex',
            'cursorMovement',
            'placementId'
          ] as const
        ).flatMap((key) =>
          command[key] === undefined ? [] : [[key, command[key]]]
        )
      )
      return displayImage(image, command)
    }
    uploads.addImage = (imageId, image, scrolling, layer, zIndex) => {
      if (!this.terminal) {
        image.close?.()
        return
      }

      if (this.activeCommand.placementId !== undefined) {
        for (const [id, placement] of this.placements) {
          if (
            placement.imageId === imageId &&
            placement.command.placementId === this.activeCommand.placementId
          ) {
            storage.deleteImage(id)
          }
        }
      }

      while (this.placements.size >= PLACEMENT_COUNT_LIMIT) {
        storage.deleteImage(this.placements.keys().next().value!)
      }
      const restore = this.restoring
      let id: number
      if (restore) {
        id = ++storage._lastId
        const buffer =
          core._bufferService.buffers[
            restore.buffer === 'normal' ? 'normal' : 'alt'
          ]
        const cellSize = restore.cellSize
        const lastLine = restore.tiles.at(-1)?.[0]
        const marker =
          restore.buffer === 'normal' && lastLine !== undefined
            ? buffer.addMarker(lastLine)
            : undefined
        marker?.onDispose(() => storage._delImg(id))
        const spec: ImageSpec = {
          orig: image,
          actual: image,
          origCellSize: cellSize,
          actualCellSize: { ...cellSize },
          marker,
          tileCount: 0,
          bufferType: restore.buffer,
          layer,
          zIndex
        }
        storage._images.set(id, spec)
        for (const [row, column, tile, count] of restore.tiles) {
          const line = buffer.lines.get(row)
          if (!line) {
            continue
          }

          for (
            let offset = 0;
            offset < count && column + offset < terminal.cols;
            offset++
          ) {
            storage._writeToCell(line, column + offset, id, tile + offset)
            spec.tileCount++
          }
        }
        storage.onImageAdded?.()
      } else {
        id = storage.addImage(image, {
          scrolling,
          layer,
          zIndex,
          cursorPos: 'iip'
        })
      }

      this.placements.set(id, { imageId, command: { ...this.activeCommand } })
    }
    handler._handleDelete = (command) => {
      const selector = command.deleteSelector ?? 'a'
      const byId = selector === 'i' || selector === 'I'
      if (!byId && selector !== 'a' && selector !== 'A') {
        return true
      }

      const freeData = selector === selector.toUpperCase()
      const imageIds = new Set<number>()
      const deleted = new Set<number>()
      const deletedBuffers = new Set<'normal' | 'alternate'>()
      const visible = new Set<number>()
      if (!byId) {
        for (
          let row = core.buffer.ybase;
          row < core.buffer.ybase + terminal.rows;
          row++
        ) {
          const line = core.buffer.lines.get(row)
          if (!line) {
            continue
          }

          for (let column = 0; column < terminal.cols; column++) {
            const tile = line.getExtended(column).payload
            if (tile) {
              visible.add(tile.imageId)
            }
          }
        }
      }

      if (byId && command.id !== undefined) {
        imageIds.add(command.id)
      }

      for (const [id, placement] of this.placements) {
        if (!byId && !visible.has(id)) {
          continue
        }

        if (byId && placement.imageId !== command.id) {
          continue
        }

        if (
          byId &&
          command.placementId !== undefined &&
          placement.command.placementId !== command.placementId
        ) {
          continue
        }

        imageIds.add(placement.imageId)
        deleted.add(id)
        deletedBuffers.add(storage._images.get(id)!.bufferType)
      }
      if (deleted.size) {
        for (const [name, buffer] of [
          ['normal', core._bufferService.buffers.normal],
          ['alternate', core._bufferService.buffers.alt]
        ] as const) {
          if (!deletedBuffers.has(name)) {
            continue
          }

          for (let row = 0; row < buffer.lines.length; row++) {
            const line = buffer.lines.get(row)!
            for (let column = 0; column < terminal.cols; column++) {
              const tile = line.getExtended(column).payload
              if (tile && deleted.has(tile.imageId)) {
                tile.imageId = -1
                tile.tileId = -1
              }
            }
          }
        }
        for (const id of deleted) {
          storage.deleteImage(id)
        }
        if (!this.headless) {
          terminal.refresh(0, terminal.rows - 1)
        }
      }

      if (freeData) {
        // A deleted placement must not invalidate another placement's upload.
        const remaining = new Set(
          [...this.placements.values()].map((placement) => placement.imageId)
        )
        if (!byId) {
          for (const id of uploads._images.keys()) {
            if (!remaining.has(id)) {
              uploads._images.delete(id)
            }
          }
          handler._cleanupAllPending()
          this.pending.clear()
        } else {
          for (const id of imageIds) {
            if (remaining.has(id)) {
              continue
            }

            uploads._images.delete(id)
            handler.pendingTransmissions.get(id)?.decoder.release()
            handler.pendingTransmissions.delete(id)
            this.pending.delete(id)
            if (handler._lastPendingKey === id) {
              handler._lastPendingKey = undefined
            }
          }
        }
      }

      return true
    }

    // Retain unfinished uploads as protocol fragments, not arbitrary terminal
    // history. A reconnect can happen between Kitty chunks or within one APC.
    const start = handler.start.bind(handler)
    const put = handler.put.bind(handler)
    const end = handler.end.bind(handler)
    handler.start = () => {
      start()
      this.current = '\x1b_G'
      this.capturing = true
    }
    handler.put = (data, start, end) => {
      if (this.capturing) {
        for (let offset = start; offset < end; offset += 4096) {
          this.current += String.fromCodePoint(
            ...data.subarray(offset, Math.min(end, offset + 4096))
          )
        }
        let bytes = this.current.length
        for (const value of this.pending.values()) {
          bytes += value.length
        }
        if (bytes > (IMAGE_BYTES_LIMIT * 4) / 3 + 4096 * IMAGE_COUNT_LIMIT) {
          this.current = ''
          this.capturing = false
          this.pending.clear()
          const decoder = handler._activeDecoder
          handler._activeDecoder = null
          // A chunk continuation can share its decoder with the pending map.
          if (
            decoder &&
            ![...handler.pendingTransmissions.values()].some(
              (pending) => pending.decoder === decoder
            )
          ) {
            decoder.release()
          }

          handler._cleanupAllPending()
        }
      }

      if (this.capturing) {
        put(data, start, end)
      }
    }
    handler.end = (success) => {
      const key = handler._parsedCommand?.id ?? handler._lastPendingKey ?? 0
      const wire = this.current + '\x1b\\'
      const captured = this.capturing
      const previousSize =
        handler.pendingTransmissions.get(key)?.totalEncodedSize
      const result = end(success && captured)
      const nextSize = handler.pendingTransmissions.get(key)?.totalEncodedSize
      if (captured && success && nextSize !== undefined) {
        // A query or placement/delete command can arrive between chunks. It
        // must not become part of the unfinished upload replay.
        if (nextSize !== previousSize) {
          const previous = this.pending.get(key) ?? ''
          this.pending.delete(key)
          this.pending.set(key, previous + wire)
        }
      } else {
        this.pending.delete(key)
        if (!success) {
          handler.pendingTransmissions.get(key)?.decoder.release()
          handler.pendingTransmissions.delete(key)
          if (handler._lastPendingKey === key) {
            handler._lastPendingKey = undefined
          }
        }
      }

      this.current = ''
      this.capturing = false
      return result
    }

    if (this.headless) {
      // Only dimensions are needed for canonical image tiles. Payloads stay
      // opaque until the browser decodes them; the host never opens image paths.
      handler._decodeAndDisplay = async (image, command) => {
        let width = image.width
        let height = image.height
        if (image.format === 100) {
          let headerBytes = await image.data.slice(0, 24).arrayBuffer()
          if (image.compression === 'z') {
            const reader = image.data
              .stream()
              .pipeThrough(new DecompressionStream('deflate'))
              .getReader()
            const bytes = new Uint8Array(24)
            let length = 0
            while (length < bytes.length) {
              const chunk = await reader.read()
              if (chunk.done) {
                break
              }

              const take = Math.min(chunk.value.length, bytes.length - length)
              bytes.set(chunk.value.subarray(0, take), length)
              length += take
            }
            await reader.cancel()
            headerBytes = bytes.buffer.slice(0, length)
          }

          const header = new DataView(headerBytes)
          if (
            header.byteLength < 24 ||
            header.getUint32(0) !== 0x89504e47 ||
            header.getUint32(4) !== 0x0d0a1a0a
          ) {
            throw new Error('Invalid PNG')
          }

          width = header.getUint32(16)
          height = header.getUint32(20)
        }

        const x = Math.max(0, command.x ?? 0)
        const y = Math.max(0, command.y ?? 0)
        width = Math.min(
          command.sourceWidth || width - x,
          Math.max(0, width - x)
        )
        height = Math.min(
          command.sourceHeight || height - y,
          Math.max(0, height - y)
        )
        if (width <= 0 || height <= 0) {
          throw new Error('Invalid image dimensions')
        }

        const cell = this.restoring?.cellSize ?? this.cellSize
        const columns =
          command.columns ??
          (command.rows === undefined
            ? Math.ceil(width / cell.width)
            : Math.max(
                1,
                Math.ceil(
                  ((width / height) * command.rows * cell.height) / cell.width
                )
              ))
        const rows =
          command.rows ??
          (command.columns === undefined
            ? Math.ceil(height / cell.height)
            : Math.max(
                1,
                Math.ceil(
                  ((height / width) * columns * cell.width) / cell.height
                )
              ))
        if (command.columns !== undefined || command.rows !== undefined) {
          width = Math.round(columns * cell.width)
          height = Math.round(rows * cell.height)
        }

        if (command.columns === undefined) {
          width += Math.min(Math.max(0, command.xOffset ?? 0), cell.width - 1)
        }

        if (command.rows === undefined) {
          height += Math.min(Math.max(0, command.yOffset ?? 0), cell.height - 1)
        }

        // The browser's offset canvas uses integer pixel dimensions.
        width = Math.floor(width)
        height = Math.floor(height)
        if (
          !Number.isFinite(width * height) ||
          width <= 0 ||
          height <= 0 ||
          width * height > PIXEL_LIMIT
        ) {
          throw new Error('Invalid image size')
        }

        const buffer = core.buffer
        const saved = { x: buffer.x, y: buffer.y, ybase: buffer.ybase }
        uploads.addImage(
          image.id,
          { width, height },
          true,
          (command.zIndex ?? 0) < 0 ? 'bottom' : 'top',
          command.zIndex ?? 0
        )
        if (command.cursorMovement === 1) {
          buffer.x = saved.x
          buffer.y = Math.max(0, saved.y - (buffer.ybase - saved.ybase))
        } else {
          buffer.x = Math.min(saved.x + columns, terminal.cols)
        }
      }
    }
  }

  async snapshot(): Promise<TerminalImageSnapshot> {
    // SAFETY: See the pinned addon boundary above.
    const { _storage: storage, _handlers: handlers } = Object(
      this.addon
    ) as Internals
    // SAFETY: snapshot is called only on an activated, live terminal.
    const core = (Object(this.terminal) as TerminalInternals)._core
    const placements = new Map<number, TerminalImagePlacement>()
    for (const [name, buffer] of [
      ['normal', core._bufferService.buffers.normal],
      ['alternate', core._bufferService.buffers.alt]
    ] as const) {
      if (
        ![...storage._images.values()].some((spec) => spec.bufferType === name)
      ) {
        continue
      }

      for (let row = 0; row < buffer.lines.length; row++) {
        const line = buffer.lines.get(row)!
        for (let column = 0; column < this.terminal!.cols; column++) {
          const tile = line.getExtended(column).payload
          if (!tile || !storage._images.has(tile.imageId)) {
            continue
          }

          const source = this.placements.get(tile.imageId)
          if (!source) {
            continue
          }

          let placement = placements.get(tile.imageId)
          if (!placement) {
            placement = {
              imageId: source.imageId,
              command: source.command,
              cellSize: { ...storage._images.get(tile.imageId)!.origCellSize },
              buffer: name,
              tiles: []
            }
            placements.set(tile.imageId, placement)
          }

          const previous = placement.tiles.at(-1)
          if (
            previous &&
            previous[0] === row &&
            previous[1] + previous[3] === column &&
            previous[2] + previous[3] === tile.tileId
          ) {
            previous[3]++
          } else {
            placement.tiles.push([row, column, tile.tileId, 1])
          }
        }
      }
    }
    const uploads = handlers.get('kitty')!._kittyStorage
    const nextImageId = uploads._nextImageId
    // Freeze every part at the same parser fence, before awaiting blob reads.
    const parserState = core._inputHandler._parser.currentState
    const suffix = this.capturing
      ? this.current
      : parserState === 14
        ? '\x1b_'
        : parserState === 1
          ? '\x1b'
          : ''
    const pending = [...this.pending.values()].join('') + suffix
    const images = await Promise.all(
      [...uploads._images.values()].map(async (image) => {
        const bytes = new Uint8Array(await image.data.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 8192)
          )
        }
        return { ...image, data: btoa(binary) }
      })
    )
    return {
      images,
      placements: [...placements.values()],
      pending,
      nextImageId
    }
  }

  async restore(snapshot: TerminalImageSnapshot): Promise<void> {
    // SAFETY: See the pinned addon boundary above.
    const { _handlers: handlers } = Object(this.addon) as Internals
    const handler = handlers.get('kitty')!
    const uploads = handler._kittyStorage
    // SAFETY: restore is called only after the terminal's text snapshot parsed.
    const core = (Object(this.terminal) as TerminalInternals)._core
    for (const image of snapshot.images) {
      const bytes = Uint8Array.from(atob(image.data), (char) =>
        char.charCodeAt(0)
      )
      uploads.storeImage(image.id, { ...image, data: new Blob([bytes]) })
    }
    uploads._nextImageId = snapshot.nextImageId
    for (const placement of snapshot.placements) {
      const image = uploads._images.get(placement.imageId)
      if (!image) {
        continue
      }

      const buffer = core.buffer
      const saved = { x: buffer.x, y: buffer.y }
      this.restoring = placement
      // Decode at the original placement's cell size. ImageStorage rescales it
      // to this viewer's font; re-rounding at the viewer size changes tile IDs.
      const renderer = handler._renderer
      handler._renderer = { dimensions: { css: { cell: placement.cellSize } } }
      await handler._displayImage(image, placement.command)
      handler._renderer = renderer
      this.restoring = null
      if (!this.terminal) {
        return
      }

      buffer.x = saved.x
      buffer.y = saved.y
    }
    if (!this.headless) {
      this.terminal?.refresh(0, this.terminal.rows - 1)
    }
  }

  dispose(): void {
    this.addon.dispose()
    this.placements.clear()
    this.pending.clear()
    this.current = ''
    this.terminal = null
  }
}
