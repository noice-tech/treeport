import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  RefCallback
} from 'react'

export interface ReorderableItemProps {
  ref: RefCallback<HTMLElement>
  style?: CSSProperties | undefined
}

export type ReorderableHandleProps = Pick<
  HTMLAttributes<HTMLElement>,
  | 'onPointerDown'
  | 'onPointerMove'
  | 'onPointerUp'
  | 'onPointerCancel'
  | 'onClickCapture'
  | 'onKeyDown'
  | 'style'
>

type DragState = {
  id: string
  pointerId: number
  startX: number
  startY: number
  startCoordinate: number
  itemStart: number
  itemSize: number
  handle: HTMLElement
  originalIds: string[]
  draftIds: string[]
  overlay: HTMLElement | null
  shield: HTMLElement | null
  listeners: AbortController | null
  started: boolean
}

export function useReorderableItems<Item extends { id: string }>({
  items,
  orientation,
  onReorder
}: {
  items: readonly Item[]
  orientation: 'horizontal' | 'vertical'
  onReorder: (itemIds: string[]) => void
}) {
  const itemIds = items.map((item) => item.id)
  const [draftIds, setDraftIds] = useState<string[] | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const itemElements = useRef(new Map<string, HTMLElement>())
  const previousRects = useRef<Map<string, DOMRect> | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const suppressClick = useRef<string | null>(null)
  const pendingCommit = useRef<readonly Item[] | null>(null)

  const itemsById = new Map(items.map((item) => [item.id, item]))
  const orderedItems = (draftIds ?? itemIds).flatMap((itemId) => {
    const item = itemsById.get(itemId)
    return item ? [item] : []
  })

  const cleanUpDrag = () => {
    const drag = dragRef.current
    drag?.listeners?.abort()
    drag?.overlay?.remove()
    drag?.shield?.remove()
    dragRef.current = null
  }

  const cancel = () => {
    cleanUpDrag()
    pendingCommit.current = null
    setDraggingId(null)
    setDraftIds(null)
  }

  const moveDraggedItem = (pointerCoordinate: number) => {
    const drag = dragRef.current
    if (!drag) {
      return
    }

    const draggedCenter =
      drag.itemStart +
      pointerCoordinate -
      drag.startCoordinate +
      drag.itemSize / 2
    const remainingIds = drag.draftIds.filter((itemId) => itemId !== drag.id)
    const targetIndex = remainingIds.findIndex((itemId) => {
      const rect = itemElements.current.get(itemId)?.getBoundingClientRect()
      const center = rect
        ? orientation === 'horizontal'
          ? rect.left + rect.width / 2
          : rect.top + rect.height / 2
        : Number.POSITIVE_INFINITY
      return draggedCenter <= center
    })
    const nextIds = [...remainingIds]
    nextIds.splice(targetIndex < 0 ? nextIds.length : targetIndex, 0, drag.id)
    if (nextIds.every((itemId, index) => itemId === drag.draftIds[index])) {
      return
    }

    previousRects.current = new Map(
      [...itemElements.current]
        .filter(([itemId]) => itemId !== drag.id)
        .map(([itemId, element]) => [itemId, element.getBoundingClientRect()])
    )
    for (const element of itemElements.current.values()) {
      for (const animation of element.getAnimations()) {
        animation.cancel()
      }
    }
    drag.draftIds = nextIds
    setDraftIds(nextIds)
  }

  const continueDrag = (clientX: number, clientY: number) => {
    const drag = dragRef.current
    if (!drag?.started || !drag.overlay) {
      return
    }

    drag.overlay.style.transform = `translate3d(${clientX - drag.startX}px, ${clientY - drag.startY}px, 0)`
    moveDraggedItem(orientation === 'horizontal' ? clientX : clientY)
  }

  const commit = () => {
    const drag = dragRef.current
    if (!drag?.started) {
      cleanUpDrag()
      return
    }

    const changed = drag.draftIds.some(
      (itemId, index) => itemId !== drag.originalIds[index]
    )
    const draggedId = drag.id
    suppressClick.current = draggedId
    window.setTimeout(() => {
      if (suppressClick.current === draggedId) {
        suppressClick.current = null
      }
    })
    cleanUpDrag()
    setDraggingId(null)
    if (!changed) {
      setDraftIds(null)
      return
    }

    pendingCommit.current = items
    setAnnouncement(
      `Moved to position ${drag.draftIds.indexOf(draggedId) + 1} of ${drag.draftIds.length}`
    )
    onReorder(drag.draftIds)
  }

  useLayoutEffect(() => {
    if (pendingCommit.current && items !== pendingCommit.current) {
      pendingCommit.current = null
      setDraftIds(null)
    }
  }, [items])

  useLayoutEffect(() => {
    const rects = previousRects.current
    previousRects.current = null
    if (
      !rects ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }

    for (const [itemId, previousRect] of rects) {
      const element = itemElements.current.get(itemId)
      if (!element) {
        continue
      }

      const nextRect = element.getBoundingClientRect()
      const x = previousRect.left - nextRect.left
      const y = previousRect.top - nextRect.top
      if (x || y) {
        element.animate(
          [
            { transform: `translate3d(${x}px, ${y}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' }
          ],
          { duration: 120, easing: 'ease-in-out' }
        )
      }
    }
  }, [draftIds])

  useEffect(() => () => cleanUpDrag(), [])

  return {
    orderedItems,
    announcement,
    getItemProps: (itemId: string): ReorderableItemProps => ({
      ref: (element) => {
        if (element) {
          itemElements.current.set(itemId, element)
        } else {
          itemElements.current.delete(itemId)
        }
      },
      style: draggingId === itemId ? { visibility: 'hidden' } : undefined
    }),
    getHandleProps: (itemId: string): ReorderableHandleProps => ({
      style: { touchAction: 'none', userSelect: 'none' },
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (!event.isPrimary || event.button !== 0) {
          return
        }

        const item = itemElements.current.get(itemId)
        if (!item) {
          return
        }

        const rect = item.getBoundingClientRect()
        dragRef.current = {
          id: itemId,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startCoordinate:
            orientation === 'horizontal' ? event.clientX : event.clientY,
          itemStart: orientation === 'horizontal' ? rect.left : rect.top,
          itemSize: orientation === 'horizontal' ? rect.width : rect.height,
          handle: event.currentTarget,
          originalIds: [...itemIds],
          draftIds: [...itemIds],
          overlay: null,
          shield: null,
          listeners: null,
          started: false
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) {
          return
        }

        if (!drag.started) {
          if (
            Math.hypot(
              event.clientX - drag.startX,
              event.clientY - drag.startY
            ) < 5
          ) {
            return
          }

          const item = itemElements.current.get(itemId)
          if (!item) {
            cancel()
            return
          }

          const rect = item.getBoundingClientRect()
          const overlay = item.cloneNode(true)
          if (!(overlay instanceof HTMLElement)) {
            cancel()
            return
          }

          overlay.removeAttribute('id')
          overlay.querySelectorAll('[id]').forEach((element) => {
            element.removeAttribute('id')
          })
          overlay.setAttribute('aria-hidden', 'true')
          Object.assign(overlay.style, {
            position: 'fixed',
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            margin: '0',
            listStyle: 'none',
            pointerEvents: 'none',
            transform: 'translate3d(0, 0, 0)',
            transition: 'none',
            zIndex: '2147483647'
          })

          const shield = document.createElement('div')
          shield.setAttribute('aria-hidden', 'true')
          Object.assign(shield.style, {
            position: 'fixed',
            inset: '0',
            touchAction: 'none',
            userSelect: 'none',
            zIndex: '2147483646'
          })
          const listeners = new AbortController()
          const listenerOptions = { signal: listeners.signal }
          shield.addEventListener(
            'pointermove',
            (nextEvent) => {
              if (nextEvent.pointerId === drag.pointerId) {
                nextEvent.preventDefault()
                continueDrag(nextEvent.clientX, nextEvent.clientY)
              }
            },
            listenerOptions
          )
          shield.addEventListener(
            'pointerup',
            (nextEvent) => {
              if (nextEvent.pointerId === drag.pointerId) {
                commit()
              }
            },
            listenerOptions
          )
          shield.addEventListener(
            'pointercancel',
            (nextEvent) => {
              if (nextEvent.pointerId === drag.pointerId) {
                cancel()
              }
            },
            listenerOptions
          )
          shield.addEventListener('lostpointercapture', cancel, listenerOptions)
          window.addEventListener('blur', cancel, listenerOptions)
          document.addEventListener(
            'visibilitychange',
            () => {
              if (document.visibilityState === 'hidden') {
                cancel()
              }
            },
            listenerOptions
          )
          document.body.append(shield, overlay)

          drag.started = true
          drag.overlay = overlay
          drag.shield = shield
          drag.listeners = listeners
          setDraftIds(drag.draftIds)
          setDraggingId(itemId)
          drag.handle.releasePointerCapture(drag.pointerId)
          shield.setPointerCapture(drag.pointerId)
        }

        event.preventDefault()
        continueDrag(event.clientX, event.clientY)
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        const drag = dragRef.current
        if (drag?.pointerId === event.pointerId) {
          commit()
        }
      },
      onPointerCancel: (event: PointerEvent<HTMLElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) {
          cancel()
        }
      },
      onClickCapture: (event) => {
        if (suppressClick.current === itemId) {
          suppressClick.current = null
          event.preventDefault()
          event.stopPropagation()
        }
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape' && dragRef.current?.started) {
          event.preventDefault()
          cancel()
          return
        }

        if (!event.altKey || !event.shiftKey) {
          return
        }

        const previousKey =
          orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
        const nextKey =
          orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
        if (event.key !== previousKey && event.key !== nextKey) {
          return
        }

        const currentIndex = itemIds.indexOf(itemId)
        const targetIndex = currentIndex + (event.key === previousKey ? -1 : 1)
        if (targetIndex < 0 || targetIndex >= itemIds.length) {
          return
        }

        event.preventDefault()
        const nextIds = [...itemIds]
        nextIds.splice(currentIndex, 1)
        nextIds.splice(targetIndex, 0, itemId)
        setAnnouncement(
          `Moved to position ${targetIndex + 1} of ${nextIds.length}`
        )
        onReorder(nextIds)
      }
    })
  }
}

export function ReorderableItems<Item extends { id: string }>({
  items,
  orientation,
  onReorder,
  children
}: {
  items: readonly Item[]
  orientation: 'horizontal' | 'vertical'
  onReorder: (itemIds: string[]) => void
  children: (
    item: Item,
    itemProps: ReorderableItemProps,
    handleProps: ReorderableHandleProps,
    index: number
  ) => ReactNode
}) {
  const { orderedItems, announcement, getItemProps, getHandleProps } =
    useReorderableItems({ items, orientation, onReorder })

  return (
    <>
      {orderedItems.map((item, index) =>
        children(item, getItemProps(item.id), getHandleProps(item.id), index)
      )}
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </>
  )
}
