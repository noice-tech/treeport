import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'

type WorkspaceSurface = 'terminal' | 'tool'

interface WorkspaceSurfaceFocusContextValue {
  focusedSurface: WorkspaceSurface
  focusedSurfaceRef: RefObject<WorkspaceSurface>
  emptyToolFocusRevision: number
  focusSurface: (surface: WorkspaceSurface) => void
  restoreEmptyToolFocus: () => void
}

const WorkspaceSurfaceFocusContext =
  createContext<WorkspaceSurfaceFocusContextValue | null>(null)

export function WorkspaceSurfaceFocusProvider({
  children
}: {
  children: ReactNode
}) {
  const [focusedSurface, setFocusedSurface] =
    useState<WorkspaceSurface>('terminal')
  const focusedSurfaceRef = useRef<WorkspaceSurface>('terminal')
  const [emptyToolFocusRevision, setEmptyToolFocusRevision] = useState(0)
  const focusSurface = useCallback((surface: WorkspaceSurface) => {
    focusedSurfaceRef.current = surface
    setFocusedSurface(surface)
  }, [])
  const restoreEmptyToolFocus = useCallback(
    () => setEmptyToolFocusRevision((current) => current + 1),
    []
  )
  const value = useMemo(
    () => ({
      focusedSurface,
      focusedSurfaceRef,
      emptyToolFocusRevision,
      focusSurface,
      restoreEmptyToolFocus
    }),
    [
      emptyToolFocusRevision,
      focusSurface,
      focusedSurface,
      restoreEmptyToolFocus
    ]
  )

  return (
    <WorkspaceSurfaceFocusContext.Provider value={value}>
      {children}
    </WorkspaceSurfaceFocusContext.Provider>
  )
}

export function useWorkspaceSurfaceFocus(): WorkspaceSurfaceFocusContextValue {
  const context = useContext(WorkspaceSurfaceFocusContext)
  if (!context) {
    throw new Error(
      'useWorkspaceSurfaceFocus requires WorkspaceSurfaceFocusProvider'
    )
  }

  return context
}
