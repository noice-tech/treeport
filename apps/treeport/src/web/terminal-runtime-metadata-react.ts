import { useSyncExternalStore } from 'react'
import type { TerminalActivity, TerminalProgram } from '@treeport/shared'
import { terminalSessions } from './terminal-session'
import type { TerminalAttentionMetadata } from './terminal-session-manager'

const EMPTY_ATTENTION: ReadonlySet<string> = new Set()
const EMPTY_TITLES: ReadonlyMap<string, string> = new Map()
const EMPTY_PROGRAMS: ReadonlyMap<string, TerminalProgram> = new Map()
const EMPTY_ACTIVITY: ReadonlyMap<string, TerminalActivity> = new Map()
const EMPTY_ATTENTION_METADATA_MAP: ReadonlyMap<
  string,
  TerminalAttentionMetadata
> = new Map()

const EMPTY_NAVIGATION_METADATA = {
  attention: EMPTY_ATTENTION,
  titles: EMPTY_TITLES,
  programs: EMPTY_PROGRAMS,
  activity: EMPTY_ACTIVITY
}
const EMPTY_ATTENTION_METADATA = {
  attention: EMPTY_ATTENTION_METADATA_MAP,
  titles: EMPTY_TITLES
}

let navigationMetadata = EMPTY_NAVIGATION_METADATA
let attentionMetadata = EMPTY_ATTENTION_METADATA

function getNavigationMetadata() {
  const attention = terminalSessions.getAttentionSnapshot()
  const titles = terminalSessions.getTitleSnapshot()
  const programs = terminalSessions.getProgramSnapshot()
  const activity = terminalSessions.getActivitySnapshot()
  if (
    navigationMetadata.attention !== attention ||
    navigationMetadata.titles !== titles ||
    navigationMetadata.programs !== programs ||
    navigationMetadata.activity !== activity
  ) {
    navigationMetadata = { attention, titles, programs, activity }
  }

  return navigationMetadata
}

function getAttentionMetadata() {
  const attention = terminalSessions.getAttentionMetadataSnapshot()
  const titles = terminalSessions.getTitleSnapshot()
  if (
    attentionMetadata.attention !== attention ||
    attentionMetadata.titles !== titles
  ) {
    attentionMetadata = { attention, titles }
  }

  return attentionMetadata
}

export function useTerminalNavigationMetadata() {
  return useSyncExternalStore(
    terminalSessions.subscribe,
    getNavigationMetadata,
    () => EMPTY_NAVIGATION_METADATA
  )
}

export function useTerminalAttentionMetadata() {
  return useSyncExternalStore(
    terminalSessions.subscribe,
    getAttentionMetadata,
    () => EMPTY_ATTENTION_METADATA
  )
}
