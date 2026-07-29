import { spawn } from 'node:child_process'
import { open, readFile, unlink } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const loopbackHost = '127.0.0.1'
const webHost = '0.0.0.0'
const startupLockPath = path.join(
  os.tmpdir(),
  `treeport-development-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.lock`
)

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

function networkUrls(port) {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => `http://${address.address}:${port}`)
}

async function waitForStackPorts(apiPort, webPort, childExit) {
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
  const releaseStartupLock = await acquireStartupLock()
  const apiPort = await findAvailablePort(8733, loopbackHost)
  const webPort = await findAvailablePort(
    5173,
    [webHost, loopbackHost],
    new Set([apiPort])
  )
  const apiUrl = `http://${loopbackHost}:${apiPort}`
  const webUrl = `http://${loopbackHost}:${webPort}`
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  )
  const environment = {
    ...process.env,
    TREEPORT_HOST: loopbackHost,
    TREEPORT_PORT: String(apiPort),
    TREEPORT_API_URL: apiUrl,
    TREEPORT_WEB_HOST: webHost,
    TREEPORT_WEB_PORT: String(webPort),
    TREEPORT_DESKTOP_URL: webUrl,
    TREEPORT_DESKTOP_USER_DATA: path.join(
      repositoryRoot,
      'apps/server/.treeport-dev/desktop'
    )
  }

  console.log('\nTreeport development')
  console.log(`Local:     ${webUrl}`)
  console.log(`API:       ${apiUrl}`)
  console.log(`Web port:  ${webPort}`)
  for (const url of networkUrls(webPort)) {
    console.log(`Network:   ${url}`)
  }

  const child = spawn('pnpm', ['exec', 'turbo', 'run', 'dev'], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
    detached: process.platform !== 'win32'
  })
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

  const portsClaimed = await waitForStackPorts(apiPort, webPort, childExit)
  await releaseStartupLock()
  if (!portsClaimed && child.exitCode === null && child.signalCode === null) {
    console.warn(
      'The development stack did not claim its ports within 30 seconds.'
    )
  }

  const result = await childExit
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
