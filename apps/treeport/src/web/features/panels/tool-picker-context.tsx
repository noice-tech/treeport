import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react'

interface ToolPickerContextValue {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  dismiss: () => void
}

const ToolPickerContext = createContext<ToolPickerContextValue | null>(null)

export function ToolPickerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const dismiss = useCallback(() => setOpen(false), [])
  const value = useMemo(() => ({ open, setOpen, dismiss }), [dismiss, open])

  return (
    <ToolPickerContext.Provider value={value}>
      {children}
    </ToolPickerContext.Provider>
  )
}

export function useToolPicker(): ToolPickerContextValue {
  const context = useContext(ToolPickerContext)
  if (!context) {
    throw new Error('useToolPicker requires ToolPickerProvider')
  }

  return context
}
