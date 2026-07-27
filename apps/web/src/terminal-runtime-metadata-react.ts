import { useCallback, useSyncExternalStore } from 'react'
import type { TerminalProgress } from '@treeport/shared'
import { terminalSessions } from './terminal-session'
import type { TerminalBellMetadata } from './terminal-session-manager'

const EMPTY_ATTENTION: ReadonlySet<string> = new Set()
const EMPTY_TITLES: ReadonlyMap<string, string> = new Map()
const EMPTY_PROGRESS: ReadonlyMap<string, TerminalProgress> = new Map()
const EMPTY_BELLS: ReadonlyMap<string, TerminalBellMetadata> = new Map()

const EMPTY_NAVIGATION_METADATA = {
  attention: EMPTY_ATTENTION,
  titles: EMPTY_TITLES,
  progress: EMPTY_PROGRESS
}
const EMPTY_BELL_METADATA = {
  bells: EMPTY_BELLS,
  titles: EMPTY_TITLES
}

let navigationMetadata = EMPTY_NAVIGATION_METADATA
let bellMetadata = EMPTY_BELL_METADATA

function getNavigationMetadata() {
  const attention = terminalSessions.getAttentionSnapshot()
  const titles = terminalSessions.getTitleSnapshot()
  const progress = terminalSessions.getProgressSnapshot()
  if (
    navigationMetadata.attention !== attention ||
    navigationMetadata.titles !== titles ||
    navigationMetadata.progress !== progress
  ) {
    navigationMetadata = { attention, titles, progress }
  }

  return navigationMetadata
}

function getBellMetadata() {
  const bells = terminalSessions.getBellSnapshot()
  const titles = terminalSessions.getTitleSnapshot()
  if (bellMetadata.bells !== bells || bellMetadata.titles !== titles) {
    bellMetadata = { bells, titles }
  }

  return bellMetadata
}

export function useTerminalTitle(terminalId: string | null): string | null {
  const getSnapshot = useCallback(
    () =>
      terminalId
        ? (terminalSessions.getTitleSnapshot().get(terminalId) ?? null)
        : null,
    [terminalId]
  )
  return useSyncExternalStore(
    terminalSessions.subscribe,
    getSnapshot,
    () => null
  )
}

export function useTerminalProgress(
  terminalId: string | null
): TerminalProgress | null {
  const getSnapshot = useCallback(
    () =>
      terminalId
        ? (terminalSessions.getProgressSnapshot().get(terminalId) ?? null)
        : null,
    [terminalId]
  )
  return useSyncExternalStore(
    terminalSessions.subscribe,
    getSnapshot,
    () => null
  )
}

export function useTerminalForegroundProcess(terminalId: string | null) {
  const getSnapshot = useCallback(
    () =>
      terminalId
        ? terminalSessions.getForegroundProcessSnapshot().has(terminalId)
        : false,
    [terminalId]
  )
  return useSyncExternalStore(
    terminalSessions.subscribe,
    getSnapshot,
    () => false
  )
}

export function useTerminalAttention(terminalId: string | null) {
  const getSnapshot = useCallback(
    () =>
      terminalId
        ? terminalSessions.getAttentionSnapshot().has(terminalId)
        : false,
    [terminalId]
  )
  return useSyncExternalStore(
    terminalSessions.subscribe,
    getSnapshot,
    () => false
  )
}

export function useTerminalNavigationMetadata() {
  return useSyncExternalStore(
    terminalSessions.subscribe,
    getNavigationMetadata,
    () => EMPTY_NAVIGATION_METADATA
  )
}

export function useTerminalBellMetadata() {
  return useSyncExternalStore(
    terminalSessions.subscribe,
    getBellMetadata,
    () => EMPTY_BELL_METADATA
  )
}
