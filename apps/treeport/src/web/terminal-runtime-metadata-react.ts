import { useSyncExternalStore } from 'react'
import type { TerminalProgram, TerminalProgress } from '@treeport/shared'
import { terminalSessions } from './terminal-session'
import type { TerminalBellMetadata } from './terminal-session-manager'

const EMPTY_ATTENTION: ReadonlySet<string> = new Set()
const EMPTY_TITLES: ReadonlyMap<string, string> = new Map()
const EMPTY_PROGRAMS: ReadonlyMap<string, TerminalProgram> = new Map()
const EMPTY_PROGRESS: ReadonlyMap<string, TerminalProgress> = new Map()
const EMPTY_BELLS: ReadonlyMap<string, TerminalBellMetadata> = new Map()

const EMPTY_NAVIGATION_METADATA = {
  attention: EMPTY_ATTENTION,
  titles: EMPTY_TITLES,
  programs: EMPTY_PROGRAMS,
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
  const programs = terminalSessions.getProgramSnapshot()
  const progress = terminalSessions.getProgressSnapshot()
  if (
    navigationMetadata.attention !== attention ||
    navigationMetadata.titles !== titles ||
    navigationMetadata.programs !== programs ||
    navigationMetadata.progress !== progress
  ) {
    navigationMetadata = { attention, titles, programs, progress }
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
