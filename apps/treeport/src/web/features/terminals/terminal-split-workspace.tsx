import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import { Columns2Icon, Grid2X2Icon, Rows2Icon, SquareIcon } from 'lucide-react'
import { z } from 'zod'
import type {
  TerminalRecord,
  TerminalWorkspaceLayout,
  TerminalWorkspaceLayoutMode,
  WorktreeRecord
} from '@treeport/shared'
import { parseResponse, rpc } from '../../api'
import { Button } from '../../components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../../components/ui/popover'
import { cn } from '../../lib/utils'
import { TerminalView } from '../../terminal-view'
import {
  terminalLayoutDrag,
  type TerminalLayoutDragSnapshot
} from './terminal-layout-drag'

export type TerminalLayoutMode = TerminalWorkspaceLayoutMode

interface TerminalLayoutState {
  mode: TerminalLayoutMode
  terminalIds: Array<string | null>
  activePane: number
  columnRatio: number
  rowRatio: number
}

type TerminalDropTarget =
  | {
      kind: 'split'
      mode: 'columns' | 'rows'
      before: boolean
    }
  | {
      kind: 'pane'
      pane: number
    }

const LAYOUT_STORAGE_PREFIX = 'treeport-terminal-layout-v2:'
const DEFAULT_RATIO = 50
const MIN_RATIO = 20
const MAX_RATIO = 80
const storedLayoutSchema = z.object({
  mode: z.enum(['single', 'columns', 'rows', 'grid']).optional(),
  terminalIds: z.array(z.string().nullable()).optional(),
  activePane: z.number().int().optional(),
  columnRatio: z.number().optional(),
  rowRatio: z.number().optional()
})

function paneCount(mode: TerminalLayoutMode): number {
  if (mode === 'single') {
    return 1
  }

  return mode === 'grid' ? 4 : 2
}

function clampRatio(value: number): number {
  return Math.round(Math.min(MAX_RATIO, Math.max(MIN_RATIO, value)))
}

function persistedLayout(layout: TerminalLayoutState): TerminalWorkspaceLayout {
  return {
    mode: layout.mode,
    terminalIds: layout.terminalIds,
    columnRatio: clampRatio(layout.columnRatio),
    rowRatio: clampRatio(layout.rowRatio)
  }
}

function normalizeTerminalIds(
  terminalIds: ReadonlyArray<string | null>,
  count: number,
  availableIds: ReadonlySet<string>
): Array<string | null> {
  const seen = new Set<string>()
  return Array.from({ length: count }, (_, index) => {
    const terminalId = terminalIds[index]
    if (!terminalId || !availableIds.has(terminalId) || seen.has(terminalId)) {
      return null
    }

    seen.add(terminalId)
    return terminalId
  })
}

function initialLayout(
  worktree: WorktreeRecord,
  selectedTerminalId: string
): TerminalLayoutState {
  const fallback: TerminalLayoutState = {
    mode: 'single',
    terminalIds: [selectedTerminalId],
    activePane: 0,
    columnRatio: DEFAULT_RATIO,
    rowRatio: DEFAULT_RATIO
  }
  const stored = localStorage.getItem(`${LAYOUT_STORAGE_PREFIX}${worktree.id}`)

  try {
    const result = stored
      ? storedLayoutSchema.safeParse(JSON.parse(stored))
      : null
    const parsed =
      worktree.terminalLayout ?? (result?.success ? result.data : null)
    if (!parsed) {
      return fallback
    }

    const mode = parsed.mode ?? 'single'
    const count = paneCount(mode)
    const availableIds = new Set(
      worktree.terminals.map((terminal) => terminal.id)
    )
    const terminalIds = normalizeTerminalIds(
      parsed.terminalIds ?? [],
      count,
      availableIds
    )
    const selectedPane = terminalIds.indexOf(selectedTerminalId)
    const requestedActive = worktree.terminalLayout
      ? 0
      : result?.success
        ? (result.data.activePane ?? 0)
        : 0
    const activePane =
      selectedPane >= 0
        ? selectedPane
        : Math.min(count - 1, Math.max(0, requestedActive))
    if (selectedPane < 0) {
      terminalIds[activePane] = selectedTerminalId
    }

    return {
      mode,
      terminalIds,
      activePane,
      columnRatio: clampRatio(parsed.columnRatio ?? DEFAULT_RATIO),
      rowRatio: clampRatio(parsed.rowRatio ?? DEFAULT_RATIO)
    }
  } catch {
    return fallback
  }
}

