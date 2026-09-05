import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupDevelopmentRuntime } from './cleanup-development-runtime.mjs'

const directories: string[] = []
const processes: number[] = []
const sockets: string[] = []

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<Value>(read: () => Promise<Value | null>) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) {
      return value
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for development runtime fixture')
}

async function reservePort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  // SAFETY: This server listens on a TCP host, so Node returns AddressInfo.
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

async function startDaemon(
  dataDir: string,
  runtimeDir: string
): Promise<ChildProcess> {
  const port = await reservePort()
  const instanceId = crypto.randomUUID()
  const apiUrl = `http://127.0.0.1:${port}`
  const program = `
    const http = require('node:http')
    const server = http.createServer((request, response) => {
      if (request.url !== '/api/health') { response.writeHead(404).end(); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        pid: process.pid,
        instanceId: ${JSON.stringify(instanceId)},
        daemonLifecycle: 'external',
        installationMethod: 'development'
      }))
    })
    server.listen(${port}, '127.0.0.1')
    process.on('SIGTERM', () => server.close(() => process.exit(0)))
  `
  const child = spawn(process.execPath, ['-e', program], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  if (!child.pid) {
    throw new Error('Daemon fixture did not start')
  }

  processes.push(child.pid)
  const record = {
    pid: child.pid,
    instanceId,
    version: 'development',
    apiUrl,
    dataDir,
    startedAt: new Date().toISOString(),
    installationMethod: 'development',
    daemonLifecycle: 'external'
  }
  await Promise.all([
    fs.writeFile(path.join(runtimeDir, 'daemon.json'), JSON.stringify(record)),
    fs.writeFile(path.join(dataDir, 'daemon.lock'), JSON.stringify(record))
  ])
  await waitFor(() =>
    fetch(`${apiUrl}/api/health`)
      .then((response) => (response.ok ? true : null))
      .catch(() => null)
  )
  return child
}

async function startTerminalHost(
  dataDir: string,
  runtimeDir: string,
  fixtureDirectory: string
): Promise<{ hostPid: number; terminalPid: number }> {
  const hostKey = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 20)
  const hostId = crypto.randomUUID()
  const token = crypto.randomBytes(24).toString('base64url')
  const socketPath = path.join(
    os.tmpdir(),
    `treeport-${process.getuid?.() ?? 'user'}`,
    `terminal-${hostKey}.sock`
  )
  const recordPath = path.join(runtimeDir, `terminal-host-${hostKey}.json`)
  const terminalPidPath = path.join(fixtureDirectory, 'terminal.pid')
  sockets.push(socketPath)
  await Promise.all([
    fs.mkdir(fixtureDirectory, { recursive: true }),
    fs.mkdir(path.dirname(socketPath), { recursive: true }),
    fs.writeFile(path.join(dataDir, 'terminal-host.token'), `${token}\n`),
    fs.rm(socketPath, { force: true })
  ])

  const program = `
    const fs = require('node:fs')
    const net = require('node:net')
    const pty = require('node-pty')
    const terminal = pty.spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)")}], {
      cwd: ${JSON.stringify(fixtureDirectory)}, env: process.env
    })
    fs.writeFileSync(${JSON.stringify(terminalPidPath)}, String(terminal.pid))
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 4) return
        const length = buffer.readUInt32BE(0)
        if (buffer.length < length + 4) return
        const request = JSON.parse(buffer.subarray(4, length + 4))
        const authenticated = request.method === 'handshake' &&
          request.input.token === ${JSON.stringify(token)} &&
          request.input.hostKey === ${JSON.stringify(hostKey)}
        const response = authenticated
          ? { protocolVersion: 3, type: 'response', id: request.id, error: null,
              result: { protocolVersion: 3, hostId: ${JSON.stringify(hostId)},
                hostKey: ${JSON.stringify(hostKey)}, pid: process.pid,
                socketPath: ${JSON.stringify(socketPath)}, startedAt: new Date().toISOString(),
                liveSessionCount: 1 } }
          : { protocolVersion: 3, type: 'response', id: request.id,
              result: null, error: { code: 'AUTH_FAILED', message: 'failed' } }
        const payload = Buffer.from(JSON.stringify(response))
        const header = Buffer.alloc(4); header.writeUInt32BE(payload.length)
        socket.write(Buffer.concat([header, payload]))
      })
    })
    server.listen(${JSON.stringify(socketPath)}, () => {
      fs.chmodSync(${JSON.stringify(socketPath)}, 0o600)
      fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
        protocolVersion: 3, hostId: ${JSON.stringify(hostId)},
        hostKey: ${JSON.stringify(hostKey)}, pid: process.pid,
        socketPath: ${JSON.stringify(socketPath)}, startedAt: new Date().toISOString()
      }))
    })
    process.on('SIGTERM', () => process.exit(0))
  `
  const child = spawn(process.execPath, ['-e', program], {
    cwd: path.resolve(import.meta.dirname, '..'),
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  if (!child.pid) {
    throw new Error('Terminal host fixture did not start')
  }

  processes.push(child.pid)
  const terminalPid = await waitFor(() =>
    fs
      .readFile(terminalPidPath, 'utf8')
      .then((value) => Number(value))
      .catch(() => null)
  )
  processes.push(terminalPid)
  await waitFor(() =>
    fs
      .stat(recordPath)
      .then(() => true)
      .catch(() => null)
  )
  return { hostPid: child.pid, terminalPid }
}

afterEach(async () => {
  for (const pid of processes.splice(0).reverse()) {
    if (processExists(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  await Promise.all(
    sockets.splice(0).map((socket) => fs.rm(socket, { force: true }))
  )
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('development runtime cleanup', () => {
  it('stops its daemon, terminal host, and PTY child without touching another worktree', async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-dev-cleanup-')
    )
    directories.push(temporaryRoot)
    const root = await fs.realpath(temporaryRoot)
    const target = path.join(root, 'target')
    const unrelated = path.join(root, 'unrelated')
    const targetData = path.join(target, 'apps/treeport/.treeport-dev/data')
    const targetRuntime = path.join(
      target,
      'apps/treeport/.treeport-dev/runtime'
    )
    const unrelatedData = path.join(
      unrelated,
      'apps/treeport/.treeport-dev/data'
    )
    const unrelatedRuntime = path.join(
      unrelated,
      'apps/treeport/.treeport-dev/runtime'
    )
    await Promise.all([
      fs.mkdir(targetData, { recursive: true }),
      fs.mkdir(targetRuntime, { recursive: true }),
      fs.mkdir(unrelatedData, { recursive: true }),
      fs.mkdir(unrelatedRuntime, { recursive: true })
    ])

    const daemon = await startDaemon(targetData, targetRuntime)
    const targetHost = await startTerminalHost(
      targetData,
      targetRuntime,
      path.join(root, 'target-host')
    )
    const unrelatedHost = await startTerminalHost(
      unrelatedData,
      unrelatedRuntime,
      path.join(root, 'unrelated-host')
    )

    await cleanupDevelopmentRuntime(target, {
      timeoutMs: 300,
      graceMs: 50
    })

    await waitFor(async () =>
      [daemon.pid!, targetHost.hostPid, targetHost.terminalPid].every(
        (pid) => !processExists(pid)
      )
        ? true
        : null
    )
    expect(processExists(unrelatedHost.hostPid)).toBe(true)
    expect(processExists(unrelatedHost.terminalPid)).toBe(true)
  }, 20_000)
})
