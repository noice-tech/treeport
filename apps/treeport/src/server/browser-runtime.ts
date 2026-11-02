import fs from 'node:fs/promises'
import path from 'node:path'

// EXTERNAL: Google ships Linux Chrome only as x86-64 .deb/.rpm packages.
export async function chromeInstallCommand(
  platform = process.platform
): Promise<string | null> {
  const apt = await fs.access('/usr/bin/apt', fs.constants.X_OK).then(
    () => true,
    () => false
  )

  return platform === 'linux' && process.arch === 'x64' && apt
    ? 'wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y /tmp/chrome.deb'
    : null
}

export function browserSetupGuidance(installCommand: string | null): string {
  return [
    'Install Google Chrome or Chromium on the Treeport daemon host (which may be different from this device).',
    ...(installCommand
      ? [`To install Google Chrome, run: ${installCommand}`]
      : []),
    'Google Chrome: https://www.google.com/chrome/',
    'Then click Retry, or retry your browser command.',
    'For an existing browser, set TREEPORT_BROWSER_EXECUTABLE to its absolute executable path in the daemon environment and restart the daemon.',
    'Treeport does not install browsers automatically or disable their sandbox.'
  ].join('\n')
}

export class BrowserNotFoundError extends Error {
  readonly reason: string
  readonly installCommand: string | null

  constructor(reason: string, installCommand: string | null) {
    super(`${reason}\n${browserSetupGuidance(installCommand)}`)
    this.reason = reason
    this.installCommand = installCommand
  }
}

export async function browserRuntime(platform = process.platform): Promise<{
  executablePath: string | null
  channel: 'chrome' | 'chromium'
  launchError: BrowserNotFoundError | null
}> {
  const configured = process.env.TREEPORT_BROWSER_EXECUTABLE?.trim()

  const candidates = configured
    ? [configured]
    : platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [
          '/opt/google/chrome/chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium'
        ]

  const channel = configured?.includes('chromium') ? 'chromium' : 'chrome'

  if (configured && !path.isAbsolute(configured)) {
    return {
      executablePath: configured,
      channel,
      launchError: new BrowserNotFoundError(
        'TREEPORT_BROWSER_EXECUTABLE must be an absolute path.',
        await chromeInstallCommand(platform)
      )
    }
  }

  for (const executablePath of candidates) {
    if (
      await fs.access(executablePath, fs.constants.X_OK).then(
        () => true,
        () => false
      )
    ) {
      return {
        executablePath,
        channel: executablePath.includes('chromium') ? 'chromium' : 'chrome',
        launchError: null
      }
    }
  }

  return {
    executablePath: configured || null,
    channel,
    launchError: new BrowserNotFoundError(
      configured
        ? `TREEPORT_BROWSER_EXECUTABLE is missing or not executable: ${configured}.`
        : 'No supported Chrome or Chromium executable was found on the Treeport daemon host.',
      await chromeInstallCommand(platform)
    )
  }
}
