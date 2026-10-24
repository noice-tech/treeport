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
    const receive = (next: DesktopShellState) => {
      document.documentElement.dataset.theme = next.theme
      setState(next)
    }
    const unsubscribe = window.treeportShell.onState(receive)
    void window.treeportShell.getState().then(receive)
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
