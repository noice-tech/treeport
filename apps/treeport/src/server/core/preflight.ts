import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppConfig } from './config'

const execute = promisify(execFile)

export interface RuntimePrerequisites {
  gitVersion: string
}

export async function checkRuntimePrerequisites(
  config: Pick<AppConfig, 'gitPath'>
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

  return { gitVersion }
}