function CrossResizeHandle({
  columnRatio,
  rowRatio,
  onRatioChange
}: {
  columnRatio: number
  rowRatio: number
  onRatioChange: (columnRatio: number, rowRatio: number) => void
}) {
  const boundsRef = useRef<DOMRect | null>(null)
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = boundsRef.current
    if (!bounds) {
      return
    }

    onRatioChange(
      clampRatio(((event.clientX - bounds.left) / bounds.width) * 100),
      clampRatio(((event.clientY - bounds.top) / bounds.height) * 100)
    )
  }
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    boundsRef.current =
      event.currentTarget.closest('main')?.getBoundingClientRect() ?? null
    event.currentTarget.setPointerCapture(event.pointerId)
    updateFromPointer(event)
  }
  const stopResize = (event: PointerEvent<HTMLDivElement>) => {
    boundsRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 5 : 2
    let nextColumnRatio = columnRatio
    let nextRowRatio = rowRatio
    if (event.key === 'ArrowLeft') {
      nextColumnRatio -= step
    } else if (event.key === 'ArrowRight') {
      nextColumnRatio += step
    } else if (event.key === 'ArrowUp') {
      nextRowRatio -= step
    } else if (event.key === 'ArrowDown') {
      nextRowRatio += step
    } else if (event.key === 'Home') {
      nextColumnRatio = DEFAULT_RATIO
      nextRowRatio = DEFAULT_RATIO
    } else {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    onRatioChange(clampRatio(nextColumnRatio), clampRatio(nextRowRatio))
  }

  return (
    <div
      className="absolute z-40 size-6 -translate-1/2 cursor-move touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      style={{ left: `${columnRatio}%`, top: `${rowRatio}%` }}
      role="button"
      aria-label="Resize all four terminal panes"
      aria-description="Drag in any direction, or use the arrow keys. Press Home to reset."
      aria-valuetext={`${Math.round(columnRatio)} percent across, ${Math.round(rowRatio)} percent down`}
      tabIndex={0}
      onPointerDown={startResize}
      onPointerMove={(event) => boundsRef.current && updateFromPointer(event)}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => onRatioChange(DEFAULT_RATIO, DEFAULT_RATIO)}
    />
  )
}

function ResizeRail({
  orientation,
  ratio,
  onRatioChange
}: {
  orientation: 'horizontal' | 'vertical'
  ratio: number
  onRatioChange: (ratio: number) => void
}) {
  const boundsRef = useRef<DOMRect | null>(null)
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = boundsRef.current
    if (!bounds) {
      return
    }

    const next =
      orientation === 'vertical'
        ? ((event.clientX - bounds.left) / bounds.width) * 100
        : ((event.clientY - bounds.top) / bounds.height) * 100
    onRatioChange(clampRatio(next))
  }
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    boundsRef.current =
      event.currentTarget.closest('main')?.getBoundingClientRect() ?? null
    event.currentTarget.setPointerCapture(event.pointerId)
    updateFromPointer(event)
  }
  const stopResize = (event: PointerEvent<HTMLDivElement>) => {
    boundsRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const decrement =
      orientation === 'vertical'
        ? event.key === 'ArrowLeft'
        : event.key === 'ArrowUp'
    const increment =
      orientation === 'vertical'
        ? event.key === 'ArrowRight'
        : event.key === 'ArrowDown'
    let next = ratio
    if (decrement) {
      next -= event.shiftKey ? 5 : 2
    } else if (increment) {
      next += event.shiftKey ? 5 : 2
    } else if (event.key === 'Home') {
      next = MIN_RATIO
    } else if (event.key === 'End') {
      next = MAX_RATIO
    } else {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    onRatioChange(clampRatio(next))
  }

  return (
    <div
      className={cn(
        'group/split absolute z-30 touch-none outline-none',
        orientation === 'vertical'
          ? 'inset-y-0 w-3 -translate-x-1/2 cursor-col-resize'
          : 'inset-x-0 h-3 -translate-y-1/2 cursor-row-resize'
      )}
      style={
        orientation === 'vertical'
          ? { left: `${ratio}%` }
          : { top: `${ratio}%` }
      }
      role="separator"
      aria-label={`Resize terminal ${orientation === 'vertical' ? 'columns' : 'rows'}`}
      aria-orientation={orientation}
      aria-valuemin={MIN_RATIO}
      aria-valuemax={MAX_RATIO}
      aria-valuenow={Math.round(ratio)}
      tabIndex={0}
      onPointerDown={startResize}
      onPointerMove={(event) => boundsRef.current && updateFromPointer(event)}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => onRatioChange(DEFAULT_RATIO)}
    >
      <span
        className={cn(
          'absolute bg-white/10 group-hover/split:bg-cyan-400/70 group-focus-visible/split:bg-cyan-400/70',
          orientation === 'vertical'
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover/split:w-0.5 group-focus-visible/split:w-0.5'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2 group-hover/split:h-0.5 group-focus-visible/split:h-0.5'
        )}
      />
    </div>
  )
}

