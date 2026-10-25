import {
  createContext,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject
} from 'react'
import {
  SidebarInset,
  SidebarProvider,
  useSidebar
} from '../../components/ui/sidebar'
import { cn } from '../../lib/utils'

const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 420
const DEFAULT_SIDEBAR_WIDTH = 272
const SIDEBAR_WIDTH_STORAGE_KEY = 'treeport-sidebar-width'

interface ProjectSwitcherContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  triggerRef: RefObject<HTMLButtonElement | null>
  dismissedIntoTerminalRef: RefObject<boolean>
}

const ProjectSwitcherContext =
  createContext<ProjectSwitcherContextValue | null>(null)

interface SidebarResizeContextValue {
  width: number
  resizing: boolean
  setWidth: (width: number) => void
  setResizing: (resizing: boolean) => void
}

const SidebarResizeContext = createContext<SidebarResizeContextValue | null>(
  null
)

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

export function useProjectSwitcher() {
  const context = useContext(ProjectSwitcherContext)

  if (!context) {
    throw new Error('useProjectSwitcher must be used within WorkspaceShell.')
  }

  return context
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false)
  const projectSwitcherTriggerRef = useRef<HTMLButtonElement | null>(null)
  const projectSwitcherDismissedIntoTerminalRef = useRef(false)

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedWidth = Number.parseInt(
      localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? '',
      10
    )

    return Number.isFinite(savedWidth)
      ? clampSidebarWidth(savedWidth)
      : DEFAULT_SIDEBAR_WIDTH
  })

  const [resizingSidebar, setResizingSidebar] = useState(false)

  const setAndSaveSidebarWidth = (width: number) => {
    const nextWidth = clampSidebarWidth(width)
    setSidebarWidth(nextWidth)
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth))
  }

  return (
    <ProjectSwitcherContext.Provider
      value={{
        open: projectSwitcherOpen,
        setOpen: setProjectSwitcherOpen,
        triggerRef: projectSwitcherTriggerRef,
        dismissedIntoTerminalRef: projectSwitcherDismissedIntoTerminalRef
      }}
    >
      <SidebarResizeContext.Provider
        value={{
          width: sidebarWidth,
          resizing: resizingSidebar,
          setWidth: setAndSaveSidebarWidth,
          setResizing: setResizingSidebar
        }}
      >
        <SidebarProvider
          className={cn(
            'app-frame isolate grid min-h-0 grid-cols-[var(--sidebar-width)_minmax(0,1fr)] bg-zinc-900 max-[701px]:grid-cols-1 max-[701px]:grid-rows-[2.5rem_minmax(0,1fr)] max-[701px]:bg-zinc-950',
            resizingSidebar && 'select-none'
          )}
          style={
            // SAFETY: The component contract supplies the asserted browser value used here.
            {
              '--sidebar-width': `${sidebarWidth}px`,
              '--sidebar-width-mobile': 'min(88vw, 18rem)'
            } as CSSProperties
          }
        >
          {children}
        </SidebarProvider>
      </SidebarResizeContext.Provider>
    </ProjectSwitcherContext.Provider>
  )
}

export function WorkspaceMain({
  children,
  presence
}: {
  children: ReactNode
  presence: ReactNode
}) {
  const { isMobile, openMobile } = useSidebar()
  const projectSwitcher = useProjectSwitcher()

  return (
    <SidebarInset asChild>
      <div
        className="relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-zinc-950 min-[702px]:my-2 min-[702px]:mr-2 min-[702px]:rounded-xl min-[702px]:shadow-[0_0_0_1px_rgb(255_255_255/0.07),0_12px_40px_-12px_rgb(0_0_0/0.6)]"
        inert={isMobile && openMobile ? true : undefined}
        aria-hidden={isMobile && openMobile ? true : undefined}
        onPointerDownCapture={() => {
          if (projectSwitcher.open) {
            projectSwitcher.dismissedIntoTerminalRef.current = true
            projectSwitcher.setOpen(false)
          }
        }}
      >
        <div>{presence}</div>
        {children}
      </div>
    </SidebarInset>
  )
}

export function ResizableSidebarRail() {
  const resize = useContext(SidebarResizeContext)
  const resizeOrigin = useRef<{ pointerX: number; width: number } | null>(null)

  if (!resize) {
    throw new Error('ResizableSidebarRail must be used within WorkspaceShell.')
  }

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    resizeOrigin.current = {
      pointerX: event.clientX,
      width: resize.width
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    resize.setResizing(true)
  }

  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeOrigin.current) {
      return
    }

    resize.setWidth(
      resizeOrigin.current.width + event.clientX - resizeOrigin.current.pointerX
    )
  }

  const stopResize = (event: PointerEvent<HTMLDivElement>) => {
    resizeOrigin.current = null

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    resize.setResizing(false)
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth = resize.width

    if (event.key === 'ArrowLeft') {
      nextWidth -= event.shiftKey ? 32 : 16
    } else if (event.key === 'ArrowRight') {
      nextWidth += event.shiftKey ? 32 : 16
    } else if (event.key === 'Home') {
      nextWidth = MIN_SIDEBAR_WIDTH
    } else if (event.key === 'End') {
      nextWidth = MAX_SIDEBAR_WIDTH
    } else {
      return
    }

    event.preventDefault()
    resize.setWidth(nextWidth)
  }

  return (
    <div
      className={cn(
        'absolute inset-y-0 right-0 z-20 hidden w-3 translate-x-1/2 touch-none cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 after:absolute after:top-1/2 after:left-1/2 after:h-8 after:w-1 after:-translate-1/2 after:rounded-full after:bg-zinc-600 after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100 hover:before:w-0.5 hover:before:bg-accent-400/60 hover:after:bg-accent-400 focus-visible:before:w-0.5 focus-visible:before:bg-accent-400 focus-visible:after:bg-accent-400 min-[701px]:block',
        resize.resizing && 'before:w-0.5 before:bg-accent-400 after:opacity-100'
      )}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-controls="worktree-sidebar"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={resize.width}
      aria-valuetext={`${resize.width} pixels`}
      title="Drag to resize; double-click to reset"
      tabIndex={0}
      onPointerDown={startResize}
      onPointerMove={continueResize}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => resize.setWidth(DEFAULT_SIDEBAR_WIDTH)}
    />
  )
}
