import { spawn, spawnSync } from 'node:child_process'
import { open, readFile, unlink } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const loopbackHost = '127.0.0.1'
const lanHost = '0.0.0.0'
const startupLockPath = path.join(
  os.tmpdir(),
  `treeport-development-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.lock`
)

function urlFor(host, port) {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

function tailscale(args) {
  const result = spawnSync('tailscale', args, { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      'Tailscale is required for `pnpm dev:tailscale`. Install it from https://tailscale.com/download, run `tailscale up`, then retry.'
    )
  }

  if (result.error) {
    throw new Error(`Could not run Tailscale: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()]
      .filter(Boolean)
      .join('\n')
    throw new Error(
      `Tailscale ${args[0]} failed${detail ? `: ${detail}` : ` (status ${result.status})`}`
    )
  }

  return result.stdout
}

function tailscaleJson(args) {
  try {
    const value = JSON.parse(tailscale(args))
    if (typeof value === 'object' && value !== null) {
      return value
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Tailscale ${args.join(' ')} returned invalid JSON`)
    }

    throw error
  }

  throw new Error(`Tailscale ${args.join(' ')} returned invalid JSON`)
}

function tailscaleDnsName() {
  const status = tailscaleJson(['status', '--json'])
  if (status.BackendState !== 'Running') {
    throw new Error(
      'Tailscale is not connected. Run `tailscale up`, then retry `pnpm dev:tailscale`.'
    )
  }

  const dnsName = status.Self?.DNSName
  if (typeof dnsName !== 'string' || !dnsName.trim()) {
    throw new Error(
      'Tailscale did not report a DNS name. Enable MagicDNS, then retry `pnpm dev:tailscale`.'
    )
  }

  return dnsName.trim().replace(/\.$/, '')
}

function tailscalePortIsServed(config, port) {
  if (
    typeof config.TCP === 'object' &&
    config.TCP !== null &&
    Object.hasOwn(config.TCP, String(port))
  ) {
    return true
  }

  if (
    typeof config.Web === 'object' &&
    config.Web !== null &&
    Object.keys(config.Web).some((hostPort) => hostPort.endsWith(`:${port}`))
  ) {
    return true
  }

  return (
    typeof config.Foreground === 'object' &&
    config.Foreground !== null &&
    Object.values(config.Foreground).some(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        tailscalePortIsServed(value, port)
    )
  )
}

function tailscaleProxyForPort(config, port) {
  if (typeof config.Web !== 'object' || config.Web === null) {
    return null
  }

  for (const [hostPort, server] of Object.entries(config.Web)) {
    if (
      hostPort.endsWith(`:${port}`) &&
      typeof server?.Handlers?.['/']?.Proxy === 'string'
    ) {
      return server.Handlers['/'].Proxy
    }
  }

  return null
}

function developmentMode() {
  const mode = process.argv[2]
  if (!mode) {
    return { name: 'local', webHost: loopbackHost }
  }

  if (mode === '--tailscale') {
    return {
      name: 'tailscale',
      webHost: loopbackHost,
      tailscaleDnsName: tailscaleDnsName()
    }
  }

  if (mode === '--lan') {
    return { name: 'lan', webHost: lanHost }
  }

  throw new Error(`Unknown development mode: ${mode}`)
}

async function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false
    }

    throw error
  }
}

async function acquireStartupLock() {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const lock = await open(startupLockPath, 'wx', 0o600)
      await lock.writeFile(String(process.pid))
      return async () => {
        await lock.close()
        await unlink(startupLockPath).catch(() => undefined)
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error
      }

      const owner = Number.parseInt(
        await readFile(startupLockPath, 'utf8').catch(() => ''),
        10
      )
      if (Number.isInteger(owner) && !(await processIsRunning(owner))) {
        await unlink(startupLockPath).catch(() => undefined)
        continue
      }

      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  throw new Error('Timed out waiting for another Treeport development stack')
}

async function portIsAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false)
        return
      }

      reject(error)
    })
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(true)
      })
    })
  })
}

export async function findAvailablePort(
  startPort,
  hosts,
  excludedPorts = new Set()
) {
  const checkedHosts = Array.isArray(hosts) ? hosts : [hosts]
  for (let port = startPort; port <= 65_535; port += 1) {
    if (excludedPorts.has(port)) {
      continue
    }

    let available = true
    for (const host of checkedHosts) {
      if (!(await portIsAvailable(port, host))) {
        available = false
        break
      }
    }
    if (available) {
      return port
    }
  }

  throw new Error(`No available port found at or above ${startPort}`)
}

function sendSignalToChild(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal)
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal)
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error
    }
  }
}

async function waitForStackPorts(apiPort, webPort, webHost, childExit) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const [apiAvailable, webAvailable] = await Promise.all([
      portIsAvailable(apiPort, loopbackHost),
      portIsAvailable(webPort, webHost)
    ])
    if (!apiAvailable && !webAvailable) {
      return true
    }

    const result = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve('retry'), 250)),
      childExit.then(() => 'exit')
    ])
    if (result === 'exit') {
      return false
    }
  }

  return false
}

