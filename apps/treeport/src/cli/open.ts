import { spawn } from 'node:child_process'

const DESKTOP_BUNDLE_ID = 'tech.noice.treeport'
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface OpenWorkspaceResult {
  client: 'desktop' | 'browser'
}

interface LaunchResult {
  code: number | null
  stderr: string
}

export type LaunchCommand = (
  executable: string,
  args: string[]
) => Promise<LaunchResult>

export class OpenWorkspaceError extends Error {}

function defaultLaunch(
  executable: string,
  args: string[]
): Promise<LaunchResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let settled = false
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_096)
    })
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        resolve({ code: null, stderr: error.message })
      }
    })
    child.once('close', (code) => {
      if (!settled) {
        settled = true
        resolve({ code, stderr: stderr.trim() })
      }
    })
  })
}

function desktopCanOpen(workspaceUrl: string): boolean {
  if (!URL.canParse(workspaceUrl)) {
    return false
  }

  const url = new URL(workspaceUrl)
  return (
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())))
  )
}

export async function openWorkspace(
  workspaceUrl: string,
  options: {
    platform?: NodeJS.Platform
    launch?: LaunchCommand
  } = {}
): Promise<OpenWorkspaceResult> {
  const platform = options.platform ?? process.platform
  const launch = options.launch ?? defaultLaunch

  if (platform === 'darwin' && desktopCanOpen(workspaceUrl)) {
    const deepLink = new URL('treeport://open')
    deepLink.searchParams.set('url', workspaceUrl)
    const desktop = await launch('open', [
      '-b',
      DESKTOP_BUNDLE_ID,
      deepLink.href
    ])
    if (desktop.code === 0) {
      return { client: 'desktop' }
    }
  }

  const browserCommand = platform === 'darwin' ? 'open' : 'xdg-open'
  const browser = await launch(browserCommand, [workspaceUrl])
  if (browser.code === 0) {
    return { client: 'browser' }
  }

  const diagnostic = browser.stderr ? ` ${browser.stderr}` : ''
  throw new OpenWorkspaceError(
    `Treeport registered the folder, but could not open it automatically.${diagnostic}\nOpen this URL manually: ${workspaceUrl}`
  )
}