export function TerminalSplitWorkspace({
  worktree,
  selectedTerminal,
  loading,
  autoFocusBlocked,
  onSelectTerminal,
  onStatusChange
}: {
  worktree: WorktreeRecord
  selectedTerminal: TerminalRecord
  loading: boolean
  autoFocusBlocked: boolean
  onSelectTerminal: (terminal: TerminalRecord) => void
  onStatusChange: () => void
}) {
  const workspaceRef = useRef<HTMLElement>(null)
  const submittedLayoutSignatures = useRef(new Set<string>())
  const lastRemoteLayoutSignature = useRef<string | null>(null)
  const [storedLayout, setLayout] = useState(() =>
    initialLayout(worktree, selectedTerminal.id)
  )
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)
  const availableIds = new Set(
    worktree.terminals.map((terminal) => terminal.id)
  )
  const terminalsById = new Map(
    worktree.terminals.map((terminal) => [terminal.id, terminal])
  )
  const terminalIdSignature = worktree.terminals
    .map((terminal) => terminal.id)
    .join('\u0000')
  const terminalIds = normalizeTerminalIds(
    storedLayout.terminalIds,
    paneCount(storedLayout.mode),
    availableIds
  )
  const selectedPane = terminalIds.indexOf(selectedTerminal.id)
  const activePane =
    selectedPane >= 0
      ? selectedPane
      : Math.min(storedLayout.activePane, terminalIds.length - 1)
  if (selectedPane < 0) {
    terminalIds[activePane] = selectedTerminal.id
  }

  const layout = { ...storedLayout, terminalIds, activePane }
  const serializedLayout = JSON.stringify(persistedLayout(layout))
  const remoteLayoutSignature = JSON.stringify(worktree.terminalLayout)
  const dragSnapshot = useSyncExternalStore(
    terminalLayoutDrag.subscribe,
    terminalLayoutDrag.getSnapshot,
    terminalLayoutDrag.getSnapshot
  )
  const activeDrag =
    dragSnapshot?.terminal.worktreeId === worktree.id &&
    !(
      layout.mode === 'single' &&
      dragSnapshot.terminal.id === layout.terminalIds[0]
    )
      ? dragSnapshot
      : null
  const dropTargetAt = useCallback(
    (snapshot: TerminalLayoutDragSnapshot): TerminalDropTarget | null => {
      const bounds = workspaceRef.current?.getBoundingClientRect()
      if (
        !bounds ||
        snapshot.terminal.worktreeId !== worktree.id ||
        snapshot.clientX < bounds.left ||
        snapshot.clientX > bounds.right ||
        snapshot.clientY < bounds.top ||
        snapshot.clientY > bounds.bottom
      ) {
        return null
      }

      const horizontalPosition = (snapshot.clientX - bounds.left) / bounds.width
      const verticalPosition = (snapshot.clientY - bounds.top) / bounds.height
      if (layout.mode === 'single') {
        const horizontalDistance = Math.abs(horizontalPosition - 0.5)
        const verticalDistance = Math.abs(verticalPosition - 0.5)
        return horizontalDistance >= verticalDistance
          ? {
              kind: 'split',
              mode: 'columns',
              before: horizontalPosition < 0.5
            }
          : {
              kind: 'split',
              mode: 'rows',
              before: verticalPosition < 0.5
            }
      }

      const column =
        layout.mode === 'rows' || horizontalPosition < layout.columnRatio / 100
          ? 0
          : 1
      const row =
        layout.mode === 'columns' || verticalPosition < layout.rowRatio / 100
          ? 0
          : 1
      return {
        kind: 'pane',
        pane: layout.mode === 'grid' ? row * 2 + column : column + row
      }
    },
    [layout.columnRatio, layout.mode, layout.rowRatio, worktree.id]
  )
  const dropTarget = activeDrag ? dropTargetAt(activeDrag) : null
  useEffect(() => {
    setLayout((current) => {
      const currentIds = normalizeTerminalIds(
        current.terminalIds,
        paneCount(current.mode),
        availableIds
      )
      const currentSelectedPane = currentIds.indexOf(selectedTerminal.id)
      const currentActivePane =
        currentSelectedPane >= 0
          ? currentSelectedPane
          : Math.min(current.activePane, currentIds.length - 1)
      if (currentSelectedPane < 0) {
        currentIds[currentActivePane] = selectedTerminal.id
      }

      return current.activePane === currentActivePane &&
        current.terminalIds.every(
          (terminalId, index) => terminalId === currentIds[index]
        )
        ? current
        : {
            ...current,
            terminalIds: currentIds,
            activePane: currentActivePane
          }
    })
  }, [selectedTerminal.id, terminalIdSignature])

  useEffect(() => {
    if (lastRemoteLayoutSignature.current === remoteLayoutSignature) {
      return
    }

    lastRemoteLayoutSignature.current = remoteLayoutSignature
    const remoteLayout = worktree.terminalLayout
    if (submittedLayoutSignatures.current.delete(remoteLayoutSignature)) {
      return
    }

    if (!remoteLayout) {
      return
    }

    const nextActivePane = Math.min(
      storedLayout.activePane,
      remoteLayout.terminalIds.length - 1
    )
    const nextActiveTerminalId =
      remoteLayout.terminalIds[nextActivePane] ??
      remoteLayout.terminalIds.find(
        (terminalId): terminalId is string => terminalId !== null
      ) ??
      null
    const nextActiveTerminal = nextActiveTerminalId
      ? terminalsById.get(nextActiveTerminalId)
      : null
    setLayout((current) => ({
      ...remoteLayout,
      activePane: Math.min(
        current.activePane,
        remoteLayout.terminalIds.length - 1
      )
    }))
    if (nextActiveTerminal && nextActiveTerminal.id !== selectedTerminal.id) {
      onSelectTerminal(nextActiveTerminal)
    }
  }, [remoteLayoutSignature, terminalIdSignature])

  useEffect(() => {
    if (serializedLayout === remoteLayoutSignature) {
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      submittedLayoutSignatures.current.add(serializedLayout)
      if (submittedLayoutSignatures.current.size > 20) {
        const oldest = submittedLayoutSignatures.current.values().next().value
        if (oldest) {
          submittedLayoutSignatures.current.delete(oldest)
        }
      }

      void parseResponse(
        rpc.api.worktrees[':worktreeId']['terminal-layout'].$put(
          {
            param: { worktreeId: worktree.id },
            json: persistedLayout(layout)
          },
          { init: { signal: controller.signal } }
        )
      )
        .then(() => {
          localStorage.removeItem(`${LAYOUT_STORAGE_PREFIX}${worktree.id}`)
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            submittedLayoutSignatures.current.delete(serializedLayout)
            console.error('[Treeport] Could not save terminal layout')
          }
        })
    }, 150)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [remoteLayoutSignature, serializedLayout, worktree.id])

  const changeMode = (mode: TerminalLayoutMode) => {
    setLayoutMenuOpen(false)
    setLayout((current) => {
      const count = paneCount(mode)
      const orderedIds = [
        selectedTerminal.id,
        ...current.terminalIds.filter(
          (terminalId): terminalId is string =>
            terminalId !== null && terminalId !== selectedTerminal.id
        )
      ]
      const uniqueIds = [...new Set(orderedIds)].slice(0, count)
      return {
        ...current,
        mode,
        terminalIds: Array.from(
          { length: count },
          (_, index) => uniqueIds[index] ?? null
        ),
        activePane: 0
      }
    })
  }

  useEffect(
    () =>
      terminalLayoutDrag.registerDropHandler((snapshot) => {
        const target = dropTargetAt(snapshot)
        if (!target) {
          return false
        }

        if (target.kind === 'split') {
          const currentTerminalId = layout.terminalIds[0] ?? null
          if (currentTerminalId === snapshot.terminal.id) {
            return true
          }

          setLayout((current) => ({
            ...current,
            mode: target.mode,
            terminalIds: target.before
              ? [snapshot.terminal.id, currentTerminalId]
              : [currentTerminalId, snapshot.terminal.id],
            activePane: target.before ? 0 : 1
          }))
          onSelectTerminal(snapshot.terminal)
          return true
        }

        const sourcePane = layout.terminalIds.indexOf(snapshot.terminal.id)
        if (sourcePane === target.pane) {
          onSelectTerminal(snapshot.terminal)
          return true
        }

        setLayout((current) => {
          const terminalIds = [...current.terminalIds]
          const replacedTerminalId = terminalIds[target.pane] ?? null
          terminalIds[target.pane] = snapshot.terminal.id
          if (sourcePane >= 0) {
            terminalIds[sourcePane] = replacedTerminalId
          }

          return { ...current, terminalIds, activePane: target.pane }
        })
        onSelectTerminal(snapshot.terminal)
        return true
      }),
    [dropTargetAt, layout.terminalIds, onSelectTerminal]
  )

  const style: CSSProperties = {
    gridTemplateColumns:
      layout.mode === 'columns' || layout.mode === 'grid'
        ? `${layout.columnRatio}% ${100 - layout.columnRatio}%`
        : 'minmax(0, 1fr)',
    gridTemplateRows:
      layout.mode === 'rows' || layout.mode === 'grid'
        ? `${layout.rowRatio}% ${100 - layout.rowRatio}%`
        : 'minmax(0, 1fr)'
  }
  let dropOverlayStyle: CSSProperties | undefined
  let dropOverlayLabel = ''
  if (dropTarget?.kind === 'split') {
    dropOverlayStyle =
      dropTarget.mode === 'columns'
        ? {
            top: 0,
            bottom: 0,
            left: dropTarget.before ? 0 : '50%',
            width: '50%'
          }
        : {
            left: 0,
            right: 0,
            top: dropTarget.before ? 0 : '50%',
            height: '50%'
          }
    dropOverlayLabel = `Split ${
      dropTarget.mode === 'columns'
        ? dropTarget.before
          ? 'left'
          : 'right'
        : dropTarget.before
          ? 'above'
          : 'below'
    }`
  } else if (dropTarget?.kind === 'pane') {
    const column =
      layout.mode === 'grid' ? dropTarget.pane % 2 : dropTarget.pane
    const row =
      layout.mode === 'grid'
        ? Math.floor(dropTarget.pane / 2)
        : layout.mode === 'rows'
          ? dropTarget.pane
          : 0
    const left = column === 0 ? 0 : layout.columnRatio
    const top = row === 0 ? 0 : layout.rowRatio
    dropOverlayStyle = {
      left: `${left}%`,
      top: `${top}%`,
      width: `${
        layout.mode === 'rows'
          ? 100
          : column === 0
            ? layout.columnRatio
            : 100 - layout.columnRatio
      }%`,
      height: `${
        layout.mode === 'columns'
          ? 100
          : row === 0
            ? layout.rowRatio
            : 100 - layout.rowRatio
      }%`
    }
    dropOverlayLabel = layout.terminalIds[dropTarget.pane]
      ? 'Replace terminal'
      : 'Place terminal'
  }

  return (
    <main
      ref={workspaceRef}
      className="relative grid min-h-0 min-w-0 overflow-hidden bg-zinc-950 max-[700px]:grid-cols-1! max-[700px]:grid-rows-[minmax(0,1fr)]!"
      style={style}
      aria-label={`${worktree.name} terminal workspace`}
    >
      {dropOverlayStyle ? (
        <div
          className="pointer-events-none absolute z-30 grid place-items-center bg-cyan-400/10 p-3 ring-2 ring-inset ring-cyan-400"
          style={dropOverlayStyle}
          aria-hidden="true"
        >
          <span className="rounded-md bg-zinc-950/90 px-2 py-1 text-xs font-medium text-cyan-100 shadow">
            {dropOverlayLabel}
          </span>
        </div>
      ) : null}
      <Popover open={layoutMenuOpen} onOpenChange={setLayoutMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-1 right-10 z-40 max-[700px]:hidden"
            aria-label="Change terminal layout"
          >
            {layout.mode === 'single' ? (
              <SquareIcon />
            ) : layout.mode === 'columns' ? (
              <Columns2Icon />
            ) : layout.mode === 'rows' ? (
              <Rows2Icon />
            ) : (
              <Grid2X2Icon />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-52 p-1">
          <div className="grid gap-1" aria-label="Terminal layouts">
            <Button
              type="button"
              variant={layout.mode === 'single' ? 'secondary' : 'ghost'}
              size="sm"
              className="justify-start"
              onClick={() => changeMode('single')}
            >
              <SquareIcon data-icon="inline-start" />
              Single terminal
            </Button>
            <Button
              type="button"
              variant={layout.mode === 'columns' ? 'secondary' : 'ghost'}
              size="sm"
              className="justify-start"
              onClick={() => changeMode('columns')}
            >
              <Columns2Icon data-icon="inline-start" />
              Split left and right
            </Button>
            <Button
              type="button"
              variant={layout.mode === 'rows' ? 'secondary' : 'ghost'}
              size="sm"
              className="justify-start"
              onClick={() => changeMode('rows')}
            >
              <Rows2Icon data-icon="inline-start" />
              Split top and bottom
            </Button>
            <Button
              type="button"
              variant={layout.mode === 'grid' ? 'secondary' : 'ghost'}
              size="sm"
              className="justify-start"
              onClick={() => changeMode('grid')}
            >
              <Grid2X2Icon data-icon="inline-start" />
              Four terminals
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {layout.terminalIds.map((terminalId, pane) => {
        const terminal = terminalId ? terminalsById.get(terminalId) : null
        const active = terminal?.id === selectedTerminal.id
        return (
          <div
            key={pane}
            className={cn(
              'relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden',
              !active && 'max-[700px]:hidden',
              active && 'max-[700px]:col-start-1 max-[700px]:row-start-1',
              layout.mode !== 'single' && 'ring-1 ring-inset ring-white/8'
            )}
          >
            {terminal ? (
              <TerminalView
                worktree={worktree}
                terminal={terminal}
                loading={loading}
                active={active}
                framed={layout.mode !== 'single'}
                autoFocusBlocked={autoFocusBlocked || !active}
                onActivate={() => {
                  if (!active) {
                    onSelectTerminal(terminal)
                  }
                }}
                onStatusChange={onStatusChange}
              />
            ) : (
              <div className="grid min-h-0 place-items-center bg-zinc-950 p-6">
                <p className="text-sm text-zinc-500">Drag a terminal here</p>
              </div>
            )}
          </div>
        )
      })}

      <div className="max-[700px]:hidden contents">
        {(layout.mode === 'columns' || layout.mode === 'grid') && (
          <ResizeRail
            orientation="vertical"
            ratio={layout.columnRatio}
            onRatioChange={(columnRatio) =>
              setLayout((current) => ({ ...current, columnRatio }))
            }
          />
        )}
        {(layout.mode === 'rows' || layout.mode === 'grid') && (
          <ResizeRail
            orientation="horizontal"
            ratio={layout.rowRatio}
            onRatioChange={(rowRatio) =>
              setLayout((current) => ({ ...current, rowRatio }))
            }
          />
        )}
        {layout.mode === 'grid' && (
          <CrossResizeHandle
            columnRatio={layout.columnRatio}
            rowRatio={layout.rowRatio}
            onRatioChange={(columnRatio, rowRatio) =>
              setLayout((current) => ({
                ...current,
                columnRatio,
                rowRatio
              }))
            }
          />
        )}
      </div>
    </main>
  )
}
