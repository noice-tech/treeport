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

async function listen(port) {
  const server = net.createServer()
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, resolve)
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
    await listen(4780)
    await listen(5173)

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
  process.env.TREEPORT_WEB_HOST,
  () => fs.writeFileSync(process.env.FAKE_ENVIRONMENT_FILE, JSON.stringify({
    apiHost: process.env.TREEPORT_HOST,
    apiPort: process.env.TREEPORT_PORT,
    webHost: process.env.TREEPORT_WEB_HOST,
    webPort: process.env.TREEPORT_WEB_PORT
  }))
)
const stop = (signal) => {
  fs.writeFileSync(process.env.FAKE_SIGNAL_FILE, signal)
  api.close()
  web.close(() => process.exit(0))
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGHUP', () => stop('SIGHUP'))
`
    )
    await chmod(fakePnpm, 0o755)

    const startDevelopment = (name) => {
      const environmentFile = path.join(directory, `${name}-environment`)
      const signalFile = path.join(directory, `${name}-signal`)
      let output = ''
      const child = spawn(process.execPath, ['scripts/development.mjs'], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          FAKE_ENVIRONMENT_FILE: environmentFile,
          FAKE_SIGNAL_FILE: signalFile
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
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
      '4781',
      '4782'
    ])
    expect(environments.map(({ webPort }) => webPort).sort()).toEqual([
      '5174',
      '5175'
    ])
    for (let index = 0; index < environments.length; index += 1) {
      const environment = environments[index]
      const development = [first, second][index]
      expect(environment.apiHost).toBe('127.0.0.1')
      expect(environment.webHost).toBe('0.0.0.0')
      expect(development.output()).toContain(
        `Local:     http://127.0.0.1:${environment.webPort}`
      )
      expect(development.output()).toContain(
        `API:       http://127.0.0.1:${environment.apiPort}`
      )
    }

    first.child.kill('SIGINT')
    second.child.kill('SIGHUP')
    await expect(first.exited).resolves.toEqual({ code: 130, signal: null })
    await expect(second.exited).resolves.toEqual({ code: 129, signal: null })
    await expect(readFile(first.signalFile, 'utf8')).resolves.toBe('SIGINT')
    await expect(readFile(second.signalFile, 'utf8')).resolves.toBe('SIGHUP')
  }, 10_000)
})
