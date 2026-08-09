import { spawn, spawnSync } from 'node:child_process'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const loopbackHost = '127.0.0.1'
const lanHost = '0.0.0.0'
const developmentUser =
  typeof process.getuid === 'function' ? process.getuid() : 'user'
const startupLockPath = path.join(
  os.tmpdir(),
  `treeport-development-${developmentUser}.lock`
)
const tailscaleLeaseDirectory = path.join(
  os.tmpdir(),
  `treeport-development-tailscale-${developmentUser}`
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

async function cleanStaleTailscaleLeases(config) {
  await mkdir(tailscaleLeaseDirectory, { recursive: true })
  const entries = await readdir(tailscaleLeaseDirectory, {
    withFileTypes: true
  })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    const leasePath = path.join(tailscaleLeaseDirectory, entry.name)
    const lease = await readFile(leasePath, 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (
      !lease ||
      !Number.isInteger(lease.pid) ||
      !Number.isInteger(lease.port) ||
      typeof lease.target !== 'string'
    ) {
      await rm(leasePath, { force: true })
      continue
    }

    if (await processIsRunning(lease.pid)) {
      continue
    }

    if (
      tailscaleProxyForPort(config, lease.port)?.replace(/\/$/, '') ===
      lease.target
    ) {
      tailscale(['serve', `--https=${lease.port}`, 'off'])
    }

    await rm(leasePath, { force: true })
  }
}

function developmentMode() {
  const mode = process.argv[2]
  if (!mode) {
    return { name: 'local', appHost: loopbackHost }
  }

  if (mode === '--tailscale') {
    return {
      name: 'tailscale',
      appHost: loopbackHost,
      tailscaleDnsName: tailscaleDnsName()
    }
  }

  if (mode === '--lan') {
    return { name: 'lan', appHost: lanHost }
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

async function waitForStackPort(appPort, appHost, childExit) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!(await portIsAvailable(appPort, appHost))) {
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
  let tailscaleServeConfig =
    mode.name === 'tailscale'
      ? tailscaleJson(['serve', 'status', '--json'])
      : null
  if (tailscaleServeConfig) {
    await cleanStaleTailscaleLeases(tailscaleServeConfig)
    tailscaleServeConfig = tailscaleJson(['serve', 'status', '--json'])
  }

  let appPort = await findAvailablePort(8733, mode.appHost)
  while (
    tailscaleServeConfig &&
    tailscalePortIsServed(tailscaleServeConfig, appPort) &&
    tailscaleProxyForPort(tailscaleServeConfig, appPort)?.replace(/\/$/, '') !==
      urlFor(loopbackHost, appPort)
  ) {
    appPort = await findAvailablePort(appPort + 1, mode.appHost)
  }
  const appUrl = urlFor(loopbackHost, appPort)
  let tailscaleRemote = null
  if (mode.name === 'tailscale') {
    let leasePath = null
    if (
      tailscaleProxyForPort(tailscaleServeConfig, appPort)?.replace(
        /\/$/,
        ''
      ) !== appUrl
    ) {
      leasePath = path.join(tailscaleLeaseDirectory, `${process.pid}.json`)
      await writeFile(
        leasePath,
        JSON.stringify({ pid: process.pid, port: appPort, target: appUrl })
      )

      tailscale(['serve', '--bg', `--https=${appPort}`, appUrl])
    }

    tailscaleRemote = {
      port: appPort,
      target: appUrl,
      url: `https://${mode.tailscaleDnsName}:${appPort}`,
      leasePath
    }
  }

  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  )
  const environment = {
    ...process.env,
    TREEPORT_HOST: mode.appHost,
    TREEPORT_PORT: String(appPort),
    TREEPORT_API_URL: appUrl,
    TREEPORT_DAEMON_LIFECYCLE: 'external',
    TREEPORT_DESKTOP_URL: appUrl,
    TREEPORT_DESKTOP_USER_DATA: path.join(
      repositoryRoot,
      'apps/treeport/.treeport-dev/desktop'
    )
  }
  delete environment.TREEPORT_WEB_HOST
  delete environment.TREEPORT_WEB_PORT
  delete environment.TREEPORT_DESKTOP_RENDERER_PORT

  console.log('\nTreeport development')
  console.log(`Local:     ${appUrl}`)
  if (tailscaleRemote) {
    console.log(`Tailscale: ${tailscaleRemote.url}`)
  }

  if (mode.name === 'lan') {
    console.warn(
      'LAN mode exposes an unauthenticated development server on every network interface. Use only on a trusted LAN.'
    )
  }

  const child = spawn(
    'pnpm',
    [
      'exec',
      'turbo',
      'run',
      'dev',
      '--ui=stream',
      '--filter=@treeport/treeport',
      '--filter=@treeport/desktop'
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

  const portsClaimed = await waitForStackPort(appPort, mode.appHost, childExit)
  await releaseStartupLock()
  if (!portsClaimed && child.exitCode === null && child.signalCode === null) {
    console.warn(
      'The development stack did not claim its port within 30 seconds.'
    )
  }

  const result = await childExit
  if (tailscaleRemote?.leasePath) {
    let cleanupComplete = false
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

      cleanupComplete = true
    } catch (error) {
      console.warn(`Could not remove Tailscale development route: ${error}`)
    }

    if (cleanupComplete) {
      await rm(tailscaleRemote.leasePath, { force: true })
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
