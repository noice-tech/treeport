import { createContext, useContext, type ReactNode } from 'react'

interface DesktopRuntime {
  computerId: string | null
  localBrowser: boolean
}

const DesktopRuntimeContext = createContext<DesktopRuntime>({
  computerId: null,
  localBrowser: false
})

export function DesktopRuntimeProvider({
  computerId,
  localBrowser,
  children
}: {
  computerId: string
  localBrowser: boolean
  children: ReactNode
}) {
  return (
    <DesktopRuntimeContext.Provider value={{ computerId, localBrowser }}>
      {children}
    </DesktopRuntimeContext.Provider>
  )
}

export function useDesktopRuntime(): DesktopRuntime {
  return useContext(DesktopRuntimeContext)
}
