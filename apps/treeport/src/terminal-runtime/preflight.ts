#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Effect from 'effect/Effect'
import {
  decodeTerminalHostResult,
  encodeTerminalHostFrame,
  makeTerminalHostFrameDecoder,
  type TerminalHostRecord
} from './api'
import { decodeTerminalHostDiscoveryRecord } from './legacy-record'

export interface TerminalHostCompatibilityProbe {
  compatible: boolean
  running: boolean
  record: TerminalHostRecord | null
  reason: string | null
  next: string | null
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // SAFETY: Node reports process signaling failures as ErrnoException objects.
    return (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function manualCutover(hostId: string, protocolVersion: number) {
  return {
    compatible: false,
    running: true,
    reason: `Running terminal host ${hostId} uses retired protocol ${protocolVersion}.`,
    next: 'Save your work, explicitly close terminals in the old Treeport release, stop the old terminal host, then retry the update.'
  } as const
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (cause: NodeJS.ErrnoException) => {
      socket.destroy()
      if (cause.code === 'ENOENT' || cause.code === 'ECONNREFUSED') {
        resolve(false)
      } else {
        reject(cause)
      }
    })
  })
}

async function probeTerminalHostApi(
  record: TerminalHostRecord,
  token: string
): Promise<{ supported: boolean; stale: boolean; reason: string | null }> {
  const id = crypto.randomUUID()
  const encoded = await Effect.runPromise(
    encodeTerminalHostFrame({
      type: 'request',
      id,
      method: 'handshake',
      input: { token, hostKey: record.hostKey, readOnly: true }
    })
  )

  return new Promise((resolve) => {
    const socket = net.createConnection(record.socketPath)
    const decode = makeTerminalHostFrameDecoder()
    let settled = false
    const finish = (result: {
      supported: boolean
      stale: boolean
      reason: string | null
    }) => {
      if (settled) {
        return
      }

      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(3_000)
    socket.once('connect', () => socket.write(encoded))
    socket.once('timeout', () =>
      finish({
        supported: false,
        stale: false,
        reason: 'The terminal host did not answer the read-only API probe.'
      })
    )
    socket.once('close', () =>
      finish({
        supported: false,
        stale: false,
        reason: 'The terminal host closed the read-only API probe.'
      })
    )
    socket.once('error', (cause: NodeJS.ErrnoException) =>
      finish({
        supported: false,
        stale: cause.code === 'ENOENT' || cause.code === 'ECONNREFUSED',
        reason:
          cause.code === 'ENOENT' || cause.code === 'ECONNREFUSED'
            ? null
            : `The terminal host API probe failed: ${cause.message}`
      })
    )
    socket.on('data', (chunk) => {
      void Effect.runPromise(decode(chunk)).then(
        async (frames) => {
          const frame = frames.find(
            (candidate) => candidate.type === 'response' && candidate.id === id
          )
          if (!frame || frame.type !== 'response') {
            return
          }

          if (frame.error) {
            finish({
              supported: false,
              stale: false,
              reason: `The terminal host refused the read-only API probe: ${frame.error.code}: ${frame.error.message}`
            })
            return
          }

          const result = await Effect.runPromise(
            Effect.either(decodeTerminalHostResult('handshake', frame.result))
          )
          if (
            result._tag === 'Left' ||
            result.right.hostId !== record.hostId ||
            result.right.hostKey !== record.hostKey ||
            result.right.pid !== record.pid ||
            result.right.socketPath !== record.socketPath
          ) {
            finish({
              supported: false,
              stale: false,
              reason:
                'The terminal host returned an invalid or mismatched API identity.'
            })
            return
          }

          finish({ supported: true, stale: false, reason: null })
        },
        (cause) =>
          finish({
            supported: false,
            stale: false,
            reason: `The terminal host returned an invalid API frame: ${String(
              cause
            )}`
          })
      )
    })
  })
}

/**
 * Staged-candidate readiness probe. The only host request is an authenticated,
 * read-only handshake; the host rejects terminal operations on that connection.
 */
export async function probeTerminalHostCompatibility(
  dataDir: string,
  runtimeDir: string
): Promise<TerminalHostCompatibilityProbe> {
  const hostKey = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 20)
  const recordPath = path.join(runtimeDir, `terminal-host-${hostKey}.json`)
  const canonicalSocketPath = path.join(
    os.tmpdir(),
    `treeport-${process.getuid?.() ?? 'user'}`,
    `terminal-${hostKey}.sock`
  )
  const source = await fs.readFile(recordPath, 'utf8').catch((cause) => {
    // SAFETY: Node filesystem promise rejections expose the filesystem error code.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw cause
  })
  if (source === null) {
    const socketExists = await fs
      .lstat(canonicalSocketPath)
      .then(() => true)
      .catch((cause) => {
        // SAFETY: Node filesystem promise rejections expose the filesystem error code.
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          return false
        }

        throw cause
      })
    if (socketExists) {
      return {
        compatible: false,
        running: true,
        record: null,
        reason:
          'A terminal host socket exists without a valid discovery record.',
        next: 'Keep the current installation active. Identify and stop the owning host explicitly; Treeport will not unlink an unidentified socket.'
      }
    }

    return {
      compatible: true,
      running: false,
      record: null,
      reason: null,
      next: null
    }
  }

  let value: unknown
  try {
    // SAFETY: JSON may contain any shape; the runtime-owned decoder validates it below.
    value = JSON.parse(source) as unknown
  } catch {
    return {
      compatible: false,
      running: false,
      record: null,
      reason: `Terminal host discovery record is invalid: ${recordPath}`,
      next: 'Keep the current Treeport installation active and inspect the terminal host record before retrying.'
    }
  }

  const parsed = await Effect.runPromise(
    Effect.either(decodeTerminalHostDiscoveryRecord(value))
  )
  if (parsed._tag === 'Left') {
    return {
      compatible: false,
      running: false,
      record: null,
      reason: `Terminal host discovery record is invalid: ${recordPath}`,
      next: 'Keep the current Treeport installation active and inspect the terminal host record before retrying.'
    }
  }

  const { protocolVersion: legacyProtocolVersion, ...record } = parsed.right
  if (record.hostKey !== hostKey || record.socketPath !== canonicalSocketPath) {
    return {
      compatible: false,
      running: processExists(record.pid),
      record,
      reason:
        'The terminal host discovery record does not identify this installation.',
      next: 'Keep the current installation active and inspect the record; Treeport will not contact or unlink an unidentified socket.'
    }
  }

  if (legacyProtocolVersion !== undefined) {
    if (
      processExists(record.pid) ||
      (await socketAcceptsConnections(record.socketPath))
    ) {
      return { ...manualCutover(record.hostId, legacyProtocolVersion), record }
    }

    return {
      compatible: true,
      running: false,
      record,
      reason: null,
      next: null
    }
  }

  const token = await fs
    .readFile(path.join(dataDir, 'terminal-host.token'), 'utf8')
    .then((contents) => contents.trim())
    .catch(() => null)
  if (!token) {
    return {
      compatible: false,
      running: processExists(record.pid),
      record,
      reason:
        'The terminal host authentication token is missing or unreadable.',
      next: 'Keep the current installation active and repair its terminal host authentication state before retrying.'
    }
  }

  const probe = await probeTerminalHostApi(record, token)
  if (probe.supported) {
    return {
      compatible: true,
      running: true,
      record,
      reason: null,
      next: null
    }
  }

  if (probe.stale && !processExists(record.pid)) {
    return {
      compatible: true,
      running: false,
      record,
      reason: null,
      next: null
    }
  }

  return {
    compatible: false,
    running: processExists(record.pid),
    record,
    reason:
      probe.reason ??
      `Terminal host PID ${record.pid} exists but its API is unavailable.`,
    next: 'Keep the current installation and terminals active. Treeport will not signal the host or replace its socket.'
  }
}

async function main(): Promise<void> {
  const dataDir = process.env.TREEPORT_DATA_DIR?.trim()
  const runtimeDir = process.env.TREEPORT_RUNTIME_DIR?.trim()
  if (!dataDir || !runtimeDir) {
    throw new Error('TREEPORT_DATA_DIR and TREEPORT_RUNTIME_DIR are required')
  }

  const result = await probeTerminalHostCompatibility(dataDir, runtimeDir)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.compatible) {
    process.exitCode = 42
  }
}

const entrypoint = process.argv[1]
const invokedPath = entrypoint
  ? await fs.realpath(entrypoint).catch(() => path.resolve(entrypoint))
  : null
const modulePath = await fs
  .realpath(fileURLToPath(import.meta.url))
  .catch(() => path.resolve(fileURLToPath(import.meta.url)))
if (invokedPath === modulePath) {
  await main()
}
