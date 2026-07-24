import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { TerminalSession } from './terminal-session.js'

interface TerminalFocusRequest {
  terminalId: string
  sequence: number
}

const RequestTerminalFocusContext = createContext<
  ((terminalId: string) => void) | null
>(null)
const TerminalFocusRequestContext = createContext<TerminalFocusRequest | null>(
  null
)

export function TerminalFocusProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<TerminalFocusRequest | null>(null)
  const requestTerminalFocus = useCallback((terminalId: string) => {
    setRequest((current) => ({
      terminalId,
      sequence: (current?.sequence ?? 0) + 1
    }))
  }, [])

  return (
    <RequestTerminalFocusContext value={requestTerminalFocus}>
      <TerminalFocusRequestContext value={request}>
        {children}
      </TerminalFocusRequestContext>
    </RequestTerminalFocusContext>
  )
}

export function useRequestTerminalFocus(): (terminalId: string) => void {
  const requestTerminalFocus = useContext(RequestTerminalFocusContext)
  if (!requestTerminalFocus) {
    throw new Error(
      'useRequestTerminalFocus must be used within TerminalFocusProvider'
    )
  }

  return requestTerminalFocus
}

export function useTerminalAutoFocus({
  terminalId,
  session,
  blocked
}: {
  terminalId: string | null
  session: TerminalSession | null
  blocked: boolean
}): void {
  const request = useContext(TerminalFocusRequestContext)
  const previousTerminalId = useRef<string | null>(null)
  const observedRequestSequence = useRef(0)
  const pendingTerminalId = useRef<string | null>(null)
  const currentTerminalId = useRef(terminalId)
  const currentSession = useRef(session)
  const focusBlocked = useRef(blocked)

  useLayoutEffect(() => {
    currentTerminalId.current = terminalId
    currentSession.current = session
    focusBlocked.current = blocked
  }, [blocked, session, terminalId])

  useEffect(() => {
    if (previousTerminalId.current !== terminalId) {
      previousTerminalId.current = terminalId
      pendingTerminalId.current = terminalId
    }

    if (request && observedRequestSequence.current !== request.sequence) {
      observedRequestSequence.current = request.sequence
      pendingTerminalId.current = request.terminalId
    }

    if (
      !terminalId ||
      !session ||
      session.terminalId !== terminalId ||
      blocked ||
      pendingTerminalId.current !== terminalId
    ) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      if (
        focusBlocked.current ||
        currentTerminalId.current !== terminalId ||
        currentSession.current !== session ||
        pendingTerminalId.current !== terminalId
      ) {
        return
      }

      session.focus()
      pendingTerminalId.current = null
    })
    return () => window.cancelAnimationFrame(frame)
  }, [blocked, request, session, terminalId])
}
