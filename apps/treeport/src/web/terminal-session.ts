export type { TerminalActivity } from '#protocol/terminal-session'

export {
  terminalKeyboardInput,
  terminalInputWithModifiers,
  terminalDisplayTitle,
  terminalTitleInTree,
  terminalOptions,
  terminalActivityLabel
} from './terminal-browser'

export * from './terminal-session-client'

export * from './terminal-session-manager'

import { TerminalSessionManager } from './terminal-session-manager'

export const terminalSessions = new TerminalSessionManager()
