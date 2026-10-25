import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import {
  decodeTerminalHostResult,
  encodeTerminalHostFrame,
  makeTerminalHostFrameDecoder,
  type TerminalHostRecord
} from './api'

const nonEmptyString = Schema.String.pipe(Schema.minLength(1))
const positiveInteger = Schema.Int.pipe(Schema.positive())

/** Protocol 4 hosts wrote protocolVersion; later standalone hosts omit it. */
const legacyHostRecordSchema = Schema.parseJson(
  Schema.Struct({
    hostId: nonEmptyString,
    hostKey: nonEmptyString,
    pid: positiveInteger,
    socketPath: nonEmptyString,
    startedAt: nonEmptyString,
    protocolVersion: Schema.optional(positiveInteger)
  })
)

/**
 * A standalone terminal host from a release before persistent session keepers.
 * Its PTYs cannot move to keepers. A non-null reason means the host may still
 * own terminals; only an idle (running, reason-free) host may be retired.
 */
export interface LegacyTerminalHost {
  readonly recordPath: string
  readonly socketPath: string
  readonly record: TerminalHostRecord | null
  readonly token: string | null
  readonly running: boolean
  readonly reason: string | null
  readonly next: string | null
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

/** Authenticated read-only handshake; the host rejects any other request. */
async function probeLegacyHost(
  record: TerminalHostRecord,
  token: string
): Promise<{
  liveSessionCount: number | null
  stale: boolean
  reason: string | null
}> {
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
      liveSessionCount: number | null
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
        liveSessionCount: null,
        stale: false,
        reason: 'The terminal host did not answer the read-only API probe.'
      })
    )
    socket.once('close', () =>
      finish({
        liveSessionCount: null,
        stale: false,
        reason: 'The terminal host closed the read-only API probe.'
      })
    )
    socket.once('error', (cause: NodeJS.ErrnoException) =>
      finish({
        liveSessionCount: null,
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
              liveSessionCount: null,
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
              liveSessionCount: null,
              stale: false,
              reason:
                'The terminal host returned an invalid or mismatched API identity.'
            })

            return
          }

          finish({
            liveSessionCount: result.right.liveSessionCount,
            stale: false,
            reason: null
          })
        },
        (cause) =>
          finish({
            liveSessionCount: null,
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
 * Locates a legacy host without replacing, signaling, or mutating it. Treeport
 * never adopts its terminals; users close them deliberately before upgrading.
 */
export async function inspectLegacyTerminalHost(
  dataDir: string,
  runtimeDir: string
): Promise<LegacyTerminalHost> {
  const hostKey = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 20)

  const recordPath = path.join(runtimeDir, `terminal-host-${hostKey}.json`)

  const socketPath = path.join(
    os.tmpdir(),
    `treeport-${process.getuid?.() ?? 'user'}`,
    `terminal-${hostKey}.sock`
  )

  const result = (
    record: TerminalHostRecord | null,
    running: boolean,
    reason: string | null = null,
    next: string | null = null
  ): LegacyTerminalHost => ({
    recordPath,
    socketPath,
    record,
    token: null,
    running,
    reason,
    next
  })

  const source = await fs.readFile(recordPath, 'utf8').catch((cause) => {
    // SAFETY: Node filesystem promise rejections expose the filesystem error code.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw cause
  })

  if (source === null) {
    const socketExists = await fs
      .lstat(socketPath)
      .then(() => true)
      .catch((cause) => {
        // SAFETY: Node filesystem promise rejections expose the filesystem error code.
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          return false
        }

        throw cause
      })

    return socketExists
      ? result(
          null,
          true,
          'A terminal host socket exists without a valid discovery record.',
          'Identify and stop the owning host explicitly; Treeport will not unlink an unidentified socket.'
        )
      : result(null, false)
  }

  const parsed = Schema.decodeUnknownEither(legacyHostRecordSchema)(source)

  if (Either.isLeft(parsed)) {
    return result(
      null,
      false,
      `Terminal host discovery record is invalid: ${recordPath}`,
      'Inspect the terminal host record before retrying; Treeport cannot tell whether its terminals are still running.'
    )
  }

  const { protocolVersion, ...record } = parsed.right

  if (record.hostKey !== hostKey || record.socketPath !== socketPath) {
    return result(
      record,
      processExists(record.pid),
      'The terminal host discovery record does not identify this installation.',
      'Inspect the record; Treeport will not contact or unlink an unidentified socket.'
    )
  }

  if (
    !processExists(record.pid) &&
    !(await socketAcceptsConnections(record.socketPath))
  ) {
    return result(record, false)
  }

  const closeTerminals = `Save your work, explicitly close terminals in the earlier Treeport release, then retry. Stopping terminal host PID ${record.pid} also ends its terminals.`

  if (protocolVersion !== undefined) {
    return result(
      record,
      true,
      `Running terminal host ${record.hostId} uses retired protocol ${protocolVersion}.`,
      closeTerminals
    )
  }

  const token = await fs
    .readFile(path.join(dataDir, 'terminal-host.token'), 'utf8')
    .then((contents) => contents.trim())
    .catch(() => null)

  if (!token) {
    return result(
      record,
      true,
      'The terminal host authentication token is missing or unreadable.',
      'Repair its authentication state or stop the host explicitly before retrying.'
    )
  }

  const probe = await probeLegacyHost(record, token)

  if (probe.stale && !processExists(record.pid)) {
    return result(record, false)
  }

  if (probe.liveSessionCount === null) {
    return result(
      record,
      true,
      probe.reason ??
        `Terminal host PID ${record.pid} exists but its API is unavailable.`,
      'Treeport will not signal the host or replace its socket. Stop it explicitly before retrying.'
    )
  }

  if (probe.liveSessionCount > 0) {
    return result(
      record,
      true,
      `Terminal host PID ${record.pid} from an earlier Treeport release still owns ${probe.liveSessionCount} terminal session(s). Persistent terminals cannot adopt them.`,
      closeTerminals
    )
  }

  return { ...result(record, true), token }
}
