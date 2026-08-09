import { spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from './development.mjs'

const servers = []
const children = []
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }

          child.once('exit', resolve)
          child.kill('SIGTERM')
        })
    )
  )
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
  const server = net.createServer((socket) => socket.destroy())
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
    const server = net.createServer((socket) => socket.destroy())
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
    const occupiedAppPort = await findAvailablePort(8733, '127.0.0.1')
    await listen(occupiedAppPort)
    const expectedAppPort = await findAvailablePort(8733, '127.0.0.1')

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
const app = net.createServer().listen(
  Number(process.env.TREEPORT_PORT),
  process.env.TREEPORT_HOST,
  () => fs.writeFileSync(process.env.FAKE_ENVIRONMENT_FILE, JSON.stringify({
    appHost: process.env.TREEPORT_HOST,
    appPort: process.env.TREEPORT_PORT,
    appUrl: process.env.TREEPORT_API_URL,
    daemonLifecycle: process.env.TREEPORT_DAEMON_LIFECYCLE,
    desktopUrl: process.env.TREEPORT_DESKTOP_URL,
    desktopUserData: process.env.TREEPORT_DESKTOP_USER_DATA,
    arguments: process.argv.slice(2)
  }))
)
const stop = (signal) => {
  fs.writeFileSync(process.env.FAKE_SIGNAL_FILE, signal)
  app.close(() => process.exit(0))
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
    expect(environments.map(({ appPort }) => appPort).sort()).toEqual([
      String(expectedAppPort),
      String(expectedAppPort + 1)
    ])
    expect(environments[0].desktopUrl).toBe(environments[0].appUrl)
    expect(environments[0].desktopUserData).toBe(
      path.resolve('apps/treeport/.treeport-dev/desktop')
    )
    expect(environments[0].arguments).toEqual([
      'exec',
      'turbo',
      'run',
      'dev',
      '--ui=stream',
      '--filter=@treeport/treeport',
      '--filter=@treeport/desktop'
    ])
    expect(environments[1].arguments).toEqual(environments[0].arguments)
    for (let index = 0; index < environments.length; index += 1) {
      const environment = environments[index]
      const development = [first, second][index]
      expect(environment.appHost).toBe('127.0.0.1')
      expect(environment.daemonLifecycle).toBe('external')
      expect(development.output()).toContain(
        `Local:     http://127.0.0.1:${environment.appPort}`
      )
      expect(development.output()).not.toContain('Web port:')
      expect(development.output()).not.toContain('Desktop renderer port:')
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
const app = net.createServer().listen(Number(process.env.TREEPORT_PORT), process.env.TREEPORT_HOST, () => fs.writeFileSync(process.env.FAKE_ENVIRONMENT_FILE, JSON.stringify(process.env)))
const stop = () => app.close(() => process.exit(0))
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

    const stalePort = await findAvailablePort(8733, '127.0.0.1')
    const staleTarget = `http://127.0.0.1:${stalePort}`
    const leaseDirectory = path.join(
      os.tmpdir(),
      `treeport-development-tailscale-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`
    )
    await mkdir(leaseDirectory, { recursive: true })
    await writeFile(
      path.join(leaseDirectory, '2147483647.json'),
      JSON.stringify({
        pid: 2_147_483_647,
        port: stalePort,
        target: staleTarget
      })
    )
    await writeFile(
      tailscaleStateFile,
      JSON.stringify({ port: String(stalePort), target: staleTarget })
    )

    const startTailscaleDevelopment = () => {
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
      return { child, output: () => output }
    }

    const firstDevelopment = startTailscaleDevelopment()
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
    const localUrl = `http://127.0.0.1:${environment.TREEPORT_PORT}`
    expect(environment.TREEPORT_HOST).toBe('127.0.0.1')
    expect(environment.TREEPORT_API_URL).toBe(localUrl)
    expect(environment.TREEPORT_DESKTOP_URL).toBe(localUrl)
    expect(environment.TREEPORT_WEB_PORT).toBeUndefined()
    expect(environment.TREEPORT_DESKTOP_RENDERER_PORT).toBeUndefined()
    expect(environment.TREEPORT_PORT).toBe(String(stalePort))
    expect(tailscaleState.port).toBe(environment.TREEPORT_PORT)
    expect(tailscaleState.target).toBe(localUrl)
    expect(firstDevelopment.output()).toContain(`Local:     ${localUrl}`)
    expect(firstDevelopment.output()).toContain(
      `Tailscale: https://treeport-dev.example.ts.net:${tailscaleState.port}`
    )

    const firstExited = new Promise((resolve) =>
      firstDevelopment.child.once('exit', resolve)
    )
    firstDevelopment.child.kill('SIGTERM')
    await firstExited
    await expect(readFile(tailscaleStateFile, 'utf8')).rejects.toThrow()
    expect(await readFile(tailscaleCallsFile, 'utf8')).toContain(
      `["serve","--https=${tailscaleState.port}","off"]`
    )

    await rm(environmentFile, { force: true })
    await writeFile(
      tailscaleStateFile,
      JSON.stringify({ port: String(stalePort), target: staleTarget })
    )
    await writeFile(tailscaleCallsFile, '')
    const secondDevelopment = startTailscaleDevelopment()
    await waitUntil(
      () =>
        readFile(environmentFile).then(
          () => true,
          () => false
        ),
      'the Tailscale development process reusing an existing route'
    )
    const reusedEnvironment = JSON.parse(
      await readFile(environmentFile, 'utf8')
    )
    expect(reusedEnvironment.TREEPORT_PORT).toBe(String(stalePort))
    expect(secondDevelopment.output()).toContain(`Local:     ${staleTarget}`)

    const secondExited = new Promise((resolve) =>
      secondDevelopment.child.once('exit', resolve)
    )
    secondDevelopment.child.kill('SIGTERM')
    await secondExited
    await expect(readFile(tailscaleStateFile, 'utf8')).resolves.toBe(
      JSON.stringify({ port: String(stalePort), target: staleTarget })
    )
    const reuseCalls = await readFile(tailscaleCallsFile, 'utf8')
    expect(reuseCalls).not.toContain('"--bg"')
    expect(reuseCalls).not.toContain('"off"')
  }, 10_000)
})
