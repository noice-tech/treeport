import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from 'react'
import type { ComputerSummary, DesktopShellState } from '../desktop-contract'

const ShellStateContext = createContext<DesktopShellState | null>(null)

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopShellState | null>(null)

  useEffect(() => {
    const unsubscribe = window.treeportShell.onState(setState)
    void window.treeportShell.getState().then(setState)
    return unsubscribe
  }, [])

  return (
    <ShellStateContext.Provider value={state}>
      {children}
    </ShellStateContext.Provider>
  )
}

export function useShellState() {
  return useContext(ShellStateContext)
}

export function selectedComputer(
  state: DesktopShellState
): ComputerSummary | undefined {
  return state.computers.find((computer) => computer.selected)
}
