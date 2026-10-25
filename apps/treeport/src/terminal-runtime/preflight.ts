#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Effect from 'effect/Effect'
import { decodeTerminalEngineMetadata, type TerminalHostRecord } from './api'
import { inspectLegacyTerminalHost } from './legacy-host'
import { PersistentSession } from './session-client'

export interface TerminalHostCompatibilityProbe {
  compatible: boolean
  running: boolean
  record: TerminalHostRecord | null
  reason: string | null
  next: string | null
}

/** Candidate updates inspect raw session owners without attaching an engine,
 * replaying output, transferring authority, or signaling any process. */
export async function probeTerminalHostCompatibility(
  dataDir: string,
  runtimeDir: string
): Promise<TerminalHostCompatibilityProbe> {
  const legacy = await inspectLegacyTerminalHost(dataDir, runtimeDir)

  if (legacy.reason !== null) {
    return {
      compatible: false,
      running: legacy.running,
      record: legacy.record,
      reason: legacy.reason,
      next: legacy.next
    }
  }

  const hostKey = crypto
    .createHash('sha256')
    .update(path.resolve(dataDir))
    .digest('hex')
    .slice(0, 20)

  const directory = path.join(
    runtimeDir,
    'terminal-engine',
    'terminal-host-' + hostKey,
    'sessions'
  )

  const names = await fs.readdir(directory).catch((error) => {
    // SAFETY: Node filesystem errors expose their standard errno code.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  })

  for (const name of names.sort()) {
    if (!/^[a-f0-9]{40}$/u.test(name)) {
      continue
    }

    const sessionDirectory = path.join(directory, name)

    try {
      const session = await PersistentSession.open(sessionDirectory)
      const manifest = session.manifest

      const metadata = await Effect.runPromise(
        decodeTerminalEngineMetadata(manifest.metadata)
      )

      if (
        name !==
        crypto
          .createHash('sha256')
          .update(metadata.input.terminalId)
          .digest('hex')
          .slice(0, 40)
      ) {
        throw new Error('Session metadata does not identify its directory')
      }

      if (
        metadata.launchSpecPath &&
        path.dirname(path.resolve(metadata.launchSpecPath)) !==
          path.resolve(
            runtimeDir,
            'terminal-engine',
            'terminal-host-' + hostKey,
            'terminal-specs'
          )
      ) {
        throw new Error('Session launch spec is outside its installation')
      }

      await session.inspect()
    } catch (error) {
      return {
        compatible: false,
        running: true,
        record: legacy.record,
        reason:
          'Persistent session ' +
          name +
          ' is not ready for this update: ' +
          (error instanceof Error ? error.message : String(error)),
        next: 'Keep the current installation and sessions active. Repair the session discovery state or finish and explicitly close the affected terminal; Treeport will not replace or signal its owner.'
      }
    }
  }

  return {
    compatible: true,
    running: legacy.running || names.length > 0,
    record: legacy.record,
    reason: null,
    next: null
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
