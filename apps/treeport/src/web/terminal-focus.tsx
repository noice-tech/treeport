import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { isIOS } from './lib/platform'
import type { TerminalSession } from './terminal-session'

interface TerminalFocusRequest {
  terminalId: string
  focus: boolean
  sequence: number
}

const SetTerminalFocusIntentContext = createContext<
  ((terminalId: string, focus: boolean) => void) | null
>(null)

const TerminalFocusRequestContext = createContext<TerminalFocusRequest | null>(
  null
)

const TerminalFocusedBeforeInputContext = createContext<RefObject<boolean>>({
  current: false
})

export function TerminalFocusProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<TerminalFocusRequest | null>(null)
  const terminalFocusedBeforeInput = useRef(false)

  useEffect(() => {
    const recordTerminalFocus = () => {
      terminalFocusedBeforeInput.current = Boolean(
        document.activeElement?.closest('.xterm-host')
      )
    }

    window.addEventListener('pointerdown', recordTerminalFocus, true)
    window.addEventListener('keydown', recordTerminalFocus, true)

    return () => {
      window.removeEventListener('pointerdown', recordTerminalFocus, true)
      window.removeEventListener('keydown', recordTerminalFocus, true)
    }
  }, [])

  const setTerminalFocusIntent = useCallback(
    (terminalId: string, focus: boolean) => {
      setRequest((current) => ({
        terminalId,
        focus,
        sequence: (current?.sequence ?? 0) + 1
      }))
    },
    []
  )

  return (
    <SetTerminalFocusIntentContext value={setTerminalFocusIntent}>
      <TerminalFocusRequestContext value={request}>
        <TerminalFocusedBeforeInputContext value={terminalFocusedBeforeInput}>
          {children}
        </TerminalFocusedBeforeInputContext>
      </TerminalFocusRequestContext>
    </SetTerminalFocusIntentContext>
  )
}

export function useSetTerminalFocusIntent(): (
  terminalId: string,
  focus: boolean
) => void {
  const setTerminalFocusIntent = useContext(SetTerminalFocusIntentContext)

  if (!setTerminalFocusIntent) {
    throw new Error(
      'useSetTerminalFocusIntent must be used within TerminalFocusProvider'
    )
  }

  return setTerminalFocusIntent
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

  const terminalFocusedBeforeInput = useContext(
    TerminalFocusedBeforeInputContext
  )

  const previousTerminalId = useRef<string | null>(null)
  const observedRequestSequence = useRef(0)
  const pendingTerminalId = useRef<string | null>(null)
  const suppressedTerminalId = useRef<string | null>(null)
  const currentTerminalId = useRef(terminalId)
  const currentSession = useRef(session)
  const focusBlocked = useRef(blocked)

  useLayoutEffect(() => {
    currentTerminalId.current = terminalId
    currentSession.current = session
    focusBlocked.current = blocked
  }, [blocked, session, terminalId])

  useEffect(() => {
    if (request && observedRequestSequence.current !== request.sequence) {
      observedRequestSequence.current = request.sequence
      pendingTerminalId.current = request.focus ? request.terminalId : null
      suppressedTerminalId.current =
        request.focus || previousTerminalId.current === request.terminalId
          ? null
          : request.terminalId
    }

    if (previousTerminalId.current !== terminalId) {
      previousTerminalId.current = terminalId
      pendingTerminalId.current =
        suppressedTerminalId.current === terminalId ? null : terminalId

      if (suppressedTerminalId.current === terminalId) {
        suppressedTerminalId.current = null
      }
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

    // EXTERNAL: iOS raising its keyboard mid-switch stutters the layout, so only keep focus that a terminal already had.
    if (isIOS() && !terminalFocusedBeforeInput.current) {
      pendingTerminalId.current = null

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
  }, [blocked, request, session, terminalFocusedBeforeInput, terminalId])
}
