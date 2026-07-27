export type { TerminalProgress } from '@treeport/shared'
export {
  terminalKeyboardInput,
  terminalOptions,
  terminalProgressLabel
} from './terminal-browser'
export * from './terminal-session-client'
export * from './terminal-session-manager'

import { TerminalSessionManager } from './terminal-session-manager'

export const terminalSessions = new TerminalSessionManager()
