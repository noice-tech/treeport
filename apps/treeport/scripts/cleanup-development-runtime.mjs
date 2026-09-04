#!/usr/bin/env node
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'

const execute = promisify(execFile)
const DEFAULT_STOP_TIMEOUT_MS = 10_000
const DEFAULT_PROCESS_GRACE_MS = 500
const MAX_HOST_FRAME_BYTES = 64 * 1024 * 1024
const daemonRecordSchema = z.object({
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
  apiUrl: z.string().min(1),
  dataDir: z.string().min(1),
  installationMethod: z.string(),
  daemonLifecycle: z.string()
})
const daemonHealthSchema = z.object({
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
  installationMethod: z.string(),
  daemonLifecycle: z.string()
})
const terminalHostRecordSchema = z.object({
  protocolVersion: z.number().int().positive(),
  hostId: z.string().min(1),
  hostKey: z.string().min(1),
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  startedAt: z.string()
})
const terminalHostResponseSchema = z.object({
  type: z.literal('response'),
  id: z.string(),
  result: terminalHostRecordSchema.nullable().optional(),
  error: z.unknown().nullable()
})

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function readJson(filePath, schema) {
  return fs
    .readFile(filePath, 'utf8')
    .then((value) => schema.parse(JSON.parse(value)))
    .catch((error) => {
      if (error?.code === 'ENOENT') {
        return null
      }

      throw new Error(`Cannot read ${filePath}: ${error.message}`)
    })
}

function validPid(value) {
  return Number.isInteger(value) && value > 0
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return pids.every((pid) => !processExists(pid))
}

async function processTree(rootPid) {
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid='])
  const children = new Map()
  for (const line of stdout.split('\n')) {
    const [pid, parentPid] = line.trim().split(/\s+/u).map(Number)
    if (!validPid(pid) || !validPid(parentPid)) {
      continue
    }

    children.set(parentPid, [...(children.get(parentPid) ?? []), pid])
  }

  const descendants = []
  const pending = [...(children.get(rootPid) ?? [])]
  while (pending.length) {
    const pid = pending.pop()
    descendants.push(pid)
    pending.push(...(children.get(pid) ?? []))
  }
  return [rootPid, ...descendants]
}

async function stopDaemon(dataDir, runtimeDir, timeoutMs) {
  const statePath = path.join(runtimeDir, 'daemon.json')
  const lockPath = path.join(dataDir, 'daemon.lock')
  const [state, lock] = await Promise.all([
    readJson(statePath, daemonRecordSchema),
    readJson(lockPath, daemonRecordSchema)
  ])
  if (!state && !lock) {
    return
  }

  if (
    state &&
    lock &&
    (state.pid !== lock.pid || state.instanceId !== lock.instanceId)
  ) {
    throw new Error(
      `Refusing development daemon cleanup because ${statePath} and ${lockPath} identify different processes`
    )
  }

  const record = state ?? lock
  const recordDataDir = await fs
    .realpath(record.dataDir)
    .catch(() => path.resolve(record.dataDir))
  if (
    recordDataDir !== dataDir ||
    record.daemonLifecycle !== 'external' ||
    record.installationMethod !== 'development'
  ) {
    throw new Error(
      `Refusing development daemon cleanup because its ownership record is invalid for ${dataDir}`
    )
  }

  if (!processExists(record.pid)) {
    for (const [filePath, value] of [
      [statePath, state],
      [lockPath, lock]
    ]) {
      if (value?.instanceId === record.instanceId) {
        await fs.rm(filePath, { force: true })
      }
    }
    return
  }

  if (!URL.canParse(record.apiUrl)) {
    throw new Error(
      'Refusing development daemon cleanup because its URL is invalid'
    )
  }

  const apiUrl = new URL(record.apiUrl)
  if (
    apiUrl.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(apiUrl.hostname)
  ) {
    throw new Error(
      'Refusing development daemon cleanup because its URL is not loopback'
    )
  }

  const health = await fetch(new URL('/api/health', apiUrl), {
    signal: AbortSignal.timeout(Math.min(timeoutMs, 2_000))
  })
    .then(async (response) =>
      response.ok ? daemonHealthSchema.parse(await response.json()) : null
    )
    .catch(() => null)
  if (
    health?.pid !== record.pid ||
    health?.instanceId !== record.instanceId ||
    health?.daemonLifecycle !== 'external' ||
    health?.installationMethod !== 'development'
  ) {
    throw new Error(
      `Refusing to stop PID ${record.pid}: the development daemon did not verify its ownership`
    )
  }

  process.kill(record.pid, 'SIGTERM')
  if (!(await waitForExit([record.pid], timeoutMs))) {
    throw new Error(`Development daemon PID ${record.pid} did not stop`)
  }

  for (const [filePath, value] of [
    [statePath, state],
    [lockPath, lock]
  ]) {
    if (value?.instanceId === record.instanceId) {
      await fs.rm(filePath, { force: true })
    }
  }
}

function hostPaths(dataDir, runtimeDir) {
  const hostKey = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 20)
  return {
    hostKey,
    recordPath: path.join(runtimeDir, `terminal-host-${hostKey}.json`),
    socketPath: path.join(
      os.tmpdir(),
      `treeport-${process.getuid?.() ?? 'user'}`,
      `terminal-${hostKey}.sock`
    ),
    tokenPath: path.join(dataDir, 'terminal-host.token')
  }
}

