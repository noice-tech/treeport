import fs from 'node:fs/promises'
import path from 'node:path'
import { BROWSER_CONTAINER_IMAGE } from './browser-container'

export function usesBrowserContainer(platform = process.platform): boolean {
  return (
    platform === 'linux' && !process.env.TREEPORT_BROWSER_EXECUTABLE?.trim()
  )
}

// One executable resolution path for launches and diagnostics. Never silently
// download a browser or disable its sandbox when the host is misconfigured.
export async function browserRuntime(platform = process.platform): Promise<{
  executablePath: string
  channel: 'chrome' | 'chromium' | 'docker'
}> {
  const configured = process.env.TREEPORT_BROWSER_EXECUTABLE?.trim()
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('TREEPORT_BROWSER_EXECUTABLE must be an absolute path.')
    }

    return { executablePath: configured, channel: 'chromium' }
  }

  if (usesBrowserContainer(platform)) {
    return { executablePath: BROWSER_CONTAINER_IMAGE, channel: 'docker' }
  }

  const candidates =
    platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [
          '/opt/google/chrome/chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser'
        ]
  for (const executablePath of candidates) {
    if (
      await fs.access(executablePath, fs.constants.X_OK).then(
        () => true,
        () => false
      )
    ) {
      return {
        executablePath,
        channel: executablePath.includes('chromium') ? 'chromium' : 'chrome'
      }
    }
  }
  return { executablePath: candidates[0]!, channel: 'chrome' }
}
