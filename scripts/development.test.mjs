import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from './development.mjs'

const servers = []
const children = []
const temporaryDirectories = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve)
        })
    )
  )
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function listen(port, host = '127.0.0.1') {
  const server = net.createServer()
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port }, resolve)
  })
  return server
}

async function waitUntil(check, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

describe('development environment allocation', () => {
  it('selects the next port when another checkout is already listening', async () => {
    const server = net.createServer()
    servers.push(server)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0 }, resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server')
    }

    expect(await findAvailablePort(address.port, '127.0.0.1')).toBeGreaterThan(
      address.port
    )
  })

  it('starts concurrent checkouts on sequential ports and stops their process groups', async () => {
    const occupiedDesktopRendererPort = await findAvailablePort(6173, [
      '127.0.0.1',
      '::1'
    ])
    await listen(occupiedDesktopRendererPort, '::1')
    const occupiedApiPort = await findAvailablePort(8733, '127.0.0.1')
    await listen(occupiedApiPort)
    const expectedApiPort = await findAvailablePort(8733, '127.0.0.1')
    const occupiedWebPort = await findAvailablePort(
      5173,
      '127.0.0.1',
      new Set([expectedApiPort])
    )
    await listen(occupiedWebPort)
    const expectedWebPort = await findAvailablePort(
      5173,
      '127.0.0.1',
      new Set([expectedApiPort])
    )

    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'treeport-development-test-')
    )
    temporaryDirectories.push(directory)
    const fakePnpm = path.join(directory, 'pnpm')
    await writeFile(
      fakePnpm,
      `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const api = net.createServer().listen(
  Number(process.env.TREEPORT_PORT),
  process.env.TREEPORT_HOST
)
const web = net.createServer().listen(
  Number(process.env.TREEPORT_WEB_PORT),
  process.env.TREEPORT_WEB_HOST
)
const desktop = net.createServer().listen(
  Number(process.env.TREEPORT_DESKTOP_RENDERER_PORT),
  '127.0.0.1',
  () => fs.writeFileSync(process.env.FAKE_ENVIRONMENT_FILE, JSON.stringify({
    apiHost: process.env.TREEPORT_HOST,
    apiPort: process.env.TREEPORT_PORT,
    webHost: process.env.TREEPORT_WEB_HOST,
    webPort: process.env.TREEPORT_WEB_PORT,
    desktopUrl: process.env.TREEPORT_DESKTOP_URL,
    desktopRendererPort: process.env.TREEPORT_DESKTOP_RENDERER_PORT,
    desktopUserData: process.env.TREEPORT_DESKTOP_USER_DATA,
    arguments: process.argv.slice(2)
  }))
)
const stop = (signal) => {
  fs.writeFileSync(process.env.FAKE_SIGNAL_FILE, signal)
  api.close()
  web.close()
  desktop.close(() => process.exit(0))
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGHUP', () => stop('SIGHUP'))
`
    )
    await chmod(fakePnpm, 0o755)

    await writeFile(
      path.join(directory, 'tailscale'),
      `#!/usr/bin/env node
process.stdout.write(process.env.FAKE_TAILSCALE_STATUS || '')
`
    )
    await chmod(path.join(directory, 'tailscale'), 0o755)

    const startDevelopment = (name, args = [], environment = {}) => {
      const environmentFile = path.join(directory, `${name}-environment`)
      const signalFile = path.join(directory, `${name}-signal`)
      let output = ''
      const child = spawn(
        process.execPath,
        ['scripts/development.mjs', ...args],
        {
          cwd: path.resolve('.'),
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            FAKE_ENVIRONMENT_FILE: environmentFile,
            FAKE_SIGNAL_FILE: signalFile,
            ...environment
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      children.push(child)
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
      return {
        child,
        environmentFile,
        signalFile,
        output: () => output,
        exited: new Promise((resolve) => {
          child.once('exit', (code, signal) => resolve({ code, signal }))
        })
      }
    }

    const first = startDevelopment('first')
    const second = startDevelopment('second')
    await waitUntil(
      async () =>
        Promise.all(
          [first, second].map(({ environmentFile }) =>
            readFile(environmentFile).then(
              () => true,
              () => false
            )
          )
        ).then((results) => results.every(Boolean)),
      'both development child processes'
    )

    const environments = await Promise.all(
      [first, second].map(({ environmentFile }) =>
        readFile(environmentFile, 'utf8').then(JSON.parse)
      )
    )
    expect(environments.map(({ apiPort }) => apiPort).sort()).toEqual([
      String(expectedApiPort),
      String(expectedApiPort + 1)
    ])
    expect(environments.map(({ webPort }) => webPort).sort()).toEqual([
      String(expectedWebPort),
      String(expectedWebPort + 1)
    ])
    expect(
      new Set(
        environments.map(({ desktopRendererPort }) => desktopRendererPort)
      )
    ).toHaveProperty('size', 2)
    for (const environment of environments) {
      expect(Number(environment.desktopRendererPort)).toBeGreaterThan(
        occupiedDesktopRendererPort
      )
      expect(environment.desktopRendererPort).not.toBe(environment.apiPort)
      expect(environment.desktopRendererPort).not.toBe(environment.webPort)
    }
    expect(environments[0].desktopUrl).toBe(
      `http://127.0.0.1:${environments[0].webPort}`
    )
    expect(environments[0].desktopUserData).toBe(
      path.resolve('apps/treeport/.treeport-dev/desktop')
    )
    expect(environments[0].arguments).toEqual([
      '--parallel',
      '--filter',
      '@treeport/treeport',
      '--filter',
      '@treeport/desktop',
      'dev'
    ])
    expect(environments[1].arguments).toEqual(environments[0].arguments)
    for (let index = 0; index < environments.length; index += 1) {
      const environment = environments[index]
      const development = [first, second][index]
      expect(environment.apiHost).toBe('127.0.0.1')
      expect(environment.webHost).toBe('127.0.0.1')
      expect(development.output()).toContain(
        `Local:     http://127.0.0.1:${environment.webPort}`
      )
      expect(development.output()).toContain(
        `API:       http://127.0.0.1:${environment.apiPort}`
      )
      expect(development.output()).toContain(
        `Desktop renderer port: ${environment.desktopRendererPort}`
      )
    }

    first.child.kill('SIGINT')
    second.child.kill('SIGHUP')
    await expect(first.exited).resolves.toEqual({ code: 130, signal: null })
    await expect(second.exited).resolves.toEqual({ code: 129, signal: null })
    await expect(readFile(first.signalFile, 'utf8')).resolves.toBe('SIGINT')
    await expect(readFile(second.signalFile, 'utf8')).resolves.toBe('SIGHUP')
  }, 10_000)

  it('keeps Tailscale development local and adds a temporary remote route', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'treeport-development-tailscale-test-')
    )
    temporaryDirectories.push(directory)
    const environmentFile = path.join(directory, 'environment')
    const tailscaleStateFile = path.join(directory, 'tailscale-state')
    const tailscaleCallsFile = path.join(directory, 'tailscale-calls')
    const fakePnpm = path.join(directory, 'pnpm')
    await writeFile(
      fakePnpm,
      `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const api = net.createServer().listen(Number(process.env.TREEPORT_PORT), process.env.TREEPORT_HOST)
const web = net.createServer().listen(Number(process.env.TREEPORT_WEB_PORT), process.env.TREEPORT_WEB_HOST, () => fs.writeFileSync(process.env.FAKE_ENVIRONMENT_FILE, JSON.stringify(process.env)))
const stop = () => api.close(() => web.close(() => process.exit(0)))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`
    )
    await chmod(fakePnpm, 0o755)
    await writeFile(
      path.join(directory, 'tailscale'),
      `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_TAILSCALE_CALLS_FILE, JSON.stringify(args) + '\\n')
if (args[0] === 'status') {
  process.stdout.write(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'treeport-dev.example.ts.net.' } }))
} else if (args[0] === 'serve' && args[1] === 'status') {
  if (fs.existsSync(process.env.FAKE_TAILSCALE_STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(process.env.FAKE_TAILSCALE_STATE_FILE, 'utf8'))
    process.stdout.write(JSON.stringify({
      TCP: { [state.port]: { HTTPS: true } },
      Web: { ['treeport-dev.example.ts.net:' + state.port]: { Handlers: { '/': { Proxy: state.target } } } }
    }))
  } else {
    process.stdout.write('{}')
  }
} else if (args[0] === 'serve' && args.includes('--bg')) {
  fs.writeFileSync(process.env.FAKE_TAILSCALE_STATE_FILE, JSON.stringify({
    port: args.find((arg) => arg.startsWith('--https=')).slice('--https='.length),
    target: args.at(-1)
  }))
} else if (args[0] === 'serve' && args.at(-1) === 'off') {
  fs.rmSync(process.env.FAKE_TAILSCALE_STATE_FILE, { force: true })
}
`
    )
    await chmod(path.join(directory, 'tailscale'), 0o755)

    let output = ''
    const child = spawn(
      process.execPath,
      ['scripts/development.mjs', '--tailscale'],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_ENVIRONMENT_FILE: environmentFile,
          FAKE_TAILSCALE_STATE_FILE: tailscaleStateFile,
          FAKE_TAILSCALE_CALLS_FILE: tailscaleCallsFile
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    children.push(child)
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    await waitUntil(
      () =>
        readFile(environmentFile).then(
          () => true,
          () => false
        ),
      'the Tailscale development process'
    )
    const environment = JSON.parse(await readFile(environmentFile, 'utf8'))
    const tailscaleState = JSON.parse(
      await readFile(tailscaleStateFile, 'utf8')
    )
    const localUrl = `http://127.0.0.1:${environment.TREEPORT_WEB_PORT}`
    expect(environment.TREEPORT_HOST).toBe('127.0.0.1')
    expect(environment.TREEPORT_WEB_HOST).toBe('127.0.0.1')
    expect(environment.TREEPORT_DESKTOP_URL).toBe(localUrl)
    expect(tailscaleState.target).toBe(localUrl)
    expect(output).toContain(`Local:     ${localUrl}`)
    expect(output).toContain(
      `Tailscale: https://treeport-dev.example.ts.net:${tailscaleState.port}`
    )

    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
    await expect(readFile(tailscaleStateFile, 'utf8')).rejects.toThrow()
    expect(await readFile(tailscaleCallsFile, 'utf8')).toContain(
      `["serve","--https=${tailscaleState.port}","off"]`
    )
  }, 10_000)
})
