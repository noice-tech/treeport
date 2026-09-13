import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react'
import type { TerminalRecord, WorktreeRecord } from '@treeport/shared'
import { cn } from '../../lib/utils'
import { TerminalView } from '../../terminal-view'
import {
  terminalLayoutDrag,
  type TerminalLayoutDragSnapshot
} from './terminal-layout-drag'
import {
  normalizeTerminalWorkspaceLayout,
  splitTerminalInLayout,
  terminalIdsInLayoutNode,
  terminalWorkspaceLayouts,
  updateTerminalSplitRatio,
  type TerminalSplitDirection,
  type TerminalWorkspaceLayout,
  type TerminalWorkspaceLayoutNode
} from './terminal-workspace-layout'

const DEFAULT_RATIO = 50
const MIN_RATIO = 20
const MAX_RATIO = 80

interface TerminalDropTarget {
  terminalId: string
  direction: TerminalSplitDirection
  bounds: DOMRect
}

function clampRatio(value: number): number {
  return Math.round(Math.min(MAX_RATIO, Math.max(MIN_RATIO, value)))
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
      event.currentTarget.parentElement?.getBoundingClientRect() ?? null
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
        'group/split absolute z-30 touch-none outline-none max-[700px]:hidden',
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
  useSyncExternalStore(
    terminalWorkspaceLayouts.subscribe,
    terminalWorkspaceLayouts.getSnapshot,
    terminalWorkspaceLayouts.getSnapshot
  )
  const terminalIds = worktree.terminals.map((terminal) => terminal.id)
  const terminalIdSignature = terminalIds.join('\u0000')
  const layout = normalizeTerminalWorkspaceLayout(
    terminalWorkspaceLayouts.read(worktree.id),
    terminalIds
  )
  const terminalsById = new Map(
    worktree.terminals.map((terminal) => [terminal.id, terminal])
  )
  const activeGroupIndex = layout.groups.findIndex((group) =>
    terminalIdsInLayoutNode(group).includes(selectedTerminal.id)
  )
  const activeGroup =
    activeGroupIndex >= 0
      ? layout.groups[activeGroupIndex]!
      : ({
          type: 'terminal',
          terminalId: selectedTerminal.id
        } satisfies TerminalWorkspaceLayoutNode)
  const dragSnapshot = useSyncExternalStore(
    terminalLayoutDrag.subscribe,
    terminalLayoutDrag.getSnapshot,
    terminalLayoutDrag.getSnapshot
  )

  const dropTargetAt = useCallback(
    (snapshot: TerminalLayoutDragSnapshot): TerminalDropTarget | null => {
      const workspace = workspaceRef.current
      if (!workspace || snapshot.terminal.worktreeId !== worktree.id) {
        return null
      }

      const pane = Array.from(
        workspace.querySelectorAll<HTMLElement>('[data-terminal-pane-id]')
      ).find((candidate) => {
        const bounds = candidate.getBoundingClientRect()
        return (
          snapshot.clientX >= bounds.left &&
          snapshot.clientX <= bounds.right &&
          snapshot.clientY >= bounds.top &&
          snapshot.clientY <= bounds.bottom
        )
      })
      if (!pane) {
        return null
      }

      const terminalId = pane.dataset.terminalPaneId
      if (!terminalId || terminalId === snapshot.terminal.id) {
        return null
      }

      const bounds = pane.getBoundingClientRect()
      const x = (snapshot.clientX - bounds.left) / bounds.width
      const y = (snapshot.clientY - bounds.top) / bounds.height
      const distances = [x, 1 - x, y, 1 - y]
      const directions = ['left', 'right', 'up', 'down'] as const
      return {
        terminalId,
        direction: directions[distances.indexOf(Math.min(...distances))]!,
        bounds
      }
    },
    [worktree.id]
  )
  const activeDrag =
    dragSnapshot?.terminal.worktreeId === worktree.id ? dragSnapshot : null
  const dropTarget = activeDrag ? dropTargetAt(activeDrag) : null
  const updateLayout = useCallback(
    (update: (current: TerminalWorkspaceLayout) => TerminalWorkspaceLayout) =>
      terminalWorkspaceLayouts.update(worktree.id, terminalIds, update),
    [terminalIdSignature, worktree.id]
  )

  useEffect(
    () =>
      terminalLayoutDrag.registerDropHandler((snapshot) => {
        const target = dropTargetAt(snapshot)
        if (!target) {
          return false
        }

        updateLayout((current) =>
          splitTerminalInLayout(
            current,
            target.terminalId,
            snapshot.terminal.id,
            target.direction
          )
        )
        onSelectTerminal(snapshot.terminal)
        return true
      }),
    [dropTargetAt, onSelectTerminal, updateLayout]
  )

  const updateRatio = (path: readonly number[], ratio: number) => {
    updateLayout((current) => ({
      groups: current.groups.map((group, index) =>
        index === activeGroupIndex
          ? updateTerminalSplitRatio(group, path, ratio)
          : group
      )
    }))
  }

  const renderNode = (
    node: TerminalWorkspaceLayoutNode,
    path: readonly number[]
  ): ReactNode => {
    if (node.type === 'terminal') {
      const terminal = terminalsById.get(node.terminalId)
      if (!terminal) {
        return null
      }

      const active = terminal.id === selectedTerminal.id
      return (
        <div
          key={terminal.id}
          data-terminal-pane-id={terminal.id}
          className={cn(
            'relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden ring-1 ring-inset ring-white/8',
            !active && 'max-[700px]:hidden',
            active && 'max-[700px]:col-start-1 max-[700px]:row-start-1'
          )}
        >
          <TerminalView
            worktree={worktree}
            terminal={terminal}
            loading={loading}
            active={active}
            autoFocusBlocked={autoFocusBlocked || !active}
            onActivate={() => {
              if (!active) {
                onSelectTerminal(terminal)
              }
            }}
            onStatusChange={onStatusChange}
          />
        </div>
      )
    }

    const style: CSSProperties =
      node.orientation === 'vertical'
        ? {
            gridTemplateColumns: `${node.ratio}% ${100 - node.ratio}%`,
            gridTemplateRows: 'minmax(0, 1fr)'
          }
        : {
            gridTemplateColumns: 'minmax(0, 1fr)',
            gridTemplateRows: `${node.ratio}% ${100 - node.ratio}%`
          }
    return (
      <div
        key={path.join('.') || 'root'}
        data-terminal-split=""
        className="relative grid min-h-0 min-w-0 overflow-hidden max-[700px]:contents"
        style={style}
      >
        {renderNode(node.first, [...path, 0])}
        {renderNode(node.second, [...path, 1])}
        <ResizeRail
          orientation={node.orientation}
          ratio={node.ratio}
          onRatioChange={(ratio) => updateRatio(path, ratio)}
        />
      </div>
    )
  }

  let dropOverlayStyle: CSSProperties | undefined
  if (dropTarget) {
    const workspaceBounds = workspaceRef.current?.getBoundingClientRect()
    if (workspaceBounds) {
      const vertical =
        dropTarget.direction === 'left' || dropTarget.direction === 'right'
      dropOverlayStyle = {
        left:
          dropTarget.bounds.left -
          workspaceBounds.left +
          (dropTarget.direction === 'right' ? dropTarget.bounds.width / 2 : 0),
        top:
          dropTarget.bounds.top -
          workspaceBounds.top +
          (dropTarget.direction === 'down' ? dropTarget.bounds.height / 2 : 0),
        width: vertical ? dropTarget.bounds.width / 2 : dropTarget.bounds.width,
        height: vertical
          ? dropTarget.bounds.height
          : dropTarget.bounds.height / 2
      }
    }
  }

  return (
    <main
      ref={workspaceRef}
      className="relative grid min-h-0 min-w-0 overflow-hidden bg-zinc-950"
      aria-label={`${worktree.name} terminal workspace`}
    >
      {dropOverlayStyle && dropTarget ? (
        <div
          className="pointer-events-none absolute z-40 grid place-items-center bg-cyan-400/10 p-3 ring-2 ring-inset ring-cyan-400"
          style={dropOverlayStyle}
          aria-hidden="true"
        >
          <span className="rounded-md bg-zinc-950/90 px-2 py-1 text-xs font-medium text-cyan-100 shadow">
            Split {dropTarget.direction}
          </span>
        </div>
      ) : null}
      {renderNode(activeGroup, [])}
    </main>
  )
}