export async function main() {
  const mode = developmentMode()
  const releaseStartupLock = await acquireStartupLock()
  const apiPort = await findAvailablePort(8733, loopbackHost)
  const webPort = await findAvailablePort(
    5173,
    mode.webHost,
    new Set([apiPort])
  )
  const apiUrl = urlFor(loopbackHost, apiPort)
  const webUrl = urlFor(mode.webHost, webPort)
  let tailscaleRemote = null
  if (mode.name === 'tailscale') {
    const serveConfig = tailscaleJson(['serve', 'status', '--json'])
    let port = webPort
    while (port <= 65_535 && tailscalePortIsServed(serveConfig, port)) {
      port += 1
    }
    if (port > 65_535) {
      throw new Error('Tailscale Serve has no available port')
    }

    tailscale(['serve', '--bg', `--https=${port}`, webUrl])
    tailscaleRemote = {
      port,
      target: webUrl,
      url: `https://${mode.tailscaleDnsName}:${port}`
    }
  }

  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  )
  const environment = {
    ...process.env,
    TREEPORT_HOST: loopbackHost,
    TREEPORT_PORT: String(apiPort),
    TREEPORT_API_URL: apiUrl,
    TREEPORT_WEB_HOST: mode.webHost,
    TREEPORT_WEB_PORT: String(webPort),
    TREEPORT_DESKTOP_URL: webUrl,
    TREEPORT_DESKTOP_USER_DATA: path.join(
      repositoryRoot,
      'apps/treeport/.treeport-dev/desktop'
    )
  }

  console.log('\nTreeport development')
  console.log(`Local:     ${webUrl}`)
  if (tailscaleRemote) {
    console.log(`Tailscale: ${tailscaleRemote.url}`)
  }

  console.log(`API:       ${apiUrl}`)
  console.log(`Web port:  ${webPort}`)

  if (mode.name === 'lan') {
    console.warn(
      'LAN mode exposes an unauthenticated development server on every network interface. Use only on a trusted LAN.'
    )
  }

  const child = spawn(
    'pnpm',
    [
      '--parallel',
      '--filter',
      '@treeport/treeport',
      '--filter',
      '@treeport/desktop',
      'dev'
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
      detached: process.platform !== 'win32'
    }
  )
  const childExit = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, signal: null, error }))
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }))
  })

  let requestedSignal = null
  let forceKillTimer = null
  const stop = (signal) => {
    if (requestedSignal) {
      sendSignalToChild(child, 'SIGKILL')
      return
    }

    requestedSignal = signal
    sendSignalToChild(child, signal)
    forceKillTimer = setTimeout(
      () => sendSignalToChild(child, 'SIGKILL'),
      5_000
    )
    forceKillTimer.unref()
  }
  const stopOnSigint = () => stop('SIGINT')
  const stopOnSigterm = () => stop('SIGTERM')
  const stopOnSighup = () => stop('SIGHUP')
  process.on('SIGINT', stopOnSigint)
  process.on('SIGTERM', stopOnSigterm)
  process.on('SIGHUP', stopOnSighup)

  const portsClaimed = await waitForStackPorts(
    apiPort,
    webPort,
    mode.webHost,
    childExit
  )
  await releaseStartupLock()
  if (!portsClaimed && child.exitCode === null && child.signalCode === null) {
    console.warn(
      'The development stack did not claim its ports within 30 seconds.'
    )
  }

  const result = await childExit
  if (tailscaleRemote) {
    try {
      const serveConfig = tailscaleJson(['serve', 'status', '--json'])
      if (
        tailscaleProxyForPort(serveConfig, tailscaleRemote.port)?.replace(
          /\/$/,
          ''
        ) === tailscaleRemote.target
      ) {
        tailscale(['serve', `--https=${tailscaleRemote.port}`, 'off'])
      }
    } catch (error) {
      console.warn(`Could not remove Tailscale development route: ${error}`)
    }
  }

  if (forceKillTimer) {
    clearTimeout(forceKillTimer)
  }

  process.off('SIGINT', stopOnSigint)
  process.off('SIGTERM', stopOnSigterm)
  process.off('SIGHUP', stopOnSighup)

  if (result.error) {
    console.error(`Could not start Turbo: ${result.error.message}`)
  } else if (!requestedSignal && result.code !== 0 && result.signal === null) {
    console.error(
      'The development stack exited unexpectedly. A selected port may have been claimed; retry pnpm dev.'
    )
  }

  process.exitCode =
    requestedSignal === 'SIGINT'
      ? 130
      : requestedSignal === 'SIGTERM'
        ? 143
        : requestedSignal === 'SIGHUP'
          ? 129
          : (result.code ?? 1)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
