import fs from 'node:fs/promises'
import path from 'node:path'

export function browserSetupGuidance(platform = process.platform): string {
  return [
    'Install Google Chrome or Chromium on the Treeport daemon host (which may be different from this device).',
    ...(platform === 'linux'
      ? [
          'On Ubuntu with Snap available, run: sudo snap install chromium',
          'Ubuntu installation instructions: https://snapcraft.io/install/chromium/ubuntu'
        ]
      : []),
    'Google Chrome: https://www.google.com/chrome/',
    'Then click Retry, or retry your browser command.',
    'For an existing browser, set TREEPORT_BROWSER_EXECUTABLE to its absolute executable path in the daemon environment and restart the daemon.',
    'Treeport does not install browsers automatically or disable their sandbox.'
  ].join('\n')
}

export async function browserRuntime(platform = process.platform): Promise<{
  executablePath: string | null
  channel: 'chrome' | 'chromium'
  launchError: string | null
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
      launchError: `TREEPORT_BROWSER_EXECUTABLE must be an absolute path.\n${browserSetupGuidance(platform)}`
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
    launchError: `${configured ? `TREEPORT_BROWSER_EXECUTABLE is missing or not executable: ${configured}.` : 'No supported Chrome or Chromium executable was found on the Treeport daemon host.'}\n${browserSetupGuidance(platform)}`
  }
}
