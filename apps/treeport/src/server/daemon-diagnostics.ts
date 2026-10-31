/* eslint-disable anti-slop/no-runtime-typeof -- Node Writable.write accepts documented string/buffer and encoding/callback overloads. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { z } from 'zod'
import { appendDaemonLog } from './daemon-log'
import { createBufferedDaemonLog } from './buffered-daemon-log'
import { resolveDataDir } from './core/config'

export function installDaemonDiagnostics(entrypoint: URL) {
  process.env.TREEPORT_INSTANCE_ID ||= crypto.randomUUID()
  process.env.TREEPORT_INSTALLATION_METHOD ||= 'unknown'

  if (!process.env.TREEPORT_APP_VERSION?.trim()) {
    const manifestPath = new URL('../../../package.json', entrypoint)

    if (fs.existsSync(manifestPath)) {
      const manifest = z
        .looseObject({
          name: z.literal('@treeport/treeport'),
          version: z.string()
        })
        .parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))

      process.env.TREEPORT_APP_VERSION = manifest.version
    }
  }

  const logPath = path.join(resolveDataDir(process.env), 'logs', 'daemon.log')
  const originalErrorWrite = process.stderr.write.bind(process.stderr)
  const build = crypto.createHash('sha256').update(fs.readFileSync(entrypoint))
  const applicationEntrypoint = new URL('./main.js', entrypoint)

  if (fs.existsSync(applicationEntrypoint)) {
    build.update(fs.readFileSync(applicationEntrypoint))
  }

  const context = {
    pid: process.pid,
    instanceId: process.env.TREEPORT_INSTANCE_ID,
    version: process.env.TREEPORT_APP_VERSION?.trim() || 'development',
    build: build.digest('hex'),
    entrypoint: fileURLToPath(entrypoint),
    node: process.version,
    installationMethod:
      process.env.TREEPORT_INSTALLATION_METHOD?.trim() || 'development',
    development:
      process.env.TREEPORT_INSTALLATION_METHOD?.trim() === 'development' ||
      process.env.TREEPORT_WEB_DEVELOPMENT?.trim() === '1'
  }

  let loggingFailed = false
  let fatal = false
  let shutdownReason: string | null = null

  const buffered = createBufferedDaemonLog(
    new URL('./daemon-log-worker.js', entrypoint),
    logPath,
    (error) => {
      loggingFailed = true
      originalErrorWrite(
        `Treeport could not persist daemon logs at ${logPath}: ${inspect(error)}\n`
      )
    }
  )

  const persist = (
    value: string | Uint8Array,
    synchronous = false
  ): boolean => {
    if (loggingFailed) {
      return false
    }

    try {
      if (!synchronous) {
        return buffered.write(value)
      }

      if (!buffered.flushSync()) {
        return false
      }

      appendDaemonLog(logPath, value)

      return true
    } catch (error) {
      loggingFailed = true
      originalErrorWrite(
        `Treeport could not persist daemon logs at ${logPath}: ${inspect(error)}\n`
      )

      return false
    }
  }

  const event = (
    name: string,
    details: {
      apiUrl?: string
      error?: string
      origin?: string
      reason?: string
      timeoutMs?: number
      code?: number
      fatal?: boolean
      shutdownReason?: string | null
    } = {}
  ) => {
    const value = `${JSON.stringify({ timestamp: new Date().toISOString(), event: name, ...context, ...details })}\n`

    if (!persist(value, fatal || name === 'exit')) {
      originalErrorWrite(value)
    }
  }

  for (const stream of [process.stdout, process.stderr]) {
    const originalWrite = stream.write.bind(stream)
    stream.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void
    ): boolean => {
      const encoding =
        typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined

      persist(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk)

      return typeof encodingOrCallback === 'function'
        ? originalWrite(chunk, encodingOrCallback)
        : originalWrite(chunk, encoding, callback)
    }
  }

  // EXTERNAL: Monitor, rather than handle, uncaught exceptions so Node retains its fatal
  // semantics. Node's default strict rejection policy reaches this monitor too.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    fatal = true
    event('fatal', {
      origin,
      error: inspect(error, { depth: 8, colors: false })
    })
  })
  process.on('exit', (code) => {
    event('exit', { code, fatal, shutdownReason })
  })
  event('starting')

  return {
    event,
    shutdown(reason: string) {
      shutdownReason = reason
      event('shutdown_requested', { reason })
    },
    failed(error: string, phase: 'startup' | 'shutdown') {
      if (fatal) {
        return
      }

      fatal = true
      event(`${phase}_failed`, { error })
    }
  }
}
