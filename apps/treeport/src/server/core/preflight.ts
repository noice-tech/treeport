import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppConfig } from './config'

const execute = promisify(execFile)

export interface RuntimePrerequisites {
  gitVersion: string
  tmuxVersion: string | null
}

function parseTmuxVersion(output: string): [number, number] | null {
  const match = /tmux\s+(\d+)\.(\d+)/i.exec(output.trim())
  return match ? [Number(match[1]), Number(match[2])] : null
}

export async function checkRuntimePrerequisites(
  config: Pick<
    AppConfig,
    'gitPath' | 'tmuxPath' | 'experimentalTerminalBackend'
  >
): Promise<RuntimePrerequisites> {
  let gitVersion: string
  try {
    const result = await execute(config.gitPath, ['--version'], {
      timeout: 5_000
    })
    gitVersion = result.stdout.trim()
  } catch (error) {
    throw new Error(
      `Git is required but ${config.gitPath} could not be executed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (config.experimentalTerminalBackend === 'direct-pty') {
    return { gitVersion, tmuxVersion: null }
  }

  let tmuxVersion: string
  try {
    const result = await execute(config.tmuxPath, ['-V'], { timeout: 5_000 })
    tmuxVersion = result.stdout.trim()
  } catch (error) {
    throw new Error(
      `tmux 3.2 or newer is required but ${config.tmuxPath} could not be executed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const parsed = parseTmuxVersion(tmuxVersion)
  if (!parsed || parsed[0] < 3 || (parsed[0] === 3 && parsed[1] < 2)) {
    throw new Error(
      `tmux 3.2 or newer is required; ${config.tmuxPath} reported ${tmuxVersion || 'an unknown version'}`
    )
  }

  return { gitVersion, tmuxVersion }
}