async function authenticateTerminalHost(
  paths,
  record,
  ignoreAbsentSocket,
  timeoutMs
) {
  const token = await fs
    .readFile(paths.tokenPath, 'utf8')
    .then((value) => value.trim())
    .catch((error) => {
      if (error?.code === 'ENOENT' && !record) {
        return null
      }

      throw error
    })
  if (!token) {
    return null
  }

  if (
    record &&
    (record.hostKey !== paths.hostKey || record.socketPath !== paths.socketPath)
  ) {
    throw new Error(
      `Refusing terminal host cleanup because ${paths.recordPath} is invalid`
    )
  }

  const requestId = crypto.randomUUID()
  const payload = Buffer.from(
    JSON.stringify({
      protocolVersion: record?.protocolVersion ?? 3,
      type: 'request',
      id: requestId,
      method: 'handshake',
      input: {
        token,
        hostKey: paths.hostKey,
        protocolVersion: record?.protocolVersion ?? 3
      }
    })
  )
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.byteLength)

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath)
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(
      () => {
        socket.destroy()
        reject(
          new Error('Timed out while verifying the development terminal host')
        )
      },
      Math.min(timeoutMs, 2_000)
    )
    const finish = (error, result = null) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve(result)
      }
    }
    socket.once('error', (error) => {
      if (
        ignoreAbsentSocket &&
        ['ENOENT', 'ECONNREFUSED'].includes(error.code)
      ) {
        finish(null, null)
        return
      }

      finish(
        new Error(
          `Cannot verify the development terminal host: ${error.message}`
        )
      )
    })
    socket.once('connect', () => socket.write(Buffer.concat([header, payload])))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength < 4) {
        return
      }

      const length = buffer.readUInt32BE(0)
      if (length <= 0 || length > MAX_HOST_FRAME_BYTES) {
        finish(new Error('The development terminal host sent an invalid frame'))
        return
      }

      if (buffer.byteLength < length + 4) {
        return
      }

      let decoded
      try {
        decoded = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'))
      } catch {
        finish(new Error('The development terminal host sent invalid JSON'))
        return
      }
      const parsed = terminalHostResponseSchema.safeParse(decoded)
      const response = parsed.success ? parsed.data : null
      const result = response?.result
      if (
        !response ||
        response.id !== requestId ||
        response.error ||
        !result ||
        result.hostKey !== paths.hostKey ||
        result.socketPath !== paths.socketPath ||
        (record &&
          (result.pid !== record.pid || result.hostId !== record.hostId))
      ) {
        finish(
          new Error(
            'Refusing terminal host cleanup because its identity did not match'
          )
        )
        return
      }

      finish(null, result)
    })
  })
}

async function stopTerminalHost(dataDir, runtimeDir, timeoutMs, graceMs) {
  const paths = hostPaths(dataDir, runtimeDir)
  const record = await readJson(paths.recordPath, terminalHostRecordSchema)
  const recordProcessExists = record ? processExists(record.pid) : false
  const host = await authenticateTerminalHost(
    paths,
    record,
    !recordProcessExists,
    timeoutMs
  )
  if (!host) {
    await Promise.all([
      fs.rm(paths.recordPath, { force: true }),
      fs.rm(paths.socketPath, { force: true })
    ])
    return
  }

  const ownedPids = await processTree(host.pid)
  process.kill(host.pid, 'SIGTERM')
  if (!(await waitForExit(ownedPids, timeoutMs))) {
    for (const pid of [...ownedPids].reverse()) {
      if (processExists(pid)) {
        process.kill(pid, 'SIGTERM')
      }
    }
    await new Promise((resolve) => setTimeout(resolve, graceMs))
    for (const pid of [...ownedPids].reverse()) {
      if (processExists(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    }
  }

  if (!(await waitForExit(ownedPids, Math.max(1_000, graceMs * 2)))) {
    throw new Error('The development terminal host left processes running')
  }

  const current = await readJson(paths.recordPath, terminalHostRecordSchema)
  if (!current || current.hostId === host.hostId) {
    await Promise.all([
      fs.rm(paths.recordPath, { force: true }),
      fs.rm(paths.socketPath, { force: true })
    ])
  }
}

export async function cleanupDevelopmentRuntime(worktreePath, options = {}) {
  const root = await fs.realpath(worktreePath)
  const developmentDirectory = path.join(
    root,
    'apps',
    'treeport',
    '.treeport-dev'
  )
  const dataDir = path.join(developmentDirectory, 'data')
  const runtimeDir = path.join(developmentDirectory, 'runtime')
  if (
    !(await fs
      .stat(developmentDirectory)
      .then(() => true)
      .catch(() => false))
  ) {
    return
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const graceMs = options.graceMs ?? DEFAULT_PROCESS_GRACE_MS
  await stopDaemon(dataDir, runtimeDir, timeoutMs)
  await stopTerminalHost(dataDir, runtimeDir, timeoutMs, graceMs)
}

async function main() {
  const args = process.argv.slice(2)
  const worktreeIndex = args.indexOf('--worktree')
  const worktreePath = worktreeIndex >= 0 ? args[worktreeIndex + 1] : undefined
  if (!worktreePath) {
    throw new Error('Usage: cleanup-development-runtime.mjs --worktree <path>')
  }

  await cleanupDevelopmentRuntime(worktreePath)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
