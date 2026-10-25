export type { TerminalActivity } from '@treeport/shared'

export {
  terminalKeyboardInput,
  terminalInputWithModifiers,
  terminalDisplayTitle,
  terminalOptions,
  terminalActivityLabel
} from './terminal-browser'

export * from './terminal-session-client'

export * from './terminal-session-manager'

import { TerminalSessionManager } from './terminal-session-manager'

export const terminalSessions = new TerminalSessionManager()
